"""Humanoid-v1 part taxonomy and draw order for Spine-ready cuts.

Names align with auto-rigger findPart keywords in src/core/auto-rigger.ts.
Z-order is back → front (first slot draws behind later slots).
"""

from __future__ import annotations

from typing import Any

# Draw order: index 0 = deepest back.
HUMANOID_V1_ORDER: list[str] = [
    "hair-back",
    "cape",
    "arm-upper-r",
    "arm-lower-r",
    "hand-r",
    "leg-upper-r",
    "leg-lower-r",
    "foot-r",
    "body",
    "pelvis",
    "torso",
    "neck",
    "head",
    "hair-bangs",
    "hair-front",
    "leg-upper-l",
    "leg-lower-l",
    "foot-l",
    "arm-upper-l",
    "arm-lower-l",
    "hand-l",
    "weapon",
    "prop",
]

# Promo / dealer art: prop + draped hair sit in front; otherwise same as humanoid-v1.
PRESENTATION_ORDER: list[str] = list(HUMANOID_V1_ORDER)

# Parts that occlude the torso and must be inpainted underneath.
HUMANOID_V1_OCCLUDERS: list[str] = [
    "arm-upper-r",
    "arm-lower-r",
    "hand-r",
    "arm-upper-l",
    "arm-lower-l",
    "hand-l",
    "weapon",
    "prop",
    "hair-front",
    "leg-upper-r",
    "leg-lower-r",
    "leg-upper-l",
    "leg-lower-l",
]

PRESENTATION_OCCLUDERS: list[str] = list(HUMANOID_V1_OCCLUDERS)

# Legacy KineticPro names (3/4 hero with one front arm + weapon).
LEGACY_ORDER: list[str] = ["body", "head", "arm-back", "weapon", "arm-front"]
LEGACY_OCCLUDERS: list[str] = ["weapon", "arm-front", "arm-back"]

# Bone parent chain for Spine bind pose (name → parent or None for root).
BONE_PARENTS: dict[str, str | None] = {
    "root": None,
    "hips": "root",
    "chest": "hips",
    "head": "chest",
    "arm-upper-r": "chest",
    "arm-lower-r": "arm-upper-r",
    "hand-r": "arm-lower-r",
    "arm-upper-l": "chest",
    "arm-lower-l": "arm-upper-l",
    "hand-l": "arm-lower-l",
    "leg-upper-r": "hips",
    "leg-lower-r": "leg-upper-r",
    "foot-r": "leg-lower-r",
    "leg-upper-l": "hips",
    "leg-lower-l": "leg-upper-l",
    "foot-l": "leg-lower-l",
    "weapon": "hand-l",
    "cape": "chest",
    "hair-back": "head",
    "hair-bangs": "head",
}

# Part → default bone binding for region attachments.
PART_BONE: dict[str, str] = {
    "body": "chest",
    "torso": "chest",
    "pelvis": "hips",
    "neck": "chest",
    "head": "head",
    "hair-back": "hair-back",
    "hair-bangs": "hair-bangs",
    "cape": "cape",
    "arm-upper-r": "arm-upper-r",
    "arm-lower-r": "arm-lower-r",
    "hand-r": "hand-r",
    "arm-upper-l": "arm-upper-l",
    "arm-lower-l": "arm-lower-l",
    "hand-l": "hand-l",
    "leg-upper-r": "leg-upper-r",
    "leg-lower-r": "leg-lower-r",
    "foot-r": "foot-r",
    "leg-upper-l": "leg-upper-l",
    "leg-lower-l": "leg-lower-l",
    "foot-l": "foot-l",
    "weapon": "weapon",
    "prop": "weapon",
    "hair-front": "hair-bangs",
    # Legacy aliases used by older cut configs / auto-rigger
    "arm-back": "arm-upper-r",
    "arm-front": "arm-upper-l",
    "forearm": "arm-lower-l",
}

# Prop rides the nearer hand bone in Spine.
BONE_PARENTS["prop"] = "hand-l"


def resolve_taxonomy(config: dict[str, Any]) -> dict[str, Any]:
    """Return order, occluders, and bone maps for the requested taxonomy."""
    name = (config.get("taxonomy") or "legacy").lower()
    if name in ("presentation", "promo", "dealer", "casino"):
        return {
            "taxonomy": "presentation",
            "order": list(PRESENTATION_ORDER),
            "occluders": list(PRESENTATION_OCCLUDERS),
            "bone_parents": dict(BONE_PARENTS),
            "part_bone": dict(PART_BONE),
        }
    if name in ("humanoid-v1", "humanoid", "full"):
        return {
            "taxonomy": "humanoid-v1",
            "order": list(HUMANOID_V1_ORDER),
            "occluders": list(HUMANOID_V1_OCCLUDERS),
            "bone_parents": dict(BONE_PARENTS),
            "part_bone": dict(PART_BONE),
        }
    return {
        "taxonomy": "legacy",
        "order": list(config.get("order") or LEGACY_ORDER),
        "occluders": list(config.get("occluders") or LEGACY_OCCLUDERS),
        "bone_parents": dict(BONE_PARENTS),
        "part_bone": dict(PART_BONE),
    }
