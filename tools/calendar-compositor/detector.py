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


class PaperColorModel:
    """Tracks and models calendar page paper color in Lab space."""

    def __init__(self) -> None:
        self.median_lab: np.ndarray | None = None
        self.std_lab: np.ndarray | None = None

    def update(self, frame: np.ndarray, quad_corners: np.ndarray) -> None:
        """Samples inner quad region to update the paper color model."""
        h, w = frame.shape[:2]
        quad_mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillConvexPoly(quad_mask, np.int32(quad_corners), 255)

        # Inset heavily (40px) to sample pure paper interior away from edges, spirals, and entering fingers
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (41, 41))
        inner_mask = cv2.erode(quad_mask, kernel, iterations=2)
        if np.count_nonzero(inner_mask) < 200:
            return

        lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
        inner_lab = lab[inner_mask > 0]
        med = np.median(inner_lab, axis=0)
        std = np.std(inner_lab, axis=0)

        if self.median_lab is None:
            self.median_lab = med
            self.std_lab = std
        else:
            self.median_lab = 0.9 * self.median_lab + 0.1 * med
            self.std_lab = 0.9 * self.std_lab + 0.1 * std


def detect_hand_mask(
    frame: np.ndarray,
    quad_corners: np.ndarray,
    paper_model: PaperColorModel | None = None,
) -> tuple[np.ndarray, bool]:
    """
    Detects hand/finger skin pixels inside the page quad.

    Requirements:
    1. Never classify warm-cream/white paper as hand.
    2. Hand pixels must be skin-toned in YCrCb and HSV.
    3. Hand pixels must be clearly different from the paper model in Lab space (dist >= 25.0).
    4. Hand pixels must belong to a connected component that touches the quad boundary band
       (hands enter from the page edge; interior features/text are rejected).
    5. Cap hand area: if total hand area > 35% of the quad, treat frame as low-confidence
       rather than 'hand' (returns is_excessive=True).
    6. If unsure or no valid components, returns empty mask (prefer no hand mask over wiping artwork).

    Returns:
        (hand_mask, is_excessive_hand)
    """
    h, w = frame.shape[:2]
    quad_mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillConvexPoly(quad_mask, np.int32(quad_corners), 255)
    quad_area = float(cv2.contourArea(quad_corners))
    if quad_area < 100.0:
        return np.zeros((h, w), dtype=np.uint8), False

    lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)

    # Determine paper median Lab color
    if paper_model is not None and paper_model.median_lab is not None:
        med_lab = paper_model.median_lab
    else:
        # Sample interior of quad
        kernel_sample = cv2.getStructuringElement(cv2.MORPH_RECT, (41, 41))
        inner_mask = cv2.erode(quad_mask, kernel_sample, iterations=2)
        if np.count_nonzero(inner_mask) > 100:
            med_lab = np.median(lab[inner_mask > 0], axis=0)
        else:
            med_lab = np.median(lab[quad_mask > 0], axis=0)

    # Color distance from paper model in Lab space
    diff = lab.astype(np.float32) - med_lab.astype(np.float32)
    dist_from_paper = np.sqrt(np.sum(diff ** 2, axis=2))

    # Skin in YCrCb (natural human skin tones)
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

    # Condition: skin-toned AND clearly different from paper (dist >= 25.0) AND inside quad
    diff_thresh = 25.0
    cand_skin = (skin_ycrcb & skin_hsv & (dist_from_paper >= diff_thresh) & (quad_mask > 0)).astype(
        np.uint8
    ) * 255

    # Morphology cleanup
    kernel_clean = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    cand_skin = cv2.morphologyEx(cand_skin, cv2.MORPH_OPEN, kernel_clean)

    # Quad boundary band (15px inside the quad edge) - hands enter from the edge
    boundary_band = cv2.subtract(
        quad_mask,
        cv2.erode(quad_mask, cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15)), iterations=1),
    )

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(cand_skin)
    valid_hand_mask = np.zeros((h, w), dtype=np.uint8)
    total_hand_pixels = 0

    for lbl in range(1, num_labels):
        comp_area = stats[lbl, cv2.CC_STAT_AREA]
        if comp_area < 100:  # Ignore tiny noise (< 100 px)
            continue
        comp_mask = (labels == lbl)
        # Connected component must intersect the quad boundary
        if np.any(comp_mask & (boundary_band > 0)):
            valid_hand_mask[comp_mask] = 255
            total_hand_pixels += comp_area

    # Cap hand area: if > 35% of quad area, treat as excessive hand occlusion (low-confidence)
    if total_hand_pixels > 0.35 * quad_area:
        return np.zeros((h, w), dtype=np.uint8), True

    # Dilate valid hand mask slightly (3px) so hand edges don't leak artwork
    if total_hand_pixels > 0:
        valid_hand_mask = cv2.dilate(valid_hand_mask, kernel_clean, iterations=1)

    return valid_hand_mask, False
