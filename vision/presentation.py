"""Presentation-pose helpers for promo / dealer / casino character art.

This art class (bent arms holding a prop, hair over the shoulder, layered
jacket/vest) is the primary input — not clean A-poses. Extract prop + hair
before limbs, then rely on heavier torso inpaint under the remaining occluders.
"""

from __future__ import annotations

from typing import Any

import cv2
import numpy as np

from mask_ops import capsule_mask, disk_mask, grow


def prop_mask_between_wrists(
    rgba: np.ndarray,
    silhouette: np.ndarray,
    pose: dict[str, list[float]],
) -> np.ndarray:
    """Mask a held prop (cards, chips) as the region between the two wrists."""
    h, w = silhouette.shape
    if "leftWrist" not in pose or "rightWrist" not in pose:
        return np.zeros((h, w), dtype=bool)

    lw, rw = pose["leftWrist"], pose["rightWrist"]
    # Capsule spanning both wrists, slightly below (deck sits in the hands)
    mid = [(lw[0] + rw[0]) * 0.5, (lw[1] + rw[1]) * 0.5 + 0.02]
    base = capsule_mask((h, w), (rw[0], rw[1]), (lw[0], lw[1]), 0.07)
    base |= disk_mask((h, w), (mid[0], mid[1]), 0.08)
    base &= silhouette

    # Prefer saturated / warm pixels (red card backs, gold trim) inside the zone
    rgb = rgba[..., :3].astype(np.float32)
    hsv = cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2HSV)
    sat = hsv[..., 1]
    warm = ((hsv[..., 0] < 25) | (hsv[..., 0] > 160)) & (sat > 60)
    colorful = base & (warm | (sat > 90))
    if colorful.sum() > 80:
        return grow(colorful, 3) & silhouette
    return grow(base, 2) & silhouette


def hair_front_mask(
    rgba: np.ndarray,
    silhouette: np.ndarray,
    pose: dict[str, list[float]],
) -> np.ndarray:
    """Side/front hair draped over the shoulder (dark strands on the upper torso)."""
    h, w = silhouette.shape
    head = pose.get("head", [0.5, 0.15])
    chest = pose.get("chest", [0.5, 0.35])
    # Bias toward the character's far shoulder in 3/4 (usually viewer's left = rightShoulder)
    shoulder = pose.get("rightShoulder", pose.get("leftShoulder", [0.35, 0.3]))

    zone = capsule_mask((h, w), (head[0], head[1]), (shoulder[0], shoulder[1] + 0.12), 0.11)
    zone |= capsule_mask((h, w), (shoulder[0], shoulder[1]), (chest[0] - 0.08, chest[1] + 0.05), 0.09)
    # Keep below forehead / above mid-torso
    ys = np.mgrid[0:h, 0:w][0]
    zone &= (ys > head[1] * h) & (ys < chest[1] * h + 0.12 * h)
    zone &= silhouette

    rgb = rgba[..., :3].astype(np.float32)
    luma = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    # Dark hair, not skin (skin is brighter / pinker)
    dark = luma < 95
    skinish = (rgb[..., 0] > 140) & (rgb[..., 1] > 100) & (rgb[..., 2] > 90) & (luma > 110)
    hair = zone & dark & ~skinish
    if hair.sum() < 40:
        return np.zeros((h, w), dtype=bool)
    # Keep largest connected component so jacket buttons don't leak in
    num, labels, stats, _ = cv2.connectedComponentsWithStats(hair.astype(np.uint8), connectivity=8)
    if num <= 1:
        return hair
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return grow(labels == largest, 1) & silhouette


def presentation_extras(
    rgba: np.ndarray,
    silhouette: np.ndarray,
    pose: dict[str, list[float]],
) -> dict[str, np.ndarray]:
    """Return optional named masks extracted before limb capsules claim pixels."""
    extras: dict[str, np.ndarray] = {}
    prop = prop_mask_between_wrists(rgba, silhouette, pose)
    if prop.any():
        extras["prop"] = prop
    hair = hair_front_mask(rgba, silhouette, pose)
    if hair.any():
        extras["hair-front"] = hair
    return extras


def inpaint_dilate_for_overlap(base_dilate: int, overlap: float) -> int:
    """Widen torso inpaint as limb–torso overlap grows (presentation poses)."""
    if overlap >= 0.5:
        return max(base_dilate, 18)
    if overlap >= 0.25:
        return max(base_dilate, 12)
    if overlap >= 0.1:
        return max(base_dilate, 8)
    return base_dilate


def merge_presentation_into_graph(graph: dict[str, Any]) -> dict[str, Any]:
    """Ensure prop / hair-front win priority over limbs."""
    priority = list(graph.get("priority") or [])
    for name in ("prop", "hair-front"):
        if name in priority:
            priority.remove(name)
        priority.insert(0, name)
    graph["priority"] = priority
    return graph
