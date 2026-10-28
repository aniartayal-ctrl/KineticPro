#!/usr/bin/env python3
"""Synthetic A-pose fixtures for the B-gated amodal cutter."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

_VISION_DIR = Path(__file__).resolve().parent
if str(_VISION_DIR) not in sys.path:
    sys.path.insert(0, str(_VISION_DIR))

from joints import apply_ball_joint_covers
from mask_ops import capsule_mask, disk_mask
from part_cutter import _FILL_LAYER, _backfill_part, cut_flat_character
from pose_gate import PoseNotRiggableError, build_pose_cut_graph, check_clear_limbs, estimate_a_pose_from_silhouette


def make_a_pose_rgba(w: int = 256, h: int = 384) -> np.ndarray:
    """Flat colored A-pose mannequin with dark outlines — arms clear of torso."""
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    # Body
    cv2.ellipse(rgba, (w // 2, int(h * 0.42)), (int(w * 0.14), int(h * 0.18)), 0, 0, 360, (70, 120, 200, 255), -1)
    # Head
    cv2.circle(rgba, (w // 2, int(h * 0.14)), int(w * 0.08), (220, 180, 150, 255), -1)
    # Legs
    cv2.ellipse(rgba, (int(w * 0.42), int(h * 0.78)), (int(w * 0.05), int(h * 0.16)), 0, 0, 360, (50, 90, 160, 255), -1)
    cv2.ellipse(rgba, (int(w * 0.58), int(h * 0.78)), (int(w * 0.05), int(h * 0.16)), 0, 0, 360, (50, 90, 160, 255), -1)
    # Arms out (A-pose)
    cv2.ellipse(rgba, (int(w * 0.22), int(h * 0.40)), (int(w * 0.12), int(h * 0.04)), -25, 0, 360, (220, 180, 150, 255), -1)
    cv2.ellipse(rgba, (int(w * 0.78), int(h * 0.40)), (int(w * 0.12), int(h * 0.04)), 25, 0, 360, (220, 180, 150, 255), -1)
    # Dark outline on full silhouette edge
    alpha = rgba[..., 3]
    edges = cv2.Canny(alpha, 50, 150)
    rgba[edges > 0, :3] = (10, 10, 10)
    return rgba


def make_crossed_pose_rgba(w: int = 256, h: int = 384) -> np.ndarray:
    """Arms painted across the torso — should trip the pose gate."""
    rgba = make_a_pose_rgba(w, h)
    # Paint a thick arm across the chest
    cv2.ellipse(rgba, (w // 2, int(h * 0.40)), (int(w * 0.22), int(h * 0.045)), 0, 0, 360, (220, 180, 150, 255), -1)
    return rgba


def test_ball_joint_overlap() -> None:
    h, w = 200, 120
    sil = np.ones((h, w), dtype=bool)
    masks = {
        "arm-upper-l": capsule_mask((h, w), (0.5, 0.2), (0.5, 0.5), 0.08),
        "arm-lower-l": capsule_mask((h, w), (0.5, 0.5), (0.5, 0.85), 0.07),
    }
    splits = [
        {
            "part": "arm-upper-l",
            "rest": "arm-upper-l",
            "pieces": [],
            "cover": {
                "from": "arm-lower-l",
                "center": [0.5, 0.5],
                "radius": 0.09,
                "pair": ["arm-upper-l", "arm-lower-l"],
            },
        }
    ]
    before = int((masks["arm-upper-l"] & masks["arm-lower-l"]).sum())
    after_masks = apply_ball_joint_covers(masks, splits, (h, w), sil)
    after = int((after_masks["arm-upper-l"] & after_masks["arm-lower-l"]).sum())
    assert after > before, f"expected coin overlap to grow ({before} -> {after})"
    assert after > 100, f"overlap too small: {after}"
    print("ok ball_joint_overlap", before, "->", after)


def test_cut_a_pose_and_spine() -> None:
    rgba = make_a_pose_rgba()
    with tempfile.TemporaryDirectory(prefix="amodal-test-") as tmp:
        tmp_path = Path(tmp)
        src = tmp_path / "hero.png"
        Image.fromarray(rgba).save(src)
        out = tmp_path / "out"
        pose = estimate_a_pose_from_silhouette(rgba[..., 3] > 0)
        cfg = {
            "trimSource": True,
            "taxonomy": "humanoid-v1",
            "usePose": True,
            "pose": pose,
            "requireClearLimbs": True,
            "maxLimbTorsoOverlap": 0.12,
            "outlineInterrupt": True,
            "emitSpineJson": True,
            "inpaintTorso": True,
            "spineStem": "hero",
        }
        result = cut_flat_character(src, out, cfg)
        names = {p["name"] for p in result["parts"]}
        assert "body" in names, names
        assert "head" in names, names
        assert any(n.startswith("arm-") for n in names), names
        spine_path = out / "hero.spine.json"
        assert spine_path.exists(), "missing spine json"
        spine = json.loads(spine_path.read_text())
        assert spine["skeleton"]["spine"].startswith("4.2")
        assert len(spine["bones"]) >= 3
        assert len(spine["slots"]) == len(result["parts"])
        assert "default" in [s["name"] for s in spine["skins"]]
        # Elbow coin overlap via graph covers
        graph = build_pose_cut_graph(pose, rgba[..., 3] > 0, "humanoid-v1", 1.1)
        assert any(s.get("cover") for s in graph["splits"])
        print("ok cut_a_pose_and_spine parts=", sorted(names), "bones=", len(spine["bones"]))


def test_pose_gate_rejects_crossed() -> None:
    rgba = make_crossed_pose_rgba()
    sil = rgba[..., 3] > 0
    pose = estimate_a_pose_from_silhouette(sil)
    # Fake a limb mask that sits on torso
    h, w = sil.shape
    limb = disk_mask((h, w), (0.5, 0.40), 0.12) & sil
    torso_heavy = {"arm-front": limb}
    try:
        check_clear_limbs(torso_heavy, pose, sil, max_overlap=0.08, require_clear=True)
        raise AssertionError("expected PoseNotRiggableError")
    except PoseNotRiggableError as exc:
        assert exc.code == "pose_not_riggable"
        print("ok pose_gate_rejects_crossed overlap=", round(exc.overlap or 0, 3))


def test_presentation_monopoly_fixture() -> None:
    """Promo/dealer art is the primary input class — must cut without hard refuse."""
    fixture = Path(__file__).resolve().parent / "fixtures" / "monopoly-woman.png"
    if not fixture.is_file():
        print("skip presentation_monopoly_fixture (no fixture)")
        return
    with tempfile.TemporaryDirectory(prefix="presentation-") as tmp:
        out = Path(tmp) / "out"
        cfg = {
            "trimSource": True,
            "taxonomy": "presentation",
            "usePose": True,
            "requireClearLimbs": False,
            "outlineInterrupt": True,
            "emitSpineJson": True,
            "inpaintTorso": True,
            "spineStem": "monopoly-woman",
        }
        result = cut_flat_character(fixture, out, cfg)
        names = {p["name"] for p in result["parts"]}
        assert "body" in names and "head" in names, names
        assert result.get("limbTorsoOverlap", 0) >= 0
        assert (out / "monopoly-woman.spine.json").exists()
        # Prefer extracting at least one arm or prop from real MediaPipe pose
        assert names & {"arm-upper-l", "arm-upper-r", "arm-lower-l", "arm-lower-r", "prop", "hair-front"}, names
        print(
            "ok presentation_monopoly_fixture",
            "parts=", sorted(names),
            "overlap=", result.get("limbTorsoOverlap"),
            "dilate=", result.get("inpaintDilatePx"),
            "warnings=", result.get("warnings"),
        )


def test_psd_fill_backfill() -> None:
    """FILL masks are flat red; the part grows under them in its own colours, never red."""
    part = Image.new("RGBA", (40, 40), (40, 90, 200, 255))
    fill = Image.new("RGBA", (30, 20), (255, 0, 60, 255))
    out, left, top = _backfill_part(part, 100, 50, [(fill, 80, 60)])
    assert (left, top) == (80, 50) and out.size == (60, 40), (left, top, out.size)
    arr = np.asarray(out)
    under = arr[10:30, 0:20]
    assert (under[..., 3] == 255).all(), "fill region must become opaque"
    assert (under[..., 0] < 120).all() and (under[..., 2] > 150).all(), "fill must take the part's colour"
    assert (arr[0:10, 0:20, 3] == 0).all(), "outside the fill stays transparent"
    assert _FILL_LAYER.match("FILL 09 > head (forehead)").group(1) == "head"
    assert _FILL_LAYER.match("FILL 03 > wing_L").group(1) == "wing_L"
    assert _FILL_LAYER.match("body") is None
    print("ok psd_fill_backfill")


def main() -> None:
    test_psd_fill_backfill()
    test_ball_joint_overlap()
    test_pose_gate_rejects_crossed()
    test_cut_a_pose_and_spine()
    test_presentation_monopoly_fixture()
    print("ALL PASSED")


if __name__ == "__main__":
    main()
