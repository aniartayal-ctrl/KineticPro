import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, commandForEvent, eventMatches, formatCombo, parseCombo, unsupportedHint, type KeyLike } from "./keymap";

const ev = (combo: string): KeyLike => {
  const c = parseCombo(combo);
  const named: Record<string, { key: string; code: string }> = {
    Equal: { key: c.shift ? "+" : "=", code: "Equal" },
    Minus: { key: c.shift ? "_" : "-", code: "Minus" },
    NumpadAdd: { key: "+", code: "NumpadAdd" },
    NumpadSubtract: { key: "-", code: "NumpadSubtract" },
    BracketLeft: { key: "[", code: "BracketLeft" },
    BracketRight: { key: "]", code: "BracketRight" },
    Slash: { key: "/", code: "Slash" },
    Space: { key: " ", code: "Space" },
    "?": { key: "?", code: "Slash" },
  };
  const k = named[c.key] ?? (c.key.length === 1 ? { key: c.shift ? c.key.toUpperCase() : c.key.toLowerCase(), code: `Key${c.key.toUpperCase()}` } : { key: c.key, code: c.key });
  return { key: k.key, code: k.code, ctrlKey: false, metaKey: c.mod, shiftKey: c.shift || c.key === "?", altKey: c.alt };
};

test("Spine's documented default hotkeys trigger the matching Kinetic commands", () => {
  // From Esoteric Software's Spine cheat sheet.
  const spine: [string, string][] = [
    ["C", "tool.rotate"],
    ["V", "tool.translate"],
    ["X", "tool.scale"],
    ["B", "tool.pose"],
    ["N", "tool.create"],
    ["ArrowLeft", "nudge.left"],
    ["K", "key.selection"],
    ["L", "key.activeTransform"],
    ["Mod+L", "key.selection"],
    ["Mod+Shift+L", "key.everything"],
    ["D", "play.forward"],
    ["A", "play.backward"],
    ["Q", "time.start"],
    ["E", "time.lastKey"],
    ["W", "time.nextKey"],
    ["S", "time.prevKey"],
    ["R", "time.nextFrame"],
    ["Shift+R", "time.next10"],
    ["F", "time.prevFrame"],
    ["Shift+F", "time.prev10"],
    ["Mod+R", "clip.toggleLoop"],
    ["H", "layer.toggleVisibility"],
    ["Shift+H", "layer.solo"],
    ["Comma", "key.breakdown"],
    ["Equal", "drawOrder.up"],
    ["Shift+Equal", "drawOrder.up5"],
    ["Minus", "drawOrder.down"],
    ["Shift+Minus", "drawOrder.down5"],
    ["Mod+Z", "edit.undo"],
    ["Mod+Shift+Z", "edit.redo"],
    ["Mod+Y", "edit.redo"],
    ["Mod+C", "pose.copy"],
    ["Mod+V", "pose.paste"],
    ["Mod+S", "file.save"],
    ["Mod+O", "file.open"],
    ["Mod+E", "file.export"],
    ["F1", "ui.instantTooltips"],
  ];
  for (const [combo, id] of spine) assert.equal(commandForEvent(ev(combo)), id, combo);
});

test("no key combination is bound twice", () => {
  const seen = new Map<string, string>();
  for (const cmd of COMMANDS) {
    for (const k of cmd.keys) {
      const c = parseCombo(k);
      const sig = `${c.mod}|${c.shift}|${c.alt}|${c.key.toLowerCase()}`;
      assert.ok(!seen.has(sig), `${k} is bound to both ${seen.get(sig)} and ${cmd.id}`);
      seen.set(sig, cmd.id);
    }
  }
});

test("modifiers must match exactly, and Ctrl works as Mod on every platform", () => {
  assert.equal(eventMatches(ev("Shift+R"), "R"), false);
  assert.equal(eventMatches(ev("Mod+R"), "R"), false);
  assert.equal(commandForEvent({ key: "r", code: "KeyR", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }), "clip.toggleLoop");
  assert.equal(commandForEvent({ key: "?", code: "Slash", ctrlKey: false, metaKey: false, shiftKey: true, altKey: false }), "panel.help");
  assert.equal(
    commandForEvent({ key: ",", code: "Comma", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }),
    "panel.preferences",
  );
  assert.equal(
    commandForEvent(
      { key: "p", code: "KeyP", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false },
      { "panel.preferences": ["Mod+P"] },
    ),
    "panel.preferences",
  );
  // Alt combos are not bound (Alt+letter types special characters on macOS).
  assert.equal(commandForEvent({ key: "ç", code: "KeyC", ctrlKey: false, metaKey: false, shiftKey: false, altKey: true }), null);
  // View zoom keeps bare =/− as draw order (Spine).
  assert.equal(commandForEvent(ev("Mod+Equal")), "view.zoomIn");
  assert.equal(commandForEvent(ev("Mod+Minus")), "view.zoomOut");
  assert.equal(commandForEvent(ev("Mod+0")), "view.reset");
  assert.equal(commandForEvent(ev("Equal")), "drawOrder.up");
  assert.equal(commandForEvent(ev("Minus")), "drawOrder.down");
});

test("unsupported Spine keys explain themselves, and combos format per platform", () => {
  assert.match(unsupportedHint(ev("Z"))!, /Shear/);
  assert.equal(unsupportedHint(ev("C")), null);
  assert.equal(formatCombo("Mod+Shift+L"), "⌘⇧L");
  assert.equal(formatCombo("Mod+Shift+L", false), "Ctrl+Shift+L");
  assert.equal(formatCombo("Shift+Equal"), "⇧+");
});
