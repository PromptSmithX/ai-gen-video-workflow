"""Warper module for perspective warping, feathered masking, and compositing."""

from __future__ import annotations
import cv2
import numpy as np


def compute_inset_corners(corners: np.ndarray, inset_ratio: float = 0.015) -> np.ndarray:
    """Pulls quad corners slightly inward toward the centroid to preserve page edges/spiral."""
    center = np.mean(corners, axis=0)
    inset = center + (1.0 - inset_ratio) * (corners - center)
    return inset.astype(np.float32)


def warp_and_composite(
    frame: np.ndarray,
    artwork: np.ndarray,
    corners: np.ndarray,
    hand_mask: np.ndarray | None = None,
    inset_ratio: float = 0.015,
) -> np.ndarray:
    """
    Warps the full-resolution artwork in-memory onto the quad in `frame`.
    - Inset is applied so artwork stays inside page margins and clear of spirals.
    - Hand pixels are masked out so fingers stay in front of artwork.
    - Mask edges are feathered <= 2 px.
    """
    frame_h, frame_w = frame.shape[:2]
    art_h, art_w = artwork.shape[:2]

    inset_corners = compute_inset_corners(corners, inset_ratio=inset_ratio)

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
    if hand_mask is not None:
        mask[hand_mask > 0] = 0

    # Feather edge <= 2 px using a small Gaussian blur (kernel 3x3, sigma 0.8)
    feathered = cv2.GaussianBlur(mask, (3, 3), 0.8)
    alpha = (feathered.astype(np.float32) / 255.0)[:, :, np.newaxis]

    # Alpha composite: frame + warped artwork
    composited = (alpha * warped_art.astype(np.float32) + (1.0 - alpha) * frame.astype(np.float32)).astype(
        np.uint8
    )

    return composited
