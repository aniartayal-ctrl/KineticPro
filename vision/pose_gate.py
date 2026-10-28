"""A-pose gate and pose → capsule / split graph for amodal cutting.

v1: prefers explicit pose landmarks in config; optionally MediaPipe; falls back to
A-pose silhouette heuristics. Refuses cuts when limbs heavily overlap the torso.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from mask_ops import capsule_mask, median_limb_halfwidth


PoseDict = dict[str, list[float]]  # name -> [x, y] normalized


REQUIRED_LANDMARKS = (
    "hips",
    "chest",
    "head",
    "leftShoulder",
    "rightShoulder",
    "leftElbow",
    "rightElbow",
    "leftWrist",
    "rightWrist",
)


class PoseNotRiggableError(ValueError):
    """Raised when the character pose is too occluded for safe joint cuts."""

    def __init__(self, message: str, overlap: float | None = None):
        super().__init__(message)
        self.code = "pose_not_riggable"
        self.overlap = overlap


def _clamp01(v: float) -> float:
    return float(max(0.0, min(1.0, v)))


def normalize_pose(raw: dict[str, Any] | None) -> PoseDict | None:
    if not raw:
        return None
    out: PoseDict = {}
    for key, val in raw.items():
        if isinstance(val, (list, tuple)) and len(val) >= 2:
            out[key] = [_clamp01(float(val[0])), _clamp01(float(val[1]))]
    return out or None


def try_mediapipe_pose(rgba: np.ndarray) -> PoseDict | None:
    """Optional MediaPipe Pose Landmarker (tasks API); None if unavailable."""
    try:
        from mediapipe import Image as MpImage
        from mediapipe import ImageFormat
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python import vision as mp_vision
    except ImportError:
        return None

    model_path = Path(__file__).resolve().parent / "models" / "pose_landmarker_lite.task"
    if not model_path.is_file():
        return None

    rgb = np.ascontiguousarray(rgba[..., :3])
    mp_image = MpImage(image_format=ImageFormat.SRGB, data=rgb)
    options = mp_vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model_path)),
        running_mode=mp_vision.RunningMode.IMAGE,
        num_poses=1,
    )
    with mp_vision.PoseLandmarker.create_from_options(options) as landmarker:
        result = landmarker.detect(mp_image)
    if not result.pose_landmarks:
        return None
    lm = result.pose_landmarks[0]

    def pt(idx: int) -> list[float]:
        p = lm[idx]
        return [_clamp01(p.x), _clamp01(p.y)]

    # Landmark indices match classic BlazePose / MediaPipe Pose
    return {
        "head": pt(0),
        "leftShoulder": pt(11),
        "rightShoulder": pt(12),
        "leftElbow": pt(13),
        "rightElbow": pt(14),
        "leftWrist": pt(15),
        "rightWrist": pt(16),
        "leftHip": pt(23),
        "rightHip": pt(24),
        "leftKnee": pt(25),
        "rightKnee": pt(26),
        "leftAnkle": pt(27),
        "rightAnkle": pt(28),
        "hips": [
            _clamp01((lm[23].x + lm[24].x) * 0.5),
            _clamp01((lm[23].y + lm[24].y) * 0.5),
        ],
        "chest": [
            _clamp01((lm[11].x + lm[12].x) * 0.5),
            _clamp01((lm[11].y + lm[12].y) * 0.5 + 0.04),
        ],
    }


def estimate_a_pose_from_silhouette(silhouette: np.ndarray) -> PoseDict:
    """Heuristic A-pose landmarks from alpha silhouette bbox (normalized)."""
    ys, xs = np.nonzero(silhouette)
    if len(xs) == 0:
        # Degenerate fallback centered figure
        return {
            "hips": [0.5, 0.62],
            "chest": [0.5, 0.38],
            "head": [0.5, 0.14],
            "leftShoulder": [0.62, 0.30],
            "rightShoulder": [0.38, 0.30],
            "leftElbow": [0.78, 0.42],
            "rightElbow": [0.22, 0.42],
            "leftWrist": [0.88, 0.55],
            "rightWrist": [0.12, 0.55],
            "leftHip": [0.56, 0.62],
            "rightHip": [0.44, 0.62],
            "leftKnee": [0.58, 0.78],
            "rightKnee": [0.42, 0.78],
            "leftAnkle": [0.58, 0.94],
            "rightAnkle": [0.42, 0.94],
        }

    h, w = silhouette.shape
    x0, x1 = float(xs.min()), float(xs.max())
    y0, y1 = float(ys.min()), float(ys.max())
    bw = max(1.0, x1 - x0)
    bh = max(1.0, y1 - y0)
    cx = (x0 + x1) * 0.5 / w

    def n(px: float, py: float) -> list[float]:
        return [_clamp01(px / w), _clamp01(py / h)]

    head = n(cx * w, y0 + bh * 0.08)
    chest = n(cx * w, y0 + bh * 0.32)
    hips = n(cx * w, y0 + bh * 0.55)
    # Arms clear of torso in classic A-pose
    return {
        "head": head,
        "chest": chest,
        "hips": hips,
        "leftShoulder": n(x0 + bw * 0.68, y0 + bh * 0.28),
        "rightShoulder": n(x0 + bw * 0.32, y0 + bh * 0.28),
        "leftElbow": n(x0 + bw * 0.88, y0 + bh * 0.42),
        "rightElbow": n(x0 + bw * 0.12, y0 + bh * 0.42),
        "leftWrist": n(x0 + bw * 0.98, y0 + bh * 0.55),
        "rightWrist": n(x0 + bw * 0.02, y0 + bh * 0.55),
        "leftHip": n(x0 + bw * 0.58, y0 + bh * 0.55),
        "rightHip": n(x0 + bw * 0.42, y0 + bh * 0.55),
        "leftKnee": n(x0 + bw * 0.60, y0 + bh * 0.75),
        "rightKnee": n(x0 + bw * 0.40, y0 + bh * 0.75),
        "leftAnkle": n(x0 + bw * 0.60, y0 + bh * 0.95),
        "rightAnkle": n(x0 + bw * 0.40, y0 + bh * 0.95),
    }


def resolve_pose(
    config: dict[str, Any],
    rgba: np.ndarray,
    silhouette: np.ndarray,
) -> PoseDict:
    pose = normalize_pose(config.get("pose"))
    if pose and all(k in pose for k in ("hips", "chest", "head")):
        # Fill missing limb tips from silhouette estimate
        est = estimate_a_pose_from_silhouette(silhouette)
        for k, v in est.items():
            pose.setdefault(k, v)
        return pose

    mp_pose = try_mediapipe_pose(rgba)
    if mp_pose:
        return mp_pose

    return estimate_a_pose_from_silhouette(silhouette)


def _seg(
    pose: PoseDict,
    a_key: str,
    b_key: str,
    silhouette: np.ndarray,
    radius_scale: float,
) -> list[float] | None:
    if a_key not in pose or b_key not in pose:
        return None
    a = (pose[a_key][0], pose[a_key][1])
    b = (pose[b_key][0], pose[b_key][1])
    half = median_limb_halfwidth(silhouette, a, b)
    radius = max(0.025, half * radius_scale)
    return [a[0], a[1], b[0], b[1], radius]


def build_pose_cut_graph(
    pose: PoseDict,
    silhouette: np.ndarray,
    taxonomy: str,
    joint_cover_scale: float = 1.1,
) -> dict[str, Any]:
    """Build capsules, splits (with ball-joint covers), and priority from pose."""
    rs = 1.35  # capsule radius vs measured half-width

    if taxonomy in ("humanoid-v1", "presentation"):
        capsules: dict[str, list[list[float]]] = {}
        for name, a_key, b_key in (
            ("head", "head", "chest"),
            ("arm-upper-r", "rightShoulder", "rightElbow"),
            ("arm-lower-r", "rightElbow", "rightWrist"),
            ("arm-upper-l", "leftShoulder", "leftElbow"),
            ("arm-lower-l", "leftElbow", "leftWrist"),
            ("leg-upper-r", "rightHip", "rightKnee"),
            ("leg-lower-r", "rightKnee", "rightAnkle"),
            ("leg-upper-l", "leftHip", "leftKnee"),
            ("leg-lower-l", "leftKnee", "leftAnkle"),
        ):
            seg = _seg(pose, a_key, b_key, silhouette, rs)
            if seg:
                # Head: shorten toward crown
                if name == "head":
                    seg = [pose["head"][0], max(0.02, pose["head"][1] - 0.06), pose["head"][0], pose["head"][1] + 0.02, max(0.06, seg[4] * 1.2)]
                capsules[name] = [seg]

        # Hands / feet as short capsules from wrist/ankle tips
        for name, tip, parent in (
            ("hand-r", "rightWrist", "rightElbow"),
            ("hand-l", "leftWrist", "leftElbow"),
            ("foot-r", "rightAnkle", "rightKnee"),
            ("foot-l", "leftAnkle", "leftKnee"),
        ):
            if tip not in pose or parent not in pose:
                continue
            tx, ty = pose[tip]
            px, py = pose[parent]
            dx, dy = tx - px, ty - py
            length = max(1e-3, (dx * dx + dy * dy) ** 0.5)
            ex, ey = tx + dx / length * 0.04, ty + dy / length * 0.04
            half = median_limb_halfwidth(silhouette, (tx, ty), (ex, ey))
            capsules[name] = [[tx, ty, ex, ey, max(0.02, half * rs)]]

        splits: list[dict[str, Any]] = []
        # Ball-joint covers at elbows / knees / shoulders / hips
        joint_specs = [
            ("arm-upper-r", "arm-lower-r", "rightElbow"),
            ("arm-upper-l", "arm-lower-l", "leftElbow"),
            ("leg-upper-r", "leg-lower-r", "rightKnee"),
            ("leg-upper-l", "leg-lower-l", "leftKnee"),
        ]
        for upper, lower, joint_key in joint_specs:
            if joint_key not in pose or upper not in capsules or lower not in capsules:
                continue
            r = max(capsules[upper][0][4], capsules[lower][0][4]) * joint_cover_scale
            cx, cy = pose[joint_key]
            # Perpendicular split line through joint
            ux, uy = capsules[upper][0][0], capsules[upper][0][1]
            lx, ly = capsules[lower][0][2], capsules[lower][0][3]
            dx, dy = lx - ux, ly - uy
            # Line perpendicular to limb axis
            nx, ny = -dy, dx
            norm = max(1e-6, (nx * nx + ny * ny) ** 0.5)
            nx, ny = nx / norm * 0.08, ny / norm * 0.08
            splits.append(
                {
                    "part": upper,
                    "rest": upper,
                    "pieces": [],
                    "cover": {
                        "from": lower,
                        "center": [cx, cy],
                        "radius": r,
                        "pair": [upper, lower],
                    },
                }
            )
            # Also attach cover onto lower via a second entry
            splits.append(
                {
                    "part": lower,
                    "rest": lower,
                    "pieces": [],
                    "cover": {
                        "from": upper,
                        "center": [cx, cy],
                        "radius": r,
                        "pair": [upper, lower],
                    },
                }
            )

        priority = [
            "hand-r",
            "hand-l",
            "arm-lower-r",
            "arm-lower-l",
            "arm-upper-r",
            "arm-upper-l",
            "foot-r",
            "foot-l",
            "leg-lower-r",
            "leg-lower-l",
            "leg-upper-r",
            "leg-upper-l",
            "head",
        ]
        return {"capsules": capsules, "splits": splits, "priority": priority, "pose": pose}

    # Legacy 3/4 hero: back arm, front arm, head, optional weapon from wrist
    capsules = {}
    for name, a_key, b_key in (
        ("head", "head", "chest"),
        ("arm-back", "rightShoulder", "rightWrist"),
        ("arm-front", "leftShoulder", "leftElbow"),
    ):
        seg = _seg(pose, a_key, b_key, silhouette, rs)
        if seg:
            if name == "head":
                seg = [pose["head"][0], max(0.02, pose["head"][1] - 0.06), pose["head"][0], pose["head"][1] + 0.02, max(0.06, seg[4] * 1.2)]
            capsules[name] = [seg]

    forearm = _seg(pose, "leftElbow", "leftWrist", silhouette, rs)
    splits = []
    if forearm and "arm-front" in capsules:
        capsules["forearm"] = [forearm]
        elbow = pose.get("leftElbow", [0.78, 0.34])
        r = max(capsules["arm-front"][0][4], forearm[4]) * joint_cover_scale
        # Split arm-front at elbow line
        sh = pose["leftShoulder"]
        wr = pose["leftWrist"]
        dx, dy = wr[0] - sh[0], wr[1] - sh[1]
        nx, ny = -dy, dx
        norm = max(1e-6, (nx * nx + ny * ny) ** 0.5)
        nx, ny = nx / norm * 0.1, ny / norm * 0.1
        splits.append(
            {
                "part": "arm-front",
                "rest": "arm-front",
                "pieces": [
                    {
                        "name": "forearm",
                        "side": "below",
                        "line": [[elbow[0] - nx, elbow[1] - ny], [elbow[0] + nx, elbow[1] + ny]],
                    }
                ],
                "cover": {"from": "forearm", "center": elbow, "radius": r, "pair": ["arm-front", "forearm"]},
            }
        )

    if "leftWrist" in pose:
        wx, wy = pose["leftWrist"]
        capsules["weapon"] = [[wx, wy, wx, min(0.98, wy + 0.35), 0.10]]

    priority = ["weapon", "forearm", "arm-front", "arm-back", "head"]
    return {"capsules": capsules, "splits": splits, "priority": priority, "pose": pose}


def torso_mask_from_pose(shape: tuple[int, int], pose: PoseDict, silhouette: np.ndarray) -> np.ndarray:
    """Approximate core torso (excludes shoulder bulbs) as a narrow hips→chest capsule."""
    hips = pose.get("hips", [0.5, 0.6])
    chest = pose.get("chest", [0.5, 0.35])
    # Narrow core only — shoulders/arms live outside this band in a true A-pose
    torso = capsule_mask(shape, (hips[0], hips[1]), (chest[0], chest[1]), 0.07)
    return torso & silhouette


def _shoulder_exclusion(shape: tuple[int, int], pose: PoseDict) -> np.ndarray:
    """Disks around shoulders so natural deltoid overlap does not trip the gate."""
    from mask_ops import disk_mask

    h, _w = shape
    excl = np.zeros(shape, dtype=bool)
    for key in ("leftShoulder", "rightShoulder"):
        if key in pose:
            excl |= disk_mask(shape, (pose[key][0], pose[key][1]), 0.06)
    return excl


def check_clear_limbs(
    part_masks: dict[str, np.ndarray],
    pose: PoseDict,
    silhouette: np.ndarray,
    max_overlap: float = 0.08,
    require_clear: bool = True,
) -> float:
    """Return max limb∩torso overlap fraction. Raise if require_clear and over threshold.

    Shoulder disks are excluded so a correct A-pose (arms clear, deltoids near chest)
    does not false-positive; crossed arms over the belly still trip the gate.
    """
    shape = silhouette.shape
    torso = torso_mask_from_pose(shape, pose, silhouette) & ~_shoulder_exclusion(shape, pose)
    limb_keys = [
        k
        for k in part_masks
        if k.startswith("arm-") or k.startswith("hand-") or k in ("arm-front", "arm-back", "forearm", "weapon")
    ]
    max_frac = 0.0
    for key in limb_keys:
        mask = part_masks[key]
        area = float(mask.sum())
        if area < 1:
            continue
        frac = float((mask & torso).sum()) / area
        max_frac = max(max_frac, frac)

    if require_clear and max_frac > max_overlap:
        raise PoseNotRiggableError(
            f"Limb-torso overlap {max_frac:.1%} exceeds {max_overlap:.0%}. "
            "Use a clear A-pose (arms off the torso) or set requireClearLimbs=false.",
            overlap=max_frac,
        )
    return max_frac
