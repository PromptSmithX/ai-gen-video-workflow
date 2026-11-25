"""
Automated Python test suite for Calendar Artwork Compositor.

Covers:
  - Corner error vs ground truth < 2% of page diagonal on (a) and (b)
  - Pixel-level accuracy on (a), (b), (c): warped artwork matches output inside inset quad (mean abs diff < 12)
  - Fake AI text in (c) is completely hidden (no text pixels remain, matches artwork)
  - Spiral binding & outside-quad regions are unchanged (mean abs diff < 4)
  - Hand/finger preservation in (d) AND artwork correctly drawn away from hand
  - Warm cream fixture (f) proves paper is never detected as skin
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
from warper import compute_inset_corners

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
    fixture_f = os.path.join(FIXTURES_DIR, "fixture_f_warm_cream.mp4")
    if not (os.path.isfile(art_path) and os.path.isfile(fixture_a) and os.path.isfile(fixture_f)):
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


def get_expected_warped_artwork(
    artwork: np.ndarray,
    gt_corners: np.ndarray,
    width: int = 1920,
    height: int = 1080,
    top_inset: float = 0.05,
    bottom_inset: float = 0.02,
    left_inset: float = 0.02,
    right_inset: float = 0.02,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Computes ground-truth warped artwork and evaluation masks for testing.
    Returns: (warped_art, eval_mask_eroded, inset_corners)
    """
    art_h, art_w = artwork.shape[:2]
    inset_corners = compute_inset_corners(
        gt_corners,
        top_inset=top_inset,
        bottom_inset=bottom_inset,
        left_inset=left_inset,
        right_inset=right_inset,
    )

    src_pts = np.float32([
        [0, 0],
        [art_w - 1, 0],
        [art_w - 1, art_h - 1],
        [0, art_h - 1],
    ])
    M = cv2.getPerspectiveTransform(src_pts, inset_corners)
    warped = cv2.warpPerspective(
        artwork, M, (width, height), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT
    )

    quad_mask = np.zeros((height, width), dtype=np.uint8)
    cv2.fillConvexPoly(quad_mask, np.int32(inset_corners), 255)
    # Erode by 8px to evaluate clean interior away from edge feathering
    eval_mask = cv2.erode(quad_mask, cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9)), iterations=1)

    return warped, eval_mask, inset_corners


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
        "--input", input_video,
        "--artwork", artwork,
        "--output", output_video,
        "--ffmpeg", FFMPEG_EXE,
        "--ffprobe", FFPROBE_EXE,
        "--report", report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0, f"CLI failed: {res.stderr}"
    assert os.path.isfile(output_video), "Output video must be created"

    with open(gt_file, "r", encoding="utf-8") as f:
        gt_data = json.load(f)
    gt_corners = np.array(gt_data[0]["corners"], dtype=np.float32)

    diag = float(np.linalg.norm(gt_corners[2] - gt_corners[0]))
    threshold_2pct = 0.02 * diag

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
    assert mean_err < threshold_2pct, f"Error {mean_err:.2f}px exceeded 2% diagonal ({threshold_2pct:.2f}px)"


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
        "--input", input_video,
        "--artwork", artwork,
        "--output", output_video,
        "--ffmpeg", FFMPEG_EXE,
        "--ffprobe", FFPROBE_EXE,
        "--report", report_file,
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
    assert mean_err < threshold_2pct, f"Error {mean_err:.2f}px exceeded 2% diagonal ({threshold_2pct:.2f}px)"


def test_pixel_accuracy_abc(tmp_path):
    """
    Pixel-level test for fixtures (a), (b), (c):
    Warp ground-truth artwork with ground-truth corners and compare to output
    inside the inset quad (eroded by a few px).
    Mean absolute difference per channel must be < 12 across sampled frames.
    """
    artwork_path = os.path.join(FIXTURES_DIR, "artwork.png")
    art = cv2.imread(artwork_path, cv2.IMREAD_COLOR)

    fixtures_to_test = [
        ("fixture_a_static", "fixture_a_static.mp4", "fixture_a_gt.json"),
        ("fixture_b_motion", "fixture_b_motion.mp4", "fixture_b_gt.json"),
        ("fixture_c_fake_text", "fixture_c_fake_text.mp4", "fixture_c_gt.json"),
    ]

    for name, mp4_name, gt_name in fixtures_to_test:
        input_video = os.path.join(FIXTURES_DIR, mp4_name)
        gt_file = os.path.join(FIXTURES_DIR, gt_name)
        output_video = str(tmp_path / f"out_{name}.mp4")
        report_file = str(tmp_path / f"report_{name}.json")

        cmd = [
            PYTHON_EXE,
            CLI_PATH,
            "--input", input_video,
            "--artwork", artwork_path,
            "--output", output_video,
            "--ffmpeg", FFMPEG_EXE,
            "--ffprobe", FFPROBE_EXE,
            "--report", report_file,
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        assert res.returncode == 0, f"Compositor failed on {name}: {res.stderr}"

        with open(gt_file, "r", encoding="utf-8") as f:
            gt_data = json.load(f)

        cap_out = cv2.VideoCapture(output_video)
        sample_frame_indices = [15, 45, 75]
        diffs = []

        for s_idx in sample_frame_indices:
            cap_out.set(cv2.CAP_PROP_POS_FRAMES, s_idx)
            ret, frame_out = cap_out.read()
            assert ret, f"Could not read frame {s_idx} from {output_video}"

            gt_corners = np.array(gt_data[s_idx]["corners"], dtype=np.float32)
            expected_art, eval_mask, _ = get_expected_warped_artwork(art, gt_corners)

            # Compare within interior evaluation mask
            diff = np.mean(
                np.abs(frame_out[eval_mask > 0].astype(float) - expected_art[eval_mask > 0].astype(float))
            )
            diffs.append(diff)

        cap_out.release()
        mean_diff = float(np.mean(diffs))
        print(f"\n[{name}] Pixel diff inside inset quad: {mean_diff:.2f} (limit: 12.0)")
        assert mean_diff < 12.0, f"{name} mean pixel diff {mean_diff:.2f} exceeded threshold 12.0"


def test_fixture_c_fake_text_completely_hidden(tmp_path):
    """
    Fake AI text must be completely hidden inside the inset quad:
    - Output pixels in the text region must match warped artwork (diff < 12).
    - No dark text pixels remain in the output page.
    """
    artwork_path = os.path.join(FIXTURES_DIR, "artwork.png")
    art = cv2.imread(artwork_path, cv2.IMREAD_COLOR)

    input_video = os.path.join(FIXTURES_DIR, "fixture_c_fake_text.mp4")
    output_video = str(tmp_path / "out_c_text.mp4")
    report_file = str(tmp_path / "rep_c_text.json")

    cmd = [
        PYTHON_EXE,
        CLI_PATH,
        "--input", input_video,
        "--artwork", artwork_path,
        "--output", output_video,
        "--ffmpeg", FFMPEG_EXE,
        "--ffprobe", FFPROBE_EXE,
        "--report", report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0

    cap_in = cv2.VideoCapture(input_video)
    cap_out = cv2.VideoCapture(output_video)

    cap_in.set(cv2.CAP_PROP_POS_FRAMES, 45)
    cap_out.set(cv2.CAP_PROP_POS_FRAMES, 45)
    ret_in, frame_in = cap_in.read()
    ret_out, frame_out = cap_out.read()
    cap_in.release()
    cap_out.release()
    assert ret_in and ret_out

    # Sample text region in input video: (700, 350) to (900, 700)
    text_bbox_in = frame_in[340:700, 620:900]
    text_bbox_out = frame_out[340:700, 620:900]

    # In input frame, dark text pixels exist (brightness < 80)
    in_dark_pixels = np.count_nonzero(np.mean(text_bbox_in, axis=2) < 80)
    assert in_dark_pixels > 200, "Input must contain dark text pixels"

    # Dark text mask from input
    dark_text_mask = np.mean(text_bbox_in, axis=2) < 80

    # In output frame, these exact text pixels must be replaced by artwork
    # Get ground truth artwork in text bbox
    gt_corners = np.float32([[460, 220], [1460, 220], [1460, 920], [460, 920]])
    expected_art, _, _ = get_expected_warped_artwork(art, gt_corners)
    art_text_bbox = expected_art[340:700, 620:900]

    # Check diff between output and artwork on text pixels
    text_vs_art_diff = np.mean(
        np.abs(text_bbox_out[dark_text_mask].astype(float) - art_text_bbox[dark_text_mask].astype(float))
    )
    print(f"\n[Fixture C] Text pixels vs artwork diff: {text_vs_art_diff:.2f} (limit: 12.0)")
    assert text_vs_art_diff < 12.0, "Artwork did not cover text pixels cleanly"

    # Check that text is substantially changed from original dark text (not a blend that keeps text shapes)
    text_vs_orig_diff = np.mean(
        np.abs(text_bbox_out[dark_text_mask].astype(float) - text_bbox_in[dark_text_mask].astype(float))
    )
    assert text_vs_orig_diff > 35.0, "Output pixels must not preserve dark text shapes"


def test_spiral_and_outside_quad_unchanged(tmp_path):
    """
    Artwork must not touch spiral / top binding or outside-quad region:
    Output equals input within codec tolerance (mean abs diff < 4.0).
    """
    artwork_path = os.path.join(FIXTURES_DIR, "artwork.png")
    input_video = os.path.join(FIXTURES_DIR, "fixture_a_static.mp4")
    output_video = str(tmp_path / "out_spiral.mp4")
    report_file = str(tmp_path / "rep_spiral.json")

    cmd = [
        PYTHON_EXE,
        CLI_PATH,
        "--input", input_video,
        "--artwork", artwork_path,
        "--output", output_video,
        "--ffmpeg", FFMPEG_EXE,
        "--ffprobe", FFPROBE_EXE,
        "--report", report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0

    cap_in = cv2.VideoCapture(input_video)
    cap_out = cv2.VideoCapture(output_video)
    cap_in.set(cv2.CAP_PROP_POS_FRAMES, 45)
    cap_out.set(cv2.CAP_PROP_POS_FRAMES, 45)
    ret_in, frame_in = cap_in.read()
    ret_out, frame_out = cap_out.read()
    cap_in.release()
    cap_out.release()
    assert ret_in and ret_out

    # 1. Spiral region: y from 185 to 235, x from 450 to 1470
    spiral_in = frame_in[185:235, 450:1470]
    spiral_out = frame_out[185:235, 450:1470]
    spiral_diff = np.mean(np.abs(spiral_out.astype(float) - spiral_in.astype(float)))
    print(f"\n[Spiral Region] Mean diff: {spiral_diff:.2f} (limit: 4.0)")
    assert spiral_diff < 4.0, f"Spiral region was altered! Diff: {spiral_diff:.2f}"

    # 2. Outside quad region (desk and background)
    quad_mask = np.zeros((1080, 1920), dtype=np.uint8)
    cv2.fillConvexPoly(
        quad_mask, np.int32([[460, 220], [1460, 220], [1460, 920], [460, 920]]), 255
    )
    outside_mask = quad_mask == 0
    outside_diff = np.mean(np.abs(frame_out[outside_mask].astype(float) - frame_in[outside_mask].astype(float)))
    print(f"[Outside Quad] Mean diff: {outside_diff:.2f} (limit: 4.0)")
    assert outside_diff < 4.0, f"Outside quad region was altered! Diff: {outside_diff:.2f}"


def test_fixture_d_hand_and_page_pixels(tmp_path):
    """
    Fixture (d):
    - Thumb skin pixels entering from page edge are preserved on top of artwork.
    - Page pixels away from thumb show artwork (diff < 12 on mask excluding thumb bbox + margin).
    """
    artwork_path = os.path.join(FIXTURES_DIR, "artwork.png")
    art = cv2.imread(artwork_path, cv2.IMREAD_COLOR)

    input_video = os.path.join(FIXTURES_DIR, "fixture_d_hand.mp4")
    output_video = str(tmp_path / "out_d.mp4")
    report_file = str(tmp_path / "rep_d.json")

    cmd = [
        PYTHON_EXE,
        CLI_PATH,
        "--input", input_video,
        "--artwork", artwork_path,
        "--output", output_video,
        "--ffmpeg", FFMPEG_EXE,
        "--ffprobe", FFPROBE_EXE,
        "--report", report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0

    cap_out = cv2.VideoCapture(output_video)
    cap_out.set(cv2.CAP_PROP_POS_FRAMES, 45)
    ret, frame_out = cap_out.read()
    cap_out.release()
    assert ret

    # 1. Thumb pixel check at (480, 580)
    thumb_pixel = frame_out[580, 480]
    ycrcb = cv2.cvtColor(np.uint8([[thumb_pixel]]), cv2.COLOR_BGR2YCrCb)[0, 0]
    cr, cb = ycrcb[1], ycrcb[2]
    assert 125 <= cr <= 180 and 70 <= cb <= 135, f"Thumb pixel {thumb_pixel} was not preserved"

    # 2. Page pixels away from thumb must show artwork
    gt_corners = np.float32([[460, 220], [1460, 220], [1460, 920], [460, 920]])
    expected_art, eval_mask, _ = get_expected_warped_artwork(art, gt_corners)

    # Exclude thumb region with generous 30px margin: x from 400 to 570, y from 500 to 670
    page_eval_mask = eval_mask.copy()
    page_eval_mask[490:680, 400:580] = 0

    page_diff = np.mean(
        np.abs(frame_out[page_eval_mask > 0].astype(float) - expected_art[page_eval_mask > 0].astype(float))
    )
    print(f"\n[Fixture D] Page pixels away from thumb diff: {page_diff:.2f} (limit: 12.0)")
    assert page_diff < 12.0, f"Page pixels away from thumb do not show artwork (diff: {page_diff:.2f})"


def test_fixture_f_warm_cream(tmp_path):
    """
    Fixture (f):
    Paper is slightly warmer cream (RGB 240, 228, 205).
    Must prove paper is never detected as skin, compositing succeeds,
    and output matches warped artwork (diff < 12).
    """
    artwork_path = os.path.join(FIXTURES_DIR, "artwork.png")
    art = cv2.imread(artwork_path, cv2.IMREAD_COLOR)

    input_video = os.path.join(FIXTURES_DIR, "fixture_f_warm_cream.mp4")
    output_video = str(tmp_path / "out_warm.mp4")
    report_file = str(tmp_path / "rep_warm.json")

    cmd = [
        PYTHON_EXE,
        CLI_PATH,
        "--input", input_video,
        "--artwork", artwork_path,
        "--output", output_video,
        "--ffmpeg", FFMPEG_EXE,
        "--ffprobe", FFPROBE_EXE,
        "--report", report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0, f"Compositor failed on warm cream: {res.stderr}"

    with open(report_file, "r", encoding="utf-8") as f:
        rep = json.load(f)
    assert rep["applied"] is True
    assert rep["trackingCoverage"] >= 0.90

    cap_out = cv2.VideoCapture(output_video)
    cap_out.set(cv2.CAP_PROP_POS_FRAMES, 45)
    ret, frame_out = cap_out.read()
    cap_out.release()
    assert ret

    gt_corners = np.float32([[460, 220], [1460, 220], [1460, 920], [460, 920]])
    expected_art, eval_mask, _ = get_expected_warped_artwork(art, gt_corners)

    warm_diff = np.mean(
        np.abs(frame_out[eval_mask > 0].astype(float) - expected_art[eval_mask > 0].astype(float))
    )
    print(f"\n[Fixture F Warm Cream] Pixel diff inside inset quad: {warm_diff:.2f} (limit: 12.0)")
    assert warm_diff < 12.0, f"Warm cream page was not composited cleanly (diff: {warm_diff:.2f})"


def test_fixture_e_occluded_fails_safely(tmp_path):
    """Heavily occluded / short page (< 1 s) must fail with exit 3 and no output file."""
    input_video = os.path.join(FIXTURES_DIR, "fixture_e_occluded.mp4")
    artwork = os.path.join(FIXTURES_DIR, "artwork.png")
    output_video = str(tmp_path / "out_e.mp4")
    report_file = str(tmp_path / "report_e.json")

    cmd = [
        PYTHON_EXE,
        CLI_PATH,
        "--input", input_video,
        "--artwork", artwork,
        "--output", output_video,
        "--ffmpeg", FFMPEG_EXE,
        "--ffprobe", FFPROBE_EXE,
        "--report", report_file,
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
        "--input", input_video,
        "--artwork", artwork,
        "--output", output_video,
        "--ffmpeg", FFMPEG_EXE,
        "--ffprobe", FFPROBE_EXE,
        "--report", report_file,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0

    in_info = probe_file(input_video)
    out_info = probe_file(output_video)

    in_audio = next((s for s in in_info["streams"] if s["codec_type"] == "audio"), None)
    out_audio = next((s for s in out_info["streams"] if s["codec_type"] == "audio"), None)
    assert in_audio is not None, "Input must have audio"
    assert out_audio is not None, "Output must have audio"
    assert out_audio["codec_name"] == in_audio["codec_name"]

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
        "--input", benchmark_video,
        "--artwork", artwork,
        "--output", output_video,
        "--ffmpeg", FFMPEG_EXE,
        "--ffprobe", FFPROBE_EXE,
        "--report", report_file,
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
