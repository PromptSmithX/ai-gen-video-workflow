"""
Synthetic fixture video generator for Desk Calendar Compositor.

Generates:
  - artwork.png: High-resolution test artwork
  - fixture_a_static.mp4 (+ _gt.json): Static front-facing cream page + audio tone
  - fixture_b_motion.mp4 (+ _gt.json): Gentle perspective motion/handheld shake
  - fixture_c_fake_text.mp4 (+ _gt.json): Page with fake 'AI' text/numbers printed on it
  - fixture_d_hand.mp4 (+ _gt.json): Skin-coloured hand/thumb blob crossing page edge
  - fixture_e_occluded.mp4: Page visible < 1 s / heavily occluded (must fail with exit 3)
  - fixture_benchmark_10s.mp4: 10 s 1080p clip for runtime/memory benchmarking
"""

from __future__ import annotations
import argparse
import json
import math
import os
import subprocess
import cv2
import numpy as np

DEFAULT_FFMPEG = r"C:\ffmpeg\bin\ffmpeg.exe"
WIDTH = 1920
HEIGHT = 1080
FPS = 30.0

# Base cream page rectangle on 1920x1080
BASE_TL = (460.0, 220.0)
BASE_TR = (1460.0, 220.0)
BASE_BR = (1460.0, 920.0)
BASE_BL = (460.0, 920.0)
BASE_CORNERS = np.float32([BASE_TL, BASE_TR, BASE_BR, BASE_BL])

# Colors (BGR)
COLOR_BG_DESK = (70, 90, 120)        # Warm gray/wood desk
COLOR_STAND = (40, 42, 45)           # Dark charcoal calendar easel base
COLOR_CREAM_PAGE = (220, 242, 248)   # Cream paper (high R, G, B with slight warm tint)
COLOR_SPIRAL = (180, 185, 190)       # Metallic spiral coils
COLOR_SKIN = (130, 160, 215)         # Natural skin tone (YCrCb: Cr~150, Cb~105)


def generate_artwork(output_path: str) -> None:
    """Generates a vibrant, high-resolution test interior artwork."""
    w, h = 1200, 800
    art = np.zeros((h, w, 3), dtype=np.uint8)

    # Colorful gradient background
    for y in range(h):
        r = int(60 + 140 * (y / h))
        g = int(120 + 80 * math.sin(y / 50.0))
        b = int(220 - 150 * (y / h))
        art[y, :] = (b, g, r)

    # Decorative mountain/landscape triangles
    cv2.fillPoly(
        art,
        [np.array([[100, 700], [500, 250], [900, 700]], dtype=np.int32)],
        (80, 140, 40),
    )
    cv2.fillPoly(
        art,
        [np.array([[400, 700], [750, 320], [1100, 700]], dtype=np.int32)],
        (120, 180, 60),
    )

    # Sun
    cv2.circle(art, (950, 200), 70, (80, 220, 255), -1)

    # Artwork title and calendar month text
    cv2.putText(
        art,
        "MOUNTAIN TRAILS - 2026",
        (180, 120),
        cv2.FONT_HERSHEY_DUPLEX,
        1.6,
        (255, 255, 255),
        3,
        cv2.LINE_AA,
    )
    cv2.putText(
        art,
        "JANUARY",
        (480, 760),
        cv2.FONT_HERSHEY_DUPLEX,
        1.4,
        (255, 255, 255),
        2,
        cv2.LINE_AA,
    )

    cv2.imwrite(output_path, art)


def draw_background_and_stand(frame: np.ndarray) -> None:
    """Draws desk surface and calendar easel stand."""
    frame[:] = COLOR_BG_DESK

    # Calendar stand / triangular easel behind page
    stand_poly = np.array(
        [[420, 180], [1500, 180], [1520, 960], [400, 960]], dtype=np.int32
    )
    cv2.fillConvexPoly(frame, stand_poly, COLOR_STAND)


def draw_spiral_binding(frame: np.ndarray, tl: tuple[float, float], tr: tuple[float, float]) -> None:
    """Draws metallic spiral rings along top edge."""
    x0, y0 = tl
    x1, y1 = tr
    num_loops = 24
    for i in range(num_loops):
        t = (i + 0.5) / num_loops
        cx = int(x0 + t * (x1 - x0))
        cy = int(y0 + t * (y1 - y0))
        cv2.ellipse(frame, (cx, cy - 8), (10, 18), 15, 0, 360, COLOR_SPIRAL, 3, cv2.LINE_AA)


def encode_video_with_audio(
    ffmpeg_exe: str,
    output_mp4: str,
    frame_generator,
    total_frames: int,
    fps: float = FPS,
    width: int = WIDTH,
    height: int = HEIGHT,
) -> None:
    """Pipes raw BGR frames to ffmpeg, combining with a 440 Hz audio tone."""
    cmd = [
        ffmpeg_exe,
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
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency=440:sample_rate=48000:duration={total_frames / fps:.4f}",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        output_mp4,
    ]
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    try:
        for frame in frame_generator():
            proc.stdin.write(frame.tobytes())
    finally:
        if proc.stdin:
            proc.stdin.close()
        proc.wait(timeout=60)


def make_fixture_a(ffmpeg_exe: str, out_dir: str) -> None:
    """Fixture (a): Static front-facing cream page + audio tone."""
    mp4_path = os.path.join(out_dir, "fixture_a_static.mp4")
    gt_path = os.path.join(out_dir, "fixture_a_gt.json")
    frames_count = 90  # 3.0 s

    gt_data = []

    def frame_gen():
        for i in range(frames_count):
            frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
            draw_background_and_stand(frame)

            # Draw cream page
            cv2.fillConvexPoly(frame, np.int32(BASE_CORNERS), COLOR_CREAM_PAGE)
            draw_spiral_binding(frame, BASE_TL, BASE_TR)

            gt_data.append({
                "frame": i,
                "corners": BASE_CORNERS.tolist(),
            })
            yield frame

    encode_video_with_audio(ffmpeg_exe, mp4_path, frame_gen, frames_count)

    with open(gt_path, "w", encoding="utf-8") as f:
        json.dump(gt_data, f)


def make_fixture_b(ffmpeg_exe: str, out_dir: str) -> None:
    """Fixture (b): Page with gentle perspective motion/handheld shake."""
    mp4_path = os.path.join(out_dir, "fixture_b_motion.mp4")
    gt_path = os.path.join(out_dir, "fixture_b_gt.json")
    frames_count = 90  # 3.0 s

    gt_data = []

    def frame_gen():
        for i in range(frames_count):
            frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
            draw_background_and_stand(frame)

            t = i / FPS
            # Sinusoidal motion & slight perspective tilt
            dx = 22.0 * math.sin(2.0 * math.pi * t / 2.5)
            dy = 14.0 * math.cos(2.0 * math.pi * t / 2.0)
            tilt_x = 10.0 * math.sin(4.0 * math.pi * t / 3.0)
            tilt_y = 8.0 * math.cos(4.0 * math.pi * t / 3.0)

            corners = np.float32([
                [BASE_TL[0] + dx - tilt_x, BASE_TL[1] + dy - tilt_y],
                [BASE_TR[0] + dx + tilt_x, BASE_TR[1] + dy - tilt_y],
                [BASE_BR[0] + dx + tilt_x, BASE_BR[1] + dy + tilt_y],
                [BASE_BL[0] + dx - tilt_x, BASE_BL[1] + dy + tilt_y],
            ])

            cv2.fillConvexPoly(frame, np.int32(corners), COLOR_CREAM_PAGE)
            draw_spiral_binding(frame, tuple(corners[0]), tuple(corners[1]))

            gt_data.append({
                "frame": i,
                "corners": corners.tolist(),
            })
            yield frame

    encode_video_with_audio(ffmpeg_exe, mp4_path, frame_gen, frames_count)

    with open(gt_path, "w", encoding="utf-8") as f:
        json.dump(gt_data, f)


def make_fixture_c(ffmpeg_exe: str, out_dir: str) -> None:
    """Fixture (c): Page with fake 'AI' text/numbers printed on it."""
    mp4_path = os.path.join(out_dir, "fixture_c_fake_text.mp4")
    gt_path = os.path.join(out_dir, "fixture_c_gt.json")
    frames_count = 90  # 3.0 s

    gt_data = []

    def frame_gen():
        for i in range(frames_count):
            frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
            draw_background_and_stand(frame)

            cv2.fillConvexPoly(frame, np.int32(BASE_CORNERS), COLOR_CREAM_PAGE)

            # Fake AI calendar text / garbled numbers
            cv2.putText(
                frame,
                "JANUARY 2026",
                (700, 350),
                cv2.FONT_HERSHEY_SIMPLEX,
                1.3,
                (40, 40, 40),
                2,
                cv2.LINE_AA,
            )
            cv2.putText(
                frame,
                "S  M  T  W  T  F  S",
                (640, 440),
                cv2.FONT_HERSHEY_SIMPLEX,
                1.1,
                (60, 60, 60),
                2,
                cv2.LINE_AA,
            )
            cv2.putText(
                frame,
                "1  2  3  4  5  6  7",
                (640, 520),
                cv2.FONT_HERSHEY_SIMPLEX,
                1.0,
                (50, 50, 50),
                2,
                cv2.LINE_AA,
            )
            cv2.putText(
                frame,
                "8  9 10 11 12 13 14",
                (630, 600),
                cv2.FONT_HERSHEY_SIMPLEX,
                1.0,
                (50, 50, 50),
                2,
                cv2.LINE_AA,
            )
            cv2.putText(
                frame,
                "15 16 17 18 19 20 21",
                (620, 680),
                cv2.FONT_HERSHEY_SIMPLEX,
                1.0,
                (50, 50, 50),
                2,
                cv2.LINE_AA,
            )

            draw_spiral_binding(frame, BASE_TL, BASE_TR)

            gt_data.append({
                "frame": i,
                "corners": BASE_CORNERS.tolist(),
            })
            yield frame

    encode_video_with_audio(ffmpeg_exe, mp4_path, frame_gen, frames_count)

    with open(gt_path, "w", encoding="utf-8") as f:
        json.dump(gt_data, f)


def make_fixture_d(ffmpeg_exe: str, out_dir: str) -> None:
    """Fixture (d): Skin-coloured blob (thumb/hand) crossing an edge of the page."""
    mp4_path = os.path.join(out_dir, "fixture_d_hand.mp4")
    gt_path = os.path.join(out_dir, "fixture_d_gt.json")
    frames_count = 90  # 3.0 s

    gt_data = []

    def frame_gen():
        for i in range(frames_count):
            frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
            draw_background_and_stand(frame)

            cv2.fillConvexPoly(frame, np.int32(BASE_CORNERS), COLOR_CREAM_PAGE)
            draw_spiral_binding(frame, BASE_TL, BASE_TR)

            # Draw realistic skin-toned thumb holding the left page margin
            thumb_pts = np.array(
                [
                    [420, 520],
                    [490, 540],
                    [530, 580],
                    [510, 630],
                    [440, 640],
                    [410, 600],
                ],
                dtype=np.int32,
            )
            cv2.fillPoly(frame, [thumb_pts], COLOR_SKIN)

            gt_data.append({
                "frame": i,
                "corners": BASE_CORNERS.tolist(),
            })
            yield frame

    encode_video_with_audio(ffmpeg_exe, mp4_path, frame_gen, frames_count)

    with open(gt_path, "w", encoding="utf-8") as f:
        json.dump(gt_data, f)


def make_fixture_e(ffmpeg_exe: str, out_dir: str) -> None:
    """Fixture (e): Page visible < 1 s / heavily occluded (must fail with exit 3)."""
    mp4_path = os.path.join(out_dir, "fixture_e_occluded.mp4")
    frames_count = 60  # 2.0 s

    def frame_gen():
        for i in range(frames_count):
            frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
            draw_background_and_stand(frame)

            # Page is visible only for frames 45..59 (15 frames = 0.5 s, less than 1.5 s quality gate requirement)
            if i >= 45:
                cv2.fillConvexPoly(frame, np.int32(BASE_CORNERS), COLOR_CREAM_PAGE)
                draw_spiral_binding(frame, BASE_TL, BASE_TR)
            else:
                # Heavy dark book occlusion covering 90% of page area
                occlusion_poly = np.array(
                    [[440, 200], [1480, 200], [1480, 940], [440, 940]], dtype=np.int32
                )
                cv2.fillConvexPoly(frame, occlusion_poly, (20, 20, 30))

            yield frame

    encode_video_with_audio(ffmpeg_exe, mp4_path, frame_gen, frames_count)


def make_fixture_benchmark(ffmpeg_exe: str, out_dir: str) -> None:
    """Fixture benchmark: 10 s (300 frames) 1080p clip to measure runtime and peak RAM."""
    mp4_path = os.path.join(out_dir, "fixture_benchmark_10s.mp4")
    frames_count = 300  # 10.0 s

    def frame_gen():
        for i in range(frames_count):
            frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
            draw_background_and_stand(frame)

            t = i / FPS
            dx = 15.0 * math.sin(2.0 * math.pi * t / 3.0)
            dy = 8.0 * math.cos(2.0 * math.pi * t / 2.5)

            corners = np.float32([
                [BASE_TL[0] + dx, BASE_TL[1] + dy],
                [BASE_TR[0] + dx, BASE_TR[1] + dy],
                [BASE_BR[0] + dx, BASE_BR[1] + dy],
                [BASE_BL[0] + dx, BASE_BL[1] + dy],
            ])

            cv2.fillConvexPoly(frame, np.int32(corners), COLOR_CREAM_PAGE)
            draw_spiral_binding(frame, tuple(corners[0]), tuple(corners[1]))
            yield frame

    encode_video_with_audio(ffmpeg_exe, mp4_path, frame_gen, frames_count)


def generate_all_fixtures(ffmpeg_exe: str, out_dir: str, include_benchmark: bool = True) -> None:
    os.makedirs(out_dir, exist_ok=True)
    artwork_path = os.path.join(out_dir, "artwork.png")
    generate_artwork(artwork_path)

    make_fixture_a(ffmpeg_exe, out_dir)
    make_fixture_b(ffmpeg_exe, out_dir)
    make_fixture_c(ffmpeg_exe, out_dir)
    make_fixture_d(ffmpeg_exe, out_dir)
    make_fixture_e(ffmpeg_exe, out_dir)

    if include_benchmark:
        make_fixture_benchmark(ffmpeg_exe, out_dir)


def main() -> None:
    parser = argparse.ArgumentParser(description="Synthetic fixture generator for Calendar Compositor")
    parser.add_argument("--ffmpeg", default=DEFAULT_FFMPEG, help="Path to ffmpeg executable")
    parser.add_argument("--output-dir", default=os.path.dirname(os.path.abspath(__file__)), help="Output directory")
    parser.add_argument("--skip-benchmark", action="store_true", help="Skip 10s benchmark video")
    args = parser.parse_args()

    generate_all_fixtures(args.ffmpeg, args.output_dir, include_benchmark=not args.skip_benchmark)
    print("All fixtures generated successfully.")


if __name__ == "__main__":
    main()
