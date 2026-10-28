/**
 * Keyboard map (`src/core/keymap.ts`).
 *
 * Spine's default hotkeys come first, so Spine animators can work from muscle memory
 * (source: Esoteric Software's Spine cheat sheet, esotericsoftware.com/spine-cheat-sheet).
 * Kinetic-only actions use keys Spine leaves free. This one table drives the key handler,
 * the help sheet and tooltips, so the three can never disagree.
 *
 * Combo syntax: "Mod+Shift+L". Mod is ⌘ on macOS and Ctrl elsewhere (either is accepted).
 * Letters match the typed character; named keys (Equal, Minus, BracketLeft…) match the physical key.
 */

export type CommandId =
  | "tool.pose"
  | "tool.rotate"
  | "tool.translate"
  | "tool.scale"
  | "tool.create"
  | "tool.import"
  | "tool.autoRig"
  | "tool.mesh"
  | "tool.weights"
  | "tool.warp"
  | "brush.smaller"
  | "brush.larger"
  | "nudge.left"
  | "nudge.right"
  | "nudge.up"
  | "nudge.down"
  | "key.selection"
  | "key.activeTransform"
  | "key.everything"
  | "key.breakdown"
  | "play.forward"
  | "play.backward"
  | "play.toggle"
  | "time.start"
  | "time.lastKey"
  | "time.nextKey"
  | "time.prevKey"
  | "time.nextFrame"
  | "time.prevFrame"
  | "time.next10"
  | "time.prev10"
  | "clip.toggleLoop"
  | "layer.toggleVisibility"
  | "layer.solo"
  | "drawOrder.up"
  | "drawOrder.down"
  | "drawOrder.up5"
  | "drawOrder.down5"
  | "edit.undo"
  | "edit.redo"
  | "pose.copy"
  | "pose.paste"
  | "file.save"
  | "file.open"
  | "file.export"
  | "panel.inspector"
  | "panel.copilot"
  | "panel.timeline"
  | "panel.graph"
  | "panel.hideAll"
  | "panel.help"
  | "panel.preferences"
  | "ui.instantTooltips"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.reset";

export type KeyGroup = "Tools" | "Keying" | "Playback" | "Layers" | "Edit" | "File" | "Panels" | "View";

export type Command = {
  id: CommandId;
  label: string;
  group: KeyGroup;
  /** Bindings. With `spine: true` the first one is Spine's own default. */
  keys: string[];
  /** Same key and meaning as in Spine. */
  spine?: boolean;
  /** How Kinetic differs from Spine for this key, shown in the help sheet. */
  note?: string;
};

export const COMMANDS: Command[] = [
  // Tools: Spine defaults
  { id: "tool.pose", label: "Pose tool", group: "Tools", keys: ["B"], spine: true },
  { id: "tool.rotate", label: "Rotate tool", group: "Tools", keys: ["C"], spine: true, note: "⇧ while dragging snaps to 15°" },
  { id: "tool.translate", label: "Translate tool", group: "Tools", keys: ["V"], spine: true, note: "⇧ while dragging locks the axis" },
  { id: "tool.scale", label: "Scale tool", group: "Tools", keys: ["X"], spine: true, note: "⇧ while dragging scales uniformly" },
  { id: "tool.create", label: "Bones & IK (Spine's Create)", group: "Tools", keys: ["N"], spine: true },
  { id: "nudge.left", label: "Nudge left", group: "Tools", keys: ["ArrowLeft", "Shift+ArrowLeft"], spine: true, note: "⇧ nudges 10×" },
  { id: "nudge.right", label: "Nudge right", group: "Tools", keys: ["ArrowRight", "Shift+ArrowRight"], spine: true },
  { id: "nudge.up", label: "Nudge up", group: "Tools", keys: ["ArrowUp", "Shift+ArrowUp"], spine: true },
  { id: "nudge.down", label: "Nudge down", group: "Tools", keys: ["ArrowDown", "Shift+ArrowDown"], spine: true },
  // Tools: Kinetic only
  { id: "tool.import", label: "Import", group: "Tools", keys: ["O"] },
  { id: "tool.autoRig", label: "Auto Rig (re-rigs the project)", group: "Tools", keys: ["Shift+A"] },
  { id: "tool.mesh", label: "Mesh", group: "Tools", keys: ["M"] },
  { id: "tool.weights", label: "Weight Paint", group: "Tools", keys: ["Shift+W"] },
  { id: "tool.warp", label: "Warp (mesh deform)", group: "Tools", keys: ["Shift+L"] },
  { id: "brush.smaller", label: "Brush smaller", group: "Tools", keys: ["BracketLeft"] },
  { id: "brush.larger", label: "Brush larger", group: "Tools", keys: ["BracketRight"] },

  // Keying: Spine defaults
  {
    id: "key.selection",
    label: "Key selected bone",
    group: "Keying",
    keys: ["K", "Mod+L"],
    spine: true,
    note: "Posing already auto-keys, so K keys what is selected",
  },
  {
    id: "key.activeTransform",
    label: "Key active transform",
    group: "Keying",
    keys: ["L"],
    spine: true,
    note: "Kinetic keys a bone's channels together, so this matches K",
  },
  { id: "key.everything", label: "Key every bone", group: "Keying", keys: ["Mod+Shift+L"], spine: true },
  { id: "key.breakdown", label: "Insert breakdown at playhead", group: "Keying", keys: ["Comma"] },

  // Playback: Spine defaults
  { id: "play.forward", label: "Play forward / stop", group: "Playback", keys: ["D"], spine: true },
  { id: "play.backward", label: "Play backward / stop", group: "Playback", keys: ["A"], spine: true },
  { id: "time.start", label: "Jump to start", group: "Playback", keys: ["Q"], spine: true },
  { id: "time.lastKey", label: "Jump to last key", group: "Playback", keys: ["E"], spine: true },
  { id: "time.nextKey", label: "Next key", group: "Playback", keys: ["W"], spine: true },
  { id: "time.prevKey", label: "Previous key", group: "Playback", keys: ["S"], spine: true },
  { id: "time.nextFrame", label: "Next frame", group: "Playback", keys: ["R"], spine: true },
  { id: "time.prevFrame", label: "Previous frame", group: "Playback", keys: ["F"], spine: true },
  { id: "time.next10", label: "10 frames forward", group: "Playback", keys: ["Shift+R"], spine: true },
  { id: "time.prev10", label: "10 frames back", group: "Playback", keys: ["Shift+F"], spine: true },
  { id: "clip.toggleLoop", label: "Loop on / off", group: "Playback", keys: ["Mod+R"], spine: true },
  // Playback: Kinetic only
  { id: "play.toggle", label: "Play / pause", group: "Playback", keys: ["Space"], note: "In Spine, Space deselects" },

  // Layers: Spine defaults
  { id: "layer.toggleVisibility", label: "Hide / show selected layer", group: "Layers", keys: ["H"], spine: true },
  { id: "layer.solo", label: "Solo selected layer", group: "Layers", keys: ["Shift+H"], note: "Isolates the selected part on the canvas" },
  { id: "drawOrder.up", label: "Draw order up", group: "Layers", keys: ["Equal", "NumpadAdd"], spine: true },
  { id: "drawOrder.down", label: "Draw order down", group: "Layers", keys: ["Minus", "NumpadSubtract"], spine: true },
  { id: "drawOrder.up5", label: "Draw order up 5", group: "Layers", keys: ["Shift+Equal", "Shift+NumpadAdd"], spine: true },
  { id: "drawOrder.down5", label: "Draw order down 5", group: "Layers", keys: ["Shift+Minus", "Shift+NumpadSubtract"], spine: true },

  // Edit
  { id: "edit.undo", label: "Undo", group: "Edit", keys: ["Mod+Z"], spine: true },
  { id: "edit.redo", label: "Redo", group: "Edit", keys: ["Mod+Shift+Z", "Mod+Y"], spine: true },
  { id: "pose.copy", label: "Copy pose", group: "Edit", keys: ["Mod+C"], spine: true, note: "Spine copies selected keys; Kinetic copies the whole pose" },
  { id: "pose.paste", label: "Paste pose at playhead", group: "Edit", keys: ["Mod+V"], spine: true },

  // File: Spine defaults
  { id: "file.save", label: "Save to projects", group: "File", keys: ["Mod+S"], spine: true },
  { id: "file.open", label: "Open project", group: "File", keys: ["Mod+O"], spine: true },
  { id: "file.export", label: "Export bundle", group: "File", keys: ["Mod+E"], spine: true },

  // Panels: Kinetic only (Spine's F1 instant tooltips included)
  { id: "panel.inspector", label: "Inspector", group: "Panels", keys: ["I"] },
  { id: "panel.copilot", label: "Copilot", group: "Panels", keys: ["Mod+K"] },
  { id: "panel.timeline", label: "Timeline (dope sheet)", group: "Panels", keys: ["T"] },
  { id: "panel.graph", label: "Graph editor", group: "Panels", keys: ["G"] },
  { id: "panel.hideAll", label: "Hide all panels", group: "Panels", keys: ["Tab"] },
  { id: "panel.help", label: "Help and shortcuts", group: "Panels", keys: ["?", "Slash"] },
  { id: "panel.preferences", label: "Preferences", group: "Panels", keys: ["Mod+Comma"] },
  { id: "ui.instantTooltips", label: "Instant tooltips", group: "Panels", keys: ["F1"], spine: true },

  // View: Kinetic (Spine uses scroll for zoom; =/− stay draw order)
  { id: "view.zoomIn", label: "Zoom in", group: "View", keys: ["Mod+Equal", "Mod+NumpadAdd"], note: "Scroll / pinch also zooms toward the cursor" },
  { id: "view.zoomOut", label: "Zoom out", group: "View", keys: ["Mod+Minus", "Mod+NumpadSubtract"] },
  { id: "view.reset", label: "Reset view (fit)", group: "View", keys: ["Mod+0"] },
];

/** Spine defaults Kinetic does not have; pressing one explains why instead of doing nothing. */
export const UNSUPPORTED_SPINE_KEYS: { key: string; hint: string }[] = [
  { key: "Z", hint: "Shear (Z) isn't available: Kinetic bones have no shear channel." },
  { key: "P", hint: "Set Parent (P) isn't available yet. Pick the parent when adding a bone." },
  { key: "F2", hint: "Rename (F2) isn't available yet." },
  { key: "PageUp", hint: "Selection history isn't available yet." },
  { key: "PageDown", hint: "Selection history isn't available yet." },
];

/** Mouse gestures in the dope sheet and graph editor (shown in the help sheet; Spine-matched). */
export const MOUSE_GESTURES: { gesture: string; action: string; spine: boolean }[] = [
  { gesture: "Drag key", action: "Move (snaps to frames)", spine: true },
  { gesture: "⇧ drag key", action: "Move without snapping", spine: true },
  { gesture: "⌥ drag key", action: "Move with all later keys", spine: true },
  { gesture: "Double-click key", action: "Delete key", spine: true },
  { gesture: "⇧ drag playhead", action: "Scrub without snapping", spine: true },
  { gesture: "Right-click canvas", action: "Previous tool", spine: true },
  { gesture: "Scroll / pinch canvas", action: "Zoom toward cursor", spine: true },
  { gesture: "⌥ scroll canvas", action: "Step ±1 frame", spine: false },
  { gesture: "Middle-drag canvas", action: "Pan view", spine: true },
  { gesture: "⌘ drag key (graph)", action: "Lock to time or value", spine: false },
];

export type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

type Combo = { mod: boolean; shift: boolean; alt: boolean; key: string };

/** Keys matched by physical position (punctuation differs between layouts and with Shift). */
const CODE_KEYS = new Set(["Equal", "Minus", "NumpadAdd", "NumpadSubtract", "BracketLeft", "BracketRight", "Slash", "Comma", "Period"]);
/** Characters that need Shift on common layouts; their combos ignore the Shift flag. */
const SHIFTED_CHARS = new Set(["?"]);

export function parseCombo(combo: string): Combo {
  const parts = combo.split("+");
  const key = parts.pop()!;
  return { mod: parts.includes("Mod"), shift: parts.includes("Shift"), alt: parts.includes("Alt"), key };
}

export function eventMatches(e: KeyLike, combo: string): boolean {
  const c = parseCombo(combo);
  if ((e.ctrlKey || e.metaKey) !== c.mod || e.altKey !== c.alt) return false;
  if (SHIFTED_CHARS.has(c.key)) return e.key === c.key;
  if (e.shiftKey !== c.shift) return false;
  if (CODE_KEYS.has(c.key)) return e.code === c.key;
  if (c.key === "Space") return e.key === " " || e.code === "Space";
  if (c.key.length === 1) return e.key.toLowerCase() === c.key.toLowerCase();
  return e.key === c.key;
}

export type ShortcutOverrides = Partial<Record<CommandId, string[]>>;

/** Commands with user overrides applied (Preferences → Shortcuts). */
export function resolveCommands(overrides: ShortcutOverrides = {}): Command[] {
  if (!overrides || Object.keys(overrides).length === 0) return COMMANDS;
  return COMMANDS.map((c) => {
    const keys = overrides[c.id];
    return keys && keys.length > 0 ? { ...c, keys } : c;
  });
}

export function commandForEvent(e: KeyLike, overrides: ShortcutOverrides = {}): CommandId | null {
  for (const cmd of resolveCommands(overrides)) if (cmd.keys.some((k) => eventMatches(e, k))) return cmd.id;
  return null;
}

/** Find another command that already uses this combo (for conflict UI). */
export function findShortcutConflict(
  combo: string,
  except: CommandId,
  overrides: ShortcutOverrides = {},
): CommandId | null {
  for (const cmd of resolveCommands(overrides)) {
    if (cmd.id === except) continue;
    if (cmd.keys.some((k) => k.toLowerCase() === combo.toLowerCase())) return cmd.id;
  }
  return null;
}

/** Build a combo string from a keyboard event (for shortcut recording). */
export function comboFromEvent(e: KeyLike): string | null {
  const key = e.key;
  if (["Control", "Meta", "Alt", "Shift"].includes(key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey && key.length !== 1 && key !== "?") parts.push("Shift");
  let token = key;
  if (key === " ") token = "Space";
  else if (e.code === "Comma") token = "Comma";
  else if (e.code === "Equal") token = "Equal";
  else if (e.code === "Minus") token = "Minus";
  else if (e.code === "BracketLeft") token = "BracketLeft";
  else if (e.code === "BracketRight") token = "BracketRight";
  else if (e.code === "Slash") token = "Slash";
  else if (key.length === 1) token = key.toUpperCase();
  parts.push(token);
  return parts.join("+");
}

export function unsupportedHint(e: KeyLike): string | null {
  return UNSUPPORTED_SPINE_KEYS.find((u) => eventMatches(e, u.key))?.hint ?? null;
}

const KEY_GLYPHS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Equal: "+",
  Minus: "−",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num −",
  BracketLeft: "[",
  BracketRight: "]",
  Slash: "/",
  Comma: ",",
  Period: ".",
  Escape: "Esc",
};

export function formatCombo(combo: string, mac = true): string {
  const c = parseCombo(combo);
  const key = KEY_GLYPHS[c.key] ?? c.key;
  if (mac) return `${c.mod ? "⌘" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${key}`;
  return [c.mod && "Ctrl", c.alt && "Alt", c.shift && "Shift", key].filter(Boolean).join("+");
}

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** First binding of a command, formatted for tooltips. */
export function shortcutLabel(id: CommandId, mac = isMacPlatform(), overrides: ShortcutOverrides = {}): string {
  const cmd = resolveCommands(overrides).find((c) => c.id === id);
  return cmd ? formatCombo(cmd.keys[0]!, mac) : "";
}
