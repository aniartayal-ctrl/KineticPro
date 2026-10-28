/**
 * Copilot tool catalog (`src/core/copilot/tools.ts`).
 *
 * One list drives everything the copilot can do. Each tool has a JSON Schema, sent to Claude
 * (Messages API tool use) and to OpenAI/xAI (function calling) so models call tools natively
 * instead of writing JSON into prose. The offline planner emits the same tools, and the client
 * executor validates and runs them. Arguments are still validated at run time: models make mistakes.
 */

export type CopilotAction = { tool: string; args: Record<string, unknown>; summary: string };

export type JsonSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolSpec = { name: string; description: string; input: JsonSchema };

const obj = (properties: Record<string, Record<string, unknown>> = {}, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});
const str = (description: string, enumValues?: string[]) => ({ type: "string", description, ...(enumValues ? { enum: enumValues } : {}) });
const num = (description: string, minimum?: number, maximum?: number) => ({
  type: "number",
  description,
  ...(minimum !== undefined ? { minimum } : {}),
  ...(maximum !== undefined ? { maximum } : {}),
});
const int = (description: string, minimum?: number) => ({ type: "integer", description, ...(minimum !== undefined ? { minimum } : {}) });
const bool = (description: string) => ({ type: "boolean", description });
const bones = (description = 'Bone names from the studio state; ["all"] for every bone. Omit for the selected bone.') => ({
  type: "array",
  items: { type: "string" },
  description,
});
const time = num("Time in seconds. Use either time or frame.", 0);
const frame = int("Frame number at the clip's frame rate. Use either time or frame.", 0);

export const EVENT_NAMES = ["OnHit", "SpawnVFX", "PlaySFX", "CameraShake"];
export const ARCHETYPES = ["auto_detect", "heavy_titan", "olympus_caster", "agile_duelist", "slot_symbol", "treasure_chest"];
export const VFX = ["none", "lightning_bolts", "fire_aura", "shockwave_rings", "coin_fountain", "star_sparks"];
export const LIP_SYNC_PHRASES = ["battle_cry", "olympus_roar", "jackpot_call"];
export const SYMBOL_ROLES = ["h1", "h2", "h3", "l1", "l2", "l3", "wild", "scatter"];

export const COACH_IDS = ["slow-in-out", "anticipation", "follow-through", "squash", "secondary", "exaggeration", "off-frame", "loop-seam", "even-timing"];

export const COPILOT_TOOLS: ToolSpec[] = [
  // Read
  {
    name: "inspect",
    description:
      "Read the open clip and a bone's keys, pose at the playhead, physics and IK. Call this before relative edits or when you need exact values.",
    input: obj({ bone: str("Bone to inspect; defaults to the selected bone") }),
  },
  // Selection, view, playback
  {
    name: "select",
    description: "Select a bone, a layer (part) or open an animation clip.",
    input: obj({ bone: str("Bone name"), part: str("Layer name"), clip: str("Clip name to open") }),
  },
  {
    name: "set_mode",
    description: "Switch tool. Spine names map here: Create = rig; Pose/Rotate/Translate/Scale = animate with that tool.",
    input: obj(
      {
        mode: str("Tool", ["import", "auto", "rig", "mesh", "weights", "animate", "liquify", "export"]),
        tool: str("Transform tool when mode is animate", ["pose", "rotate", "translate", "scale"]),
      },
      ["mode"],
    ),
  },
  {
    name: "toggle_overlay",
    description: "Show or hide a viewport overlay.",
    input: obj(
      {
        overlay: str("Overlay", ["bones", "mesh", "heatmap", "onion", "arcs", "trail", "lighting", "hitboxes", "solo"]),
        on: bool("true shows, false hides; omit to toggle"),
      },
      ["overlay"],
    ),
  },
  {
    name: "playback",
    description: "Play, play backward, pause or set the playback speed.",
    input: obj({ action: str("What to do", ["play", "play_backward", "pause", "toggle"]), speed: num("Playback speed multiplier", 0.1, 4) }),
  },
  {
    name: "go_to",
    description: "Move the playhead to a time, a frame, or the next/previous/first/last key.",
    input: obj({ time, frame, key: str("Jump to a key", ["next", "prev", "first", "last"]) }),
  },
  // Rigging
  {
    name: "auto_rig",
    description:
      "Auto-rig the whole project: infer physics, mesh every layer, solve weights and regenerate the game clips. Replaces existing animation. An archetype tunes mass and motion.",
    input: obj({ archetype: str("Body type; omit to detect from the art", ARCHETYPES) }),
  },
  {
    name: "add_bone",
    description: "Add a bone. Position is normalized to the canvas (0..1); defaults to a small offset from the parent.",
    input: obj({ name: str("New bone name"), parent: str("Parent bone; defaults to the selected bone"), x: num("0..1", 0, 1), y: num("0..1", 0, 1) }, ["name"]),
  },
  {
    name: "move_pivot",
    description: "Move a bone's bind pivot (setup pose), normalized 0..1. Skinned meshes re-weight.",
    input: obj({ bone: str("Bone name"), x: num("0..1", 0, 1), y: num("0..1", 0, 1) }, ["bone", "x", "y"]),
  },
  {
    name: "configure_ik",
    description: "Set an IK constraint's mix (0 = off, 1 = full) and bend direction.",
    input: obj({ ikName: str("IK constraint; defaults to the first"), mix: num("0..1", 0, 1), flip: bool("Reverse the bend direction") }),
  },
  {
    name: "configure_spring_physics",
    description: "Add, tune or remove secondary-motion physics (spring) on a bone. Typical stiffness 40 (loose) to 90 (tight).",
    input: obj(
      {
        bone: str("Bone name"),
        enabled: bool("false removes physics"),
        stiffness: num("5..200", 5, 200),
        damping: num("0.5..40", 0.5, 40),
        wind: num("Ambient sway 0..10", 0, 10),
      },
      ["bone", "enabled"],
    ),
  },
  {
    name: "lock_bone",
    description: "Lock or unlock a bone against weight painting.",
    input: obj({ bone: str("Bone name"), locked: bool("true locks") }, ["bone", "locked"]),
  },
  // Mesh and weights
  {
    name: "configure_mesh_and_weights",
    description: "Re-mesh a layer (or all layers) and solve its bone weights.",
    input: obj(
      {
        part: str('Layer name, or "all"'),
        density: str("Triangle density", ["low", "medium", "high"]),
        weightMode: str("Weight solver", ["hybrid", "heat", "capsule"]),
      },
      ["part"],
    ),
  },
  { name: "reset_warp", description: "Clear warp (FFD) offsets on a layer in the open clip.", input: obj({ part: str("Layer name") }, ["part"]) },
  {
    name: "set_draw_order",
    description: "Move a layer in the draw order: forward/backward by steps, or to the front/back.",
    input: obj({ part: str("Layer name"), move: str("Direction", ["forward", "backward", "front", "back"]), steps: int("Layers to move (default 1)", 1) }, [
      "part",
      "move",
    ]),
  },
  {
    name: "set_layer_visibility",
    description: "Show or hide a layer in the viewport (view only; export is unchanged).",
    input: obj({ part: str("Layer name"), visible: bool("false hides") }, ["part", "visible"]),
  },
  // Animation
  {
    name: "set_key",
    description:
      "Key bones at the playhead (or at time/frame). Values are offsets from the setup pose: r degrees clockwise, x/y pixels (y down), sx/sy scale multipliers (1 = rest). Channels you omit keep their current value. relative: true adds r/x/y to the current pose and multiplies sx/sy. Keying without values records the current pose.",
    input: obj({
      bones: bones(),
      r: num("Rotation in degrees"),
      x: num("Move X in pixels"),
      y: num("Move Y in pixels (down is positive)"),
      sx: num("Scale X (1 = rest)"),
      sy: num("Scale Y (1 = rest)"),
      relative: bool("Add r/x/y to the current pose and multiply sx/sy, instead of setting them"),
      time,
      frame,
    }),
  },
  {
    name: "breakdown",
    description: "Key an in-between at the playhead, a fraction of the way from the previous key's pose to the next (0.5 halfway, above 1 overshoots).",
    input: obj({ fraction: num("-0.25..1.25", -0.25, 1.25), bones: bones("Bones; omit for every bone") }, ["fraction"]),
  },
  {
    name: "delete_key",
    description: "Delete keys at the playhead (or at time/frame) on the given bones.",
    input: obj({ bones: bones('Bones; ["all"] for every bone. Omit for the selected bone.'), time, frame }),
  },
  { name: "copy_pose", description: "Copy the whole pose at the playhead.", input: obj() },
  { name: "paste_pose", description: "Paste the copied pose as keys at the playhead (or time/frame).", input: obj({ time, frame }) },
  {
    name: "set_curve",
    description: "Set the easing of every key on the given bones in the open clip.",
    input: obj({ bones: bones('Bones; omit or ["all"] for every bone'), curve: str("Easing", ["linear", "ease", "ease_in", "ease_out", "overshoot", "stepped"]) }, [
      "curve",
    ]),
  },
  {
    name: "retime_clip",
    description: "Change the open clip's length (duration in seconds or scale factor), frame rate or looping. Keys stretch with the length by default.",
    input: obj({
      duration: num("New length in seconds", 0.05, 60),
      scale: num("Length multiplier, e.g. 0.8 = 20% faster", 0.1, 10),
      fps: { type: "integer", enum: [24, 30, 60], description: "Frame rate" },
      loop: bool("Loop the clip"),
      stretch: bool("Scale keys with the new length (default true)"),
    }),
  },
  { name: "generate_clips", description: "Regenerate the built-in game action clips from the current rig.", input: obj() },
  { name: "bake_springs_to_keys", description: "Bake physics, follow and IK into plain keys for the open clip.", input: obj() },
  {
    name: "add_animation_event",
    description: "Add a Unity animation event at the playhead (or time/frame).",
    input: obj({ name: str("Event", EVENT_NAMES), time, frame }, ["name"]),
  },
  {
    name: "remove_animation_event",
    description: "Remove animation events: by name at a time/frame, every event at that frame, or every event with that name.",
    input: obj({ name: str("Event name", EVENT_NAMES), time, frame }),
  },
  {
    name: "set_principles",
    description:
      "Tune the principles of animation used by the game clip generator (1 = default, 0..2) and regenerate every game clip. Replaces hand edits to those clips.",
    input: obj({
      squashAndStretch: num("0..2", 0, 2),
      anticipation: num("0..2", 0, 2),
      followThroughOverlap: num("0..2", 0, 2),
      arcsAndEasing: num("0..2", 0, 2),
      secondaryAndAppeal: num("0..2", 0, 2),
      exaggeration: num("0.5..2", 0.5, 2),
    }),
  },
  { name: "set_vfx", description: "Choose the elemental VFX layer shown with the character.", input: obj({ vfx: str("Effect", VFX) }, ["vfx"]) },
  {
    name: "lip_sync",
    description: "Key a voice line's mouth and blink animation into the open clip.",
    input: obj({ phrase: str("Voice line", LIP_SYNC_PHRASES) }, ["phrase"]),
  },
  {
    name: "open_symbol_rig",
    description: "Open one of the theme's 8 slot symbols as its own rig (asks the user first if there are unsaved changes).",
    input: obj({ role: str("Symbol", SYMBOL_ROLES) }, ["role"]),
  },
  // Coach
  {
    name: "review",
    description: "Review the open clip against the principles of animation. Returns suggestions with ids for apply_suggestion.",
    input: obj(),
  },
  {
    name: "apply_suggestion",
    description: "Apply one coach suggestion by id (ids come from review or the studio state).",
    input: obj({ id: str("Suggestion id", COACH_IDS) }, ["id"]),
  },
  { name: "fix_all", description: "Apply every coach suggestion that has a fix, as one undo step.", input: obj() },
  // Project
  { name: "set_skin_variant", description: "Switch the skin tier.", input: obj({ skinName: str("Skin name from the studio state") }, ["skinName"]) },
  {
    name: "check_budget",
    description: "Measure the rig against a performance target and return the metrics (texture memory, vertices, draw calls…).",
    input: obj({ target: str("Target", ["mobile-symbol", "mobile-hero", "desktop-hero"]) }),
  },
  { name: "undo", description: "Undo the last change.", input: obj() },
  { name: "redo", description: "Redo the last undone change.", input: obj() },
  { name: "save", description: "Save the project into the projects folder.", input: obj() },
  {
    name: "open_project",
    description: "Open a saved project or built-in template by (partial) name; without a name, show the list. Asks the user first if there are unsaved changes.",
    input: obj({ name: str("Project or template name") }),
  },
  { name: "export", description: "Build the Unity / Spine 4.2 / sprite-sheet bundle.", input: obj() },
];

export const TOOL_NAMES = new Set(COPILOT_TOOLS.map((t) => t.name));

/** Live studio state sent with every request so models use real names and current values. */
export type CopilotContext = {
  bones: string[];
  parts: string[];
  clips: string[];
  ikNames: string[];
  activeClip: string;
  selectedBone: string | null;
  selectedPart: string | null;
  currentTime: number;
  duration: number;
  fps: number;
  loop?: boolean;
  mode?: string;
  transformTool?: string;
  isPlaying?: boolean;
  skins?: string[];
  activeSkin?: string;
  springBones?: string[];
  hiddenParts?: string[];
  suggestions?: { id: string; principle: string; title: string; fixable: boolean }[];
};

export const SYSTEM_PROMPT = [
  "You are the copilot inside Kinetic, a 2D rigging and animation studio for Unity slot games (symbols, wins, idles, big-win sequences).",
  "You are an expert animator: apply the 12 principles of animation (anticipation, follow-through, slow in and out, arcs, squash and stretch, timing, exaggeration, secondary action).",
  "Operate the studio only through the tools. Use exact bone, layer, clip and skin names from the studio state; never invent names.",
  "Conventions: rotation is degrees clockwise, x/y are pixels with y pointing down, scale 1 is rest. Keys are offsets from the setup pose. Prefer frame numbers; keys snap to frames.",
  "A motion needs at least two keys. Squash and stretch preserves volume (sy 0.8 pairs with sx about 1.2). Slot symbols usually loop: match the first and last pose.",
  "Work in small, checkable steps; you may call several tools at once when they are independent. After tools run you get their results: read them, and if one fails, correct it rather than repeating it.",
  "Call inspect before relative or follow-up edits when you need current values. Call review before fixing animation problems unless the studio state already lists the suggestion.",
  "Destructive tools (auto_rig, generate_clips, bake_springs_to_keys, open_project) replace work: use them only when the user asks for that outcome. Every change is one undo step.",
  "When finished, reply in one or two plain sentences saying what changed. If the request is ambiguous, ask one short question instead of guessing.",
].join("\n");

export function describeContext(ctx: CopilotContext): string {
  const lines = [
    `Clip: ${ctx.activeClip} (${ctx.duration.toFixed(2)} s, ${ctx.fps} fps, ${ctx.loop ? "loops" : "plays once"}); playhead ${ctx.currentTime.toFixed(3)} s = frame ${Math.round(ctx.currentTime * ctx.fps)}${ctx.isPlaying ? ", playing" : ""}`,
    `Clips: ${ctx.clips.join(", ")}`,
    `Bones: ${ctx.bones.join(", ")}`,
    `Layers (back to front): ${ctx.parts.join(", ")}${ctx.hiddenParts?.length ? `; hidden: ${ctx.hiddenParts.join(", ")}` : ""}`,
    `IK constraints: ${ctx.ikNames.join(", ") || "none"}`,
    `Bones with physics: ${ctx.springBones?.join(", ") || "none"}`,
    `Selected: bone ${ctx.selectedBone ?? "none"}, layer ${ctx.selectedPart ?? "none"}; tool ${ctx.mode ?? "?"}${ctx.mode === "animate" && ctx.transformTool ? `/${ctx.transformTool}` : ""}`,
  ];
  if (ctx.skins?.length) lines.push(`Skins: ${ctx.skins.map((k) => (k === ctx.activeSkin ? `${k} (active)` : k)).join(", ")}`);
  if (ctx.suggestions?.length) {
    lines.push("Coach suggestions for this clip:");
    for (const s of ctx.suggestions) lines.push(`- ${s.id} (${s.principle}): ${s.title}${s.fixable ? "" : " [advice only]"}`);
  } else {
    lines.push("Coach suggestions for this clip: none");
  }
  return lines.join("\n");
}
