"""Fast unit tests (no video): open-page segment planning, blank-page check, size-jump guard, and an optional
regression run on a real Muse calendar video (set CAL_REAL_VIDEO to its path; skipped otherwise)."""

from __future__ import annotations
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import cv2
import numpy as np
import pytest

from detector import BLANK_MIN_FRACTION, page_blank_fraction, page_is_blank
from segments import plan_segments
from tracker import PageTracker

W, H, FPS = 1000, 800, 24.0
QUAD = np.array([[200, 200], [800, 200], [800, 600], [200, 600]], dtype=np.float32)


def _q(dx: float = 0.0) -> np.ndarray:
    return QUAD + np.array([dx, 0], dtype=np.float32)


# ---------- plan_segments ----------

def test_open_page_at_end_of_clip_passes_gate_metrics() -> None:
    # 10 s clip, page visible only in the last 3 s: the old "60% of the whole video" rule rejected this.
    frames = [None] * 168 + [_q() for _ in range(72)]
    plan = plan_segments(frames, FPS, W, H)
    assert plan.longest_run == 72
    assert plan.span_coverage == 1.0
    assert plan.span_start == 168 and plan.span_end == 239


def test_short_gap_is_bridged_by_interpolation() -> None:
    frames = [_q(0)] * 20 + [None, None, None] + [_q(9)] * 20
    plan = plan_segments(frames, FPS, W, H)
    assert all(c is not None for c in plan.corners)
    mid = plan.corners[21]
    assert mid is not None and 0 < float(mid[0][0] - QUAD[0][0]) < 9
    assert plan.longest_run == 43


def test_gap_with_big_jump_is_not_bridged() -> None:
    frames = [_q(0)] * 20 + [None] + [_q(300)] * 20
    plan = plan_segments(frames, FPS, W, H)
    assert plan.corners[20] is None
    assert plan.longest_run == 20


def test_long_gap_is_not_bridged() -> None:
    frames = [_q()] * 20 + [None] * 30 + [_q()] * 20
    plan = plan_segments(frames, FPS, W, H)
    assert plan.longest_run == 20
    assert plan.span_coverage == pytest.approx(40 / 70)


def test_short_isolated_runs_are_dropped() -> None:
    # A 4-frame false positive early in the clip must not flash artwork.
    frames = [None] * 10 + [_q()] * 4 + [None] * 100 + [_q()] * 50
    plan = plan_segments(frames, FPS, W, H)
    assert all(c is None for c in plan.corners[:114])
    assert plan.span_start == 114 and plan.visible == 50


def test_nothing_detected() -> None:
    plan = plan_segments([None] * 50, FPS, W, H)
    assert plan.longest_run == 0 and plan.visible == 0 and plan.span_coverage == 0.0


# ---------- blank page check ----------

def _frame(page_bgr: tuple[int, int, int], printed: bool = False) -> np.ndarray:
    f = np.full((H, W, 3), (40, 70, 30), dtype=np.uint8)  # dark green shirt-like background
    cv2.fillConvexPoly(f, np.int32(QUAD), page_bgr)
    if printed:
        rng = np.random.default_rng(1)
        for _ in range(400):
            x, y = int(rng.integers(220, 780)), int(rng.integers(220, 580))
            color = tuple(int(v) for v in rng.integers(0, 255, 3))
            cv2.circle(f, (x, y), int(rng.integers(5, 25)), color, -1)
    return f


def test_blank_cream_page_is_blank() -> None:
    f = _frame((205, 228, 240))  # warm cream (BGR)
    assert page_blank_fraction(f, QUAD) > 0.95
    assert page_is_blank(f, QUAD)


def test_page_with_sparse_dark_text_still_counts_as_blank() -> None:
    # Fake AI text on the page must still be covered by the artwork.
    f = _frame((235, 240, 243))
    for row in range(260, 560, 40):
        cv2.putText(f, "JAN 2027 1 2 3 4 5 6 7", (230, row), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (40, 40, 40), 1)
    assert page_is_blank(f, QUAD)


def test_printed_colourful_cover_is_not_blank() -> None:
    f = _frame((205, 228, 240), printed=True)
    assert page_blank_fraction(f, QUAD) < BLANK_MIN_FRACTION


def test_dark_clothing_is_not_blank() -> None:
    f = np.full((H, W, 3), (40, 70, 30), dtype=np.uint8)
    assert not page_is_blank(f, QUAD)


def test_hand_pixels_are_excluded() -> None:
    f = _frame((205, 228, 240))
    hand = np.zeros((H, W), dtype=np.uint8)
    cv2.rectangle(f, (200, 350), (420, 600), (120, 150, 210), -1)  # skin-ish block
    cv2.rectangle(hand, (200, 350), (420, 600), 255, -1)
    assert page_blank_fraction(f, QUAD, hand) > 0.95


# ---------- tracker size-jump guard ----------

def test_tracker_ignores_sudden_page_size_jump() -> None:
    # Page held steady, then for a few frames the detector merges it with a pale wall into a much larger blob.
    big = np.array([[150, 200], [850, 200], [850, 750], [150, 750]], dtype=np.float32)
    page = np.full((H, W, 3), (40, 70, 30), dtype=np.uint8)
    cv2.fillConvexPoly(page, np.int32(big), (205, 228, 240))
    t = PageTracker(alpha=0.3)
    for _ in range(5):
        c, _, ok = t.process_frame(page)
        assert ok and c is not None
    merged = page.copy()
    merged[0:300, 0:W] = (205, 228, 240)  # pale wall merging with the page top
    for _ in range(3):
        c, _, ok = t.process_frame(merged)
        if ok and c is not None:
            assert cv2.contourArea(c) < 1.3 * cv2.contourArea(big)


# ---------- optional real-video regression ----------

REAL_VIDEO = os.environ.get("CAL_REAL_VIDEO", "")
REAL_ARTWORK = os.environ.get("CAL_REAL_ARTWORK", "")


@pytest.mark.skipif(not (os.path.isfile(REAL_VIDEO) and os.path.isfile(REAL_ARTWORK)), reason="CAL_REAL_VIDEO not set")
def test_real_muse_video(tmp_path) -> None:
    cli = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "calendar_compositor.py"))
    out = str(tmp_path / "out.part")  # the app writes a .part temp file
    rep = str(tmp_path / "rep.json")
    res = subprocess.run(
        [sys.executable, cli, "--input", REAL_VIDEO, "--artwork", REAL_ARTWORK, "--output", out,
         "--ffmpeg", r"C:\ffmpeg\bin\ffmpeg.exe", "--ffprobe", r"C:\ffmpeg\bin\ffprobe.exe", "--report", rep],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    assert res.returncode == 0, res.stderr
    report = json.load(open(rep, encoding="utf-8"))
    assert report["applied"] is True
    # Artwork only on the open page (last ~3 s of a 10 s clip), never on the front cover earlier.
    assert report["visibleFrames"] < 0.5 * report["processedFrames"]
    assert os.path.getsize(out) > 0


# ---------- non-ASCII paths (videos live under e.g. "output\2026-11\Hỏi đáp\") ----------

FFMPEG = r"C:\ffmpeg\bin\ffmpeg.exe"
FFPROBE = r"C:\ffmpeg\bin\ffprobe.exe"


@pytest.mark.skipif(not (os.path.isfile(FFMPEG) and os.path.isfile(FFPROBE)), reason="ffmpeg not installed")
def test_probe_video_handles_vietnamese_path(tmp_path) -> None:
    from calendar_compositor import probe_video

    folder = tmp_path / "Hỏi đáp"
    folder.mkdir()
    video = str(folder / "lịch.mp4")
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=1",
                    "-pix_fmt", "yuv420p", video], check=True)
    probe = probe_video(FFPROBE, video)
    assert probe is not None and probe["width"] == 320 and probe["height"] == 240
