"""Shared OpenCV mask helpers for the amodal part cutter."""

from __future__ import annotations

import cv2
import numpy as np


def disk(px: int) -> np.ndarray:
    px = max(1, int(px))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (px * 2 + 1, px * 2 + 1))


def grow(mask: np.ndarray, px: int) -> np.ndarray:
    if px <= 0:
        return mask.astype(bool)
    return cv2.dilate(mask.astype(np.uint8), disk(px)) > 0


def erode(mask: np.ndarray, px: int) -> np.ndarray:
    if px <= 0:
        return mask.astype(bool)
    return cv2.erode(mask.astype(np.uint8), disk(px)) > 0


def soft(mask: np.ndarray, sigma: float = 1.0) -> np.ndarray:
    if sigma <= 0:
        return mask.astype(np.float32)
    return cv2.GaussianBlur(mask.astype(np.float32), (0, 0), sigma)


def above_line(shape: tuple[int, int], a: tuple[float, float], b: tuple[float, float]) -> np.ndarray:
    """True for pixels above the directed line a -> b (normalized [0..1] coords)."""
    h, w = shape
    ys, xs = np.mgrid[0:h, 0:w]
    return (b[0] - a[0]) * w * (ys - a[1] * h) - (b[1] - a[1]) * h * (xs - a[0] * w) < 0


def capsule_mask(
    shape: tuple[int, int],
    a: tuple[float, float],
    b: tuple[float, float],
    radius_norm: float,
) -> np.ndarray:
    """True for pixels inside a capsule from a to b with radius (normalized to height)."""
    h, w = shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    ax, ay = a[0] * w, a[1] * h
    bx, by = b[0] * w, b[1] * h
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq < 1e-6:
        t = np.zeros_like(xs)
    else:
        t = np.clip(((xs - ax) * dx + (ys - ay) * dy) / length_sq, 0.0, 1.0)
    dist = np.hypot(xs - (ax + dx * t), ys - (ay + dy * t))
    return dist <= (radius_norm * h)


def disk_mask(shape: tuple[int, int], center: tuple[float, float], radius_norm: float) -> np.ndarray:
    """Circular mask; center and radius in normalized image coords (radius vs height)."""
    h, w = shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = center[0] * w, center[1] * h
    r_px = radius_norm * h
    return ((xs - cx) ** 2 + (ys - cy) ** 2) <= (r_px ** 2)


def median_limb_halfwidth(
    silhouette: np.ndarray,
    a: tuple[float, float],
    b: tuple[float, float],
    samples: int = 12,
) -> float:
    """Estimate half-width of the silhouette along segment a→b, normalized by height."""
    h, w = silhouette.shape
    ax, ay = a[0] * w, a[1] * h
    bx, by = b[0] * w, b[1] * h
    dx, dy = bx - ax, by - ay
    length = float(np.hypot(dx, dy))
    if length < 1.0:
        return 0.04
    nx, ny = -dy / length, dx / length
    widths: list[float] = []
    for i in range(1, samples + 1):
        t = i / (samples + 1)
        cx = ax + dx * t
        cy = ay + dy * t
        # Walk perpendicular until leaving silhouette
        for sign in (-1.0, 1.0):
            dist = 0.0
            step = 1.0
            while dist < length:
                px = int(round(cx + nx * sign * dist))
                py = int(round(cy + ny * sign * dist))
                if px < 0 or py < 0 or px >= w or py >= h or not silhouette[py, px]:
                    widths.append(dist)
                    break
                dist += step
            else:
                widths.append(dist)
    if not widths:
        return 0.04
    return float(np.median(widths) / h)
