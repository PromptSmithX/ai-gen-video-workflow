"""Warper module for perspective warping, feathered masking, and compositing."""

from __future__ import annotations
import cv2
import numpy as np


def compute_inset_corners(
    corners: np.ndarray,
    top_inset: float = 0.05,
    bottom_inset: float = 0.02,
    left_inset: float = 0.02,
    right_inset: float = 0.02,
    inset_ratio: float | None = None,
) -> np.ndarray:
    """
    Pulls quad corners inward to preserve page edges and avoid touching spiral bindings.

    - top_inset defaults to 0.05 (>= 4% of page height) so artwork never overlaps spiral coils.
    - bottom_inset, left_inset, right_inset default to 0.02 (natural clean margin).
    - If inset_ratio is passed and directional insets are not customized, applies uniform inset.
    """
    pts = np.asarray(corners, dtype=np.float32).reshape(4, 2)
    tl, tr, br, bl = pts[0], pts[1], pts[2], pts[3]

    if inset_ratio is not None and top_inset == 0.05 and bottom_inset == 0.02:
        # Fallback to uniform if explicit legacy inset_ratio provided without custom directional insets
        center = np.mean(pts, axis=0)
        return (center + (1.0 - inset_ratio) * (pts - center)).astype(np.float32)

    v_left = bl - tl     # Vector from TL down to BL
    v_right = br - tr    # Vector from TR down to BR
    u_top = tr - tl      # Vector from TL right to TR
    u_bottom = br - bl   # Vector from BL right to BR

    inset_tl = tl + top_inset * v_left + left_inset * u_top
    inset_tr = tr + top_inset * v_right - right_inset * u_top
    inset_br = br - bottom_inset * v_right - right_inset * u_bottom
    inset_bl = bl - bottom_inset * v_left + left_inset * u_bottom

    return np.array([inset_tl, inset_tr, inset_br, inset_bl], dtype=np.float32)


def warp_and_composite(
    frame: np.ndarray,
    artwork: np.ndarray,
    corners: np.ndarray,
    hand_mask: np.ndarray | None = None,
    top_inset: float = 0.05,
    bottom_inset: float = 0.02,
    left_inset: float = 0.02,
    right_inset: float = 0.02,
    inset_ratio: float | None = None,
) -> np.ndarray:
    """
    Warps the full-resolution artwork in-memory onto the quad in `frame`.
    - Directional inset is applied (top >= 4% height) so artwork stays inside page margins
      and clear of spirals.
    - Hand pixels are masked out so fingers stay in front of artwork.
    - Mask edges are feathered <= 2 px.
    """
    frame_h, frame_w = frame.shape[:2]
    art_h, art_w = artwork.shape[:2]

    inset_corners = compute_inset_corners(
        corners,
        top_inset=top_inset,
        bottom_inset=bottom_inset,
        left_inset=left_inset,
        right_inset=right_inset,
        inset_ratio=inset_ratio,
    )

    src_pts = np.float32([
        [0, 0],
        [art_w - 1, 0],
        [art_w - 1, art_h - 1],
        [0, art_h - 1],
    ])

    # Compute perspective transform
    M = cv2.getPerspectiveTransform(src_pts, inset_corners)

    # Warp the original artwork directly to frame size
    warped_art = cv2.warpPerspective(
        artwork, M, (frame_w, frame_h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT
    )

    # Create binary quad mask
    mask = np.zeros((frame_h, frame_w), dtype=np.uint8)
    cv2.fillConvexPoly(mask, np.int32(inset_corners), 255)

    # If hand detected inside the quad, remove hand pixels from artwork mask
    if hand_mask is not None and np.count_nonzero(hand_mask) > 0:
        mask[hand_mask > 0] = 0

    # Feather edge <= 2 px using a small Gaussian blur (kernel 3x3, sigma 0.8)
    feathered = cv2.GaussianBlur(mask, (3, 3), 0.8)
    alpha = (feathered.astype(np.float32) / 255.0)[:, :, np.newaxis]

    # Alpha composite: frame + warped artwork
    composited = (alpha * warped_art.astype(np.float32) + (1.0 - alpha) * frame.astype(np.float32)).astype(
        np.uint8
    )

    return composited
