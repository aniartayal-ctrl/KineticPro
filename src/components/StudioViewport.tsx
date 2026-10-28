"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { SpineForgeAnimator } from "@/core/animator";
import { compute25DParallaxBoneOffsets } from "@/core/parallax-and-lipsync";
import { patchKeyAt, snapTime, type Channel } from "@/core/keyframes";
import { RIG_BONE_PALETTE, type TransformKey } from "@/core/schema";
import { applyAffine, buildSkeleton, deformMeshVerticesCPU } from "@/core/solver";
import { evaluateElementalVfx, generateUnity2DColliders } from "@/core/vfx-colliders-profiler";
import { SpineForgeWebGLRenderer, type GhostFramePass, type ViewCamera } from "@/core/webgl-renderer";
import { buildPartMesh, computeVertexHeatmapColors } from "@/core/weights";
import { usePreferencesStore } from "@/store/usePreferencesStore";
import { useStudioNoTime, useStudioStore } from "@/store/useStudioStore";

const edgeCache = new WeakMap<object, Uint32Array>();

/** Unique triangle edges as vertex index pairs, computed once per mesh object. */
function uniqueEdges(mesh: object, indices: ArrayLike<number>): Uint32Array {
  const cached = edgeCache.get(mesh);
  if (cached) return cached;
  const seen = new Set<number>();
  const out: number[] = [];
  const add = (a: number, b: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * 1_000_003 + hi;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(lo, hi);
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    add(indices[t]!, indices[t + 1]!);
    add(indices[t + 1]!, indices[t + 2]!);
    add(indices[t + 2]!, indices[t]!);
  }
  const edges = Uint32Array.from(out);
  edgeCache.set(mesh, edges);
  return edges;
}

export function StudioViewport() {
  const {
    project,
    mode,
    selectedBone,
    selectedPart,
    activeClip,
    playbackSpeed,
    heatmapSingleBone,
    selectBone,
    previewBone,
    applyWeightBrush,
    applyLiquifyBrush,
    transformTool,
    editActiveClip,
    commitPreview,
    swapToPreviousTool,
    setCurrentTime,
    setParallaxConfig,
  } = useStudioNoTime();

  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SpineForgeWebGLRenderer | null>(null);
  const animatorRef = useRef<SpineForgeAnimator | null>(null);
  const ghostAnimatorRef = useRef<SpineForgeAnimator | null>(null);
  const pointerRigPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastBrushRigPosRef = useRef<{ x: number; y: number } | null>(null);
  const draggingBoneRef = useRef<{
    boneName: string;
    startRigX: number;
    startRigY: number;
    origX: number;
    origY: number;
    origR: number;
    origSx: number;
    origSy: number;
    /** Track and frame at drag start; every move re-derives from these, so drags never accumulate drift. */
    origTrack: TransformKey[];
    time: number;
    lastTool: "rotate" | "translate" | "scale" | "pivot";
    moved: boolean;
  } | null>(null);
  const isPaintingRef = useRef(false);
  const panningRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const [loadedProjectId, setLoadedProjectId] = useState<string>("");

  // Decode part images and initialize WebGL2 renderer
  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    if (!glCanvas) return;

    let cancelled = false;
    const images: Record<string, HTMLImageElement> = {};

    Promise.all(
      project.parts.map((part) => {
        return new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => {
            images[part.name] = img;
            resolve();
          };
          img.onerror = () => resolve();
          img.src = part.src;
        });
      }),
    ).then(() => {
      if (cancelled) return;
      rendererRef.current?.destroy();
      const skeleton = buildSkeleton(project);
      const renderer = new SpineForgeWebGLRenderer(glCanvas, skeleton, images, {
        preserveDrawingBuffer: true,
      });
      rendererRef.current = renderer;
      animatorRef.current = new SpineForgeAnimator(project, activeClip);
      ghostAnimatorRef.current = new SpineForgeAnimator(project, activeClip);
      setLoadedProjectId(project.id + ":" + project.parts.length);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.parts.length]);

  // Sync mesh weight changes & heatmap colors to GPU buffers
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const selectedBoneIdx = heatmapSingleBone
      ? project.bones.findIndex((b) => b.name === selectedBone)
      : -1;

    for (const part of project.parts) {
      const mesh = part.mesh ?? buildPartMesh(project, part);
      const heat = computeVertexHeatmapColors(mesh, project.bones, selectedBoneIdx);
      renderer.updatePartWeightsAndHeatmap(part.name, mesh, heat);
    }
    animatorRef.current = new SpineForgeAnimator(project, activeClip);
    ghostAnimatorRef.current = new SpineForgeAnimator(project, activeClip);
  }, [project, selectedBone, heatmapSingleBone, activeClip, loadedProjectId]);

  // Main render & animation loop
  useEffect(() => {
    let rafId = 0;
    let lastNow = performance.now();
    // Render on demand: while playing, and for a short settle window after any state change or
    // pointer movement (physics and brush cursors need a few frames). Idle studios stay cool.
    let lastState: unknown = null;
    let lastActivity = performance.now();
    const SETTLE_MS = 1500;
    const onActivity = () => {
      lastActivity = performance.now();
    };
    window.addEventListener("pointermove", onActivity, { passive: true });
    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("resize", onActivity);

    let lastFrameAt = 0;
    const tick = (now: number) => {
      const prefs = usePreferencesStore.getState();
      const minFrameMs = 1000 / Math.max(30, prefs.maxFps);
      if (now - lastFrameAt < minFrameMs - 0.5) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      lastFrameAt = now;
      const dt = Math.min(0.05, (now - lastNow) / 1000) * playbackSpeed;
      lastNow = now;

      const store = useStudioStore.getState();
      if (store !== lastState) {
        lastState = store;
        lastActivity = now;
      }
      if (!store.isPlaying && now - lastActivity > SETTLE_MS) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const renderer = rendererRef.current;
      const animator = animatorRef.current;
      const ghostAnim = ghostAnimatorRef.current;
      const overlay = overlayCanvasRef.current;

      if (renderer && animator && overlay) {
        const clip = store.project.animations[store.activeClip];
        const duration = clip?.duration ?? 2.4;
        let evalTime = store.currentTime;
        if (store.isPlaying && store.mode !== "rig" && store.mode !== "mesh") {
          evalTime = (((store.currentTime + dt * store.playDirection) % duration) + duration) % duration;
          setCurrentTime(evalTime);
        } else if (store.mode === "rig" || store.mode === "mesh") {
          evalTime = 0;
        }

        // Onion-skin: depth pairs of prev/next ghosts (Preferences → onionSkinDepth / opacity).
        const ghostFrames: GhostFramePass[] = [];
        if (store.showOnionSkin && ghostAnim && store.mode !== "rig" && store.mode !== "mesh") {
          const prefs = usePreferencesStore.getState();
          const depth = prefs.onionSkinDepth;
          const baseOp = prefs.onionSkinOpacity;
          ghostAnim.setClip(store.activeClip);
          const step = 0.1;
          for (let i = depth; i >= 1; i--) {
            const fade = baseOp * (1 - (i - 1) / (depth + 0.5));
            const prevT = ((evalTime - step * i) % duration + duration) % duration;
            const nextT = (evalTime + step * i) % duration;
            const prevFrame = ghostAnim.evaluateAt(prevT, 0);
            const nextFrame = ghostAnim.evaluateAt(nextT, 0);
            ghostFrames.push(
              {
                skin: new Float32Array(prevFrame.skin),
                order: prevFrame.order.filter((n) => !store.hiddenParts.includes(n)),
                tint: [0.15, 0.85, 1.0, fade],
              },
              {
                skin: new Float32Array(nextFrame.skin),
                order: nextFrame.order.filter((n) => !store.hiddenParts.includes(n)),
                tint: [1.0, 0.38, 0.78, fade * 0.85],
              },
            );
          }
        }

        animator.setClip(store.activeClip);
        const parallaxOffsets = compute25DParallaxBoneOffsets(store.project, store.parallax, evalTime);
        const frame = animator.evaluateAt(
          evalTime,
          store.mode === "rig" || store.mode === "mesh" ? 0 : dt,
          store.mode === "rig" || store.mode === "mesh" ? undefined : parallaxOffsets,
        );

        const visibleOrder = frame.order.filter((name) => !store.hiddenParts.includes(name));
        const activeSkinObj = store.project.skins?.find((s) => s.name === store.activeSkinName);
        const lightRad = (store.lightAngleDeg * Math.PI) / 180;
        const lightDir: [number, number, number] = [
          Math.cos(lightRad) * 0.75,
          Math.sin(lightRad) * 0.75,
          0.68,
        ];

        const pixelRatio = Math.max(0.75, Math.min(2, usePreferencesStore.getState().pixelRatio));
        const camera: ViewCamera = { zoom: store.viewZoom, panX: store.viewPanX, panY: store.viewPanY };
        renderer.draw({
          skin: frame.skin,
          order: visibleOrder,
          deforms: frame.deforms,
          flash: frame.fx.flash,
          heatmapMix:
            store.showHeatmap || store.mode === "weights"
              ? store.mode === "weights" && !store.showHeatmap
                ? 0.55
                : 0.78
              : 0,
          selectedPart: store.selectedPart,
          isolateSelectedPart: store.isolatePart,
          skinTintHex: activeSkinObj?.tint,
          rimHex: activeSkinObj?.rimColor,
          flashHex: activeSkinObj?.flashColor,
          lightDir,
          lightIntensity: store.enable3DRelight ? store.lightIntensity : 0,
          ghostFrames,
          pixelRatio,
          camera,
        });

        // Draw 2D gizmo overlay (wireframe, motion arcs, weapon slash trails, capsules, bones, brush cursor)
        const dpr = pixelRatio;
        const w = Math.max(1, Math.round(overlay.clientWidth * dpr));
        const h = Math.max(1, Math.round(overlay.clientHeight * dpr));
        if (overlay.width !== w || overlay.height !== h) {
          overlay.width = w;
          overlay.height = h;
        }
        store.setViewCanvasSize(w, h);

        const ctx = overlay.getContext("2d")!;
        ctx.clearRect(0, 0, w, h);
        const { scale, offsetX, offsetY } = renderer.getViewMetrics(w, h, camera);
        const toScreen = (rx: number, ry: number): [number, number] => [
          rx * scale + offsetX,
          ry * scale + offsetY,
        ];

        // 0A. Weapon Slash Ribbon Trail (when showSlashTrail is active during action clips)
        if (store.showSlashTrail && ghostAnim && store.activeClip !== "idle" && (store.mode === "animate" || store.mode === "auto")) {
          const weaponIdx = store.project.bones.findIndex((b) => b.name === "weapon");
          if (weaponIdx >= 0) {
            const trailSteps = 10;
            const spanSec = 0.18;
            const outerPts: [number, number][] = [];
            const innerPts: [number, number][] = [];
            ghostAnim.setClip(store.activeClip);
            for (let s = 0; s <= trailSteps; s++) {
              const sampleT = Math.max(0, evalTime - ((trailSteps - s) / trailSteps) * spanSec);
              const tf = ghostAnim.evaluateAt(sampleT, 0);
              const wMat = tf.world[weaponIdx]!;
              const tipLen = 0.24 * store.project.height;
              const baseLen = 0.08 * store.project.height;
              const [ox, oy] = applyAffine(wMat, 0, tipLen);
              const [ix, iy] = applyAffine(wMat, 0, baseLen);
              outerPts.push(toScreen(ox, oy));
              innerPts.push(toScreen(ix, iy));
            }
            if (outerPts.length >= 2) {
              ctx.save();
              ctx.beginPath();
              ctx.moveTo(outerPts[0]![0], outerPts[0]![1]);
              for (let i = 1; i < outerPts.length; i++) ctx.lineTo(outerPts[i]![0], outerPts[i]![1]);
              for (let i = innerPts.length - 1; i >= 0; i--) ctx.lineTo(innerPts[i]![0], innerPts[i]![1]);
              ctx.closePath();
              const grad = ctx.createLinearGradient(
                outerPts[0]![0],
                outerPts[0]![1],
                outerPts[outerPts.length - 1]![0],
                outerPts[outerPts.length - 1]![1],
              );
              grad.addColorStop(0, "rgba(56, 189, 248, 0.0)");
              grad.addColorStop(0.6, "rgba(56, 189, 248, 0.24)");
              grad.addColorStop(1, "rgba(250, 204, 21, 0.55)");
              ctx.fillStyle = grad;
              ctx.fill();
              ctx.restore();
            }
          }
        }

        // 0A-2. GPU Elemental VFX & Particle System (Lightning Bolts, Fire Aura, Shockwaves, Coin Fountain, Star Sparks)
        if (store.activeVfx !== "none") {
          const weaponIdx = store.project.bones.findIndex((b) => b.name === "weapon");
          const wMat = weaponIdx >= 0 ? frame.world[weaponIdx]! : frame.world[0]!;
          const rMat = frame.world[0]!;
          const vfxPrims = evaluateElementalVfx(
            store.project,
            store.activeVfx,
            evalTime,
            [wMat[4], wMat[5]],
            [rMat[4], rMat[5]],
          );
          ctx.save();
          for (const prim of vfxPrims) {
            ctx.globalAlpha = Math.max(0, Math.min(1, prim.alpha));
            if (prim.kind === "bolt" && prim.points.length >= 2) {
              ctx.strokeStyle = prim.color;
              ctx.lineWidth = prim.width;
              ctx.shadowColor = "#38bdf8";
              ctx.shadowBlur = 12;
              ctx.beginPath();
              const [sx0, sy0] = toScreen(prim.points[0]![0], prim.points[0]![1]);
              ctx.moveTo(sx0, sy0);
              for (let i = 1; i < prim.points.length; i++) {
                const [sxi, syi] = toScreen(prim.points[i]![0], prim.points[i]![1]);
                ctx.lineTo(sxi, syi);
              }
              ctx.stroke();
            } else if (prim.kind === "ring") {
              const [cx, cy] = toScreen(prim.x, prim.y);
              ctx.strokeStyle = prim.color;
              ctx.lineWidth = prim.width;
              ctx.beginPath();
              ctx.ellipse(cx, cy, prim.rx * scale, prim.ry * scale, 0, 0, Math.PI * 2);
              ctx.stroke();
            } else if (prim.kind === "particle") {
              const [px, py] = toScreen(prim.x, prim.y);
              const pr = prim.radius * scale;
              ctx.fillStyle = prim.color;
              ctx.beginPath();
              if (prim.shape === "coin") {
                ctx.ellipse(
                  px,
                  py,
                  Math.max(2, Math.abs(Math.cos(prim.rotation)) * pr),
                  pr,
                  0,
                  0,
                  Math.PI * 2,
                );
              } else {
                ctx.arc(px, py, pr, 0, Math.PI * 2);
              }
              ctx.fill();
            }
          }
          ctx.restore();
        }

        // 0A-3. Unity 2D Hitbox & PolygonCollider2D Overlay (when showHitboxes is enabled)
        if (store.showHitboxes) {
          const colliders = generateUnity2DColliders(store.project, 100);
          ctx.save();
          for (const col of colliders) {
            const bIdx = store.project.bones.findIndex((b) => b.name === col.boneName);
            const m = bIdx >= 0 ? frame.world[bIdx]! : frame.world[0]!;
            const stroke =
              col.role === "hitbox_weapon"
                ? "#f43f5e"
                : col.role === "hurtbox_head"
                  ? "#38bdf8"
                  : "#22c55e";
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 2]);
            ctx.beginPath();
            col.polygonPathsMeters.forEach(([lxMeters, lyMeters], idx) => {
              const localPxX = lxMeters * 100;
              const localPxY = -lyMeters * 100;
              const [wx, wy] = applyAffine(m, localPxX, localPxY);
              const [sx, sy] = toScreen(wx, wy);
              if (idx === 0) ctx.moveTo(sx, sy);
              else ctx.lineTo(sx, sy);
            });
            ctx.closePath();
            ctx.stroke();
          }
          ctx.setLineDash([]);
          ctx.restore();
        }

        // 0B. Selected Bone Motion Arc Trajectory (when showMotionArcs is active)
        if (store.showMotionArcs && ghostAnim && store.selectedBone) {
          const selIdx = store.project.bones.findIndex((b) => b.name === store.selectedBone);
          if (selIdx > 0) {
            const arcSteps = 28;
            ctx.save();
            ctx.strokeStyle = "rgba(250, 204, 21, 0.65)";
            ctx.lineWidth = 1.6;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ghostAnim.setClip(store.activeClip);
            for (let s = 0; s <= arcSteps; s++) {
              const st = (s / arcSteps) * duration;
              const af = ghostAnim.evaluateAt(st, 0);
              const m = af.world[selIdx]!;
              const [sx, sy] = toScreen(m[4], m[5]);
              if (s === 0) ctx.moveTo(sx, sy);
              else ctx.lineTo(sx, sy);
            }
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
        }

        // 1. Draw Delaunay Mesh Wireframe
        if (store.showMeshWireframe) {
          for (const partName of visibleOrder) {
            if (store.isolatePart && store.selectedPart && store.selectedPart !== partName) continue;
            const part = store.project.parts.find((p) => p.name === partName);
            if (!part?.mesh) continue;
            const isSelectedPart = store.selectedPart === partName;
            const deformed = deformMeshVerticesCPU(part.mesh, frame.skin, frame.deforms[partName]);
            const indices = part.mesh.indices;

            ctx.strokeStyle = isSelectedPart ? "rgba(103, 232, 249, 0.58)" : "rgba(148, 163, 184, 0.18)";
            ctx.lineWidth = isSelectedPart ? 1.25 : 0.75;
            // Each shared edge once (half the segments of drawing every triangle), cached per mesh.
            const edges = uniqueEdges(part.mesh, indices);
            ctx.beginPath();
            for (let e = 0; e < edges.length; e += 2) {
              const a = edges[e]!;
              const b = edges[e + 1]!;
              const [ax, ay] = toScreen(deformed[a * 2]!, deformed[a * 2 + 1]!);
              const [bx, by] = toScreen(deformed[b * 2]!, deformed[b * 2 + 1]!);
              ctx.moveTo(ax, ay);
              ctx.lineTo(bx, by);
            }
            ctx.stroke();

            if (isSelectedPart && (store.mode === "mesh" || store.mode === "weights" || store.mode === "liquify")) {
              const vCount = deformed.length / 2;
              for (let v = 0; v < vCount; v++) {
                const [vx, vy] = toScreen(deformed[v * 2]!, deformed[v * 2 + 1]!);
                const isHull = v < part.mesh.hullCount;
                ctx.fillStyle = isHull ? "#67e8f9" : "rgba(248, 250, 252, 0.85)";
                ctx.beginPath();
                ctx.arc(vx, vy, isHull ? 2.5 : 1.7, 0, Math.PI * 2);
                ctx.fill();
              }
            }
          }
        }

        // 2. Draw Capsule Weight Envelopes
        if (store.showCapsules) {
          store.project.bones.forEach((bone, bIdx) => {
            if (!bone.regions) return;
            const col = bone.color ?? RIG_BONE_PALETTE[bIdx % RIG_BONE_PALETTE.length]!;
            const isSel = bone.name === store.selectedBone;
            ctx.strokeStyle = col;
            ctx.lineWidth = isSel ? 2.2 : 1.2;
            ctx.setLineDash([6, 4]);
            for (const [ax, ay, bx, by, radius] of bone.regions) {
              const [sax, say] = toScreen(ax * store.project.width, ay * store.project.height);
              const [sbx, sby] = toScreen(bx * store.project.width, by * store.project.height);
              const rPx = radius * store.project.height * scale;
              ctx.beginPath();
              ctx.arc(sax, say, rPx, 0, Math.PI * 2);
              ctx.arc(sbx, sby, rPx, 0, Math.PI * 2);
              ctx.stroke();
            }
            ctx.setLineDash([]);
          });
        }

        // 3. Draw Bone Hierarchy & IK Gizmos
        if (store.showBones) {
          const skeleton = animator.skeleton;
          store.project.bones.forEach((bone, i) => {
            const worldMat = frame.world[i]!;
            const [bx, by] = toScreen(worldMat[4], worldMat[5]);
            const pIdx = skeleton.parents[i]!;
            const col = bone.color ?? RIG_BONE_PALETTE[i % RIG_BONE_PALETTE.length]!;
            const isSelected = bone.name === store.selectedBone;
            const isIkTarget = bone.name.startsWith("ik-");

            if (pIdx >= 0 && !isIkTarget) {
              const pMat = frame.world[pIdx]!;
              const [px, py] = toScreen(pMat[4], pMat[5]);
              ctx.strokeStyle = isSelected ? "#ffffff" : col;
              ctx.lineWidth = isSelected ? 3 : 2;
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(bx, by);
              ctx.stroke();
            }

            const lenPx = (bone.length ?? 0.06) * store.project.height;
            const [tipRigX, tipRigY] = applyAffine(worldMat, lenPx, 0);
            const [tx, ty] = toScreen(tipRigX, tipRigY);

            if (isIkTarget) {
              ctx.strokeStyle = isSelected ? "#fde047" : "#ffffff";
              ctx.lineWidth = 2;
              const s = isSelected ? 9 : 7;
              ctx.beginPath();
              ctx.moveTo(bx, by - s);
              ctx.lineTo(bx + s, by);
              ctx.lineTo(bx, by + s);
              ctx.lineTo(bx - s, by);
              ctx.closePath();
              ctx.stroke();
            } else {
              ctx.beginPath();
              ctx.arc(bx, by, isSelected ? 6.5 : 4.8, 0, Math.PI * 2);
              ctx.fillStyle = isSelected ? "#ffffff" : col;
              ctx.fill();
              ctx.lineWidth = 1.5;
              ctx.strokeStyle = "#040711";
              ctx.stroke();

              ctx.strokeStyle = col;
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(bx, by);
              ctx.lineTo(tx, ty);
              ctx.stroke();
            }

            if (isSelected || bone.spring) {
              ctx.font = "600 11px -apple-system, SF Mono, ui-monospace, monospace";
              ctx.fillStyle = isSelected ? "#ffffff" : "rgba(226, 232, 240, 0.85)";
              const badge = bone.spring ? `${bone.name} · spring` : bone.name;
              ctx.fillText(badge, bx + 10, by - 5);
            }
          });

          // IK pole / stretch readout for the selected chain.
          for (const ik of store.project.ikConstraints ?? []) {
            const tipIdx = store.project.bones.findIndex((b) => b.name === ik.target);
            const boneIdxs = ik.bones.map((n) => store.project.bones.findIndex((b) => b.name === n)).filter((i) => i >= 0);
            if (tipIdx < 0 || boneIdxs.length === 0) continue;
            const tipMat = frame.world[tipIdx]!;
            const [tx, ty] = toScreen(tipMat[4], tipMat[5]);
            const rootIdx = boneIdxs[0]!;
            const rootMat = frame.world[rootIdx]!;
            const [rx, ry] = toScreen(rootMat[4], rootMat[5]);
            const midIdx = boneIdxs[Math.floor(boneIdxs.length / 2)]!;
            const midMat = frame.world[midIdx]!;
            const [mx, my] = toScreen(midMat[4], midMat[5]);
            const selectedIk = store.selectedBone === ik.target || ik.bones.includes(store.selectedBone ?? "");
            if (!selectedIk && !store.lockIkEndEffector) continue;
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = selectedIk ? "#fde047" : "rgba(253, 224, 71, 0.45)";
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.moveTo(rx, ry);
            ctx.lineTo(mx - (ty - ry) * 0.15, my + (tx - rx) * 0.15);
            ctx.lineTo(tx, ty);
            ctx.stroke();
            ctx.setLineDash([]);
            const stretch = Math.hypot(tipMat[4] - rootMat[4], tipMat[5] - rootMat[5]) / Math.max(1, store.project.height);
            ctx.font = "600 10px -apple-system, SF Mono, ui-monospace, monospace";
            ctx.fillStyle = "#fde047";
            ctx.fillText(
              `${ik.name || ik.target} · stretch ${stretch.toFixed(2)}${store.lockIkEndEffector ? " · EE lock" : ""}`,
              tx + 12,
              ty + 14,
            );
          }
        }

        // 4. Draw Brush Cursor when in Weight Painter or Liquify FFD mode
        if ((store.mode === "weights" || store.mode === "liquify") && pointerRigPosRef.current) {
          const [cx, cy] = toScreen(pointerRigPosRef.current.x, pointerRigPosRef.current.y);
          const rScreen = store.brushRadius * scale;
          ctx.strokeStyle =
            store.mode === "liquify"
              ? "#c084fc"
              : store.brushMode === "subtract"
                ? "#fb7185"
                : store.brushMode === "smooth"
                  ? "#38bdf8"
                  : "#34d399";
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.arc(cx, cy, rScreen, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("resize", onActivity);
    };
  }, [playbackSpeed, setCurrentTime]);

  // Test hook for scripts/smoke-ui.mjs, only when the page is opened with ?test.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("test")) return;
    const w = window as unknown as { __kineticTest?: Record<string, unknown> };
    w.__kineticTest = {
      ...w.__kineticTest,
      boneScreen: (name: string) => {
        const overlay = overlayCanvasRef.current;
        const renderer = rendererRef.current;
        const animator = animatorRef.current;
        const s = useStudioStore.getState();
        const idx = s.project.bones.findIndex((b) => b.name === name);
        if (!overlay || !renderer || !animator || idx < 0) return null;
        const m = animator.evaluateAt(s.mode === "rig" || s.mode === "mesh" ? 0 : s.currentTime, 0).world[idx]!;
        const rect = overlay.getBoundingClientRect();
        const dpr = overlay.width / Math.max(1, rect.width);
        const camera: ViewCamera = { zoom: s.viewZoom, panX: s.viewPanX, panY: s.viewPanY };
        const { scale, offsetX, offsetY } = renderer.getViewMetrics(overlay.width, overlay.height, camera);
        return { x: rect.left + (m[4] * scale + offsetX) / dpr, y: rect.top + (m[5] * scale + offsetY) / dpr };
      },
      state: () => {
        const s = useStudioStore.getState();
        const clip = s.project.animations[s.activeClip];
        return {
          mode: s.mode,
          transformTool: s.transformTool,
          currentTime: s.currentTime,
          isPlaying: s.isPlaying,
          playDirection: s.playDirection,
          historyIndex: s.historyIndex,
          fps: clip?.fps ?? 30,
          loop: clip?.loop ?? false,
        };
      },
      boneKeys: (bone: string) => {
        const s = useStudioStore.getState();
        return s.project.animations[s.activeClip]?.boneTracks[bone] ?? [];
      },
      project: () => {
        const p = useStudioStore.getState().project;
        return { id: p.id, title: p.title, bones: p.bones.length, parts: p.parts.length, clips: Object.keys(p.animations).length };
      },
    };
  }, []);

  const viewCamera = (): ViewCamera => {
    const s = useStudioStore.getState();
    return { zoom: s.viewZoom, panX: s.viewPanX, panY: s.viewPanY };
  };

  const eventToRigCoords = (e: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
    const overlay = overlayCanvasRef.current;
    const renderer = rendererRef.current;
    if (!overlay || !renderer) return null;
    const rect = overlay.getBoundingClientRect();
    const dpr = overlay.width / Math.max(1, rect.width);
    const canvasX = (e.clientX - rect.left) * dpr;
    const canvasY = (e.clientY - rect.top) * dpr;
    const { scale, offsetX, offsetY } = renderer.getViewMetrics(overlay.width, overlay.height, viewCamera());
    return {
      x: (canvasX - offsetX) / scale,
      y: (canvasY - offsetY) / scale,
    };
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    // Middle mouse: pan the viewport (Spine-style navigation companion to zoom).
    if (e.button === 1) {
      e.preventDefault();
      const overlay = overlayCanvasRef.current;
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const dpr = overlay.width / Math.max(1, rect.width);
      panningRef.current = {
        pointerId: e.pointerId,
        lastX: (e.clientX - rect.left) * dpr,
        lastY: (e.clientY - rect.top) * dpr,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return; // right-click swaps tools (onContextMenu); never start a drag with it
    const pt = eventToRigCoords(e);
    if (!pt) return;
    pointerRigPosRef.current = pt;
    lastBrushRigPosRef.current = pt;

    if (mode === "weights" && selectedPart) {
      isPaintingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      applyWeightBrush(selectedPart, pt.x, pt.y);
      return;
    }

    if (mode === "liquify" && selectedPart) {
      isPaintingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      applyLiquifyBrush(selectedPart, pt.x, pt.y, 0, 0);
      return;
    }

    const animator = animatorRef.current;
    if (!animator) return;
    const currentTime = useStudioStore.getState().currentTime;
    const evalTime = mode === "rig" || mode === "mesh" ? 0 : currentTime;
    const frame = animator.evaluateAt(evalTime, 0);

    let closestBone: string | null = null;
    let minDist = 28;
    project.bones.forEach((bone, i) => {
      const m = frame.world[i]!;
      const d = Math.hypot(pt.x - m[4], pt.y - m[5]);
      if (d < minDist) {
        minDist = d;
        closestBone = bone.name;
      }
    });

    if (closestBone) {
      selectBone(closestBone);
      const boneObj = project.bones.find((b) => b.name === closestBone)!;
      const bIdx = project.bones.indexOf(boneObj);
      const pose = frame.poses[bIdx]!;
      const clip = project.animations[activeClip];
      // Keys land on whole frames, as in Spine; the playhead jumps to that frame.
      const keyTime = clip ? snapTime(currentTime, clip.fps || 30, clip.duration) : 0;
      if (mode === "animate" && clip && Math.abs(keyTime - currentTime) > 1e-4) setCurrentTime(keyTime);
      draggingBoneRef.current = {
        boneName: closestBone,
        startRigX: pt.x,
        startRigY: pt.y,
        origX: mode === "rig" ? boneObj.x : pose.x,
        origY: mode === "rig" ? boneObj.y : pose.y,
        origR: pose.r,
        origSx: pose.sx,
        origSy: pose.sy,
        origTrack: clip?.boneTracks[closestBone] ?? [],
        time: keyTime,
        lastTool: mode === "rig" ? "pivot" : "rotate",
        moved: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const pan = panningRef.current;
    if (pan && pan.pointerId === e.pointerId) {
      const overlay = overlayCanvasRef.current;
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const dpr = overlay.width / Math.max(1, rect.width);
      const x = (e.clientX - rect.left) * dpr;
      const y = (e.clientY - rect.top) * dpr;
      const s = useStudioStore.getState();
      s.setViewPan(s.viewPanX + (x - pan.lastX), s.viewPanY + (y - pan.lastY));
      pan.lastX = x;
      pan.lastY = y;
      return;
    }

    const pt = eventToRigCoords(e);
    if (!pt) return;
    const prevPt = lastBrushRigPosRef.current ?? pt;
    pointerRigPosRef.current = pt;
    lastBrushRigPosRef.current = pt;

    // Update 2.5D Parallax Look-At target from cursor position on canvas
    const normX = Math.max(-1, Math.min(1, (pt.x / Math.max(1, project.width) - 0.5) * 2));
    const normY = Math.max(-1, Math.min(1, (pt.y / Math.max(1, project.height) - 0.4) * 2));
    if (useStudioStore.getState().parallax.enabled && !draggingBoneRef.current && !isPaintingRef.current) {
      setParallaxConfig({ lookX: Number(normX.toFixed(2)), lookY: Number(normY.toFixed(2)) });
    }

    if (isPaintingRef.current && mode === "weights" && selectedPart) {
      applyWeightBrush(selectedPart, pt.x, pt.y);
      return;
    }

    if (isPaintingRef.current && mode === "liquify" && selectedPart) {
      applyLiquifyBrush(selectedPart, pt.x, pt.y, pt.x - prevPt.x, pt.y - prevPt.y);
      return;
    }

    const drag = draggingBoneRef.current;
    if (!drag) return;
    const dx = pt.x - drag.startRigX;
    const dy = pt.y - drag.startRigY;

    if (!drag.moved && Math.hypot(dx, dy) < 2) return;

    if (mode === "rig") {
      drag.moved = true;
      previewBone(drag.boneName, {
        x: Number(Math.max(0, Math.min(1, drag.origX + dx / project.width)).toFixed(4)),
        y: Number(Math.max(0, Math.min(1, drag.origY + dy / project.height)).toFixed(4)),
      });
    } else if (mode === "animate") {
      // B (pose): IK targets and root move, other bones rotate, ⇧ moves. C / V / X force one transform,
      // and ⇧ refines it as in Spine: 15° rotation steps, axis lock, uniform scale.
      const isPose = transformTool === "pose";
      const tool: "rotate" | "translate" | "scale" = isPose
        ? drag.boneName.startsWith("ik-") || drag.boneName === "root" || e.shiftKey
          ? "translate"
          : "rotate"
        : transformTool;
      const refine = !isPose && e.shiftKey;
      const patch: Partial<Record<Channel, number>> = {};
      if (tool === "rotate") {
        const delta = dx * 0.45;
        patch.r = drag.origR + (refine ? Math.round(delta / 15) * 15 : delta);
      } else if (tool === "translate") {
        const lockY = refine && Math.abs(dx) >= Math.abs(dy);
        const lockX = refine && !lockY;
        patch.x = drag.origX + (lockX ? 0 : dx);
        patch.y = drag.origY + (lockY ? 0 : dy);
      } else {
        const fx = Math.max(0.01, 1 + dx * 0.005);
        const fy = refine ? fx : Math.max(0.01, 1 - dy * 0.005);
        patch.sx = drag.origSx * fx;
        patch.sy = drag.origSy * fy;
      }
      drag.moved = true;
      drag.lastTool = tool;
      editActiveClip(
        (c) => ({ ...c, boneTracks: { ...c.boneTracks, [drag.boneName]: patchKeyAt(drag.origTrack, drag.time, patch) } }),
        null,
      );
    }
  };

  const handlePointerUp = () => {
    panningRef.current = null;
    const drag = draggingBoneRef.current;
    const painted = isPaintingRef.current;
    isPaintingRef.current = false;
    draggingBoneRef.current = null;
    // One undo step per drag or brush stroke.
    if (drag?.moved) {
      const verb = { rotate: "Rotated", translate: "Moved", scale: "Scaled", pivot: "Moved pivot of" }[drag.lastTool];
      commitPreview(`${verb} ${drag.boneName}`);
    }
    if (painted && selectedPart) commitPreview(mode === "weights" ? `Painted weights on ${selectedPart}` : `Warped ${selectedPart}`);
  };

  return (
    <div className="fixed inset-0 bg-[#040711] overflow-hidden select-none">
      {/* iOS 26 Solarium Ambient Spatial Light Stage */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle at 50% 42%, rgba(56, 189, 248, 0.14) 0%, rgba(99, 102, 241, 0.07) 35%, rgba(4, 7, 17, 0.95) 75%), radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)",
          backgroundSize: "100% 100%, 28px 28px",
        }}
      />

      <canvas ref={glCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <canvas
        ref={overlayCanvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={(e) => {
          // ⌥+scroll: step frames (existing). Plain scroll / trackpad pinch: zoom toward cursor.
          if (e.altKey) {
            e.preventDefault();
            const s = useStudioStore.getState();
            const clip = s.project.animations[s.activeClip];
            if (!clip) return;
            const fps = clip.fps || 30;
            const frameDelta = e.deltaY > 0 ? 1 : -1;
            const next = Math.max(0, Math.min(clip.duration, s.currentTime + frameDelta / fps));
            s.setIsPlaying(false);
            s.setCurrentTime(Number(next.toFixed(4)));
            return;
          }
          e.preventDefault();
          const overlay = overlayCanvasRef.current;
          if (!overlay) return;
          const rect = overlay.getBoundingClientRect();
          const dpr = overlay.width / Math.max(1, rect.width);
          const ax = (e.clientX - rect.left) * dpr;
          const ay = (e.clientY - rect.top) * dpr;
          // Pinch on macOS Chrome arrives as ctrlKey + wheel; use a slightly stronger step.
          const sensitivity = e.ctrlKey ? 0.01 : 0.0015;
          const factor = Math.exp(-e.deltaY * sensitivity);
          useStudioStore.getState().zoomAt(factor, ax, ay, overlay.width, overlay.height);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          swapToPreviousTool();
        }}
        onPointerLeave={() => {
          handlePointerUp();
          setParallaxConfig({ lookX: 0, lookY: 0 });
        }}
        className={`absolute inset-0 w-full h-full ${
          mode === "weights" || mode === "liquify" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"
        }`}
        style={{ touchAction: "none" }}
      />
    </div>
  );
}
