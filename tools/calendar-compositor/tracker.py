"""Tracker module using Lucas-Kanade optical flow, RANSAC homography, and temporal smoothing."""

from __future__ import annotations
import cv2
import numpy as np
from detector import detect_page_quad, is_valid_quad, order_corners


def generate_grid_points(corners: np.ndarray, nx: int = 8, ny: int = 8) -> np.ndarray:
    """Generates a grid of interior points inside a quadrilateral via bilinear interpolation."""
    u = np.linspace(0.1, 0.9, nx)
    v = np.linspace(0.1, 0.9, ny)
    uu, vv = np.meshgrid(u, v)
    uu = uu.flatten()
    vv = vv.flatten()

    tl, tr, br, bl = corners
    pts = (
        (1 - uu)[:, None] * (1 - vv)[:, None] * tl
        + uu[:, None] * (1 - vv)[:, None] * tr
        + uu[:, None] * vv[:, None] * br
        + (1 - uu)[:, None] * vv[:, None] * bl
    )
    return pts.astype(np.float32).reshape(-1, 1, 2)


class PageTracker:
    """Tracks the calendar page corners across video frames with drift correction."""

    def __init__(self, alpha: float = 0.3, max_area_jump: float = 0.3, relock_frames: int = 12) -> None:
        self.alpha = alpha  # Smoothing factor for confident runs
        self.max_area_jump = max_area_jump
        self.relock_frames = relock_frames
        self.jump_streak = 0
        # Last confidently tracked page: survives single-frame tracking dropouts so the size-jump guard still
        # has a reference (cleared only by reset()).
        self.anchor_corners: np.ndarray | None = None
        self.prev_gray: np.ndarray | None = None
        self.prev_corners: np.ndarray | None = None
        self.smoothed_corners: np.ndarray | None = None
        self.tracked_pts: np.ndarray | None = None

    def reset(self) -> None:
        self.prev_gray = None
        self.prev_corners = None
        self.smoothed_corners = None
        self.tracked_pts = None
        self.anchor_corners = None

    def process_frame(
        self, frame: np.ndarray
    ) -> tuple[np.ndarray | None, float, bool]:
        """
        Processes a frame and returns (smoothed_corners, confidence, is_confident).
        If confidence < 0.65, returns (None, confidence, False) to prevent drifting/jumping.
        """
        frame_h, frame_w = frame.shape[:2]
        curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        det_corners, det_score = detect_page_quad(frame)

        # A held page cannot change its size abruptly between frames. A detection that does is usually the page
        # merged with a bright background (e.g. a pale wall) into one blob: ignore it, unless the new size persists
        # (then the page really moved closer/further and we re-lock on it).
        if det_corners is not None and self.anchor_corners is not None:
            prev_area = float(cv2.contourArea(self.anchor_corners))
            det_area = float(cv2.contourArea(det_corners))
            if abs(det_area - prev_area) / max(prev_area, 1.0) > self.max_area_jump:
                self.jump_streak += 1
                if self.jump_streak < self.relock_frames:
                    det_corners, det_score = None, 0.0
                else:
                    self.jump_streak = 0
                    self.reset()
            else:
                self.jump_streak = 0
        else:
            self.jump_streak = 0

        tracked_corners: np.ndarray | None = None
        inlier_ratio = 0.0

        # Try tracking from previous frame if available
        if (
            self.prev_gray is not None
            and self.prev_corners is not None
            and self.tracked_pts is not None
            and len(self.tracked_pts) >= 12
        ):
            next_pts, status, _ = cv2.calcOpticalFlowPyrLK(
                self.prev_gray,
                curr_gray,
                self.tracked_pts,
                None,
                winSize=(21, 21),
                maxLevel=3,
                criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
            )

            if next_pts is not None and status is not None:
                good_prev = self.tracked_pts[status.flatten() == 1]
                good_next = next_pts[status.flatten() == 1]

                if len(good_prev) >= 8:
                    H, inliers = cv2.findHomography(good_prev, good_next, cv2.RANSAC, 3.0)
                    if H is not None and inliers is not None:
                        inlier_count = int(np.sum(inliers))
                        inlier_ratio = inlier_count / max(len(good_prev), 1)

                        if inlier_ratio >= 0.55:
                            cand_pts = cv2.perspectiveTransform(
                                self.prev_corners.reshape(-1, 1, 2), H
                            ).reshape(-1, 2)
                            ordered_cand = order_corners(cand_pts)

                            if is_valid_quad(ordered_cand, frame_w, frame_h):
                                prev_area = cv2.contourArea(self.prev_corners)
                                cand_area = cv2.contourArea(ordered_cand)
                                area_change = abs(cand_area - prev_area) / max(prev_area, 1.0)
                                if area_change < 0.25:
                                    tracked_corners = ordered_cand

        # Decision & Fusion
        chosen_corners: np.ndarray | None = None
        confidence = 0.0

        if tracked_corners is not None and det_corners is not None:
            # Both tracking and detection succeeded -> check agreement
            dist = float(np.mean(np.linalg.norm(tracked_corners - det_corners, axis=1)))
            if dist < 30.0:
                # High agreement: fuse tracking (80%) and detection (20%) to prevent drift
                chosen_corners = 0.8 * tracked_corners + 0.2 * det_corners
                confidence = max(0.90, min(1.0, 1.0 - (dist / 100.0)))
            elif inlier_ratio >= 0.75:
                # Tracking very confident, detection might have caught partial shadow/hand
                chosen_corners = tracked_corners
                confidence = float(inlier_ratio)
            elif det_score >= 0.8:
                # Tracking uncertain, detection strong
                chosen_corners = det_corners
                confidence = float(det_score)
            else:
                chosen_corners = tracked_corners
                confidence = float(inlier_ratio * 0.7)
        elif tracked_corners is not None:
            chosen_corners = tracked_corners
            confidence = float(inlier_ratio)
        elif det_corners is not None:
            chosen_corners = det_corners
            confidence = float(det_score)
        else:
            chosen_corners = None
            confidence = 0.0

        is_confident = chosen_corners is not None and confidence >= 0.65

        if is_confident and chosen_corners is not None:
            # Apply temporal smoothing
            if self.smoothed_corners is None:
                self.smoothed_corners = chosen_corners.copy()
            else:
                self.smoothed_corners = (
                    self.alpha * chosen_corners + (1.0 - self.alpha) * self.smoothed_corners
                )

            self.prev_corners = self.smoothed_corners.copy()
            self.anchor_corners = self.smoothed_corners.copy()
            self.prev_gray = curr_gray.copy()

            # Refresh tracking points inside the new smoothed quad
            grid = generate_grid_points(self.smoothed_corners, nx=8, ny=8)
            # Add goodFeaturesToTrack inside quad mask
            mask = np.zeros((frame_h, frame_w), dtype=np.uint8)
            cv2.fillConvexPoly(mask, np.int32(self.smoothed_corners), 255)
            corners_features = cv2.goodFeaturesToTrack(
                curr_gray, maxCorners=50, qualityLevel=0.02, minDistance=10, mask=mask
            )
            if corners_features is not None and len(corners_features) > 0:
                combined_pts = np.vstack([grid, corners_features])
            else:
                combined_pts = grid
            self.tracked_pts = combined_pts.astype(np.float32)

            return self.smoothed_corners.copy(), float(confidence), True
        else:
            # Low confidence: do not draw, reset smoothing to avoid jump when tracking resumes
            self.smoothed_corners = None
            self.prev_gray = curr_gray.copy()
            if det_corners is not None and det_score > 0.5:
                self.prev_corners = det_corners.copy()
                self.tracked_pts = generate_grid_points(det_corners, nx=8, ny=8)
            else:
                self.prev_corners = None
                self.tracked_pts = None

            return None, float(confidence), False
