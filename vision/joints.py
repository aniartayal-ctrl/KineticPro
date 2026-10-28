"""Ball-joint amodal caps and outline interruption for Spine-ready limbs."""

from __future__ import annotations

from typing import Any

import numpy as np

from mask_ops import disk_mask, erode


def apply_ball_joint_covers(
    part_masks: dict[str, np.ndarray],
    splits: list[dict[str, Any]],
    shape: tuple[int, int],
    silhouette: np.ndarray,
) -> dict[str, np.ndarray]:
    """Merge circular joint caps onto paired limb parts (coin overlap).

    For each split cover with center/radius, OR the disk onto both parts in
    `cover.pair` (or rest + from). Caps are clipped to the character silhouette
    so we do not invent floating pixels outside the figure.
    """
    out = {k: v.copy() for k, v in part_masks.items()}
    for split in splits:
        cov = split.get("cover")
        if not cov:
            continue
        center = (float(cov["center"][0]), float(cov["center"][1]))
        radius = float(cov["radius"])
        ring = disk_mask(shape, center, radius) & silhouette
        pair = cov.get("pair")
        if pair and len(pair) >= 2:
            targets = [p for p in pair if p in out]
        else:
            targets = [n for n in (split.get("rest"), cov.get("from")) if n and n in out]
        for name in targets:
            out[name] |= ring
    return out


def interrupt_internal_outlines(
    rgba: np.ndarray,
    part_masks: dict[str, np.ndarray],
    splits: list[dict[str, Any]],
    outline_luma: float = 48.0,
) -> np.ndarray:
    """Remove dark outline strokes inside joint overlap disks.

    Outer silhouette outlines stay; only the internal half of each joint cap
    (where two limb pieces overlap) has dark line art replaced with local fill
    so rotating bones do not flash a doll seam.
    """
    out = rgba.copy()
    rgb = out[..., :3].astype(np.float32)
    h, w = rgba.shape[:2]
    luma = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    outline = luma < outline_luma

    for split in splits:
        cov = split.get("cover")
        if not cov:
            continue
        center = (float(cov["center"][0]), float(cov["center"][1]))
        radius = float(cov["radius"])
        ring = disk_mask((h, w), center, radius)
        pair = cov.get("pair") or []
        if len(pair) < 2:
            from_part = cov.get("from")
            rest = split.get("rest")
            if from_part and rest:
                pair = [rest, from_part]
        if len(pair) < 2:
            continue
        a_name, b_name = pair[0], pair[1]
        if a_name not in part_masks or b_name not in part_masks:
            continue
        # Internal zone: both parts claim the pixel (overlap after cover merge)
        overlap = part_masks[a_name] & part_masks[b_name] & ring
        if not overlap.any():
            # Fall back to eroded interior of the disk
            overlap = erode(ring, max(1, int(radius * h * 0.15)))
        kill = overlap & outline
        if not kill.any():
            continue
        # Sample fill color from nearby non-outline limb pixels
        sample = (part_masks[a_name] | part_masks[b_name]) & ring & ~outline
        if sample.any():
            fill = np.median(rgb[sample], axis=0)
        else:
            fill = np.array([180.0, 140.0, 120.0], dtype=np.float32)
        rgb[kill] = fill

    out[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    return out


def apply_line_splits(
    part_masks: dict[str, np.ndarray],
    splits: list[dict[str, Any]],
    shape: tuple[int, int],
) -> dict[str, np.ndarray]:
    """Apply geometric line splits (legacy elbow crease) before cover rings."""
    from mask_ops import above_line

    out = {k: v.copy() for k, v in part_masks.items()}
    for split in splits:
        pieces = split.get("pieces") or []
        if not pieces:
            continue
        src_name = split["part"]
        if src_name not in out:
            continue
        remaining = out.pop(src_name).copy()
        for piece in pieces:
            p_line = piece["line"]
            side = above_line(shape, tuple(p_line[0]), tuple(p_line[1]))
            cut = remaining & (side if piece.get("side") == "above" else ~side)
            out[piece["name"]] = cut
            remaining &= ~cut
        rest_name = split.get("rest", src_name)
        out[rest_name] = remaining
    return out
