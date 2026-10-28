import assert from "node:assert/strict";
import test from "node:test";
import { applyAllCues, reviewClip } from "../coach";
import { BUILTIN_PRESETS } from "../presets";
import { findNames, planCommand, splitClauses } from "./planner";
import type { CopilotContext } from "./tools";
import { COPILOT_TOOLS, TOOL_NAMES } from "./tools";

const project = BUILTIN_PRESETS["astral-forge"]!();
const ctx: CopilotContext = {
  bones: project.bones.map((b) => b.name),
  parts: project.parts.map((p) => p.name),
  clips: Object.keys(project.animations),
  ikNames: (project.ikConstraints ?? []).map((k) => k.name),
  activeClip: "strike",
  selectedBone: "arm",
  selectedPart: "body",
  currentTime: 0.5,
  duration: 2,
  fps: 24,
};
const tools = (p: string) => planCommand(p, ctx).actions.map((a) => a.tool);

test("clause splitting keeps objects with their verb", () => {
  assert.deepEqual(splitClauses("show onion skin and motion arcs, then key all"), ["show onion skin and motion arcs", "key all"]);
  assert.deepEqual(splitClauses("mesh body and head; play"), ["mesh body and head", "play"]);
});

test("names resolve exactly and through synonyms", () => {
  assert.deepEqual(findNames("add physics to the arm back", ctx.bones), ["arm-back"]);
  assert.ok(findNames("swing the sword", ctx.bones).includes("weapon"));
  assert.deepEqual(findNames("warm up", ctx.bones), []);
});

test("every feature area is reachable in plain English", () => {
  const cases: [string, string[]][] = [
    ["review this clip", ["review"]],
    ["add anticipation and overshoot", ["apply_suggestion", "apply_suggestion"]],
    ["fix everything", ["fix_all"]],
    ["mesh the body dense with heat weights", ["configure_mesh_and_weights"]],
    ["re-weight all layers", ["configure_mesh_and_weights"]],
    ["add physics to the cape, then make it snappier", ["configure_spring_physics", "retime_clip"]],
    ["remove physics from cape", ["configure_spring_physics"]],
    ["add a bone called tassel under head", ["add_bone"]],
    ["set ik to 40%", ["configure_ik"]],
    ["flip the elbow", ["configure_ik"]],
    ["lock chest", ["lock_bone"]],
    ["key all bones, then breakdown 30% on arm", ["set_key", "breakdown"]],
    ["copy pose then go to frame 20 then paste pose", ["copy_pose", "go_to", "paste_pose"]],
    ["ease in on the arm", ["set_curve"]],
    ["make it 1.5 seconds long", ["retime_clip"]],
    ["60 fps", ["retime_clip"]],
    ["play the idle animation", ["select", "playback"]],
    ["pause", ["playback"]],
    ["next key", ["go_to"]],
    ["show onion skin and motion arcs", ["toggle_overlay", "toggle_overlay"]],
    ["hide the bones", ["toggle_overlay"]],
    ["auto rig it", ["auto_rig"]],
    ["generate all clips", ["generate_clips"]],
    ["bake physics", ["bake_springs_to_keys"]],
    ["add a camera shake event at frame 12", ["add_animation_event"]],
    ["open the weight paint tool", ["set_mode"]],
    ["check the budget", ["check_budget"]],
    ["undo", ["undo"]],
    ["save", ["save"]],
    ["export", ["export"]],
    ["open project sands", ["open_project"]],
    ["use the rotate tool", ["set_mode"]],
    ["switch to scale", ["set_mode"]],
    ["open the astral forge project", ["open_project"]],
    ["show my projects", ["open_project"]],
  ];
  for (const [prompt, expected] of cases) assert.deepEqual(tools(prompt), expected, prompt);
  // Every emitted tool exists in the catalog.
  for (const [prompt] of cases) for (const a of planCommand(prompt, ctx).actions) assert.ok(TOOL_NAMES.has(a.tool), a.tool);
  assert.ok(COPILOT_TOOLS.length >= 30);
});

test("Spine tool names map to Kinetic tools", () => {
  assert.deepEqual(planCommand("use the rotate tool", ctx).actions[0]!.args, { mode: "animate", tool: "rotate" });
  assert.deepEqual(planCommand("use the create tool", ctx).actions[0]!.args, { mode: "rig" });
});

test("project requests carry the name the user typed", () => {
  assert.deepEqual(planCommand("open project sands", ctx).actions[0]!.args, { name: "sands" });
  assert.deepEqual(planCommand("open the astral forge project", ctx).actions[0]!.args, { name: "astral forge" });
  assert.deepEqual(planCommand("show my projects", ctx).actions[0]!.args, {});
  assert.deepEqual(planCommand("save then open project sands", ctx).actions.map((a) => a.tool), ["save", "open_project"]);
});

test("unknown requests explain themselves instead of guessing", () => {
  const plan = planCommand("make me a sandwich", ctx);
  assert.equal(plan.actions.length, 0);
  assert.match(plan.reply, /couldn't map/);
});

test("coach reviews clips and every fix applies cleanly", () => {
  const cards = reviewClip(project, "strike");
  assert.ok(cards.length > 0, "built-in strike has room to improve");
  for (const card of cards) {
    if (!card.apply) continue;
    const next = card.apply(project, "strike");
    assert.notEqual(next, project, `${card.id} changed nothing`);
    for (const track of Object.values(next.animations.strike!.boneTracks)) {
      for (let i = 1; i < track.length; i++) assert.ok(track[i]!.time > track[i - 1]!.time, `${card.id} left unsorted keys`);
      for (const k of track) for (const v of [k.r, k.x, k.y, k.sx, k.sy]) assert.ok(v === undefined || Number.isFinite(v));
    }
  }
  const { project: fixed, applied } = applyAllCues(project, "strike");
  assert.ok(applied.length > 0);
  const remaining = reviewClip(fixed, "strike").filter((c) => c.apply).map((c) => c.id);
  assert.ok(!remaining.includes("off-frame") && !remaining.includes("anticipation") && !remaining.includes("secondary"), remaining.join());
});

test("coach catches a linear, unanticipated, rigid clip and fixes it", () => {
  const p = structuredClone(project);
  p.animations.test = {
    name: "test",
    duration: 1,
    fps: 24,
    loop: true,
    boneTracks: { arm: [{ time: 0, r: 0 }, { time: 0.25, r: 5 }, { time: 0.5, r: 80 }, { time: 0.75, r: 80 }] },
  };
  const ids = reviewClip(p, "test").map((c) => c.id);
  for (const id of ["slow-in-out", "anticipation", "follow-through", "loop-seam"]) assert.ok(ids.includes(id), `missing ${id} in ${ids}`);
});

test("explicit numbers key the named bones", () => {
  const plan = (p: string) => planCommand(p, ctx).actions;
  assert.deepEqual(plan("Tilt the head 15 degrees at frame 6")[0]!.args, { bones: ["head"], r: 15, frame: 6 });
  assert.deepEqual(plan("rotate the head 10 degrees further")[0]!.args, { bones: ["head"], r: 10, relative: true });
  assert.deepEqual(plan("nudge the hips 5 px left")[0]!.args, { bones: ["hips"], x: -5, relative: true });
  assert.deepEqual(plan("squash the chest at frame 10: scale y to 0.85 and scale x to 1.15")[0]!.args, { bones: ["chest"], sx: 1.15, sy: 0.85, frame: 10 });
  assert.deepEqual(plan("squash it 20%")[0]!.args, { bones: ["arm"], sx: 1.25, sy: 0.8, relative: true });
  assert.deepEqual(plan("tilt the head 10° counter-clockwise")[0]!.args, { bones: ["head"], r: -10 });
  const chained = plan("turn the head 20 degrees and move it up 10px at frame 3");
  assert.deepEqual(chained[1]!.args, { bones: ["head"], y: -10, relative: true, frame: 3 }, "'it' is the bone named before");
});

test("questions are answered without changing anything", () => {
  const mutating = new Set(COPILOT_TOOLS.map((t) => t.name).filter((n) => !["inspect", "review", "check_budget"].includes(n)));
  for (const q of ["Which bones have physics?", "what's the frame rate?", "how long is this clip?", "is the loop seamless?", "What bones are there?", "Will this fit the mobile symbol budget?"]) {
    const p = planCommand(q, { ...ctx, springBones: ["cape"] });
    assert.ok(!p.actions.some((a) => mutating.has(a.tool)), `${q} → ${p.actions.map((a) => a.tool)}`);
    assert.ok(p.reply.length > 0 || p.actions.length > 0, q);
  }
  assert.match(planCommand("Which bones have physics?", { ...ctx, springBones: ["cape"] }).reply, /cape/);
  assert.deepEqual(planCommand("can you add physics to the cape", ctx).actions[0]!.tool, "configure_spring_physics");
});

test("common phrasings for timing, IK, skins and the clipboard", () => {
  const args = (p: string) => planCommand(p, { ...ctx, skins: ["default", "awakened"] }).actions.map((a) => [a.tool, a.args]);
  assert.deepEqual(args("Set the arm IK to 70 percent")[0]![1], { ikName: ctx.ikNames[0], mix: 0.7 });
  assert.deepEqual(args("Make this clip play once instead of looping"), [["retime_clip", { loop: false }]]);
  assert.deepEqual(args("make the clip 10% slower")[0], ["retime_clip", { scale: 1.1, stretch: true }]);
  assert.deepEqual(args("Play the animation backward at half speed")[0], ["playback", { action: "play_backward", speed: 0.5 }]);
  assert.deepEqual(args("Switch to the awakened skin")[0], ["set_skin_variant", { skinName: "awakened" }]);
  assert.deepEqual(args("Copy the pose at frame 12 and paste it at frame 30"), [
    ["go_to", { frame: 12 }],
    ["copy_pose", {}],
    ["paste_pose", { frame: 30 }],
  ]);
  assert.deepEqual(args("Fix the follow-through problem the coach found")[0], ["apply_suggestion", { id: "follow-through" }]);
  assert.deepEqual(args("Apply every coach fix you can")[0], ["fix_all", {}]);
  assert.deepEqual(args("go to the last key")[0], ["go_to", { key: "last" }]);
  assert.deepEqual(args("make the cape floppier")[0], ["configure_spring_physics", { bone: "cape", enabled: true, stiffness: 40 }]);
});

test("layers, cleanup, presentation and generator phrasings", () => {
  const args = (p: string) => planCommand(p, ctx).actions.map((a) => [a.tool, a.args]);
  const order = ctx.parts;
  const back = order[0]!;
  const front = order[order.length - 1]!;
  assert.deepEqual(args(`bring the ${back} to the front`)[0], ["set_draw_order", { part: back, move: "front" }]);
  assert.deepEqual(args(`put the ${front} behind the ${back}`)[0], ["set_draw_order", { part: front, move: "backward", steps: order.length - 1 }]);
  assert.deepEqual(args(`hide the ${front} layer`)[0], ["set_layer_visibility", { part: front, visible: false }]);
  assert.deepEqual(args("hide the bones")[0], ["toggle_overlay", { overlay: "bones", on: false }]);
  assert.deepEqual(args("delete the key at frame 12 on the head")[0], ["delete_key", { bones: ["head"], frame: 12 }]);
  assert.deepEqual(args("remove the camera shake event")[0], ["remove_animation_event", { name: "CameraShake" }]);
  assert.deepEqual(args("turn the vfx to fire")[0], ["set_vfx", { vfx: "fire_aura" }]);
  assert.deepEqual(args("lip sync the jackpot call")[0], ["lip_sync", { phrase: "jackpot_call" }]);
  assert.deepEqual(args("open the wild symbol")[0], ["open_symbol_rig", { role: "wild" }]);
  assert.deepEqual(args("more anticipation in all clips")[0], ["set_principles", { anticipation: 1.4 }]);
  assert.deepEqual(args("auto rig as a heavy titan")[0], ["auto_rig", { archetype: "heavy_titan" }]);
  assert.deepEqual(args("add a vfx event at frame 10")[0], ["add_animation_event", { name: "SpawnVFX", frame: 10 }]);
});

test("every catalog tool is reachable from plain English", () => {
  const phrases = [
    "what is wrong with this clip?", "which bones are there?", "inspect the head", "select the head", "use the rotate tool", "show onion skin", "play", "go to frame 3",
    "auto rig", "add a bone called tip under head", "move the head pivot to 0.5, 0.2", "set ik to 40%", "add physics to the cape", "lock the chest",
    "mesh the body dense", "reset the warp on the body", "bring the head to the front", "hide the hammer layer", "rotate the head 10 degrees",
    "breakdown 50%", "delete the key at frame 4 on the head", "copy the pose", "paste the pose at frame 9", "ease all keys", "make it 20% faster",
    "regenerate all clips", "bake", "add an onhit event at frame 4", "remove the onhit event", "more anticipation in all clips",
    "turn the vfx to coins", "lip sync the battle cry", "open the wild symbol", "review this clip",
    "add anticipation", "fix everything", "switch to the awakened skin", "check the budget", "undo", "redo", "save", "open project sands", "export",
  ];
  const reached = new Set(phrases.flatMap((p) => planCommand(p, { ...ctx, skins: ["default", "awakened"] }).actions.map((a) => a.tool)));
  const missing = COPILOT_TOOLS.map((t) => t.name).filter((n) => !reached.has(n));
  assert.deepEqual(missing, []);
});
