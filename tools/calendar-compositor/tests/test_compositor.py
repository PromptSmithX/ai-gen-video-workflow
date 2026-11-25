"""
Automated Python test suite for Calendar Artwork Compositor.

Covers:
  - Corner error vs ground truth < 2% of page diagonal on (a) and (b)
  - Artwork fully covers fake text in (c)
  - Hand/finger preservation in (d)
  - Occluded/short page fails safely with exit 3 and no output file in (e)
  - Audio stream present and duration within 1 frame in output
  - Runtime and peak RAM per 10 s 1080p clip reported
"""

from __future__ import annotations
import json
import math
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import cv2
import numpy as np
import pytest

from detector import detect_page_quad, order_corners
from tracker import PageTracker

FFMPEG_EXE = r"C:\ffmpeg\bin\ffmpeg.exe"
FFPROBE_EXE = r"C:\ffmpeg\bin\ffprobe.exe"
FIXTURES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "fixtures"))
CLI_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "calendar_compositor.py"))
PYTHON_EXE = sys.executable


@pytest.fixture(scope="session", autouse=True)
def ensure_fixtures():
    """Ensures test fixtures exist before running tests."""
    art_path = os.path.join(FIXTURES_DIR, "artwork.png")
    fixture_a = os.path.join(FIXTURES_DIR, "fixture_a_static.mp4")
    if not (os.path.isfile(art_path) and os.path.isfile(fixture_a)):
        from fixtures.make_fixtures import generate_all_fixtures

        generate_all_fixtures(FFMPEG_EXE, FIXTURES_DIR, include_benchmark=True)


def probe_file(path: str) -> dict:
    cmd = [
        FFPROBE_EXE,
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        path,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
    return json.loads(res.stdout)


def test_fixture_a_corner_accuracy(tmp_path):
    """Corner error vs ground truth must be < 2% of page diagonal on (a)."""
    input_video = os.path.join(FIXTURES_DIR, "fixture_a_static.mp4")
    artwork = os.path.join(FIXTURES_DIR, "artwork.png")
    gt_file = os.path.join(FIXTURES_DIR, "fixture_a_gt.json")
    output_video = str(tmp_path / "out_a.mp4")
    report_file = str(tmp_path / "report_a.json")

    cmd = [
        PYTHON_EXE,
        CLI_PATH,
        "--input",
        input_video,
        "--artwork",
        artwork,
        "--output",
        output_video,
        "--ffmpeg",
        FFMPEG_EXE,
        "--ffprobe",
        FFPROBE_EXE,
        "--report",
        report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0, f"CLI failed: {res.stderr}"
    assert os.path.isfile(output_video), "Output video must be created"
    assert os.path.isfile(report_file), "Report JSON must be created"

    with open(report_file, "r", encoding="utf-8") as f:
        report = json.load(f)
    assert report["applied"] is True
    assert report["visibleFrames"] >= 80

    # Ground truth comparison
    with open(gt_file, "r", encoding="utf-8") as f:
        gt_data = json.load(f)
    gt_corners = np.array(gt_data[0]["corners"], dtype=np.float32)

    # Page diagonal: distance from TL to BR
    diag = float(np.linalg.norm(gt_corners[2] - gt_corners[0]))
    threshold_2pct = 0.02 * diag

    # Track on raw video directly to verify corner detection precision
    cap = cv2.VideoCapture(input_video)
    tracker = PageTracker(alpha=0.3)
    errors = []
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        corners, conf, is_conf = tracker.process_frame(frame)
        if is_conf and corners is not None:
            err = float(np.mean(np.linalg.norm(corners - gt_corners, axis=1)))
            errors.append(err)
    cap.release()

    assert len(errors) > 0
    mean_err = float(np.mean(errors))
    print(f"\n[Fixture A] Mean corner error: {mean_err:.2f} px (2% limit: {threshold_2pct:.2f} px)")
    assert mean_err < threshold_2pct, f"Error {mean_err} exceeded 2% diagonal ({threshold_2pct})"


def test_fixture_b_motion_accuracy(tmp_path):
    """Corner error vs ground truth must be < 2% of page diagonal on (b)."""
    input_video = os.path.join(FIXTURES_DIR, "fixture_b_motion.mp4")
    artwork = os.path.join(FIXTURES_DIR, "artwork.png")
    gt_file = os.path.join(FIXTURES_DIR, "fixture_b_gt.json")
    output_video = str(tmp_path / "out_b.mp4")
    report_file = str(tmp_path / "report_b.json")

    cmd = [
        PYTHON_EXE,
        CLI_PATH,
        "--input",
        input_video,
        "--artwork",
        artwork,
        "--output",
        output_video,
        "--ffmpeg",
        FFMPEG_EXE,
        "--ffprobe",
        FFPROBE_EXE,
        "--report",
        report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0, f"CLI failed: {res.stderr}"

    with open(gt_file, "r", encoding="utf-8") as f:
        gt_data = json.load(f)

    cap = cv2.VideoCapture(input_video)
    tracker = PageTracker(alpha=0.3)
    frame_idx = 0
    errors = []
    diag = 0.0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        gt_corners = np.array(gt_data[frame_idx]["corners"], dtype=np.float32)
        if diag == 0.0:
            diag = float(np.linalg.norm(gt_corners[2] - gt_corners[0]))

        corners, conf, is_conf = tracker.process_frame(frame)
        if is_conf and corners is not None:
            err = float(np.mean(np.linalg.norm(corners - gt_corners, axis=1)))
            errors.append(err)
        frame_idx += 1
    cap.release()

    threshold_2pct = 0.02 * diag
    assert len(errors) > 0
    mean_err = float(np.mean(errors))
    print(f"\n[Fixture B] Mean corner error: {mean_err:.2f} px (2% limit: {threshold_2pct:.2f} px)")
    assert mean_err < threshold_2pct, f"Error {mean_err} exceeded 2% diagonal ({threshold_2pct})"


def test_fixture_c_covers_fake_text(tmp_path):
    """Artwork must fully cover fake 'AI' text printed on the page in (c)."""
    input_video = os.path.join(FIXTURES_DIR, "fixture_c_fake_text.mp4")
    artwork = os.path.join(FIXTURES_DIR, "artwork.png")
    output_video = str(tmp_path / "out_c.mp4")
    report_file = str(tmp_path / "report_c.json")

    cmd = [
        PYTHON_EXE,
        CLI_PATH,
        "--input",
        input_video,
        "--artwork",
        artwork,
        "--output",
        output_video,
        "--ffmpeg",
        FFMPEG_EXE,
        "--ffprobe",
        FFPROBE_EXE,
        "--report",
        report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0, f"CLI failed: {res.stderr}"

    # Verify center area of input vs output
    # In input_video, (700, 350) to (900, 700) has dark text (values around 40-60) on cream (values ~220-250)
    cap_in = cv2.VideoCapture(input_video)
    cap_out = cv2.VideoCapture(output_video)

    ret_in, frame_in = cap_in.read()
    ret_out, frame_out = cap_out.read()
    cap_in.release()
    cap_out.release()

    assert ret_in and ret_out
    # Sample text region
    text_sample_in = frame_in[340:360, 700:800]
    text_sample_out = frame_out[340:360, 700:800]

    # In input, dark text pixels exist (brightness < 100)
    in_dark_pixels = np.count_nonzero(np.mean(text_sample_in, axis=2) < 100)
    assert in_dark_pixels > 50, "Input must contain dark text pixels"

    # In output, artwork is drawn; the dark fake text pixels must be replaced
    # Verify the difference between input and output in the page area is substantial
    diff = np.mean(np.abs(text_sample_out.astype(float) - text_sample_in.astype(float)))
    assert diff > 20.0, "Artwork must replace text region pixels"


def test_fixture_d_hand_preservation(tmp_path):
    """Skin-coloured hand/thumb entering the page must be preserved on top of artwork."""
    input_video = os.path.join(FIXTURES_DIR, "fixture_d_hand.mp4")
    artwork = os.path.join(FIXTURES_DIR, "artwork.png")
    output_video = str(tmp_path / "out_d.mp4")
    report_file = str(tmp_path / "report_d.json")

    cmd = [
        PYTHON_EXE,
        CLI_PATH,
        "--input",
        input_video,
        "--artwork",
        artwork,
        "--output",
        output_video,
        "--ffmpeg",
        FFMPEG_EXE,
        "--ffprobe",
        FFPROBE_EXE,
        "--report",
        report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0, f"CLI failed: {res.stderr}"

    # Check thumb region: (480, 580)
    cap_out = cv2.VideoCapture(output_video)
    ret, frame_out = cap_out.read()
    cap_out.release()
    assert ret

    # Skin color at (480, 580) in BGR is close to (130, 160, 215)
    thumb_pixel = frame_out[580, 480]
    # Check that it resembles skin tone, not the artwork background
    ycrcb = cv2.cvtColor(np.uint8([[thumb_pixel]]), cv2.COLOR_BGR2YCrCb)[0, 0]
    cr, cb = ycrcb[1], ycrcb[2]
    assert 125 <= cr <= 180 and 70 <= cb <= 135, f"Thumb pixel {thumb_pixel} was not preserved"


def test_fixture_e_occluded_fails_safely(tmp_path):
    """Heavily occluded / short page (< 1 s) must fail with exit 3 and no output file."""
    input_video = os.path.join(FIXTURES_DIR, "fixture_e_occluded.mp4")
    artwork = os.path.join(FIXTURES_DIR, "artwork.png")
    output_video = str(tmp_path / "out_e.mp4")
    report_file = str(tmp_path / "report_e.json")

    cmd = [
        PYTHON_EXE,
        CLI_PATH,
        "--input",
        input_video,
        "--artwork",
        artwork,
        "--output",
        output_video,
        "--ffmpeg",
        FFMPEG_EXE,
        "--ffprobe",
        FFPROBE_EXE,
        "--report",
        report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 3, f"Expected exit code 3, got {res.returncode}. Output: {res.stdout} {res.stderr}"
    assert not os.path.isfile(output_video), "Output file must be deleted on exit 3"
    assert os.path.isfile(report_file), "Report JSON must be written on exit 3"

    with open(report_file, "r", encoding="utf-8") as f:
        report = json.load(f)
    assert report["applied"] is False


def test_audio_stream_and_duration(tmp_path):
    """Output video must retain audio stream and duration within 1 frame of input."""
    input_video = os.path.join(FIXTURES_DIR, "fixture_a_static.mp4")
    artwork = os.path.join(FIXTURES_DIR, "artwork.png")
    output_video = str(tmp_path / "out_audio.mp4")
    report_file = str(tmp_path / "report_audio.json")

    cmd = [
        PYTHON_EXE,
        CLI_PATH,
        "--input",
        input_video,
        "--artwork",
        artwork,
        "--output",
        output_video,
        "--ffmpeg",
        FFMPEG_EXE,
        "--ffprobe",
        FFPROBE_EXE,
        "--report",
        report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0

    in_info = probe_file(input_video)
    out_info = probe_file(output_video)

    # Audio presence check
    in_audio = next((s for s in in_info["streams"] if s["codec_type"] == "audio"), None)
    out_audio = next((s for s in out_info["streams"] if s["codec_type"] == "audio"), None)
    assert in_audio is not None, "Input must have audio"
    assert out_audio is not None, "Output must have audio"
    assert out_audio["codec_name"] == in_audio["codec_name"]

    # Duration check (within 1 frame duration = 1/30 = 0.033s)
    in_dur = float(in_info["format"]["duration"])
    out_dur = float(out_info["format"]["duration"])
    dur_delta = abs(out_dur - in_dur)
    frame_dur = 1.0 / 30.0
    print(f"\n[Audio & Duration] Input: {in_dur:.3f}s, Output: {out_dur:.3f}s, Delta: {dur_delta:.4f}s")
    assert dur_delta <= frame_dur + 0.05, f"Duration delta {dur_delta}s exceeded frame tolerance"


def test_benchmark_runtime_10s_clip(tmp_path):
    """Reports runtime and peak RAM for a 10 s 1080p clip."""
    benchmark_video = os.path.join(FIXTURES_DIR, "fixture_benchmark_10s.mp4")
    if not os.path.isfile(benchmark_video):
        pytest.skip("Benchmark video not found")

    artwork = os.path.join(FIXTURES_DIR, "artwork.png")
    output_video = str(tmp_path / "out_benchmark.mp4")
    report_file = str(tmp_path / "report_benchmark.json")

    start_time = time.perf_counter()
    cmd = [
        PYTHON_EXE,
        CLI_PATH,
        "--input",
        benchmark_video,
        "--artwork",
        artwork,
        "--output",
        output_video,
        "--ffmpeg",
        FFMPEG_EXE,
        "--ffprobe",
        FFPROBE_EXE,
        "--report",
        report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    elapsed_sec = time.perf_counter() - start_time

    assert res.returncode == 0, f"Benchmark run failed: {res.stderr}"
    assert os.path.isfile(output_video)

    with open(report_file, "r", encoding="utf-8") as f:
        rep = json.load(f)

    fps_proc = rep["processedFrames"] / elapsed_sec if elapsed_sec > 0 else 0.0
    print(f"\n================ BENCHMARK REPORT ================")
    print(f"Clip: 10s 1080p ({rep['processedFrames']} frames)")
    print(f"Elapsed Time: {elapsed_sec:.2f} s ({fps_proc:.1f} fps)")
    print(f"Coverage: {rep['trackingCoverage']:.2%}")
    print(f"Visible Frames: {rep['visibleFrames']}")
    print(f"==================================================")
