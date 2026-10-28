"""Occlusion inpainting: joint-ring local fill + torso hole reconstruction."""

from __future__ import annotations

from typing import Any

import cv2
import numpy as np

from mask_ops import disk_mask, grow


def inpaint_occluded_body(
    rgba: np.ndarray,
    occluder_mask: np.ndarray,
    protect_mask: np.ndarray | None = None,
    dilate_px: int = 6,
) -> tuple[np.ndarray, np.ndarray]:
    """Inpaint the body under movable limbs using OpenCV Telea + alpha feathering."""
    rgb = rgba[..., :3].astype(np.uint8)
    alpha = rgba[..., 3].astype(np.uint8)
    inpaint_zone = grow(occluder_mask, dilate_px)
    if protect_mask is not None:
        inpaint_zone &= ~grow(protect_mask, 2)
    mask_u8 = (inpaint_zone.astype(np.uint8)) * 255
    inpainted_rgb = cv2.inpaint(rgb, mask_u8, inpaintRadius=7, flags=cv2.INPAINT_TELEA)
    body_alpha = alpha.copy()
    inpainted_alpha = cv2.inpaint(body_alpha, mask_u8, inpaintRadius=7, flags=cv2.INPAINT_TELEA)
    return inpainted_rgb, inpainted_alpha


def inpaint_joint_rings(
    rgba: np.ndarray,
    splits: list[dict[str, Any]],
    silhouette: np.ndarray,
) -> np.ndarray:
    """Local Telea fill only inside joint cover disks (Approach B small-cap fill)."""
    out = rgba.copy()
    h, w = rgba.shape[:2]
    ring_union = np.zeros((h, w), dtype=bool)
    for split in splits:
        cov = split.get("cover")
        if not cov:
            continue
        center = (float(cov["center"][0]), float(cov["center"][1]))
        radius = float(cov["radius"])
        ring_union |= disk_mask((h, w), center, radius)

    # Only inpaint the ring fringe just outside modal limb cores — keep silhouette
    zone = ring_union & silhouette
    if not zone.any():
        return out
    mask_u8 = (zone.astype(np.uint8)) * 255
    rgb = out[..., :3]
    filled = cv2.inpaint(rgb, mask_u8, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
    # Blend only where we actually needed extension (low alpha or hole)
    alpha = out[..., 3]
    need = zone & (alpha < 200)
    out_rgb = rgb.copy()
    out_rgb[need] = filled[need]
    out[..., :3] = out_rgb
    # Raise alpha inside ring ∩ silhouette so caps are opaque
    new_a = alpha.copy()
    new_a[zone] = np.maximum(new_a[zone], 255)
    out[..., 3] = new_a
    return out


def resolve_inpaint_config(config: dict[str, Any]) -> dict[str, Any]:
    raw = config.get("inpaint")
    if isinstance(raw, dict):
        return {
            "mode": str(raw.get("mode") or "telea"),
            "dilatePx": int(raw.get("dilatePx") or raw.get("dilate_px") or 6),
            "ai_inpaint_url": raw.get("ai_inpaint_url") or raw.get("aiInpaintUrl"),
        }
    return {"mode": "telea", "dilatePx": 6, "ai_inpaint_url": None}
