"""Detector module for calendar page quadrilateral and hand detection."""

from __future__ import annotations
import cv2
import numpy as np


def order_corners(pts: np.ndarray) -> np.ndarray:
    """Orders 4 points in clockwise order: Top-Left, Top-Right, Bottom-Right, Bottom-Left."""
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    rect = np.zeros((4, 2), dtype=np.float32)

    # Sum of coordinates: TL has minimum x+y, BR has maximum x+y
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]

    # Difference of coordinates (y - x): TR has minimum (small y, large x), BL has maximum (large y, small x)
    diff = pts[:, 1] - pts[:, 0]
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]

    return rect


def is_valid_quad(corners: np.ndarray, frame_w: int, frame_h: int) -> bool:
    """Validates that a 4-point contour is a convex, non-degenerate quadrilateral."""
    if corners is None or len(corners) != 4:
        return False
    pts = np.asarray(corners, dtype=np.float32).reshape(4, 2)
    if not cv2.isContourConvex(pts.astype(np.int32)):
        return False

    area = cv2.contourArea(pts)
    frame_area = frame_w * frame_h
    if area < 0.05 * frame_area or area > 0.95 * frame_area:
        return False

    # Edge lengths
    d_top = float(np.linalg.norm(pts[1] - pts[0]))
    d_right = float(np.linalg.norm(pts[2] - pts[1]))
    d_bottom = float(np.linalg.norm(pts[3] - pts[2]))
    d_left = float(np.linalg.norm(pts[0] - pts[3]))

    if min(d_top, d_right, d_bottom, d_left) < 50.0:
        return False

    avg_w = (d_top + d_bottom) / 2.0
    avg_h = (d_left + d_right) / 2.0
    aspect = avg_w / max(avg_h, 1.0)
    if aspect < 0.4 or aspect > 2.5:
        return False

    return True


def detect_page_quad(frame: np.ndarray) -> tuple[np.ndarray | None, float]:
    """
    Detects the blank light/cream page quadrilateral in a video frame.
    Returns (ordered_corners, confidence_score) or (None, 0.0).
    """
    frame_h, frame_w = frame.shape[:2]
    frame_area = frame_h * frame_w

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

    # Multi-level threshold search: start with high brightness (cream paper) to avoid spiral binding,
    # then fallback to moderate brightness if needed.
    for thresh_val in (205, 190, 175, 160):
        # Paper brightness & low saturation
        mask_bright = gray >= thresh_val
        mask_sat = hsv[:, :, 1] <= 90
        combined_mask = (mask_bright & mask_sat).astype(np.uint8) * 255

        # Morphological close to bridge small text / inner features
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (11, 11))
        closed_mask = cv2.morphologyEx(combined_mask, cv2.MORPH_CLOSE, kernel)

        contours, _ = cv2.findContours(closed_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue

        best_cand: np.ndarray | None = None
        best_score = 0.0

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < 0.05 * frame_area:
                continue

            hull = cv2.convexHull(cnt)
            peri = cv2.arcLength(hull, True)

            # Try multiple approximation factors to find a 4-vertex quad
            for eps in (0.015, 0.02, 0.025, 0.03, 0.04, 0.05):
                approx = cv2.approxPolyDP(hull, eps * peri, True)
                if len(approx) == 4:
                    ordered = order_corners(approx.reshape(4, 2))
                    if is_valid_quad(ordered, frame_w, frame_h):
                        quad_area = cv2.contourArea(ordered)
                        score = min(1.0, quad_area / (0.5 * frame_area))
                        if score > best_score:
                            best_score = score
                            best_cand = ordered
                    break

        if best_cand is not None and best_score > 0.4:
            return best_cand, float(best_score)

    return None, 0.0


def detect_hand_mask(frame: np.ndarray, quad_corners: np.ndarray) -> np.ndarray:
    """
    Detects hand/finger skin pixels inside the page quad.
    Returns a binary mask (uint8, 0 or 255) where 255 indicates hand pixels.
    """
    h, w = frame.shape[:2]

    # Skin in YCrCb
    ycrcb = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)
    cr = ycrcb[:, :, 1]
    cb = ycrcb[:, :, 2]
    skin_ycrcb = (cr >= 133) & (cr <= 175) & (cb >= 77) & (cb <= 127)

    # Skin in HSV
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    h_chan = hsv[:, :, 0]
    s_chan = hsv[:, :, 1]
    v_chan = hsv[:, :, 2]
    skin_hsv = (h_chan <= 25) & (s_chan >= 30) & (s_chan <= 210) & (v_chan >= 60)

    skin = (skin_ycrcb & skin_hsv).astype(np.uint8) * 255

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    skin = cv2.morphologyEx(skin, cv2.MORPH_OPEN, kernel)
    skin = cv2.dilate(skin, kernel, iterations=1)

    # Intersect with the page quad
    quad_mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillConvexPoly(quad_mask, np.int32(quad_corners), 255)

    hand_mask = cv2.bitwise_and(skin, quad_mask)
    return hand_mask
