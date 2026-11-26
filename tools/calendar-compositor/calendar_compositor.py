#!/usr/bin/env python3
"""
Calendar Artwork Compositor CLI sidecar.
Composites interior artwork onto desk calendar video page.

Usage:
  calendar-compositor --input <mp4> --artwork <img> --output <mp4>
                      --ffmpeg <exe> --ffprobe <exe> --report <json>
                      [--min-coverage 0.6] [--top-inset 0.05]

Exit codes:
  0: OK (compositing applied and quality gate passed)
  2: Bad input (missing files, bad arguments, unreadable video/image)
  3: Tracking failed / Quality gate failed (applied=false, output deleted)
  4: Internal error
"""

from __future__ import annotations
import argparse
import hashlib
import json
import os
import subprocess
import sys
from typing import Any
import cv2
import numpy as np

from detector import PaperColorModel, detect_hand_mask, page_is_blank
from segments import plan_segments
from tracker import PageTracker
from warper import warp_and_composite

COMPOSITOR_VERSION = "1.1.0"


def compute_file_sha256(path: str) -> str:
    """Computes SHA-256 hex digest of a file without leaking paths."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def probe_video(
    ffprobe_exe: str, video_path: str
) -> dict[str, Any] | None:
    """Probes video using ffprobe to obtain dimensions, fps, duration, and audio presence."""
    cmd = [
        ffprobe_exe,
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        video_path,
    ]
    try:
        # ffprobe prints UTF-8 (the JSON echoes the input path, e.g. "Hỏi đáp"); never decode it with the Windows
        # ANSI code page, which fails on Vietnamese characters.
        proc = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
            check=True,
        )
        data = json.loads(proc.stdout)
    except Exception:
        return None

    streams = data.get("streams", [])
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not video_stream:
        return None

    has_audio = any(s.get("codec_type") == "audio" for s in streams)

    width = int(video_stream.get("width", 0))
    height = int(video_stream.get("height", 0))

    fps_str = video_stream.get("r_frame_rate", "30/1")
    try:
        if "/" in fps_str:
            num, den = fps_str.split("/", 1)
            fps = float(num) / float(den) if float(den) > 0 else 30.0
        else:
            fps = float(fps_str)
    except Exception:
        fps = 30.0

    duration_str = video_stream.get("duration") or data.get("format", {}).get("duration", "0")
    try:
        duration = float(duration_str)
    except Exception:
        duration = 0.0

    nb_frames_str = video_stream.get("nb_frames")
    nb_frames = int(nb_frames_str) if nb_frames_str and nb_frames_str.isdigit() else None

    return {
        "width": width,
        "height": height,
        "fps": fps,
        "duration": duration,
        "nb_frames": nb_frames,
        "has_audio": has_audio,
    }


def write_report(
    report_path: str,
    applied: bool,
    artwork_sha256: str,
    processed_frames: int,
    visible_frames: int,
    tracking_coverage: float,
    low_confidence_frames: int,
) -> None:
    """Writes sanitized report JSON without absolute paths."""
    report_data = {
        "applied": applied,
        "artworkSha256": artwork_sha256,
        "processedFrames": processed_frames,
        "visibleFrames": visible_frames,
        "trackingCoverage": round(float(tracking_coverage), 4),
        "lowConfidenceFrames": low_confidence_frames,
        "compositorVersion": COMPOSITOR_VERSION,
    }
    temp_report = report_path + ".tmp"
    with open(temp_report, "w", encoding="utf-8") as f:
        json.dump(report_data, f, indent=2)
    if os.path.exists(report_path):
        os.remove(report_path)
    os.rename(temp_report, report_path)


def run_compositor(args: argparse.Namespace) -> int:
    # 1. Validate inputs existence
    if not os.path.isfile(args.input):
        sys.stderr.write("Input video file does not exist\n")
        return 2

    if not os.path.isfile(args.artwork):
        sys.stderr.write("Artwork image file does not exist\n")
        return 2

    if not os.path.isfile(args.ffmpeg):
        sys.stderr.write("ffmpeg executable does not exist\n")
        return 2

    if not os.path.isfile(args.ffprobe):
        sys.stderr.write("ffprobe executable does not exist\n")
        return 2

    # Compute artwork SHA-256
    try:
        artwork_sha256 = compute_file_sha256(args.artwork)
    except Exception:
        sys.stderr.write("Failed to read artwork file\n")
        return 2

    # Load artwork in memory
    # cv2.imread cannot open non-ASCII paths on Windows; decode from bytes instead.
    try:
        artwork = cv2.imdecode(np.fromfile(args.artwork, dtype=np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        artwork = None
    if artwork is None or artwork.size == 0:
        sys.stderr.write("Failed to decode artwork image\n")
        return 2

    # Probe input video
    probe = probe_video(args.ffprobe, args.input)
    if not probe or probe["width"] <= 0 or probe["height"] <= 0:
        sys.stderr.write("Failed to probe input video\n")
        return 2

    width = probe["width"]
    height = probe["height"]
    fps = probe["fps"]
    has_audio = probe["has_audio"]

    frame_w, frame_h = width, height
    frame_area = float(width * height)
    min_coverage = float(args.min_coverage)
    top_inset = getattr(args, "top_inset", 0.05)

    # ---- Pass 1: locate the blank page in every frame. Nothing is encoded yet. ----
    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        sys.stderr.write("Failed to open input video with OpenCV\n")
        return 2

    tracker = PageTracker(alpha=0.3)
    frame_corners: list[np.ndarray | None] = []
    try:
        while True:
            ret, frame = cap.read()
            if not ret or frame is None:
                break
            corners, _confidence, is_confident = tracker.process_frame(frame)
            if is_confident and corners is not None:
                hand_mask, is_excessive = detect_hand_mask(frame, corners)
                # Only the blank interior page may receive artwork: a printed cover, the reviewer's clothing or a
                # drifted quad over the background is rejected, and tracking restarts from fresh detection.
                if is_excessive or not page_is_blank(frame, corners, hand_mask):
                    tracker.reset()
                    corners = None
            else:
                corners = None
            frame_corners.append(corners)
    except Exception:
        sys.stderr.write("Unexpected internal error during page detection\n")
        return 4
    finally:
        cap.release()

    processed_frames = len(frame_corners)
    plan = plan_segments(frame_corners, fps, frame_w, frame_h)
    kept = [c for c in plan.corners if c is not None]
    avg_page_area_ratio = (
        float(np.mean([cv2.contourArea(c) for c in kept])) / frame_area if kept else 0.0
    )

    # Quality gate (brief §7.7): one continuous open-page run of >= ~1.5 s, steady tracking inside the open-page
    # span, and a page large enough to be legible.
    min_run_req = int(1.4 * fps)
    run_ok = plan.longest_run >= min_run_req
    coverage_ok = plan.span_coverage >= min_coverage
    area_ok = avg_page_area_ratio >= 0.05
    low_confidence_frames = plan.span_length - plan.visible

    if not (run_ok and coverage_ok and area_ok):
        if os.path.exists(args.output):
            try:
                os.remove(args.output)
            except Exception:
                pass
        write_report(
            args.report,
            applied=False,
            artwork_sha256=artwork_sha256,
            processed_frames=processed_frames,
            visible_frames=plan.visible,
            tracking_coverage=plan.span_coverage,
            low_confidence_frames=low_confidence_frames,
        )
        sys.stderr.write(
            f"Quality gate failed: longest_open_run={plan.longest_run} (req={min_run_req}), "
            f"span_coverage={plan.span_coverage:.2%} (min={min_coverage:.2%}), avg_area={avg_page_area_ratio:.2%}\n"
        )
        return 3

    # ---- Pass 2: composite the planned frames and encode. ----
    ffmpeg_cmd = [
        args.ffmpeg, "-y", "-loglevel", "error",
        "-f", "rawvideo", "-vcodec", "rawvideo", "-s", f"{width}x{height}", "-pix_fmt", "bgr24",
        "-r", f"{fps:.4f}", "-i", "-",
    ]
    if has_audio:
        ffmpeg_cmd += ["-i", args.input, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "copy"]
    # Explicit muxer: the caller's output path may not end in .mp4 (e.g. a .part temp file).
    ffmpeg_cmd += ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-f", "mp4", args.output]

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        sys.stderr.write("Failed to open input video with OpenCV\n")
        return 2
    try:
        ffmpeg_proc = subprocess.Popen(
            ffmpeg_cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except Exception:
        cap.release()
        sys.stderr.write("Failed to spawn ffmpeg encoder process\n")
        return 4

    paper_model = PaperColorModel()
    composited = 0
    write_failed = False
    try:
        idx = 0
        while True:
            ret, frame = cap.read()
            if not ret or frame is None:
                break
            corners = plan.corners[idx] if idx < len(plan.corners) else None
            idx += 1
            frame_out = frame
            if corners is not None:
                paper_model.update(frame, corners)
                hand_mask, is_excessive = detect_hand_mask(frame, corners, paper_model=paper_model)
                if not is_excessive:
                    frame_out = warp_and_composite(frame, artwork, corners, hand_mask=hand_mask, top_inset=top_inset)
                    composited += 1
            try:
                assert ffmpeg_proc.stdin is not None
                ffmpeg_proc.stdin.write(frame_out.tobytes())
            except Exception:
                write_failed = True
                break
    except Exception:
        write_failed = True
    finally:
        cap.release()
        try:
            if ffmpeg_proc.stdin:
                ffmpeg_proc.stdin.close()
            ffmpeg_proc.wait(timeout=120)
        except Exception:
            ffmpeg_proc.kill()

    if write_failed or ffmpeg_proc.returncode != 0 or not os.path.isfile(args.output):
        if os.path.exists(args.output):
            try:
                os.remove(args.output)
            except Exception:
                pass
        sys.stderr.write("Encoding failed\n")
        return 4

    write_report(
        args.report,
        applied=True,
        artwork_sha256=artwork_sha256,
        processed_frames=processed_frames,
        visible_frames=composited,
        tracking_coverage=plan.span_coverage,
        low_confidence_frames=low_confidence_frames,
    )
    sys.stdout.write(
        f"Calendar compositing succeeded: {composited}/{processed_frames} frames composited, "
        f"open-page run {plan.longest_run} frames, span coverage {plan.span_coverage:.2%}\n"
    )
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Calendar Artwork Compositor CLI")
    parser.add_argument("--input", required=True, help="Input video MP4 path")
    parser.add_argument("--artwork", required=True, help="Artwork image path")
    parser.add_argument("--output", required=True, help="Output video MP4 path")
    parser.add_argument("--ffmpeg", required=True, help="Path to ffmpeg executable")
    parser.add_argument("--ffprobe", required=True, help="Path to ffprobe executable")
    parser.add_argument("--report", required=True, help="Path to output report JSON")
    parser.add_argument("--min-coverage", type=float, default=0.6, help="Minimum share of frames with the page tracked inside the open-page span [0..1]")
    parser.add_argument("--top-inset", type=float, default=0.05, help="Top edge inset ratio (>= 0.04)")

    try:
        args = parser.parse_args()
    except SystemExit:
        sys.exit(2)

    try:
        code = run_compositor(args)
        sys.exit(code)
    except Exception:
        sys.exit(4)


if __name__ == "__main__":
    main()
