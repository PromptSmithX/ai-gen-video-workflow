"""Open-page segment planning: decides, before any frame is encoded, which frames get artwork.

Pass 1 of the compositor records the verified page corners per frame (or None). This module then
  1. bridges short detection gaps by interpolating corners (no visible flicker on a steady page),
  2. drops short isolated runs (spurious detections must not flash artwork),
  3. measures the open-page segment for the quality gate.
A real review only shows the blank page for part of the clip (cover first, page turn, then the page), so the
gate looks at the longest continuous open-page run, never at the fraction of the whole video.
"""

from __future__ import annotations
from dataclasses import dataclass
import numpy as np

Corners = np.ndarray  # (4, 2) float32: TL, TR, BR, BL


@dataclass
class SegmentPlan:
    corners: list[Corners | None]
    longest_run: int
    span_start: int
    span_end: int  # inclusive; -1 when nothing kept
    visible: int

    @property
    def span_length(self) -> int:
        return 0 if self.span_end < self.span_start else self.span_end - self.span_start + 1

    @property
    def span_coverage(self) -> float:
        """Visible frames / frames between the first and last kept page frame."""
        return self.visible / self.span_length if self.span_length > 0 else 0.0


def _runs(flags: list[bool]) -> list[tuple[int, int]]:
    """Inclusive (start, end) index pairs of consecutive True values."""
    runs: list[tuple[int, int]] = []
    start = -1
    for i, f in enumerate(flags):
        if f and start < 0:
            start = i
        elif not f and start >= 0:
            runs.append((start, i - 1))
            start = -1
    if start >= 0:
        runs.append((start, len(flags) - 1))
    return runs


def plan_segments(
    frame_corners: list[Corners | None],
    fps: float,
    frame_w: int,
    frame_h: int,
    max_gap_s: float = 0.25,
    min_run_s: float = 0.5,
    max_jump_per_frame: float = 0.04,
) -> SegmentPlan:
    corners: list[Corners | None] = [None if c is None else np.asarray(c, dtype=np.float32) for c in frame_corners]
    diag = float(np.hypot(frame_w, frame_h))
    max_gap = max(1, int(round(max_gap_s * fps)))
    min_run = max(1, int(round(min_run_s * fps)))

    # 1. Bridge short gaps between two nearby detections (the page did not move much).
    idx = [i for i, c in enumerate(corners) if c is not None]
    for a, b in zip(idx, idx[1:]):
        gap = b - a - 1
        if gap <= 0 or gap > max_gap:
            continue
        ca, cb = corners[a], corners[b]
        assert ca is not None and cb is not None
        # The page may move while detection drops out; allow a displacement proportional to the gap length.
        if float(np.mean(np.linalg.norm(ca - cb, axis=1))) > max_jump_per_frame * (gap + 1) * diag:
            continue
        for k in range(1, gap + 1):
            t = k / (gap + 1)
            corners[a + k] = ((1.0 - t) * ca + t * cb).astype(np.float32)

    # 2. Drop short isolated runs.
    for start, end in _runs([c is not None for c in corners]):
        if end - start + 1 < min_run:
            for i in range(start, end + 1):
                corners[i] = None

    kept = _runs([c is not None for c in corners])
    if not kept:
        return SegmentPlan(corners=corners, longest_run=0, span_start=0, span_end=-1, visible=0)
    longest = max(end - start + 1 for start, end in kept)
    visible = sum(end - start + 1 for start, end in kept)
    return SegmentPlan(
        corners=corners,
        longest_run=longest,
        span_start=kept[0][0],
        span_end=kept[-1][1],
        visible=visible,
    )


__all__ = ["SegmentPlan", "plan_segments"]
