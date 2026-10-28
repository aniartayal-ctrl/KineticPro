/**
 * Copilot executor. Runs catalog actions against the studio store (browser, or Node for evals).
 *
 * Model output is treated as untrusted: names are resolved tolerantly (case, punctuation,
 * synonyms like sword → weapon), values are coerced (40 → 0.4 for a mix, frames ↔ seconds) and
 * clamped, and every action is isolated so one bad call reports an error instead of breaking the
 * studio. Error messages list the valid choices, so an agent can correct itself on the next step.
 */

import { EASE_BACK_OUT, EASE_POWER2_IN, EASE_POWER2_OUT, EASE_SINE_IN_OUT, sampleTransformTrack } from "@/core/animator";
import { BUDGET_TARGETS, computeBudget, type BudgetTarget } from "@/core/budget";
import { applyAllCues, reviewClip } from "@/core/coach";
import { findNames } from "@/core/copilot/planner";
import { getThemeSymbols, type SlotSymbolRole } from "@/core/batch-symbols";
import { ARCHETYPES, LIP_SYNC_PHRASES, SYMBOL_ROLES, VFX, type CopilotAction, type CopilotContext } from "@/core/copilot/tools";
import type { AnimationPrinciplesConfig, AutoArchetypeId } from "@/core/physics-and-principles";
import type { ElementalVfxType } from "@/core/vfx-colliders-profiler";
import { keyPreservingShape, patchKeyAt, snapTime, type Channel } from "@/core/keyframes";
import type { CurveType } from "@/core/schema";
import { useStudioStore, type StudioMode, type TransformTool } from "@/store/useStudioStore";

export type ActionResult = { action: CopilotAction; ok: boolean; message: string };
export type ExecutorHost = {
  exportBundle: () => Promise<void>;
  /** Resolves false when the save did not reach disk. */
  save: () => Promise<boolean>;
  openBudget: () => void;
  /** Opens a project by (partial) name; no name shows the project list. Returns a status line. */
  openProject: (name?: string) => Promise<string>;
  /** Opens one of the theme's slot symbols as its own rig, asking about unsaved work first. */
  openSymbol: (role: SlotSymbolRole, title: string) => Promise<string>;
};

const OVERLAY_KEYS = {
  bones: "showBones",
  mesh: "showMeshWireframe",
  heatmap: "showHeatmap",
  onion: "showOnionSkin",
  arcs: "showMotionArcs",
  trail: "showSlashTrail",
  lighting: "enable3DRelight",
  hitboxes: "showHitboxes",
  solo: "isolatePart",
} as const;

const OVERLAY_ALIASES: Record<string, keyof typeof OVERLAY_KEYS> = {
  skeleton: "bones",
  wireframe: "mesh",
  weights: "heatmap",
  weight_heatmap: "heatmap",
  onion_skin: "onion",
  onionskin: "onion",
  motion_arcs: "arcs",
  motion_paths: "arcs",
  weapon_trail: "trail",
  normal_map_lighting: "lighting",
  relight: "lighting",
  colliders: "hitboxes",
  isolate: "solo",
};

const CURVES: Record<string, CurveType> = {
  linear: "linear",
  ease: EASE_SINE_IN_OUT,
  ease_in: EASE_POWER2_IN,
  ease_out: EASE_POWER2_OUT,
  overshoot: EASE_BACK_OUT,
  stepped: "stepped",
};
const CURVE_ALIASES: Record<string, string> = {
  smooth: "ease",
  ease_in_out: "ease",
  easeinout: "ease",
  sine: "ease",
  easein: "ease_in",
  easeout: "ease_out",
  back: "overshoot",
  back_out: "overshoot",
  bounce: "overshoot",
  step: "stepped",
  hold: "stepped",
  constant: "stepped",
};

const MODES: StudioMode[] = ["import", "auto", "rig", "mesh", "weights", "animate", "liquify", "export"];
const MODE_ALIASES: Record<string, StudioMode> = { create: "rig", bones: "rig", pose: "animate", warp: "liquify", weight_paint: "weights", auto_rig: "auto" };
const TRANSFORMS: TransformTool[] = ["pose", "rotate", "translate", "scale"];

/** Older action names some saved prompts or models still emit. */
const ALIASES: Record<string, string> = {
  set_keyframe_pose: "set_key",
  select_target: "select",
  trigger_unity_export: "export",
  auto_rig_project: "auto_rig",
  regenerate_procedural_clips: "generate_clips",
  key: "set_key",
  get_state: "inspect",
};

class ActionError extends Error {}
const fail = (msg: string): never => {
  throw new ActionError(msg);
};
const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const numArg = (v: unknown) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
const snake = (v: string) => v.toLowerCase().trim().replace(/[\s-]+/g, "_");
const listOf = (names: string[]) => (names.length > 12 ? `${names.slice(0, 12).join(", ")}…` : names.join(", "));

/** Picks an enum value from loose wording: exact, a synonym, or the value that contains a word of the input. */
function pickEnum(input: unknown, values: string[], kind: string, synonyms: Record<string, string> = {}): string {
  const raw = snake(str(input) ?? fail(`Missing ${kind}. Choose: ${values.join(", ")}`));
  if (values.includes(raw)) return raw;
  for (const [word, value] of Object.entries(synonyms)) if (raw.includes(word)) return value;
  const words = raw.split("_").filter((w) => w.length > 2);
  const hit = values.find((v) => words.some((w) => v.split("_").includes(w)));
  return hit ?? fail(`Unknown ${kind} "${raw}". Choose: ${values.join(", ")}`);
}

const VFX_SYNONYMS: Record<string, string> = {
  lightning: "lightning_bolts",
  bolt: "lightning_bolts",
  fire: "fire_aura",
  flame: "fire_aura",
  shock: "shockwave_rings",
  ring: "shockwave_rings",
  coin: "coin_fountain",
  gold: "coin_fountain",
  star: "star_sparks",
  spark: "star_sparks",
  off: "none",
};

/** Exact, then case/punctuation-insensitive, then synonym/phrase match; fails listing valid names. */
function resolveName(input: unknown, names: string[], kind: string): string {
  const raw = str(input) ?? fail(`Missing ${kind} name`);
  const exact = names.find((n) => n === raw) ?? names.find((n) => norm(n) === norm(raw));
  if (exact) return exact;
  const fuzzy = findNames(raw.replace(/[_-]+/g, " "), names)[0];
  if (fuzzy) return fuzzy;
  return fail(`No ${kind} named "${raw}". ${kind[0]!.toUpperCase()}${kind.slice(1)}s: ${listOf(names)}`);
}

/** 0..1 fraction from a fraction or a percentage (models often send 40 for 40%). */
function fraction(v: unknown, lo: number, hi: number): number | undefined {
  const n = numArg(typeof v === "string" ? v.replace("%", "") : v);
  if (n === undefined) return undefined;
  return clamp(Math.abs(n) > 2 ? n / 100 : n, lo, hi);
}

export function copilotContext(): CopilotContext {
  const s = useStudioStore.getState();
  const clip = s.project.animations[s.activeClip];
  return {
    bones: s.project.bones.map((b) => b.name),
    parts: s.project.parts.map((p) => p.name),
    clips: Object.keys(s.project.animations),
    ikNames: (s.project.ikConstraints ?? []).map((k) => k.name),
    activeClip: s.activeClip,
    selectedBone: s.selectedBone,
    selectedPart: s.selectedPart,
    currentTime: s.currentTime,
    duration: clip?.duration ?? 1,
    fps: clip?.fps || 30,
    loop: clip?.loop ?? false,
    mode: s.mode,
    transformTool: s.transformTool,
    isPlaying: s.isPlaying,
    skins: ["default", ...(s.project.skins ?? []).map((k) => k.name).filter((n) => n !== "default")],
    activeSkin: s.activeSkinName,
    hiddenParts: s.hiddenParts,
    springBones: s.project.bones.filter((b) => b.spring).map((b) => b.name),
    suggestions: reviewClip(s.project, s.activeClip).map((c) => ({ id: c.id, principle: c.principle, title: c.title, fixable: Boolean(c.apply) })),
  };
}

/** Short label for a tool call, shown in the copilot thread (models do not send summaries). */
export function describeCall(tool: string, args: Record<string, unknown>): string {
  const a = args ?? {};
  const named = [a.bone, a.part, a.clip, a.name, a.ikName, a.skinName, a.overlay, a.id].find((v) => typeof v === "string") as string | undefined;
  const list = Array.isArray(a.bones) ? (a.bones as unknown[]).join(", ") : undefined;
  const label = tool.replace(/_/g, " ");
  return [label.charAt(0).toUpperCase() + label.slice(1), named ?? list].filter(Boolean).join(" · ");
}

function timeFrom(a: Record<string, unknown>, fps: number): number | undefined {
  const frame = numArg(a.frame);
  if (frame !== undefined) return frame / fps;
  return numArg(a.time);
}

function boneList(v: unknown): string[] {
  const s = useStudioStore.getState();
  const names = s.project.bones.map((b) => b.name);
  const items = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  if (items.some((x) => typeof x === "string" && x.toLowerCase() === "all")) return names;
  const list = items.map((x) => resolveName(x, names, "bone"));
  if (list.length === 0) {
    if (!s.selectedBone) fail("Select a bone first, or name the bones");
    return [s.selectedBone!];
  }
  return [...new Set(list)];
}

function inspect(boneArg: unknown): string {
  const s = useStudioStore.getState();
  const clip = s.project.animations[s.activeClip];
  if (!clip) return "No clip open.";
  const fps = clip.fps || 30;
  const bone = boneArg !== undefined ? resolveName(boneArg, s.project.bones.map((b) => b.name), "bone") : s.selectedBone;
  const lines = [
    `Clip ${s.activeClip}: ${clip.duration.toFixed(2)} s, ${fps} fps, ${clip.loop ? "loops" : "plays once"}, ${Object.values(clip.boneTracks).reduce((n, t) => n + t.length, 0)} keys on ${Object.keys(clip.boneTracks).length} bones, ${clip.events?.length ?? 0} events.`,
    `Playhead ${s.currentTime.toFixed(3)} s (frame ${Math.round(s.currentTime * fps)}).`,
  ];
  if (bone) {
    const track = clip.boneTracks[bone] ?? [];
    const p = sampleTransformTrack(track, s.currentTime);
    const def = s.project.bones.find((b) => b.name === bone)!;
    lines.push(
      `Bone ${bone} (parent ${def.parent ?? "none"}): pose now r ${p.r.toFixed(1)}°, x ${p.x.toFixed(1)}, y ${p.y.toFixed(1)}, sx ${p.sx.toFixed(3)}, sy ${p.sy.toFixed(3)}.`,
      def.spring ? `Physics: stiffness ${def.spring.stiffness}, damping ${def.spring.damping}, wind ${def.spring.wind ?? 0}.` : "No physics.",
      track.length === 0
        ? "No keys."
        : `Keys (frame: r/x/y/sx/sy, curve): ${track
            .slice(0, 24)
            .map(
              (k) =>
                `${Math.round(k.time * fps)}: ${(k.r ?? 0).toFixed(1)}/${(k.x ?? 0).toFixed(1)}/${(k.y ?? 0).toFixed(1)}/${(k.sx ?? 1).toFixed(2)}/${(k.sy ?? 1).toFixed(2)} ${k.curve === "stepped" ? "stepped" : Array.isArray(k.curve) ? "eased" : "linear"}`,
            )
            .join("; ")}${track.length > 24 ? ` … (${track.length} total)` : ""}`,
    );
  }
  for (const ik of s.project.ikConstraints ?? []) lines.push(`IK ${ik.name}: mix ${Math.round(ik.mix * 100)}%, bones ${ik.bones.join(" → ")}, target ${ik.target}.`);
  return lines.join("\n");
}

async function runOne(action: CopilotAction, host: ExecutorHost): Promise<string> {
  const s = useStudioStore.getState();
  const a = (action.args && typeof action.args === "object" ? action.args : {}) as Record<string, unknown>;
  const clip = s.project.animations[s.activeClip];
  const fps = clip?.fps || 30;
  const tool = ALIASES[action.tool] ?? action.tool;
  const boneNames = s.project.bones.map((b) => b.name);
  const partNames = s.project.parts.map((p) => p.name);
  const at = (t: number | undefined) => {
    if (t === undefined || !clip) return;
    s.setIsPlaying(false);
    s.setCurrentTime(snapTime(t, fps, clip.duration));
  };

  switch (tool) {
    case "inspect":
      return inspect(a.bone);
    case "select": {
      if (a.clip === undefined && a.bone === undefined && a.part === undefined) fail("Name a bone, layer or clip to select");
      const done: string[] = [];
      if (a.clip !== undefined) {
        const c = resolveName(a.clip, Object.keys(s.project.animations), "clip");
        s.setActiveClip(c);
        done.push(`clip ${c}`);
      }
      if (a.bone !== undefined) {
        const b = resolveName(a.bone, boneNames, "bone");
        s.selectBone(b);
        done.push(`bone ${b}`);
      }
      if (a.part !== undefined) {
        const p = resolveName(a.part, partNames, "layer");
        s.selectPart(p);
        done.push(`layer ${p}`);
      }
      return `Selected ${done.join(", ")}`;
    }
    case "set_mode": {
      const rawMode = snake(str(a.mode) ?? fail(`Missing mode. Modes: ${MODES.join(", ")}`));
      const t = str(a.tool) ? snake(str(a.tool)!) : undefined;
      const transform = (t && TRANSFORMS.includes(t as TransformTool) ? t : TRANSFORMS.includes(rawMode as TransformTool) ? rawMode : undefined) as
        | TransformTool
        | undefined;
      if (t && !transform) fail(`Unknown transform tool "${t}". Tools: ${TRANSFORMS.join(", ")}`);
      const mode = transform ? "animate" : (MODE_ALIASES[rawMode] ?? (rawMode as StudioMode));
      if (!MODES.includes(mode)) fail(`Unknown mode "${rawMode}". Modes: ${MODES.join(", ")}`);
      if (mode === "auto") s.runOneClickAutoRig();
      if (mode === "export") {
        await host.exportBundle();
        return "Export opened and bundle built";
      }
      s.chooseTool(mode, transform);
      return transform ? `${transform[0]!.toUpperCase()}${transform.slice(1)} tool` : `Opened ${mode}`;
    }
    case "toggle_overlay": {
      const rawKey = snake(str(a.overlay) ?? fail("Missing overlay"));
      const overlay = (rawKey in OVERLAY_KEYS ? rawKey : OVERLAY_ALIASES[rawKey]) as keyof typeof OVERLAY_KEYS | undefined;
      if (!overlay) fail(`Unknown overlay "${rawKey}". Overlays: ${Object.keys(OVERLAY_KEYS).join(", ")}`);
      const key = OVERLAY_KEYS[overlay!];
      const current = (s as unknown as Record<string, boolean>)[key];
      if (typeof a.on !== "boolean" || a.on !== current) s.toggleOverlay(key);
      return `${overlay} ${useStudioStore.getState()[key] ? "on" : "off"}`;
    }
    case "playback": {
      const speed = numArg(a.speed);
      if (speed !== undefined) s.setPlaybackSpeed(clamp(speed, 0.1, 4));
      const act = snake(str(a.action) ?? (speed !== undefined ? "none" : "toggle"));
      if (act === "play" || act === "play_forward") {
        s.setPlayDirection(1);
        s.setIsPlaying(true);
      } else if (act === "play_backward" || act === "reverse") {
        s.setPlayDirection(-1);
        s.setIsPlaying(true);
      } else if (act === "pause" || act === "stop") s.setIsPlaying(false);
      else if (act === "toggle") {
        if (!s.isPlaying) s.setPlayDirection(1);
        s.setIsPlaying(!s.isPlaying);
      } else if (act !== "none") fail(`Unknown playback action "${act}". Use play, play_backward, pause or toggle`);
      const after = useStudioStore.getState();
      return `${after.isPlaying ? (after.playDirection === 1 ? "Playing" : "Playing backward") : "Paused"} at ${after.playbackSpeed}×`;
    }
    case "go_to": {
      if (!clip) fail("No clip open");
      let t = timeFrom(a, fps);
      const key = str(a.key);
      if (key) {
        const times = [...new Set(Object.values(clip!.boneTracks).flatMap((tr) => tr.map((k) => k.time)))].sort((x, y) => x - y);
        if (key === "first") t = 0;
        else if (key === "last") t = times.length > 0 ? times[times.length - 1]! : clip!.duration;
        else if (key === "next") t = times.find((x) => x > s.currentTime + 1e-4);
        else if (key === "prev" || key === "previous") t = [...times].reverse().find((x) => x < s.currentTime - 1e-4);
        else fail(`Unknown key "${key}". Use next, prev, first or last`);
        if (t === undefined) fail(`No ${key} key from frame ${Math.round(s.currentTime * fps)}`);
      }
      if (t === undefined) fail("Give a time (seconds), a frame, or key: next/prev/first/last");
      at(clamp(t!, 0, clip!.duration));
      return `Playhead at frame ${Math.round(useStudioStore.getState().currentTime * fps)}`;
    }
    case "auto_rig": {
      if (a.archetype !== undefined) useStudioStore.setState({ autoArchetype: pickEnum(a.archetype, ARCHETYPES, "archetype") as AutoArchetypeId });
      useStudioStore.getState().runOneClickAutoRig();
      const after = useStudioStore.getState();
      return `Rigged, meshed, weighted and regenerated ${Object.keys(after.project.animations).length} game clips (${after.autoArchetype.replace(/_/g, " ")}, ${after.project.bones.length} bones)`;
    }
    case "set_draw_order": {
      const part = resolveName(a.part, partNames, "layer");
      const move = snake(str(a.move) ?? fail("Missing move: forward, backward, front or back"));
      const idx = partNames.indexOf(part);
      const toFront = /front|top/.test(move) && !/forward/.test(move);
      const toBack = /^(back|to_back|bottom|behind_all)$/.test(move);
      const dir: "up" | "down" | undefined = toFront || /forward|up|in_front|raise/.test(move) ? "up" : toBack || /backward|down|behind|lower/.test(move) ? "down" : undefined;
      if (!dir) fail(`Unknown move "${move}". Use forward, backward, front or back`);
      const n = toFront ? partNames.length - 1 - idx : toBack ? idx : Math.max(1, Math.round(numArg(a.steps) ?? 1));
      if (n === 0) return `${part} is already ${dir === "up" ? "in front" : "at the back"}`;
      s.movePartLayerOrder(part, dir!, n);
      const order = useStudioStore.getState().project.parts.map((p) => p.name);
      return `Draw order, back to front: ${order.join(", ")}`;
    }
    case "set_layer_visibility": {
      const part = resolveName(a.part, partNames, "layer");
      const want = a.visible !== false && a.visible !== "false";
      if (s.hiddenParts.includes(part) === want) s.togglePartVisibility(part);
      return `${part} ${want ? "shown" : "hidden"} in the viewport`;
    }
    case "delete_key": {
      if (!clip) fail("No clip open");
      at(timeFrom(a, fps));
      const t = snapTime(useStudioStore.getState().currentTime, fps, clip!.duration);
      const bones = boneList(a.bones ?? a.bone);
      const hit = (k: { time: number }) => Math.abs(k.time - t) < 0.5 / fps;
      const withKeys = bones.filter((b) => (clip!.boneTracks[b] ?? []).some(hit));
      if (withKeys.length === 0) return `No keys at frame ${Math.round(t * fps)} on ${bones.length === 1 ? bones[0] : `${bones.length} bones`}`;
      useStudioStore.getState().editActiveClip(
        (c) => ({ ...c, boneTracks: { ...c.boneTracks, ...Object.fromEntries(withKeys.map((b) => [b, (c.boneTracks[b] ?? []).filter((k) => !hit(k))])) } }),
        `Copilot deleted keys at frame ${Math.round(t * fps)}`,
      );
      return `Deleted the frame ${Math.round(t * fps)} key on ${withKeys.length === 1 ? withKeys[0] : `${withKeys.length} bones`}`;
    }
    case "remove_animation_event": {
      if (!clip) fail("No clip open");
      const name = str(a.name) ? (["OnHit", "SpawnVFX", "PlaySFX", "CameraShake"].find((n) => norm(n) === norm(str(a.name)!)) ?? str(a.name)!) : undefined;
      const t = timeFrom(a, fps);
      if (name === undefined && t === undefined) fail("Give an event name, a time or frame, or both");
      const events = clip!.events ?? [];
      const keep = events.filter((e) => !((name === undefined || e.name === name) && (t === undefined || Math.abs(e.time - t) < 0.5 / fps)));
      const removed = events.length - keep.length;
      const where = t !== undefined ? ` at frame ${Math.round(t * fps)}` : "";
      if (removed === 0) return `No ${name ?? ""} event${where} in ${s.activeClip}. Events: ${events.map((e) => `${e.name}@${Math.round(e.time * fps)}`).join(", ") || "none"}`;
      s.editActiveClip((c) => ({ ...c, events: keep }), `Copilot removed ${removed} event${removed === 1 ? "" : "s"}`);
      return `Removed ${removed} ${name ?? ""} event${removed === 1 ? "" : "s"}${where}`;
    }
    case "set_principles": {
      const keys: (keyof AnimationPrinciplesConfig)[] = ["squashAndStretch", "anticipation", "followThroughOverlap", "arcsAndEasing", "secondaryAndAppeal", "exaggeration"];
      const patch: Partial<AnimationPrinciplesConfig> = {};
      for (const k of keys) {
        const v = numArg(a[k]);
        if (v !== undefined) patch[k] = clamp(v > 2 ? v / 100 : v, k === "exaggeration" ? 0.5 : 0, 2);
      }
      if (Object.keys(patch).length === 0) fail(`Give at least one of: ${keys.join(", ")}`);
      s.updatePrinciples(patch);
      const p = useStudioStore.getState().principles;
      return `Regenerated the game clips with ${keys.map((k) => `${k} ${p[k].toFixed(2)}`).join(", ")}`;
    }
    case "set_vfx": {
      const vfx = pickEnum(a.vfx, VFX, "effect", VFX_SYNONYMS) as ElementalVfxType;
      s.setActiveVfx(vfx);
      return vfx === "none" ? "VFX off" : `VFX: ${vfx.replace(/_/g, " ")}`;
    }
    case "lip_sync": {
      if (!clip) fail("No clip open");
      const phrase = pickEnum(a.phrase, LIP_SYNC_PHRASES, "voice line");
      s.applyVoiceLipSync(phrase);
      return `Lip-sync "${phrase.replace(/_/g, " ")}" keyed into ${s.activeClip}`;
    }
    case "open_symbol_rig": {
      const role = pickEnum(a.role, SYMBOL_ROLES, "symbol") as SlotSymbolRole;
      const desc = getThemeSymbols(s.project.id).find((d) => d.role === role);
      return await host.openSymbol(role, desc?.label ?? role.toUpperCase());
    }
    case "add_bone": {
      const name = (str(a.name) ?? fail("Missing bone name")).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      if (boneNames.includes(name)) fail(`Bone ${name} already exists`);
      const parent = resolveName(a.parent ?? s.selectedBone ?? boneNames[0], boneNames, "bone");
      const p = s.project.bones.find((b) => b.name === parent)!;
      s.addBone(parent, name, clamp(numArg(a.x) ?? p.x + 0.05, 0, 1), clamp(numArg(a.y) ?? p.y - 0.08, 0, 1));
      if (!useStudioStore.getState().project.bones.some((b) => b.name === name)) fail(`Could not add ${name}`);
      return `Added ${name} under ${parent}`;
    }
    case "move_pivot": {
      const bone = resolveName(a.bone, boneNames, "bone");
      const x = numArg(a.x) ?? fail("Missing x (0..1)");
      const y = numArg(a.y) ?? fail("Missing y (0..1)");
      s.updateBone(bone, { x: clamp(x > 1 ? x / s.project.width : x, 0, 1), y: clamp(y > 1 ? y / s.project.height : y, 0, 1) });
      return `Moved ${bone} pivot`;
    }
    case "configure_ik": {
      const iks = s.project.ikConstraints ?? [];
      if (iks.length === 0) fail("This rig has no IK constraint");
      const ik = a.ikName !== undefined ? iks.find((k) => k.name === resolveName(a.ikName, iks.map((x) => x.name), "IK constraint"))! : iks[0]!;
      const mix = fraction(a.mix, 0, 1) ?? ik.mix;
      const flip = a.flip === true || a.bendPositive === "toggle";
      const bend = flip ? !ik.bendPositive : typeof a.bendPositive === "boolean" ? a.bendPositive : ik.bendPositive;
      s.updateIkMix(ik.name, mix, bend);
      return `${ik.name}: ${Math.round(mix * 100)}%${flip ? ", bend flipped" : ""}`;
    }
    case "configure_spring_physics": {
      const bone = resolveName(a.bone, boneNames, "bone");
      const existing = s.project.bones.find((b) => b.name === bone)!.spring;
      if (a.enabled === false || a.enabled === "false") {
        s.updateBone(bone, { spring: undefined });
        return `Removed physics from ${bone}`;
      }
      const spring = {
        stiffness: clamp(numArg(a.stiffness) ?? existing?.stiffness ?? 60, 5, 200),
        damping: clamp(numArg(a.damping) ?? existing?.damping ?? 6, 0.5, 40),
        gain: existing?.gain ?? ([7, 3] as [number, number]),
        wind: clamp(numArg(a.wind) ?? existing?.wind ?? 1.2, 0, 10),
      };
      s.updateBone(bone, { spring });
      return `Physics on ${bone}: stiffness ${spring.stiffness}, damping ${spring.damping}, wind ${spring.wind}`;
    }
    case "lock_bone": {
      const bone = resolveName(a.bone, boneNames, "bone");
      const want = a.locked !== false && a.locked !== "false";
      if (s.lockedBones.includes(bone) !== want) s.toggleBoneLock(bone);
      return `${want ? "Locked" : "Unlocked"} ${bone}`;
    }
    case "configure_mesh_and_weights": {
      const densityRaw = snake(str(a.density) ?? "medium");
      const density = ({ dense: "high", fine: "high", detailed: "high", light: "low", coarse: "low", normal: "medium", default: "medium" } as Record<string, string>)[densityRaw] ?? densityRaw;
      const weightRaw = snake(str(a.weightMode) ?? str(a.weights) ?? "hybrid");
      const mode = ({ geodesic: "heat", heat_diffusion: "heat", envelope: "capsule", envelopes: "capsule", auto: "hybrid" } as Record<string, string>)[weightRaw] ?? weightRaw;
      if (!["low", "medium", "high"].includes(density)) fail(`Unknown density "${density}". Use low, medium or high`);
      if (!["hybrid", "heat", "capsule"].includes(mode)) fail(`Unknown weight mode "${mode}". Use hybrid, heat or capsule`);
      const parts = str(a.part)?.toLowerCase() === "all" ? partNames : [resolveName(a.part ?? s.selectedPart, partNames, "layer")];
      for (const part of parts) {
        useStudioStore.getState().regeneratePartMesh(part, density as "low" | "medium" | "high", mode as "hybrid" | "heat" | "capsule");
      }
      const verts = parts.reduce((n, name) => n + ((useStudioStore.getState().project.parts.find((p) => p.name === name)?.mesh?.positions.length ?? 0) / 2), 0);
      return `Meshed ${parts.length === 1 ? parts[0] : `${parts.length} layers`} (${density}, ${mode} weights, ${verts} vertices)`;
    }
    case "reset_warp": {
      const part = resolveName(a.part ?? s.selectedPart, partNames, "layer");
      s.resetPartLiquifyDeform(part);
      return `Reset warp on ${part}`;
    }
    case "set_key": {
      if (!clip) fail("No clip open");
      at(timeFrom(a, fps));
      const t = snapTime(useStudioStore.getState().currentTime, fps, clip!.duration);
      const bones = boneList(a.bones ?? a.bone);
      const channels = (["r", "x", "y", "sx", "sy"] as Channel[]).filter((ch) => numArg(a[ch]) !== undefined);
      const relative = a.relative === true || a.relative === "true";
      useStudioStore.getState().editActiveClip((c) => {
        const boneTracks = { ...c.boneTracks };
        for (const b of bones) {
          const track = boneTracks[b] ?? [];
          const pose = sampleTransformTrack(track, t);
          const patch: Partial<Record<Channel, number>> = {};
          for (const ch of channels) {
            const v = numArg(a[ch])!;
            patch[ch] = !relative ? v : ch === "sx" || ch === "sy" ? pose[ch] * v : pose[ch] + v;
          }
          boneTracks[b] = channels.length > 0 ? patchKeyAt(track, t, patch) : keyPreservingShape(track, t);
        }
        return { ...c, boneTracks };
      }, `Copilot keyed ${bones.length === 1 ? bones[0] : `${bones.length} bones`}`);
      const after = sampleTransformTrack(useStudioStore.getState().project.animations[s.activeClip]!.boneTracks[bones[0]!], t);
      return `Keyed ${bones.length === 1 ? bones[0] : `${bones.length} bones`} at frame ${Math.round(t * fps)}${
        bones.length === 1 ? ` (r ${after.r.toFixed(1)}°, x ${after.x.toFixed(1)}, y ${after.y.toFixed(1)}, sx ${after.sx.toFixed(2)}, sy ${after.sy.toFixed(2)})` : ""
      }`;
    }
    case "breakdown": {
      const f = fraction(a.fraction, -0.25, 1.25) ?? 0.5;
      s.insertBreakdown(f, a.bones === undefined && a.bone === undefined ? undefined : boneList(a.bones ?? a.bone));
      return `Breakdown ${Math.round(f * 100)}% at frame ${Math.round(useStudioStore.getState().currentTime * fps)}`;
    }
    case "copy_pose":
      s.copyPose();
      return `Pose copied from frame ${Math.round(s.currentTime * fps)}`;
    case "paste_pose": {
      if (!s.poseClipboard) fail("Copy a pose first (copy_pose)");
      at(timeFrom(a, fps));
      useStudioStore.getState().pastePose();
      return `Pose pasted at frame ${Math.round(useStudioStore.getState().currentTime * fps)}`;
    }
    case "set_curve": {
      const rawCurve = snake(str(a.curve) ?? fail("Missing curve"));
      const curveName = rawCurve in CURVES ? rawCurve : (CURVE_ALIASES[rawCurve.replace(/_/g, "")] ?? CURVE_ALIASES[rawCurve]);
      const curve: CurveType = (curveName ? CURVES[curveName] : undefined) ?? fail(`Unknown curve "${rawCurve}". Curves: ${Object.keys(CURVES).join(", ")}`);
      const bones = a.bones === undefined && a.bone === undefined ? boneNames : boneList(a.bones ?? a.bone);
      s.editActiveClip(
        (c) => ({
          ...c,
          boneTracks: Object.fromEntries(Object.entries(c.boneTracks).map(([b, tr]) => [b, bones.includes(b) ? tr.map((k) => ({ ...k, curve })) : tr])),
        }),
        `Copilot ${curveName} curves`,
      );
      return `${curveName!.replace("_", " ")} on ${bones.length === boneNames.length ? "every bone" : bones.join(", ")}`;
    }
    case "retime_clip": {
      if (!clip) fail("No clip open");
      const scale = numArg(a.scale);
      const duration = scale !== undefined ? clip!.duration * clamp(scale, 0.1, 10) : numArg(a.duration);
      const fpsArg = numArg(a.fps);
      if (fpsArg !== undefined && ![24, 30, 60].includes(fpsArg)) fail("Frame rate must be 24, 30 or 60");
      if (duration === undefined && fpsArg === undefined && typeof a.loop !== "boolean") fail("Give duration, scale, fps or loop");
      s.setClipTiming({
        ...(duration !== undefined ? { duration: clamp(duration, 0.05, 60) } : {}),
        ...(fpsArg !== undefined ? { fps: fpsArg } : {}),
        ...(typeof a.loop === "boolean" ? { loop: a.loop } : {}),
        stretch: a.stretch !== false,
      });
      const c2 = useStudioStore.getState().project.animations[s.activeClip]!;
      return `${s.activeClip}: ${c2.duration.toFixed(2)} s · ${c2.fps} fps · ${c2.loop ? "loops" : "plays once"}`;
    }
    case "generate_clips":
      s.regenerateAllProceduralClips();
      return `Regenerated ${Object.keys(useStudioStore.getState().project.animations).length} clips`;
    case "bake_springs_to_keys":
      s.bakeCurrentClipSprings();
      return `Physics baked into keys on ${s.activeClip}`;
    case "add_animation_event": {
      const raw = str(a.name) ?? "OnHit";
      const name = ["OnHit", "SpawnVFX", "PlaySFX", "CameraShake"].find((n) => norm(n) === norm(raw)) ?? fail(`Unknown event "${raw}". Events: OnHit, SpawnVFX, PlaySFX, CameraShake`);
      at(timeFrom(a, fps));
      useStudioStore.getState().addAnimationEventAtCurrentTime(name, `fx_${s.activeClip}_${name.toLowerCase()}`, 1);
      return `${name} event at frame ${Math.round(useStudioStore.getState().currentTime * fps)}`;
    }
    case "review": {
      const cards = reviewClip(s.project, s.activeClip);
      if (cards.length === 0) return `No suggestions: ${s.activeClip} reads well against the principles checked.`;
      return cards.map((c) => `${c.id} [${c.severity}] ${c.principle}: ${c.title}. ${c.detail}${c.apply ? ` Fix: ${c.fixLabel}.` : " (advice only)"}`).join("\n");
    }
    case "apply_suggestion": {
      const id = str(a.id) ?? fail(`Missing suggestion id`);
      const cards = reviewClip(s.project, s.activeClip);
      const card = cards.find((c) => c.id === id || norm(c.id) === norm(id));
      if (!card) return `Nothing to do: "${id}" is not an open suggestion. Open: ${cards.map((c) => c.id).join(", ") || "none"}`;
      if (!card.apply) return `"${card.id}" is advice only: ${card.detail}`;
      s.pushHistory(`Coach: ${card.fixLabel}`, card.apply(s.project, s.activeClip));
      const remaining = reviewClip(useStudioStore.getState().project, s.activeClip).map((c) => c.id);
      return `${card.fixLabel}. Remaining suggestions: ${remaining.join(", ") || "none"}`;
    }
    case "fix_all": {
      const { project, applied } = applyAllCues(s.project, s.activeClip);
      if (applied.length === 0) return "Nothing to fix";
      s.pushHistory(`Coach: ${applied.length} fixes`, project);
      const remaining = reviewClip(project, s.activeClip).map((c) => c.id);
      return `Applied ${applied.length} fixes: ${applied.join("; ")}. Remaining: ${remaining.join(", ") || "none"}`;
    }
    case "set_skin_variant": {
      const skins = ["default", ...(s.project.skins ?? []).map((k) => k.name).filter((n) => n !== "default")];
      const name = resolveName(a.skinName ?? a.name, skins, "skin");
      s.setActiveSkin(name);
      return `Skin ${name}`;
    }
    case "check_budget": {
      const targetId = (str(a.target) ?? "mobile-hero") as BudgetTarget["id"];
      const target = BUDGET_TARGETS[targetId] ?? fail(`Unknown target "${targetId}". Targets: ${Object.keys(BUDGET_TARGETS).join(", ")}`);
      host.openBudget();
      const report = computeBudget(s.project, target);
      return [
        `${target.label}: score ${report.score}/100, ${report.status === "good" ? "within budget" : report.status === "warn" ? "near the limit" : "over budget"}.`,
        ...report.metrics.map((m) => `${m.label}: ${m.display} of ${m.target}${m.status === "good" ? "" : ` (${m.status}: ${m.advice})`}`),
      ].join("\n");
    }
    case "undo": {
      if (s.historyIndex <= 0) return "Nothing to undo";
      const label = s.history[s.historyIndex]?.label;
      s.undo();
      return `Undid "${label}"`;
    }
    case "redo": {
      if (s.historyIndex >= s.history.length - 1) return "Nothing to redo";
      s.redo();
      return `Redid "${useStudioStore.getState().history[useStudioStore.getState().historyIndex]?.label}"`;
    }
    case "save":
      if (!(await host.save())) fail("Not saved. The message under the title says why.");
      return "Saved to the projects folder";
    case "open_project":
      return await host.openProject(str(a.name));
    case "export":
      await host.exportBundle();
      return "Bundle built";
    default:
      return fail(`Unknown tool "${action.tool}"`);
  }
}

export async function executeCopilotActions(actions: CopilotAction[], host: ExecutorHost): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const action of actions.slice(0, 40)) {
    const withSummary = { ...action, summary: action.summary || describeCall(action.tool, action.args) };
    try {
      results.push({ action: withSummary, ok: true, message: await runOne(withSummary, host) });
    } catch (err) {
      results.push({ action: withSummary, ok: false, message: err instanceof Error ? err.message : "Failed" });
    }
  }
  return results;
}
