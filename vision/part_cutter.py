#!/usr/bin/env python3
"""SpineForge Vision Worker: B-gated amodal part cutter.

Pipeline:
  0. A-pose / clear-limb gate (optional refuse)
  1. Pose landmarks → capsules + joint covers
  2. Modal masks + ball-joint amodal caps + outline interrupt
  3. Joint-ring + torso Telea inpaint
  4. Trimmed PNGs (+ optional Spine 4.2 JSON)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

# Allow `python vision/part_cutter.py` from repo root
_VISION_DIR = Path(__file__).resolve().parent
if str(_VISION_DIR) not in sys.path:
    sys.path.insert(0, str(_VISION_DIR))

from inpaint import inpaint_joint_rings, inpaint_occluded_body, resolve_inpaint_config
from joints import apply_ball_joint_covers, apply_line_splits, interrupt_internal_outlines
from mask_ops import capsule_mask, grow, soft
from pose_gate import PoseNotRiggableError, build_pose_cut_graph, check_clear_limbs, resolve_pose
from presentation import inpaint_dilate_for_overlap, merge_presentation_into_graph, presentation_extras
from spine_export import export_spine_bundle
from taxonomy import resolve_taxonomy


def _safe_layer_name(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in name.strip().lower()).strip("-")


# "FILL 03 > wing_L" or "FILL 09 > head (forehead)": hidden backfill painted under the named part.
_FILL_LAYER = re.compile(r"^\s*fill\b[^>]*>\s*([^\s(]+)", re.IGNORECASE)
# Hidden layers that are artist guides, not alternate art.
_GUIDE_LAYER = re.compile(r"\b(ref|reference|guide|sketch|hide)\b", re.IGNORECASE)


def _layer_pixels(layer: Any) -> tuple[Image.Image, int, int] | None:
    """Layer pixels at their canvas offset, ignoring the layer's visibility flag."""
    pil_img = layer.topil() if layer.kind == "pixel" else layer.composite(force=True)
    if pil_img is None:
        return None
    return pil_img.convert("RGBA"), layer.left, layer.top


def _backfill_part(
    rgba: Image.Image, left: int, top: int, fill_pixels: list[tuple[Image.Image, int, int]]
) -> tuple[Image.Image, int, int]:
    """Grow a part under its FILL masks. The masks only mark where (artists paint them flat red),
    so the new pixels are inpainted from the part's own colours."""
    import cv2

    x0 = min([left] + [fl for _, fl, _ in fill_pixels])
    y0 = min([top] + [ft for _, _, ft in fill_pixels])
    x1 = max([left + rgba.width] + [fl + f.width for f, fl, _ in fill_pixels])
    y1 = max([top + rgba.height] + [ft + f.height for f, _, ft in fill_pixels])
    canvas = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
    canvas.alpha_composite(rgba, (left - x0, top - y0))
    part = np.asarray(canvas).copy()
    fill_alpha = np.zeros(part.shape[:2], dtype=np.uint8)
    for f, fl, ft in fill_pixels:
        a = np.asarray(f)[..., 3]
        region = fill_alpha[ft - y0 : ft - y0 + f.height, fl - x0 : fl - x0 + f.width]
        np.maximum(region, a, out=region)

    opaque = part[..., 3] > 8
    if not (fill_alpha > 8).any() or not opaque.any():
        return rgba, left, top
    # Inpaint every non-opaque pixel so transparent black never bleeds into the fill.
    rgb = cv2.inpaint(part[..., :3], (~opaque).astype(np.uint8) * 255, inpaintRadius=9, flags=cv2.INPAINT_TELEA)
    out = part.copy()
    out[..., :3] = np.where(opaque[..., None], part[..., :3], rgb)
    out[..., 3] = np.maximum(part[..., 3], fill_alpha)
    return Image.fromarray(out), x0, y0


def extract_psd_layers(psd_path: Path, out_dir: Path) -> dict[str, Any]:
    """Extract visible layers from a .psd file into trimmed PNG parts.

    Hidden "FILL nn > part" layers are artist backfill: each is merged underneath the part it names,
    so the hole behind an occluding part is already painted when that part moves. Other hidden layers
    (closed eyelids, a shut mouth) come in as parts marked `hidden`, for clips to switch on.
    """
    try:
        from psd_tools import PSDImage
    except ImportError as exc:
        raise RuntimeError("psd-tools is required for PSD extraction") from exc

    psd = PSDImage.open(psd_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    canvas_w, canvas_h = psd.width, psd.height
    parts_meta: list[dict[str, Any]] = []

    fills: dict[str, list[Any]] = {}
    for layer in psd:
        match = _FILL_LAYER.match(layer.name)
        if match and not layer.is_group():
            fills.setdefault(_safe_layer_name(match.group(1)), []).append(layer)

    for idx, layer in enumerate(psd):
        if layer.is_group():
            continue
        hidden = not layer.is_visible()
        if hidden and (_FILL_LAYER.match(layer.name) or _GUIDE_LAYER.search(layer.name)):
            continue
        pixels = _layer_pixels(layer)
        if pixels is None:
            continue
        rgba, left, top = pixels
        safe_name = _safe_layer_name(layer.name) or f"layer-{idx}"

        fill_pixels = [p for p in (_layer_pixels(f) for f in fills.get(safe_name, [])) if p is not None]
        if fill_pixels:
            rgba, left, top = _backfill_part(rgba, left, top, fill_pixels)

        bbox = rgba.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
        if not bbox:
            continue
        cropped = rgba.crop(bbox)
        part_filename = f"part-{safe_name}.png"
        cropped.save(out_dir / part_filename, "PNG")
        lx0 = left + bbox[0]
        ly0 = top + bbox[1]
        lw = bbox[2] - bbox[0]
        lh = bbox[3] - bbox[1]
        meta: dict[str, Any] = {
            "name": safe_name,
            "src": part_filename,
            "x": round(lx0 / canvas_w, 5),
            "y": round(ly0 / canvas_h, 5),
            "w": round(lw / canvas_w, 5),
            "h": round(lh / canvas_h, 5),
            "pixelWidth": lw,
            "pixelHeight": lh,
        }
        if fill_pixels:
            meta["filled"] = len(fill_pixels)
        if hidden:
            meta["hidden"] = True
        parts_meta.append(meta)

    composite_name = None
    flat = psd.composite()
    if flat is not None:
        composite_name = "source-composite.png"
        flat.convert("RGBA").save(out_dir / composite_name, "PNG")

    return {
        "width": canvas_w,
        "height": canvas_h,
        "parts": parts_meta,
        "composite": composite_name,
    }


def cut_flat_character(
    image_path: Path,
    out_dir: Path,
    config: dict[str, Any],
) -> dict[str, Any]:
    """Cut a flat character into Spine-ready parts with ball-joint caps and occlusion fill."""
    out_dir.mkdir(parents=True, exist_ok=True)
    raw = Image.open(image_path).convert("RGBA")
    bbox = raw.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    work = raw.crop(bbox) if bbox and config.get("trimSource", False) else raw
    w, h = work.size
    rgba = np.array(work, dtype=np.uint8)
    alpha = rgba[..., 3].astype(np.float32) / 255.0
    silhouette = alpha > 0.03

    tax = resolve_taxonomy(config)
    taxonomy_name = tax["taxonomy"]
    inpaint_cfg = resolve_inpaint_config(config)
    joint_cover_scale = float(config.get("jointCoverScale") or config.get("joint_cover_scale") or 1.1)
    outline_interrupt = bool(config.get("outlineInterrupt", config.get("outline_interrupt", True)))
    require_clear = bool(config.get("requireClearLimbs", config.get("require_clear_limbs", False)))
    max_overlap = float(config.get("maxLimbTorsoOverlap", config.get("max_limb_torso_overlap", 0.08)))
    emit_spine = bool(config.get("emitSpineJson", config.get("emit_spine_json", False)))

    # --- Stage 0–1: pose + capsules ---
    # Pose graph when: explicit pose, humanoid-v1 taxonomy, usePose=true, or no capsules given.
    capsules_cfg: dict[str, list[list[float]]] = dict(config.get("capsules") or {})
    presentation_mode = taxonomy_name == "presentation"
    if config.get("usePose") is False:
        use_pose_graph = False
    elif config.get("pose") or taxonomy_name in ("humanoid-v1", "presentation") or not capsules_cfg:
        use_pose_graph = True
    else:
        use_pose_graph = bool(config.get("usePose", False))

    pose = None
    splits: list[dict[str, Any]] = list(config.get("splits") or [])
    priority: list[str] = list(config.get("priority") or list(capsules_cfg.keys()))

    if use_pose_graph:
        pose = resolve_pose(config, rgba, silhouette)
        graph_tax = "humanoid-v1" if presentation_mode else taxonomy_name
        graph = build_pose_cut_graph(pose, silhouette, graph_tax, joint_cover_scale)
        if presentation_mode:
            graph = merge_presentation_into_graph(graph)
        # Merge: explicit capsules override pose-generated ones for same keys
        for name, caps in graph["capsules"].items():
            capsules_cfg.setdefault(name, caps)
        if not config.get("splits"):
            splits = graph["splits"]
        if not config.get("priority"):
            priority = graph["priority"]
        pose = graph["pose"]

    part_masks: dict[str, np.ndarray] = {}
    taken = np.zeros((h, w), dtype=bool)

    # Presentation: claim prop + draped hair before limb capsules
    if presentation_mode and pose is not None:
        for name, mask in presentation_extras(rgba, silhouette, pose).items():
            claim = mask & ~taken
            if claim.any():
                part_masks[name] = claim
                taken |= claim
                if name not in priority:
                    priority.insert(0, name)

    for name in priority:
        if name in part_masks:
            continue
        mask = np.zeros((h, w), dtype=bool)
        for cap in capsules_cfg.get(name, []):
            ax, ay, bx, by, radius = cap
            mask |= capsule_mask((h, w), (ax, ay), (bx, by), radius)
        mask &= silhouette & ~taken
        if mask.any():
            part_masks[name] = mask
            taken |= mask

    part_masks["body"] = silhouette & ~taken

    # Line splits (legacy elbow) then ball-joint covers
    part_masks = apply_line_splits(part_masks, splits, (h, w))
    part_masks = apply_ball_joint_covers(part_masks, splits, (h, w), silhouette)

    # Overlap is measured for adaptive inpaint; hard refuse only if explicitly required
    warnings: list[str] = []
    if pose is not None:
        overlap = check_clear_limbs(
            part_masks,
            pose,
            silhouette,
            max_overlap=max_overlap,
            require_clear=require_clear and not presentation_mode,
        )
        if overlap > max_overlap:
            warnings.append(
                f"limb_torso_overlap={overlap:.3f}: presentation pose — using heavy torso inpaint"
            )
    else:
        overlap = 0.0

    # Outline interrupt on a working RGBA copy
    work_rgba = rgba
    if outline_interrupt and splits:
        work_rgba = interrupt_internal_outlines(rgba, part_masks, splits)

    # Joint-ring local inpaint (extend caps)
    work_rgba = inpaint_joint_rings(work_rgba, splits, silhouette)
    rgb = work_rgba[..., :3].astype(np.float32)
    alpha = work_rgba[..., 3].astype(np.float32) / 255.0

    # Torso occlusion fill
    occluders = config.get("occluders")
    if occluders is None:
        occluders = tax["occluders"]
    # Drop occluders that were explicitly disabled via inpaintTorso=false
    if config.get("inpaintTorso") is False:
        occluders = []

    occ_mask = np.zeros((h, w), dtype=bool)
    for occ_name in occluders:
        if occ_name in part_masks:
            occ_mask |= part_masks[occ_name]

    protect = part_masks.get("head")
    if protect is None:
        protect = np.zeros((h, w), dtype=bool)
    dilate_px = inpaint_dilate_for_overlap(int(inpaint_cfg["dilatePx"]), float(overlap))
    if presentation_mode:
        dilate_px = max(dilate_px, 14)
    inpaint_rgb, inpaint_a = inpaint_occluded_body(
        work_rgba,
        occ_mask,
        protect,
        dilate_px=dilate_px,
    )

    order = config.get("order") or tax["order"]
    # Ensure every extracted part appears even if not in taxonomy order
    for name in part_masks:
        if name not in order:
            order.append(name)

    parts_out: list[dict[str, Any]] = []
    for name in order:
        mask = part_masks.get(name)
        if mask is None or not mask.any():
            continue
        if name == "body":
            fill_zone = grow(occ_mask, 4) & silhouette
            part_rgb = np.where(part_masks["body"][..., None], rgb, inpaint_rgb.astype(np.float32))
            part_alpha = np.maximum(
                alpha * soft(part_masks["body"], 0.8),
                (inpaint_a.astype(np.float32) / 255.0) * soft(fill_zone, 1.2),
            )
        else:
            dilated = grow(mask, 2) & silhouette
            # For joint covers that extend beyond modal silhouette slightly, allow ring∩mask
            dilated |= mask
            part_rgb = rgb
            part_alpha = alpha * soft(dilated, 0.9)
            part_alpha = np.maximum(part_alpha, soft(mask, 0.5) * np.clip(alpha + 0.15, 0, 1))

        ys, xs = np.nonzero(part_alpha > 0.02)
        if len(xs) == 0:
            continue
        x0, y0 = max(0, int(xs.min()) - 4), max(0, int(ys.min()) - 4)
        x1, y1 = min(w, int(xs.max()) + 5), min(h, int(ys.max()) + 5)

        tile = np.dstack(
            [
                np.clip(part_rgb[y0:y1, x0:x1], 0, 255),
                np.clip(part_alpha[y0:y1, x0:x1] * 255.0, 0, 255),
            ]
        ).astype(np.uint8)
        filename = f"part-{name}.png"
        Image.fromarray(tile).save(out_dir / filename, "PNG")
        parts_out.append(
            {
                "name": name,
                "src": filename,
                "x": round(x0 / w, 5),
                "y": round(y0 / h, 5),
                "w": round((x1 - x0) / w, 5),
                "h": round((y1 - y0) / h, 5),
                "pixelWidth": int(x1 - x0),
                "pixelHeight": int(y1 - y0),
            }
        )

    result: dict[str, Any] = {
        "width": w,
        "height": h,
        "parts": parts_out,
        "taxonomy": taxonomy_name,
        "limbTorsoOverlap": round(float(overlap), 4),
        "inpaintDilatePx": dilate_px,
        "pose": pose,
        "warnings": warnings,
    }

    if emit_spine:
        stem = config.get("spineStem") or image_path.stem or "character"
        bundle = export_spine_bundle(
            out_dir,
            width=w,
            height=h,
            parts=parts_out,
            pose=pose,
            bone_parents=tax["bone_parents"],
            part_bone=tax["part_bone"],
            stem=str(stem),
        )
        result["spineJson"] = bundle["spineJson"]
        result["atlas"] = bundle["atlas"]

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="SpineForge Vision Worker CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    psd_p = sub.add_parser("psd", help="Extract PSD layers into parts")
    psd_p.add_argument("input", type=Path)
    psd_p.add_argument("output_dir", type=Path)

    cut_p = sub.add_parser("cut", help="Cut flat image into parts with joint covers and inpainting")
    cut_p.add_argument("input", type=Path)
    cut_p.add_argument("output_dir", type=Path)
    cut_p.add_argument("--config", type=Path, required=True)
    cut_p.add_argument("--spine-json", action="store_true", help="Also write Spine 4.2 JSON + atlas")

    args = parser.parse_args()
    try:
        if args.cmd == "psd":
            res = extract_psd_layers(args.input, args.output_dir)
            print(json.dumps(res, indent=2))
        elif args.cmd == "cut":
            cfg = json.loads(args.config.read_text())
            if args.spine_json:
                cfg["emitSpineJson"] = True
            res = cut_flat_character(args.input, args.output_dir, cfg)
            print(json.dumps(res, indent=2))
    except PoseNotRiggableError as exc:
        err = {"error": str(exc), "code": exc.code, "overlap": exc.overlap}
        print(json.dumps(err), file=sys.stderr)
        print(json.dumps(err))
        sys.exit(2)


if __name__ == "__main__":
    main()
