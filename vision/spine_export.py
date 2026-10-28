"""Emit Spine 4.2 JSON with region attachments from cut parts (in-place coords).

Coordinate convention matches src/exporters/spine42-exporter.ts:
studio is top-left Y-down; Spine is Y-up with root bone at (0,0).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from taxonomy import PART_BONE


def _round4(n: float) -> float:
    return round(float(n) * 10000) / 10000


def studio_to_spine_world(px: float, py: float, root_px: float, root_py: float) -> tuple[float, float]:
    return px - root_px, root_py - py


def build_bones_from_pose(
    pose: dict[str, list[float]],
    width: int,
    height: int,
    bone_parents: dict[str, str | None],
    part_names: list[str],
) -> list[dict[str, Any]]:
    """Build Spine bones from normalized pose landmarks."""
    # Map landmark keys → bone names we emit
    landmark_for_bone: dict[str, str] = {
        "hips": "hips",
        "chest": "chest",
        "head": "head",
        "rightShoulder": "arm-upper-r",
        "rightElbow": "arm-lower-r",
        "rightWrist": "hand-r",
        "leftShoulder": "arm-upper-l",
        "leftElbow": "arm-lower-l",
        "leftWrist": "hand-l",
        "rightHip": "leg-upper-r",
        "rightKnee": "leg-lower-r",
        "rightAnkle": "foot-r",
        "leftHip": "leg-upper-l",
        "leftKnee": "leg-lower-l",
        "leftAnkle": "foot-l",
    }
    # Also support legacy bone names present in parts
    needed: set[str] = {"root", "hips", "chest", "head"}
    for name in part_names:
        bone = PART_BONE.get(name, name)
        needed.add(bone)
        # Walk parents
        p = bone_parents.get(bone)
        while p:
            needed.add(p)
            p = bone_parents.get(p)

    # World positions in studio pixels
    root_px = 0.5 * width
    root_py = 0.97 * height
    world: dict[str, tuple[float, float]] = {"root": (root_px, root_py)}

    for lm_key, bone_name in landmark_for_bone.items():
        if bone_name not in needed:
            continue
        if lm_key in pose:
            world[bone_name] = (pose[lm_key][0] * width, pose[lm_key][1] * height)

    # Defaults if missing
    defaults = {
        "hips": (0.5 * width, 0.62 * height),
        "chest": (0.5 * width, 0.38 * height),
        "head": (0.5 * width, 0.14 * height),
    }
    for b, pt in defaults.items():
        world.setdefault(b, pt)

    # Weapon at hand-l if present
    if "weapon" in needed and "hand-l" in world:
        world["weapon"] = world["hand-l"]
    if "cape" in needed and "chest" in world:
        cx, cy = world["chest"]
        world["cape"] = (cx - 0.08 * width, cy + 0.05 * height)
    if "hair-back" in needed and "head" in world:
        world["hair-back"] = world["head"]
    if "hair-bangs" in needed and "head" in world:
        world["hair-bangs"] = world["head"]

    # Legacy aliases
    if "arm-back" in needed or any(p.startswith("arm-back") for p in part_names):
        if "arm-upper-r" in world:
            world.setdefault("arm-back", world["arm-upper-r"])
    if "arm-front" in needed:
        world.setdefault("arm-front", world.get("arm-upper-l", (0.72 * width, 0.22 * height)))
    if "forearm" in needed:
        world.setdefault("forearm", world.get("arm-lower-l", (0.78 * width, 0.34 * height)))

    # Emit in parent-first order
    order: list[str] = []
    remaining = set(needed) & set(world.keys()) | ({"root"} & needed)
    # Ensure all needed that have world coords
    remaining = {b for b in needed if b in world or b == "root"}
    world.setdefault("root", (root_px, root_py))

    def emit(name: str) -> None:
        if name in order:
            return
        parent = bone_parents.get(name)
        if parent and parent in remaining:
            emit(parent)
        if name not in order:
            order.append(name)

    for name in sorted(remaining, key=lambda n: (0 if n == "root" else 1, n)):
        emit(name)

    bones: list[dict[str, Any]] = []
    for name in order:
        parent = bone_parents.get(name)
        wx, wy = studio_to_spine_world(*world[name], root_px, root_py)
        if parent and parent in world:
            pwx, pwy = studio_to_spine_world(*world[parent], root_px, root_py)
            lx, ly = _round4(wx - pwx), _round4(wy - pwy)
        else:
            lx, ly = _round4(wx), _round4(wy)
        entry: dict[str, Any] = {"name": name, "x": lx, "y": ly, "rotation": 0, "scaleX": 1, "scaleY": 1}
        if parent:
            entry["parent"] = parent
        bones.append(entry)
    return bones


def build_spine42_json(
    *,
    width: int,
    height: int,
    parts: list[dict[str, Any]],
    pose: dict[str, list[float]] | None,
    bone_parents: dict[str, str | None],
    part_bone: dict[str, str],
    images_dir: str = "./images/",
) -> dict[str, Any]:
    pose = pose or {}
    part_names = [p["name"] for p in parts]
    bones = build_bones_from_pose(pose, width, height, bone_parents, part_names)
    bone_world_studio: dict[str, tuple[float, float]] = {}
    # Reconstruct studio bone positions from pose for attachment offsets
    root_px = 0.5 * width
    root_py = 0.97 * height
    bone_world_studio["root"] = (root_px, root_py)
    lm_map = {
        "hips": "hips",
        "chest": "chest",
        "head": "head",
        "arm-upper-r": "rightShoulder",
        "arm-lower-r": "rightElbow",
        "hand-r": "rightWrist",
        "arm-upper-l": "leftShoulder",
        "arm-lower-l": "leftElbow",
        "hand-l": "leftWrist",
        "leg-upper-r": "rightHip",
        "leg-lower-r": "rightKnee",
        "foot-r": "rightAnkle",
        "leg-upper-l": "leftHip",
        "leg-lower-l": "leftKnee",
        "foot-l": "leftAnkle",
        "arm-back": "rightShoulder",
        "arm-front": "leftShoulder",
        "forearm": "leftElbow",
        "weapon": "leftWrist",
    }
    for bone_name, lm in lm_map.items():
        if lm in pose:
            bone_world_studio[bone_name] = (pose[lm][0] * width, pose[lm][1] * height)
    bone_world_studio.setdefault("hips", (0.5 * width, 0.62 * height))
    bone_world_studio.setdefault("chest", (0.5 * width, 0.38 * height))
    bone_world_studio.setdefault("head", (0.5 * width, 0.14 * height))

    slots: list[dict[str, Any]] = []
    attachments: dict[str, dict[str, Any]] = {}

    for part in parts:
        name = part["name"]
        bone_name = part_bone.get(name, part_bone.get(name.lower(), "chest"))
        # Prefer bone that exists in skeleton
        bone_names = {b["name"] for b in bones}
        if bone_name not in bone_names:
            # Legacy remap
            aliases = {
                "arm-upper-r": "arm-back",
                "arm-upper-l": "arm-front",
                "arm-lower-l": "forearm",
            }
            for alt in (aliases.get(bone_name), "chest", "root"):
                if alt and alt in bone_names:
                    bone_name = alt
                    break

        slots.append({"name": name, "bone": bone_name, "attachment": name})

        # Region attachment: center of trimmed rect in bone-local Spine space
        x0 = float(part["x"]) * width
        y0 = float(part["y"]) * height
        pw = float(part.get("pixelWidth") or part["w"] * width)
        ph = float(part.get("pixelHeight") or part["h"] * height)
        cx = x0 + pw * 0.5
        cy = y0 + ph * 0.5
        bx, by = bone_world_studio.get(bone_name, bone_world_studio["root"])
        wx, wy = studio_to_spine_world(cx, cy, root_px, root_py)
        bwx, bwy = studio_to_spine_world(bx, by, root_px, root_py)
        attachments[name] = {
            name: {
                "x": _round4(wx - bwx),
                "y": _round4(wy - bwy),
                "width": int(round(pw)),
                "height": int(round(ph)),
            }
        }

    return {
        "skeleton": {
            "hash": "spineforge-amodal",
            "spine": "4.2.33",
            "x": _round4(-width * 0.5),
            "y": 0,
            "width": width,
            "height": height,
            "fps": 30,
            "images": images_dir,
        },
        "bones": bones,
        "slots": slots,
        "skins": [{"name": "default", "attachments": attachments}],
        "animations": {},
    }


def write_atlas(parts: list[dict[str, Any]], atlas_path: Path, page_name: str = "parts.png") -> None:
    """Minimal single-page atlas listing each part as its own packed region (identity pack).

    For v1 each part PNG is referenced by name; a real packer can replace this later.
    Spine atlas format: page header then region blocks.
    """
    # Identity atlas: each region is its own image file via path — Spine expects one page.
    # We write a multi-region atlas assuming an atlas packer will be run; for cutter MVP
    # we emit per-part pages by writing one atlas entry that points path = part name.
    lines: list[str] = [page_name, "size:1,1", "filter:Linear,Linear", "format:RGBA8888"]
    # Without a real pack, write a companion JSON sidecar instead for studio import.
    # Still emit a valid-looking atlas with zero-size placeholders for tooling smoke tests.
    x = 0
    max_h = 1
    for part in parts:
        pw = int(part.get("pixelWidth") or 1)
        ph = int(part.get("pixelHeight") or 1)
        lines.append(part["name"])
        lines.append(f"  rotate: false")
        lines.append(f"  xy: {x}, 0")
        lines.append(f"  size: {pw}, {ph}")
        lines.append(f"  orig: {pw}, {ph}")
        lines.append(f"  offset: 0, 0")
        lines.append(f"  index: -1")
        x += pw
        max_h = max(max_h, ph)
    lines[1] = f"size:{x},{max_h}"
    atlas_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def export_spine_bundle(
    out_dir: Path,
    *,
    width: int,
    height: int,
    parts: list[dict[str, Any]],
    pose: dict[str, list[float]] | None,
    bone_parents: dict[str, str | None],
    part_bone: dict[str, str],
    stem: str = "character",
) -> dict[str, Any]:
    spine = build_spine42_json(
        width=width,
        height=height,
        parts=parts,
        pose=pose,
        bone_parents=bone_parents,
        part_bone=part_bone,
        images_dir="./",
    )
    json_path = out_dir / f"{stem}.spine.json"
    json_path.write_text(json.dumps(spine, indent=2), encoding="utf-8")
    write_atlas(parts, out_dir / f"{stem}.atlas.txt", page_name=f"{stem}.png")
    return {"spineJson": json_path.name, "atlas": f"{stem}.atlas.txt", "skeleton": spine}
