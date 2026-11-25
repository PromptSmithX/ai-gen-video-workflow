"""
Generates a side-by-side Before/After visual comparison frame grid for all test fixtures.
Saves a clear PNG at tools/calendar-compositor/comparison_grid.png.
"""

from __future__ import annotations
import os
import subprocess
import sys
import cv2
import numpy as np

FFMPEG_EXE = r"C:\ffmpeg\bin\ffmpeg.exe"
FFPROBE_EXE = r"C:\ffmpeg\bin\ffprobe.exe"
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
FIXTURES_DIR = os.path.join(BASE_DIR, "fixtures")
ARTWORK_PATH = os.path.join(FIXTURES_DIR, "artwork.png")
OUTPUT_GRID_PATH = os.path.join(BASE_DIR, "comparison_grid.png")


def run_cli_on_fixture(cli_path: str, input_video: str, output_video: str, report_json: str) -> bool:
    cmd = [
        cli_path if cli_path.endswith(".exe") else sys.executable,
    ]
    if not cli_path.endswith(".exe"):
        cmd.append(cli_path)
    cmd.extend([
        "--input", input_video,
        "--artwork", ARTWORK_PATH,
        "--output", output_video,
        "--ffmpeg", FFMPEG_EXE,
        "--ffprobe", FFPROBE_EXE,
        "--report", report_json,
    ])
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return res.returncode == 0


def extract_frame_at_sec(video_path: str, target_sec: float = 1.5) -> np.ndarray | None:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    target_frame = int(target_sec * fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
    ret, frame = cap.read()
    cap.release()
    return frame if ret else None


def label_frame(frame: np.ndarray, title: str, subtitle: str = "") -> np.ndarray:
    annotated = frame.copy()
    h, w = frame.shape[:2]
    # Header bar
    cv2.rectangle(annotated, (0, 0), (w, 60), (30, 30, 30), -1)
    cv2.putText(
        annotated,
        title,
        (20, 42),
        cv2.FONT_HERSHEY_DUPLEX,
        1.1,
        (255, 255, 255),
        2,
        cv2.LINE_AA,
    )
    if subtitle:
        cv2.putText(
            annotated,
            subtitle,
            (w - 450, 42),
            cv2.FONT_HERSHEY_DUPLEX,
            0.8,
            (180, 220, 255),
            1,
            cv2.LINE_AA,
        )
    return annotated


def generate_comparison_grid(cli_path: str, output_png: str = OUTPUT_GRID_PATH) -> str:
    temp_dir = os.path.join(BASE_DIR, ".tmp_grid")
    os.makedirs(temp_dir, exist_ok=True)

    fixtures = [
        ("Fixture A: Static Cream Page", "fixture_a_static.mp4"),
        ("Fixture B: Motion & Handheld Shake", "fixture_b_motion.mp4"),
        ("Fixture C: Fake AI Text (Hidden)", "fixture_c_fake_text.mp4"),
        ("Fixture D: Skin Hand / Thumb Preserved", "fixture_d_hand.mp4"),
        ("Fixture F: Warm Cream Page (RGB 240, 228, 205)", "fixture_f_warm_cream.mp4"),
    ]

    rows = []
    scale = 0.5  # 960x540 per frame -> row is 1920x540

    for label, filename in fixtures:
        input_mp4 = os.path.join(FIXTURES_DIR, filename)
        out_mp4 = os.path.join(temp_dir, f"out_{filename}")
        rep_json = os.path.join(temp_dir, f"rep_{filename}.json")

        success = run_cli_on_fixture(cli_path, input_mp4, out_mp4, rep_json)
        if not success or not os.path.isfile(out_mp4):
            print(f"Warning: Failed to run on {filename}")
            continue

        in_frame = extract_frame_at_sec(input_mp4, 1.5)
        out_frame = extract_frame_at_sec(out_mp4, 1.5)

        if in_frame is None or out_frame is None:
            continue

        labeled_in = label_frame(in_frame, f"{label} - INPUT", "@ 1.5s")
        labeled_out = label_frame(out_frame, f"{label} - OUTPUT", "Composited")

        small_in = cv2.resize(labeled_in, (int(1920 * scale), int(1080 * scale)))
        small_out = cv2.resize(labeled_out, (int(1920 * scale), int(1080 * scale)))

        row = np.hstack([small_in, small_out])
        rows.append(row)

    if not rows:
        raise RuntimeError("No comparison frames could be generated")

    grid = np.vstack(rows)
    cv2.imwrite(output_png, grid)
    print(f"Comparison grid saved to {output_png} ({grid.shape[1]}x{grid.shape[0]})")
    return output_png


if __name__ == "__main__":
    cli = sys.argv[1] if len(sys.argv) > 1 else os.path.join(BASE_DIR, "calendar_compositor.py")
    generate_comparison_grid(cli)
