import assert from "node:assert/strict";
import test from "node:test";
import { SpineForgeAnimator } from "./animator";
import { autoRigProject, isCreatureProject } from "./auto-rigger";
import { runFullAutoModePipeline } from "./physics-and-principles";
import { validateProject, type RigPart, type SpineForgeProject } from "./schema";
import { exportSpine42Json } from "../exporters/spine42-exporter";

const part = (name: string, x: number, y: number, w: number, h: number): RigPart => ({ name, src: `${name}.png`, x, y, w, h });

/** Layer boxes of a sitting three-quarter dragon, as the PSD importer produces them. */
function dragon(): SpineForgeProject {
  return {
    version: "1.0.0",
    id: "dragon",
    title: "Dragon",
    src: "dragon.png",
    width: 1078,
    height: 1325,
    action: "raise",
    frame: { left: 0.25, top: 0.2, right: 0.25, bottom: 0.05 },
    palette: { rim: "#ffd27a", flash: "#ffffff" },
    bones: [{ name: "root", x: 0.5, y: 0.97 }],
    ikConstraints: [],
    animations: {},
    parts: [
      part("wing_r", 0.004, 0.345, 0.387, 0.263),
      part("wing_l", 0.557, 0.313, 0.439, 0.282),
      part("tail", 0.521, 0.646, 0.375, 0.349),
      part("spines_back", 0.54, 0.357, 0.292, 0.294),
      part("body", 0.283, 0.315, 0.477, 0.509),
      part("leg_r", 0.299, 0.643, 0.147, 0.165),
      part("leg_l", 0.481, 0.589, 0.274, 0.253),
      part("arm_r", 0.286, 0.453, 0.13, 0.215),
      part("arm_l", 0.419, 0.453, 0.224, 0.197),
      part("earfin_r", 0.139, 0.175, 0.233, 0.143),
      part("earfin_l", 0.622, 0.131, 0.077, 0.126),
      part("horn_l", 0.533, 0.002, 0.082, 0.142),
      part("head", 0.31, 0.091, 0.36, 0.268),
      part("eye_l", 0.583, 0.168, 0.05, 0.063),
      { ...part("eyelid_closed_l", 0.576, 0.163, 0.063, 0.074), hidden: true },
      part("mouth", 0.429, 0.273, 0.185, 0.069),
      { ...part("mouth_closed", 0.421, 0.267, 0.199, 0.081), hidden: true },
      part("mane", 0.242, 0.012, 0.308, 0.403),
    ],
  };
}

test("wings or a tail switch the auto-rigger to the creature rig", () => {
  assert.equal(isCreatureProject(dragon()), true);
  assert.equal(isCreatureProject({ parts: [part("cape-tail", 0, 0, 1, 1), part("ponytail", 0, 0, 1, 1)] }), false);
});

test("creature rig gives wings, tail and mane spring chains and binds every part", () => {
  const rigged = autoRigProject(dragon());
  assert.deepEqual(validateProject(rigged), []);
  const bones = new Map(rigged.bones.map((b) => [b.name, b]));
  for (const name of ["hips", "chest", "head", "jaw", "wing-l", "wing-l-2", "wing-r", "tail", "tail-3", "mane-2", "leg-l", "arm", "arm-back"]) {
    assert.ok(bones.has(name), `missing bone ${name}`);
  }
  assert.ok(bones.get("wing-l-2")!.spring && bones.get("tail-3")!.spring);
  // The left wing hangs off the body's right edge and reaches up and out.
  assert.ok(bones.get("wing-l")!.x <= 0.56 && bones.get("wing-l-2")!.x > bones.get("wing-l")!.x);

  const bind = new Map(rigged.parts.map((p) => [p.name, p.skin ?? [p.bone]]));
  assert.deepEqual(bind.get("wing_l"), ["wing-l", "wing-l-2"]);
  assert.deepEqual(bind.get("tail"), ["tail", "tail-2", "tail-3"]);
  assert.deepEqual(bind.get("mouth"), ["jaw"]);
  assert.deepEqual(bind.get("eye_l"), ["head"]);
  assert.deepEqual(bind.get("horn_l"), ["head"]);
  assert.deepEqual(bind.get("arm_l"), ["arm"]);
  assert.deepEqual(bind.get("eyelid_closed_l"), ["head"]);
  assert.deepEqual(bind.get("mouth_closed"), ["head"]);
});

test("creature clips blink and shut the mouth, and the hidden layers only draw while keyed on", () => {
  const rigged = autoRigProject(dragon());
  const idle = rigged.animations.idle!;
  const lid = idle.visibilityTracks!["eyelid_closed_l"]!;
  assert.equal(lid.length, 4, "idle blinks twice");
  assert.deepEqual(idle.visibilityTracks!["mouth_closed"]!.map((k) => k.visible), [true, false]);
  assert.deepEqual(idle.visibilityTracks!["mouth"]!.map((k) => k.visible), [false, true]);

  const anim = new SpineForgeAnimator(rigged, "idle");
  const atRest = anim.evaluateAt(0.01, 0);
  assert.ok(!atRest.order.includes("eyelid_closed_l") && !atRest.order.includes("mouth_closed"));
  assert.ok(atRest.slotOrder.includes("eyelid_closed_l"), "slot order keeps every part");
  const blinking = anim.evaluateAt(lid[0]!.time + 0.05, 0);
  assert.ok(blinking.order.includes("eyelid_closed_l"));
  const mouthShut = anim.evaluateAt(idle.visibilityTracks!["mouth_closed"]![0]!.time + 0.1, 0);
  assert.ok(mouthShut.order.includes("mouth_closed") && !mouthShut.order.includes("mouth"));
});

test("Spine export starts hidden slots empty and keys their attachments", () => {
  const json = exportSpine42Json(autoRigProject(dragon()));
  const slot = (name: string) => json.slots.find((s) => s.name === name)!;
  assert.equal(slot("eyelid_closed_l").attachment, undefined);
  assert.equal(slot("eye_l").attachment, "eye_l");
  const keys = json.animations.idle!.slots!["eyelid_closed_l"]!.attachment;
  assert.deepEqual(keys.map((k) => k.name), ["eyelid_closed_l", null, "eyelid_closed_l", null]);
});

test("creature clips only key bones the rig has, and flap the wings", () => {
  const { project } = runFullAutoModePipeline(dragon());
  assert.deepEqual(validateProject(project), []);
  const have = new Set(project.bones.map((b) => b.name));
  assert.ok(Object.keys(project.animations).length >= 6);
  for (const clip of Object.values(project.animations)) {
    for (const bone of Object.keys(clip.boneTracks)) assert.ok(have.has(bone), `${clip.name} keys missing bone ${bone}`);
    const flap = clip.boneTracks["wing-l"]!;
    assert.equal(flap.at(-1)!.time, clip.duration, `${clip.name} wing flap must span the clip`);
    assert.equal(flap[0]!.r, flap.at(-1)!.r, `${clip.name} wing flap must loop`);
  }
});
