import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { sampleTransformTrack } from "@/core/animator";
import { snapTime } from "@/core/keyframes";
import { COACH_IDS, COPILOT_TOOLS } from "@/core/copilot/tools";
import { useStudioStore } from "@/store/useStudioStore";
import { copilotContext, executeCopilotActions, type ExecutorHost } from "./executor";

const initial = useStudioStore.getState();
const calls: string[] = [];
const host: ExecutorHost = {
  exportBundle: async () => void calls.push("export"),
  save: async () => (calls.push("save"), true),
  openBudget: () => void calls.push("budget"),
  openProject: async (name) => (calls.push(`open:${name ?? ""}`), `Opened ${name}`),
  openSymbol: async (role, title) => (calls.push(`symbol:${role}`), `Opened ${title}`),
};

const run1 = async (tool: string, args: Record<string, unknown> = {}, h = host) => (await executeCopilotActions([{ tool, args, summary: "" }], h))[0]!;
const state = () => useStudioStore.getState();
const clip = () => state().project.animations[state().activeClip]!;
const poseAt = (bone: string, frame: number) => sampleTransformTrack(clip().boneTracks[bone], snapTime(frame / (clip().fps || 30), clip().fps || 30, clip().duration));

beforeEach(() => {
  useStudioStore.setState(initial, true);
  useStudioStore.getState().setIsPlaying(false);
  calls.length = 0;
});

describe("copilot executor", () => {
  it("handles every catalog tool name", async () => {
    for (const t of COPILOT_TOOLS) {
      const r = await run1(t.name, {});
      assert.ok(!/Unknown tool/.test(r.message), `${t.name}: ${r.message}`);
    }
  });

  it("reports live context for the model", () => {
    const ctx = copilotContext();
    assert.ok(ctx.bones.includes("weapon"));
    assert.ok(ctx.skins?.includes("default"));
    assert.equal(typeof ctx.loop, "boolean");
    for (const s of ctx.suggestions ?? []) assert.ok(COACH_IDS.includes(s.id), `coach id ${s.id} missing from the tool enum`);
  });

  it("resolves names tolerantly and lists choices on a miss", async () => {
    assert.equal((await run1("select", { bone: "Weapon" })).ok, true);
    assert.equal(state().selectedBone, "weapon");
    assert.equal((await run1("select", { bone: "cape tail" })).ok, true);
    assert.equal(state().selectedBone, "cape-tail");
    assert.equal((await run1("select", { clip: "SYMBOL_WIN" })).ok, true);
    assert.equal(state().activeClip, "symbol-win");
    const miss = await run1("select", { bone: "tentacle" });
    assert.equal(miss.ok, false);
    assert.match(miss.message, /No bone named "tentacle"\. Bones: root, hips/);
  });

  it("keys absolute values at a frame and keeps other channels", async () => {
    const before = poseAt("weapon", 6);
    const r = await run1("set_key", { bones: ["weapon"], r: 15, frame: 6 });
    assert.equal(r.ok, true, r.message);
    const after = poseAt("weapon", 6);
    assert.equal(after.r, 15);
    assert.equal(after.x, before.x);
    assert.equal(after.sy, before.sy);
    assert.equal(Math.round(state().currentTime * clip().fps), 6);
    assert.match(r.message, /frame 6/);
  });

  it("keys relative values: adds rotation, multiplies scale", async () => {
    await run1("set_key", { bones: ["head"], r: 10, sy: 1, frame: 4 });
    await run1("set_key", { bones: ["head"], r: 5, sy: 0.8, relative: true, frame: 4 });
    const p = poseAt("head", 4);
    assert.equal(p.r, 15);
    assert.ok(Math.abs(p.sy - 0.8) < 1e-9);
  });

  it('accepts "all", a bare string, and string numbers', async () => {
    const r = await run1("set_key", { bones: "all", r: "3", frame: 2 });
    assert.equal(r.ok, true, r.message);
    for (const b of state().project.bones) assert.equal(poseAt(b.name, 2).r, 3, b.name);
    assert.equal((await run1("set_key", { bones: "chest", x: 4, frame: 3 })).ok, true);
    assert.equal(poseAt("chest", 3).x, 4);
  });

  it("turns percentages into fractions", async () => {
    const r = await run1("configure_ik", { mix: 40 });
    assert.equal(r.ok, true, r.message);
    assert.equal(state().project.ikConstraints![0]!.mix, 0.4);
    const bend = state().project.ikConstraints![0]!.bendPositive;
    await run1("configure_ik", { flip: true });
    assert.equal(state().project.ikConstraints![0]!.bendPositive, !bend);
  });

  it("returns review ids that apply_suggestion accepts", async () => {
    const review = await run1("review");
    const id = review.message.split(" ")[0]!;
    assert.ok(COACH_IDS.includes(id), review.message);
    const fix = await run1("apply_suggestion", { id });
    assert.equal(fix.ok, true, fix.message);
    assert.match(fix.message, /Remaining suggestions/);
    assert.ok(!copilotContext().suggestions!.some((s) => s.id === id), `${id} should be resolved`);
  });

  it("reports budget metrics and opens the panel", async () => {
    const r = await run1("check_budget", { target: "mobile-symbol" });
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /score \d+\/100/);
    assert.ok(r.message.split("\n").length > 2);
    assert.deepEqual(calls, ["budget"]);
  });

  it("plays backward", async () => {
    await run1("playback", { action: "play_backward", speed: 0.5 });
    assert.equal(state().isPlaying, true);
    assert.equal(state().playDirection, -1);
    assert.equal(state().playbackSpeed, 0.5);
    await run1("playback", { action: "pause" });
    assert.equal(state().isPlaying, false);
  });

  it("navigates keys", async () => {
    await run1("go_to", { frame: 0 });
    const next = await run1("go_to", { key: "next" });
    assert.equal(next.ok, true, next.message);
    assert.ok(state().currentTime > 0);
    const last = await run1("go_to", { key: "last" });
    assert.equal(last.ok, true);
    const t = state().currentTime;
    const none = await run1("go_to", { key: "next" });
    assert.equal(none.ok, false);
    assert.equal(state().currentTime, t);
  });

  it("maps synonyms for curves, overlays, density and modes", async () => {
    assert.equal((await run1("set_curve", { curve: "smooth", bones: ["weapon"] })).ok, true);
    assert.ok(clip().boneTracks.weapon!.every((k) => Array.isArray(k.curve)));
    assert.equal((await run1("toggle_overlay", { overlay: "wireframe", on: true })).message, "mesh on");
    assert.equal((await run1("toggle_overlay", { overlay: "mesh", on: true })).message, "mesh on");
    const mesh = await run1("configure_mesh_and_weights", { part: "Hammer", density: "dense", weightMode: "geodesic" });
    assert.equal(mesh.ok, true, mesh.message);
    assert.match(mesh.message, /hammer \(high, heat weights, \d+ vertices\)/);
    assert.equal((await run1("set_mode", { mode: "rotate" })).ok, true);
    assert.equal(state().mode, "animate");
    assert.equal(state().transformTool, "rotate");
  });

  it("undoes copilot edits as single steps", async () => {
    const before = poseAt("weapon", 6).r;
    await run1("set_key", { bones: ["weapon"], r: 42, frame: 6 });
    const u = await run1("undo");
    assert.match(u.message, /Undid "Copilot keyed weapon"/);
    assert.equal(poseAt("weapon", 6).r, before);
    await run1("redo");
    assert.equal(poseAt("weapon", 6).r, 42);
  });

  it("fails clearly instead of throwing", async () => {
    const results = await executeCopilotActions(
      [
        { tool: "teleport", args: {}, summary: "" },
        { tool: "set_key", args: { bones: ["nope"], r: 1 }, summary: "" },
        { tool: "retime_clip", args: { fps: 25 }, summary: "" },
        { tool: "save", args: {}, summary: "" },
      ],
      { ...host, save: async () => false },
    );
    assert.deepEqual(
      results.map((r) => r.ok),
      [false, false, false, false],
    );
    assert.match(results[0]!.message, /Unknown tool/);
    assert.match(results[2]!.message, /24, 30 or 60/);
    assert.ok(results.every((r) => r.action.summary.length > 0), "summaries are filled in for the thread");
  });

  it("accepts legacy action names", async () => {
    const r = await run1("key", { bones: ["head"], r: 7, frame: 1 });
    assert.equal(r.ok, true, r.message);
    assert.equal(poseAt("head", 1).r, 7);
  });

  it("reorders and hides layers", async () => {
    const parts = () => state().project.parts.map((p) => p.name);
    const back = parts()[0]!;
    const r = await run1("set_draw_order", { part: back, move: "front" });
    assert.equal(r.ok, true, r.message);
    assert.equal(parts()[parts().length - 1], back);
    assert.match((await run1("set_draw_order", { part: back, move: "front" })).message, /already in front/);
    await run1("set_draw_order", { part: back, move: "backward", steps: 2 });
    assert.equal(parts().indexOf(back), parts().length - 3);
    await run1("set_layer_visibility", { part: back, visible: false });
    assert.ok(state().hiddenParts.includes(back));
    await run1("set_layer_visibility", { part: back, visible: false });
    assert.ok(state().hiddenParts.includes(back), "hiding twice keeps it hidden");
    await run1("set_layer_visibility", { part: back, visible: true });
    assert.ok(!state().hiddenParts.includes(back));
  });

  it("deletes keys and events at a frame", async () => {
    await run1("set_key", { bones: ["head"], r: 9, frame: 7 });
    const del = await run1("delete_key", { bones: ["head"], frame: 7 });
    assert.equal(del.ok, true, del.message);
    assert.ok(!clip().boneTracks.head!.some((k) => Math.round(k.time * clip().fps) === 7));
    assert.match((await run1("delete_key", { bones: ["head"], frame: 7 })).message, /No keys at frame 7/);
    await run1("add_animation_event", { name: "PlaySFX", frame: 11 });
    const rm = await run1("remove_animation_event", { name: "playsfx", frame: 11 });
    assert.match(rm.message, /Removed 1 PlaySFX event at frame 11/);
    assert.ok(!(clip().events ?? []).some((e) => e.name === "PlaySFX" && Math.round(e.time * clip().fps) === 11));
    assert.equal((await run1("remove_animation_event", {})).ok, false);
  });

  it("drives VFX and lip-sync", async () => {
    assert.equal((await run1("set_vfx", { vfx: "fire" })).message, "VFX: fire aura");
    assert.equal(state().activeVfx, "fire_aura");
    assert.equal((await run1("lip_sync", { phrase: "jackpot call" })).ok, true);
    assert.equal((await run1("set_vfx", { vfx: "glitter cannon" })).ok, false);
  });

  it("tunes the clip generator and rigs by archetype", async () => {
    const r = await run1("set_principles", { anticipation: 1.5, exaggeration: 150 });
    assert.equal(r.ok, true, r.message);
    assert.equal(state().principles.anticipation, 1.5);
    assert.equal(state().principles.exaggeration, 1.5);
    assert.equal((await run1("set_principles", {})).ok, false);
    const rig = await run1("auto_rig", { archetype: "heavy titan" });
    assert.equal(rig.ok, true, rig.message);
    assert.equal(state().autoArchetype, "heavy_titan");
  });

  it("opens symbol rigs through the host", async () => {
    const r = await run1("open_symbol_rig", { role: "WILD" });
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(calls, ["symbol:wild"]);
    assert.match(r.message, /Opened WILD/);
  });

  it("caps a step at 40 calls", async () => {
    const many = Array.from({ length: 45 }, () => ({ tool: "go_to", args: { frame: 1 }, summary: "" }));
    assert.equal((await executeCopilotActions(many, host)).length, 40);
  });
});
