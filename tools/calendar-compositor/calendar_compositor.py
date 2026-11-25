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

from detector import PaperColorModel, detect_hand_mask
from tracker import PageTracker
from warper import warp_and_composite

COMPOSITOR_VERSION = "1.0.1"


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
        proc = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True
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
    artwork = cv2.imread(args.artwork, cv2.IMREAD_COLOR)
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

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        sys.stderr.write("Failed to open input video with OpenCV\n")
        return 2

    # Setup ffmpeg output pipe
    ffmpeg_cmd = [
        args.ffmpeg,
        "-y",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-vcodec",
        "rawvideo",
        "-s",
        f"{width}x{height}",
        "-pix_fmt",
        "bgr24",
        "-r",
        f"{fps:.4f}",
        "-i",
        "-",
    ]

    if has_audio:
        ffmpeg_cmd.extend([
            "-i",
            args.input,
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-shortest",
            args.output,
        ])
    else:
        ffmpeg_cmd.extend([
            "-map",
            "0:v:0",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            args.output,
        ])

    ffmpeg_proc = None
    try:
        ffmpeg_proc = subprocess.Popen(
            ffmpeg_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        cap.release()
        sys.stderr.write("Failed to spawn ffmpeg encoder process\n")
        return 4

    tracker = PageTracker(alpha=0.3)
    paper_model = PaperColorModel()
    processed_frames = 0
    visible_frames = 0
    low_confidence_frames = 0
    total_area_sum = 0.0
    top_inset = getattr(args, "top_inset", 0.05)

    try:
        while True:
            ret, frame = cap.read()
            if not ret or frame is None:
                break

            processed_frames += 1
            corners, confidence, is_confident = tracker.process_frame(frame)

            if is_confident and corners is not None:
                paper_model.update(frame, corners)
                hand_mask, is_excessive = detect_hand_mask(frame, corners, paper_model=paper_model)

                if is_excessive:
                    low_confidence_frames += 1
                    frame_out = frame
                else:
                    frame_out = warp_and_composite(
                        frame,
                        artwork,
                        corners,
                        hand_mask=hand_mask,
                        top_inset=top_inset,
                    )
                    visible_frames += 1
                    total_area_sum += float(cv2.contourArea(corners))
            else:
                low_confidence_frames += 1
                frame_out = frame

            # Write raw frame bytes to ffmpeg stdin
            try:
                if ffmpeg_proc.stdin:
                    ffmpeg_proc.stdin.write(frame_out.tobytes())
            except Exception:
                break

    except Exception:
        cap.release()
        if ffmpeg_proc:
            try:
                ffmpeg_proc.kill()
            except Exception:
                pass
        if os.path.exists(args.output):
            os.remove(args.output)
        sys.stderr.write("Unexpected internal error during compositing\n")
        return 4
    finally:
        cap.release()

    if ffmpeg_proc:
        try:
            if ffmpeg_proc.stdin:
                ffmpeg_proc.stdin.close()
            ffmpeg_proc.wait(timeout=60)
        except Exception:
            ffmpeg_proc.kill()

    # Calculate coverage and quality metrics
    min_coverage = float(args.min_coverage)
    tracking_coverage = visible_frames / max(processed_frames, 1)
    frame_area = width * height
    avg_page_area_ratio = (
        (total_area_sum / max(visible_frames, 1)) / frame_area if visible_frames > 0 else 0.0
    )

    # Quality Gate (brief §7.7 and specification):
    # 1. Open page segment must be at least ~1.5 seconds: visible_frames >= 1.5 * fps (allow ~1.4 * fps margin)
    min_visible_frames_req = int(1.4 * fps)
    open_segment_ok = visible_frames >= min_visible_frames_req
    coverage_ok = tracking_coverage >= min_coverage
    area_ok = avg_page_area_ratio >= 0.05

    quality_passed = open_segment_ok and coverage_ok and area_ok

    if quality_passed:
        write_report(
            args.report,
            applied=True,
            artwork_sha256=artwork_sha256,
            processed_frames=processed_frames,
            visible_frames=visible_frames,
            tracking_coverage=tracking_coverage,
            low_confidence_frames=low_confidence_frames,
        )
        sys.stdout.write(
            f"Calendar compositing succeeded: {visible_frames}/{processed_frames} visible ({tracking_coverage:.2%})\n"
        )
        return 0
    else:
        # Quality gate failed: delete output file, write report with applied=false, exit 3
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
            visible_frames=visible_frames,
            tracking_coverage=tracking_coverage,
            low_confidence_frames=low_confidence_frames,
        )
        sys.stderr.write(
            f"Quality gate failed: visible={visible_frames} (req={min_visible_frames_req}), "
            f"coverage={tracking_coverage:.2%} (min={min_coverage:.2%}), avg_area={avg_page_area_ratio:.2%}\n"
        )
        return 3


def main() -> None:
    parser = argparse.ArgumentParser(description="Calendar Artwork Compositor CLI")
    parser.add_argument("--input", required=True, help="Input video MP4 path")
    parser.add_argument("--artwork", required=True, help="Artwork image path")
    parser.add_argument("--output", required=True, help="Output video MP4 path")
    parser.add_argument("--ffmpeg", required=True, help="Path to ffmpeg executable")
    parser.add_argument("--ffprobe", required=True, help="Path to ffprobe executable")
    parser.add_argument("--report", required=True, help="Path to output report JSON")
    parser.add_argument("--min-coverage", type=float, default=0.6, help="Minimum tracking coverage [0..1]")
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
