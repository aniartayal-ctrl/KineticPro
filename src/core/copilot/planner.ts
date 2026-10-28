/**
 * Offline copilot planner (`src/core/copilot/planner.ts`).
 *
 * Turns plain-English requests into catalog actions with no network. Requests can chain steps
 * ("mesh the body dense, add physics to the cape, then ease everything"). Names are matched
 * against the real rig, including common synonyms (sword → weapon, torso → chest).
 */

import type { CopilotAction, CopilotContext } from "./tools";

export type Plan = { reply: string; actions: CopilotAction[] };

const VERBS =
  "add|make|set|key|keyframe|mesh|remesh|weight|reweight|auto|rig|ease|smooth|snap|fix|review|check|apply|play|pause|stop|go|jump|show|hide|toggle|turn|enable|disable|lock|unlock|select|open|switch|export|save|undo|redo|copy|paste|breakdown|bake|generate|regenerate|retime|speed|slow|loop|length|move|flip|bend|solo|give|remove|push|exaggerate|close|clean|use|load|edit|scrub|reset|stiffen|loosen|tween|rotate|tilt|twist|lean|raise|lower|lift|nudge|shift|squash|drop|delete|clear|bring|send|put|preview|lip";
const VERB_START = new RegExp(`^(?:please\\s+|now\\s+|also\\s+)?(?:${VERBS})\\b`);

const SYNONYMS: Record<string, string[]> = {
  weapon: ["sword", "hammer", "axe", "staff", "spear", "blade", "mace"],
  chest: ["torso", "upper body"],
  hips: ["pelvis", "waist"],
  head: ["face", "skull"],
  cape: ["cloak", "mantle"],
  forearm: ["lower arm"],
};

const OVERLAYS: [RegExp, string][] = [
  [/\bheat ?map|weight view|weights view\b/, "heatmap"],
  [/\bwire ?frame|\bmesh\b|triangles\b/, "mesh"],
  [/\bbones?\b|skeleton\b/, "bones"],
  [/\bonion\b|ghost/, "onion"],
  [/\barcs?\b|motion paths?\b/, "arcs"],
  [/\btrails?\b/, "trail"],
  [/\blighting\b|relight|normal.?map/, "lighting"],
  [/\bhit ?box(es)?\b|colliders?\b/, "hitboxes"],
  [/\bsolo\b|isolate/, "solo"],
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Finds names mentioned in `text` by 1–3 word phrase match (plus synonyms). Longer phrases claim
 * their words first, so "arm back" resolves to "arm-back" and not also to "arm".
 */
export function findNames(text: string, names: string[]): string[] {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const lookup = new Map<string, string>();
  for (const name of names) lookup.set(norm(name), name);
  for (const [target, words] of Object.entries(SYNONYMS)) {
    if (names.includes(target)) for (const w of words) if (!lookup.has(norm(w))) lookup.set(norm(w), target);
  }
  const covered = new Set<number>();
  const found: string[] = [];
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const span = Array.from({ length: n }, (_, k) => i + k);
      if (span.some((j) => covered.has(j))) continue;
      const name = lookup.get(tokens.slice(i, i + n).join(""));
      if (!name) continue;
      span.forEach((j) => covered.add(j));
      if (!found.includes(name)) found.push(name);
    }
  }
  return found;
}

const num = (re: RegExp, s: string): number | undefined => {
  const m = s.match(re);
  return m ? parseFloat(m[1]!) : undefined;
};

/** Percentages written as "70%", "70 percent" or "70 per cent". */
const pctOf = (s: string): number | undefined => num(/(-?\d+(?:\.\d+)?)\s*(?:%|percent\b|per cent\b|pct\b)/, s);

/** "half speed", "double speed", "2x", "50% speed". */
function speedOf(c: string): number | undefined {
  const x = num(/(\d+(?:\.\d+)?)\s*x\b/, c);
  if (x !== undefined) return x;
  if (/\bhalf(-| )?speed\b|\bhalf as fast\b/.test(c)) return 0.5;
  if (/\bquarter(-| )?speed\b/.test(c)) return 0.25;
  if (/\b(double|twice the) speed\b|\btwice as fast\b/.test(c)) return 2;
  if (/\b(normal|full|real-?time) speed\b/.test(c)) return 1;
  const pct = /\bspeed\b/.test(c) ? pctOf(c) : undefined;
  return pct !== undefined ? pct / 100 : undefined;
}

const RELATIVE = /\b(further|more|another|extra|additional|than it is now|from where it is|from (the )?current|relative|on top)\b/;

/**
 * Explicit transforms with numbers: "tilt the head 15 degrees at frame 6", "move the hips 20 px up",
 * "scale Y to 0.85 and scale X to 1.15", "rotate the head 10 degrees further". Keys the named bones.
 */
function directKey(c: string, bones: string[], ctx: CopilotContext): CopilotAction | null {
  const r = num(/(-?\d+(?:\.\d+)?)\s*(?:°|deg\b|degs\b|degrees?\b)/, c);
  const sx = num(/\b(?:scale\s*x|sx|x\s*scale|width)\s*(?:to|=|of|by)?\s*(\d+(?:\.\d+)?)/, c);
  const sy = num(/\b(?:scale\s*y|sy|y\s*scale|height)\s*(?:to|=|of|by)?\s*(\d+(?:\.\d+)?)/, c);
  const uniformPct = sx === undefined && sy === undefined ? num(/\bscale\s*(?:(?:it|them|up|down)\s*)*(?:to|by)?\s*(\d+(?:\.\d+)?)\s*%/, c) : undefined;
  // "squash it 20%" / "stretch the chest 15%": volume-preserving, multiplied onto the current scale.
  const squashPct = /\b(squash|squish|stretch)\b/.test(c) && sx === undefined && sy === undefined ? pctOf(c) : undefined;
  const uniform =
    uniformPct !== undefined
      ? uniformPct / 100
      : sx === undefined && sy === undefined
        ? num(/\bscale\b(?:\s+(?!to\b|by\b)[a-z-]+){0,3}\s*(?:to|by|=)?\s*(\d+(?:\.\d+)?)(?!\d|\s*(?:px|pixels?|%|fps|s\b|sec|frames?))/, c)
        : undefined;
  const dirFirst = c.match(/\b(up|down|left|right)\s*(?:by\s*)?(-?\d+(?:\.\d+)?)\s*(?:px|pixels?)/);
  const unitFirst = c.match(/(-?\d+(?:\.\d+)?)\s*(?:px|pixels?)\s*(?:to the\s+)?(up|down|left|right|upward|downward)?/);
  const pxMatch = dirFirst && !unitFirst?.[2] ? [dirFirst[0], dirFirst[2], dirFirst[1]] : unitFirst;
  let x: number | undefined;
  let y: number | undefined;
  if (pxMatch) {
    const amount = parseFloat(pxMatch[1]!);
    const dir = (pxMatch[2] ?? (/\b(raise|lift)\b/.test(c) ? "up" : /\b(lower|drop)\b/.test(c) ? "down" : "")).replace(/ward$/, "");
    if (dir === "up") y = -Math.abs(amount);
    else if (dir === "down") y = Math.abs(amount);
    else if (dir === "left") x = -Math.abs(amount);
    else if (dir === "right") x = Math.abs(amount);
    else if (/\bx\b|horizontal/.test(c)) x = amount;
    else if (/\by\b|vertical/.test(c)) y = amount;
  }
  if (r === undefined && sx === undefined && sy === undefined && uniform === undefined && squashPct === undefined && x === undefined && y === undefined) return null;
  const targets = bones.length > 0 ? bones : ctx.selectedBone ? [ctx.selectedBone] : [];
  if (targets.length === 0) return null;
  const ccw = /\b(counter-?clockwise|anti-?clockwise|ccw)\b/.test(c);
  const moves = x !== undefined || y !== undefined;
  const relative = RELATIVE.test(c) || squashPct !== undefined || (moves && /\b(move|shift|nudge|raise|lift|lower|drop|push|pull)\b/.test(c));
  const squashY = squashPct !== undefined ? (/\bstretch\b/.test(c) ? 1 + squashPct / 100 : 1 - squashPct / 100) : undefined;
  const frame = num(/\bframe\s*(\d+)/, c);
  const time = frame === undefined ? num(/\bat\s*(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b/, c) : undefined;
  const args: Record<string, unknown> = {
    bones: targets,
    ...(r !== undefined ? { r: ccw ? -Math.abs(r) : r } : {}),
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(sx !== undefined ? { sx } : uniform !== undefined ? { sx: uniform } : squashY !== undefined ? { sx: Number((1 / squashY).toFixed(3)) } : {}),
    ...(sy !== undefined ? { sy } : uniform !== undefined ? { sy: uniform } : squashY !== undefined ? { sy: squashY } : {}),
    ...(relative ? { relative: true } : {}),
    ...(frame !== undefined ? { frame } : time !== undefined ? { time } : {}),
  };
  const what = [
    r !== undefined ? `${relative ? "+" : ""}${args.r}°` : "",
    x !== undefined || y !== undefined ? `move ${x ?? 0}, ${y ?? 0} px` : "",
    args.sx !== undefined || args.sy !== undefined ? `scale ${args.sx ?? "–"} × ${args.sy ?? "–"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return act("set_key", args, `Key ${targets.join(", ")}: ${what}${frame !== undefined ? ` at frame ${frame}` : ""}`);
}

// "do"/"have" also start commands ("do the same on the cape"), so only a question mark makes those questions.
const QUESTION = /^(what|which|how|is|are|does|why|where|who|did|whats|what's)\b|\?\s*$/;
const POLITE = /^(?:can|could|would|will) you\s+(?:please\s+)?/;

/** Answers questions from the studio state, using only read-only tools. */
function answerQuestion(q: string, ctx: CopilotContext): Plan | null {
  if (!QUESTION.test(q) || POLITE.test(q)) return null;
  const list = (xs: string[]) => (xs.length > 0 ? xs.join(", ") : "none");
  if (/\b(budget|fit|heavy|performance|memory|draw calls?|optimi[sz]ed?)\b/.test(q)) return { reply: "", actions: [act("check_budget", { target: budgetTarget(q) }, "Check budget")] };
  if (/\b(wrong|improve|better|fix|problems?|issues?|suggestions?|feedback|good|seam(less)?|pops?|smooth|jumps?|reads?)\b/.test(q)) {
    return { reply: "", actions: [act("review", {}, "Review the clip")] };
  }
  if (/\b(physics|springs?|jiggle)\b/.test(q)) return { reply: ctx.springBones?.length ? `Physics is on ${list(ctx.springBones)}.` : "No bones have physics yet.", actions: [] };
  if (/\bik\b/.test(q)) return { reply: `IK constraints: ${list(ctx.ikNames)}.`, actions: [] };
  if (/\bskins?\b/.test(q)) return { reply: `Skins: ${list(ctx.skins ?? [])}${ctx.activeSkin ? `; ${ctx.activeSkin} is active` : ""}.`, actions: [] };
  if (/\b(clips?|animations?)\b/.test(q) && !/\b(long|length|fps|frame rate|loop)/.test(q)) return { reply: `${ctx.clips.length} clips: ${list(ctx.clips)}. ${ctx.activeClip} is open.`, actions: [] };
  if (/\b(layers?|parts?)\b/.test(q)) return { reply: `${ctx.parts.length} layers: ${list(ctx.parts)}.`, actions: [] };
  if (/\bbones?\b/.test(q)) return { reply: `${ctx.bones.length} bones: ${list(ctx.bones)}.`, actions: [] };
  if (/\b(long|length|duration|fps|frame rate|loops?|frame|playhead|time)\b/.test(q)) {
    return {
      reply: `${ctx.activeClip} is ${ctx.duration.toFixed(2)} s at ${ctx.fps} fps (${Math.round(ctx.duration * ctx.fps)} frames), ${ctx.loop ? "looping" : "playing once"}. The playhead is on frame ${Math.round(ctx.currentTime * ctx.fps)}.`,
      actions: [],
    };
  }
  const bone = findNames(q, ctx.bones)[0];
  return { reply: "", actions: [act("inspect", bone ? { bone } : {}, `Inspect ${bone ?? "clip"}`)] };
}

function budgetTarget(c: string): string {
  if (/\bdesktop\b/.test(c)) return "desktop-hero";
  if (/\bsymbol\b/.test(c)) return "mobile-symbol";
  return "mobile-hero";
}

const VFX_WORDS: [RegExp, string][] = [
  [/\blightning|\bbolts?\b/, "lightning_bolts"],
  [/\bfire|\bflames?\b/, "fire_aura"],
  [/\bshock ?waves?|\brings?\b/, "shockwave_rings"],
  [/\bcoins?|\bgold\b/, "coin_fountain"],
  [/\bstars?|\bsparks?\b/, "star_sparks"],
  [/\b(no|none|off|remove|clear)\b/, "none"],
];
const PRINCIPLE_WORDS: [RegExp, string][] = [
  [/anticipat|wind.?up/, "anticipation"],
  [/squash|stretch/, "squashAndStretch"],
  [/follow.?through|overlap/, "followThroughOverlap"],
  [/\barcs?\b|easing/, "arcsAndEasing"],
  [/secondary|appeal|breathing/, "secondaryAndAppeal"],
  [/exaggerat/, "exaggeration"],
];
const ARCHETYPE_WORDS: [RegExp, string][] = [
  [/\b(heavy|titan|tank|brute)\b/, "heavy_titan"],
  [/\b(caster|mage|wizard|sorcer\w*)\b/, "olympus_caster"],
  [/\b(agile|duelist|nimble|rogue)\b/, "agile_duelist"],
  [/\b(treasure|chest)\b/, "treasure_chest"],
  [/\bsymbol\b/, "slot_symbol"],
];

/** Splits a request into clauses on ";", "then", new lines, and on "," / "and" when a verb follows. */
export function splitClauses(prompt: string): string[] {
  const out: string[] = [];
  for (const chunk of prompt.toLowerCase().split(/\s*(?:;|\n|\band then\b|\bthen\b|\.\s+)\s*/)) {
    const pieces = chunk.split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
    for (const p of pieces) {
      if (out.length > 0 && !VERB_START.test(p) && !/^(next|previous|prev) key/.test(p)) out[out.length - 1] += ` and ${p}`;
      else out.push(p);
    }
  }
  return out.map((c) => c.trim()).filter(Boolean);
}

function act(tool: string, args: Record<string, unknown>, summary: string): CopilotAction {
  return { tool, args, summary };
}

const COACH: [RegExp, string, string][] = [
  [/anticipat|wind.?up/, "anticipation", "Add anticipation"],
  [/overshoot|follow.?through|settle/, "follow-through", "Add follow-through"],
  [/squash|stretch/, "squash", "Add squash on impact"],
  [/snap .*frames?|clean (up )?(the )?keys|whole frames/, "off-frame", "Snap keys to frames"],
  [/(fix|close|smooth) (the )?loop|loop (pops|seam|jumps)/, "loop-seam", "Close the loop"],
  [/exaggerat|push (the )?poses|bigger|more punch/, "exaggeration", "Exaggerate poses"],
];

function planClause(c: string, ctx: CopilotContext, memo: { bones: string[] } = { bones: [] }): CopilotAction[] {
  const named = findNames(c, ctx.bones);
  // "turn the head 20 degrees and move it up 10 px": "it" is the bone named before.
  const bones = named.length > 0 ? named : /\b(it|them|those)\b/.test(c) ? memo.bones : [];
  if (named.length > 0) memo.bones = named;
  const parts = findNames(c, ctx.parts);
  const all = /\b(all|every|everything|whole|full body|entire)\b/.test(c);
  const out: CopilotAction[] = [];

  // Project-level commands.
  if (/^(please\s+)?undo\b/.test(c)) return [act("undo", {}, "Undo")];
  if (/^(please\s+)?redo\b/.test(c)) return [act("redo", {}, "Redo")];
  if (/\bsave\b/.test(c) && !/\bsave (a |the )?pose/.test(c)) return [act("save", {}, "Save project")];
  const openNamed = c.match(/\b(?:open|load|switch to)\s+(?:the\s+)?(.+?)\s+project\b/);
  const openList = c.match(/\b(?:open|load|switch to|show|list)\s+(?:my\s+|the\s+|a\s+)?(?:saved\s+)?projects?\b\s*(?:called|named)?\s*(.*)$/);
  if (openList || openNamed) {
    const name = (openList?.[1] || openNamed?.[1] || "").trim();
    return [act("open_project", name ? { name } : {}, name ? `Open project ${name}` : "Show projects")];
  }
  if (/\b(export|ship|build (the )?(unity )?bundle)\b/.test(c)) return [act("export", {}, "Build Unity bundle")];
  if (/\b(budget|performance|optimi[sz]e|draw calls|texture memory|too heavy)\b/.test(c)) return [act("check_budget", { target: budgetTarget(c) }, "Check budget")];

  // Explicit numbers on named bones beat every keyword below ("squash the chest: scale y 0.85").
  const direct = directKey(c, bones, ctx);
  if (direct) return [...out, direct];

  // Clip generator principles apply to every game clip ("more anticipation in all clips").
  if (/\b(principles?|all (the )?(game )?clips|every (game )?clip|globally|across (all )?clips)\b/.test(c)) {
    const hits = PRINCIPLE_WORDS.filter(([re]) => re.test(c));
    if (hits.length > 0) {
      const value = num(/\b(?:to|=|at)\s*(\d+(?:\.\d+)?)\b/, c);
      const level = value !== undefined ? (value > 2 ? value / 100 : value) : /\b(less|reduce|lower|subtle|softer)\b/.test(c) ? 0.6 : 1.4;
      const patch = Object.fromEntries(hits.map(([, k]) => [k, level]));
      return [act("set_principles", patch, `Game clips: ${hits.map(([, k]) => k).join(", ")} ${level}`)];
    }
  }

  if (/\b(vfx|effects?|particles?|aura)\b/.test(c) && !/\bevent\b/.test(c)) {
    const vfx = VFX_WORDS.find(([re]) => re.test(c))?.[1];
    if (vfx) return [act("set_vfx", { vfx }, `VFX ${vfx.replace(/_/g, " ")}`)];
  }
  if (/\blip.?sync|\bmouth\b|\bvoice line\b/.test(c)) {
    const phrase = /battle/.test(c) ? "battle_cry" : /olympus|roar/.test(c) ? "olympus_roar" : /jackpot/.test(c) ? "jackpot_call" : "battle_cry";
    return [act("lip_sync", { phrase }, `Lip-sync ${phrase.replace(/_/g, " ")}`)];
  }
  const symbol = c.match(/\b(wild|scatter|h[1-3]|l[1-3])\b/)?.[1];
  if (symbol && /\bsymbol\b/.test(c) && /\b(open|load|rig|switch|edit|animate|work on)\b/.test(c)) {
    return [act("open_symbol_rig", { role: symbol }, `Open the ${symbol} symbol`)];
  }

  // Coach: a named fix first, then "fix everything", then a plain review.
  const wantsCoachFix = /\b(add|give|fix|close|push|clean|snap|exaggerate|make it|apply)\b/.test(c);
  const coachHits = COACH.filter(([re, id]) => re.test(c) && (wantsCoachFix || id === "exaggeration") && !/\bcurve\b/.test(c));
  if (coachHits.length > 0) return coachHits.map(([, id, label]) => act("apply_suggestion", { id }, label));
  if (
    /\b(fix (all|everything|it all)|apply (all|every|each)\b.*\b(suggestions?|cues?|fix(es)?)|all (the )?(coach )?(fixes|suggestions)|polish (it|this|the clip))\b/.test(c)
  ) {
    return [act("fix_all", {}, "Apply all coach fixes")];
  }
  if (/\b(review|critique|feedback|what (can|should) i improve|what'?s wrong|suggest|coach)\b/.test(c)) {
    return [act("review", {}, "Review the clip")];
  }

  // Viewport overlays.
  const show = /\b(show|display|turn on|enable|reveal)\b/.test(c);
  const hide = /\b(hide|turn off|disable)\b/.test(c);
  if (show || hide || /\btoggle\b/.test(c)) {
    const hits = OVERLAYS.filter(([re]) => re.test(c)).map(([, o]) => o);
    if (hits.length > 0 && !/\b(physics|spring|ik)\b/.test(c)) {
      return hits.map((o) => act("toggle_overlay", show || hide ? { overlay: o, on: show } : { overlay: o }, `${show ? "Show" : hide ? "Hide" : "Toggle"} ${o}`));
    }
  }

  // Layer visibility ("hide the hammer layer") when no overlay matched.
  if ((show || hide || /\bunhide\b/.test(c)) && parts.length > 0 && !/\b(physics|spring|ik)\b/.test(c)) {
    const visible = !hide || /\bunhide\b/.test(c);
    return parts.map((part) => act("set_layer_visibility", { part, visible }, `${visible ? "Show" : "Hide"} ${part}`));
  }

  // Draw order: "bring the head to the front", "put the cape behind the body", "move the hammer forward".
  if (/\b(draw order|front|forward|backward|behind|in front of|on top|to the back|bottom|layer order)\b/.test(c) && parts.length > 0 && !/\bplay\b/.test(c)) {
    const rel = c.match(/^(.*)\b(behind|in front of|above|below|over|under)\b(.*)$/);
    if (rel) {
      const a = findNames(rel[1]!, ctx.parts)[0];
      const b = findNames(rel[3]!, ctx.parts)[0];
      if (a && b && a !== b) {
        const ia = ctx.parts.indexOf(a);
        const ib = ctx.parts.indexOf(b);
        const front = /in front of|above|over/.test(rel[2]!);
        const steps = front ? ib - ia : ia - ib;
        if (steps <= 0) return [act("inspect", {}, `${a} is already ${front ? "in front of" : "behind"} ${b}`)];
        return [act("set_draw_order", { part: a, move: front ? "forward" : "backward", steps }, `${a} ${front ? "in front of" : "behind"} ${b}`)];
      }
    }
    const move = /\b(to the front|on top|in front|front)\b/.test(c) && !/\bforward\b/.test(c) ? "front" : /\b(to the back|bottom|back of)\b/.test(c) ? "back" : /\bbackward|\bback\b/.test(c) ? "backward" : "forward";
    const steps = num(/(\d+)\s*(?:layers?|steps?|places?)\b/, c);
    return [act("set_draw_order", { part: parts[0], move, ...(steps ? { steps } : {}) }, `Draw order: ${parts[0]} ${move}`)];
  }

  // Deleting keys and events.
  if (/\b(delete|remove|clear|erase)\b/.test(c) && /\bevents?\b/.test(c)) {
    const name = /shake/.test(c) ? "CameraShake" : /\b(sfx|sound|audio)\b/.test(c) ? "PlaySFX" : /\b(vfx|effect|particle)\b/.test(c) ? "SpawnVFX" : /\bhit\b/.test(c) ? "OnHit" : undefined;
    const frame = num(/frame\s*(\d+)/, c);
    return [act("remove_animation_event", { ...(name ? { name } : {}), ...(frame !== undefined ? { frame } : {}) }, `Remove ${name ?? ""} event${frame !== undefined ? ` at frame ${frame}` : ""}`)];
  }
  if (/\b(delete|remove|clear|erase)\b/.test(c) && /\bkeys?(frames?)?\b/.test(c)) {
    const frame = num(/frame\s*(\d+)/, c);
    const targets = all ? "all" : bones.length > 0 ? bones : undefined;
    return [act("delete_key", { ...(targets ? { bones: targets } : {}), ...(frame !== undefined ? { frame } : {}) }, `Delete key${frame !== undefined ? ` at frame ${frame}` : ""}`)];
  }

  // Clip selection (only with a clip-ish verb, since clip names like "power" are common words).
  if (/\b(clip|animation|anim|open|switch to|edit|load|play|show me)\b/.test(c)) {
    const clip = findNames(c, ctx.clips)[0];
    if (clip && clip !== ctx.activeClip) out.push(act("select", { clip }, `Open clip ${clip}`));
  }

  // Looping (before playback: "play once instead of looping" is about the clip, not the transport).
  if (/\b(don'?t loop|do not loop|no loop|loop off|stop looping|not loop|play(s)? once|instead of looping|one-?shot|non-?looping)\b/.test(c)) {
    return [...out, act("retime_clip", { loop: false }, "Loop off")];
  }

  // Playback and navigation.
  if (/\b(pause|stop)\b/.test(c) && !/\bstop looping\b/.test(c)) return [...out, act("playback", { action: "pause" }, "Pause")];
  const speed = speedOf(c);
  if (/\bplay\b.*\b(backwards?|in reverse|reversed?)\b|\breverse play/.test(c)) {
    return [...out, act("playback", { action: "play_backward", ...(speed ? { speed } : {}) }, "Play backward")];
  }
  if (/\b(play|preview)\b/.test(c) && !/\bplayback speed\b/.test(c)) {
    return [...out, act("playback", { action: "play", ...(speed ? { speed } : {}) }, speed ? `Play at ${speed}×` : "Play")];
  }
  if (speed && /\b(speed|playback)\b/.test(c)) return [...out, act("playback", { action: "toggle", speed }, `Speed ${speed}×`)];
  if (/\bnext key\b/.test(c)) return [act("go_to", { key: "next" }, "Next key")];
  if (/\b(previous|prev) key\b/.test(c)) return [act("go_to", { key: "prev" }, "Previous key")];
  if (/\b(last|final) key\b/.test(c)) return [act("go_to", { key: "last" }, "Last key")];
  if (/\bfirst key\b/.test(c)) return [act("go_to", { key: "first" }, "First key")];
  if (/\b(go|jump|move|scrub|skip) to\b|^frame \d+|^(at|on) frame \d+$|^(to )?the (start|end)\b/.test(c) && !/\bpivot\b/.test(c)) {
    const frame = num(/frame\s*(\d+)/, c);
    const time = num(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b/, c);
    if (frame !== undefined) return [...out, act("go_to", { frame }, `Go to frame ${frame}`)];
    if (time !== undefined) return [...out, act("go_to", { time }, `Go to ${time}s`)];
    if (/\b(start|beginning|first frame)\b/.test(c)) return [...out, act("go_to", { key: "first" }, "Go to start")];
    if (/\b(end|last frame)\b/.test(c)) return [...out, act("go_to", { frame: Math.round(ctx.duration * ctx.fps) }, "Go to end")];
  }

  if (/\bbake\b/.test(c)) return [act("bake_springs_to_keys", {}, "Bake physics into keys")];

  // Rigging.
  if (/\bauto.?rig|\brig (it|this|everything|the (character|symbol|hero))\b|\brig it up\b/.test(c)) {
    const archetype = /\bas (an? )?|\barchetype\b|\blike (an? )?/.test(c) ? ARCHETYPE_WORDS.find(([re]) => re.test(c))?.[1] : undefined;
    return [act("auto_rig", archetype ? { archetype } : {}, archetype ? `Auto-rig as ${archetype.replace(/_/g, " ")}` : "Auto-rig")];
  }
  if (/\b(add|create|new)( a| another)? bone\b|\bnew bone\b/.test(c)) {
    const name = c.match(/(?:called|named)\s+([a-z0-9_-]+)/)?.[1] ?? `bone-${ctx.bones.length + 1}`;
    const parentText = c.match(/(?:under|on|to|child of|from|below)\s+(?:the\s+)?(.+)$/)?.[1] ?? "";
    const parent = findNames(parentText, ctx.bones)[0] ?? ctx.selectedBone ?? ctx.bones[0];
    return [act("add_bone", { name, parent }, `Add bone ${name} under ${parent}`)];
  }
  if (/\b(ik|elbow|knee|reach|pin)\b/.test(c) && !/\b(show|hide)\b/.test(c)) {
    const pct = pctOf(c);
    const plain = pct === undefined ? num(/\b(?:to|at|mix)\s*(0?\.\d+|1(?:\.0+)?|0)\b/, c) : undefined;
    const mix = pct !== undefined ? pct / 100 : plain !== undefined ? plain : /\b(off|disable|release)\b/.test(c) ? 0 : /\b(on|full|enable|lock)\b/.test(c) ? 1 : undefined;
    const flip = /\b(flip|other way|reverse|invert)\b/.test(c);
    const ikName = findNames(c, ctx.ikNames)[0] ?? ctx.ikNames[0];
    if (ikName && (mix !== undefined || flip)) {
      return [act("configure_ik", { ikName, ...(mix !== undefined ? { mix } : {}), ...(flip ? { bendPositive: "toggle" } : {}) }, `IK ${ikName}${mix !== undefined ? ` ${Math.round(mix * 100)}%` : ""}${flip ? " flipped" : ""}`)];
    }
  }
  if (/\b(spring\w*|physics|jiggl\w*|wobbl\w*|flopp\w*|dangl\w*|sway\w*|stiff\w*|loose\w*|secondary|bouncier)\b/.test(c)) {
    const targets = bones.length > 0 ? bones : [];
    const off = /\b(remove|disable|no|turn off|without|kill)\b/.test(c);
    const stiffness = num(/stiffness\s*(\d+)/, c) ?? (/\b(stiff|stiffer|tighter|tight)\b/.test(c) ? 85 : /\b(loose|looser|softer|floppier|floppy)\b/.test(c) ? 40 : undefined);
    if (targets.length === 0) return off ? [] : [act("apply_suggestion", { id: "secondary" }, "Add physics to loose parts")];
    return targets.map((bone) =>
      act("configure_spring_physics", { bone, enabled: !off, ...(stiffness ? { stiffness } : {}) }, `${off ? "Remove" : "Physics on"} ${bone}${stiffness ? ` (stiffness ${stiffness})` : ""}`),
    );
  }
  if (/\b(un)?lock\b/.test(c) && bones.length > 0) {
    const locked = !/\bunlock\b/.test(c);
    return bones.map((bone) => act("lock_bone", { bone, locked }, `${locked ? "Lock" : "Unlock"} ${bone}`));
  }
  if (/\bpivot\b/.test(c) && bones.length > 0) {
    // Commas split clauses, so "to 0.5, 0.2" arrives as "to 0.5 and 0.2".
    const xy = c.match(/(-?\d+(?:\.\d+)?)\s*(?:,|\band\b|\s)\s*(-?\d+(?:\.\d+)?)/) ?? c.match(/\bx\s*=?\s*(\d+(?:\.\d+)?).*?\by\s*=?\s*(\d+(?:\.\d+)?)/);
    if (xy) {
      const [x, y] = [parseFloat(xy[1]!), parseFloat(xy[2]!)];
      return [act("move_pivot", { bone: bones[0], x, y }, `Move ${bones[0]} pivot to ${x}, ${y}`)];
    }
  }
  if (/\b(inspect|current (pose|values)|show me the keys|what keys)\b/.test(c)) return [act("inspect", bones[0] ? { bone: bones[0] } : {}, `Inspect ${bones[0] ?? "clip"}`)];
  if (/\breset (the )?(warp|liquify|ffd)\b/.test(c)) {
    const part = parts[0] ?? ctx.selectedPart;
    if (part) return [act("reset_warp", { part }, `Reset warp on ${part}`)];
  }

  // Mesh and weights.
  if (/\b(re)?mesh\b|triangulat|\bdensity\b|\b(auto.?|re)?weights?\b|\bskinning\b|\bre-?weight\b/.test(c) && !/\bweight paint\b/.test(c)) {
    const density = /\b(dense|high|fine|detailed|more triangles)\b/.test(c) ? "high" : /\b(low|coarse|light|cheap|fewer|lower)\b/.test(c) ? "low" : "medium";
    const weightMode = /\b(heat|geodesic)\b/.test(c) ? "heat" : /\b(capsule|envelope)\b/.test(c) ? "capsule" : "hybrid";
    const targets = all ? ["all"] : parts.length > 0 ? parts : ctx.selectedPart ? [ctx.selectedPart] : ["all"];
    return targets.map((part) => act("configure_mesh_and_weights", { part, density, weightMode }, `Mesh ${part} (${density}, ${weightMode} weights)`));
  }

  // Curves.
  const curveWord = c.match(/\b(ease in|ease out|ease|easing|smooth|linear|stepped|step(ped)? keys|blocking|overshoot|bounce|organic|less robotic)\b/)?.[1];
  if (curveWord && !/\bease (all )?(the )?linear\b/.test(c)) {
    const curve = /ease in/.test(curveWord) ? "ease_in" : /ease out/.test(curveWord) ? "ease_out" : /linear/.test(curveWord) ? "linear" : /step|blocking/.test(curveWord) ? "stepped" : /overshoot|bounce/.test(curveWord) ? "overshoot" : "ease";
    return [...out, act("set_curve", { bones: bones.length > 0 ? bones : "all", curve }, `${curve.replace("_", " ")} curves on ${bones.length > 0 ? bones.join(", ") : "every bone"}`)];
  }
  if (/\bease (all )?(the )?linear\b/.test(c)) return [act("apply_suggestion", { id: "slow-in-out" }, "Ease linear moves")];

  // Keys, breakdowns, pose clipboard.
  if (/\b(breakdown|in-?between|tween)\b/.test(c)) {
    const pct = pctOf(c);
    const fraction = pct !== undefined ? pct / 100 : /\bfavou?r (the )?next\b/.test(c) ? 0.66 : /\bfavou?r (the )?(previous|prev|first)\b/.test(c) ? 0.33 : 0.5;
    return [act("breakdown", { fraction, ...(bones.length > 0 ? { bones } : {}) }, `Breakdown ${Math.round(fraction * 100)}%${bones.length ? ` on ${bones.join(", ")}` : ""}`)];
  }
  if (/\bcopy (the |this |that )?pose\b/.test(c)) {
    const frame = num(/frame\s*(\d+)/, c);
    return [...(frame !== undefined ? [act("go_to", { frame }, `Go to frame ${frame}`)] : []), act("copy_pose", {}, "Copy pose")];
  }
  if (/\bpaste\b/.test(c)) {
    const frame = num(/frame\s*(\d+)/, c);
    return [act("paste_pose", frame !== undefined ? { frame } : {}, frame !== undefined ? `Paste pose at frame ${frame}` : "Paste pose")];
  }
  if (/^(set (a )?key|key|keyframe|add (a )?key(frame)?)\b|\bkey (all|everything|the pose|bones|it)\b/.test(c)) {
    const deg = num(/(-?\d+(?:\.\d+)?)\s*(?:°|deg|degrees)\b/, c);
    const scale = num(/scale\s*(?:to\s*)?(\d+(?:\.\d+)?)/, c);
    const frame = num(/frame\s*(\d+)/, c);
    const targets = all || bones.length === 0 ? (all ? "all" : ctx.selectedBone ? [ctx.selectedBone] : "all") : bones;
    return [
      act(
        "set_key",
        { bones: targets, ...(deg !== undefined ? { r: deg } : {}), ...(scale !== undefined ? { sx: scale, sy: scale } : {}), ...(frame !== undefined ? { frame } : {}) },
        `Key ${targets === "all" ? "all bones" : (targets as string[]).join(", ")}${deg !== undefined ? ` at ${deg}°` : ""}`,
      ),
    ];
  }

  // Timing.
  const seconds = num(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b/, c);
  const fps = num(/(\d+)\s*fps\b/, c);
  if (seconds !== undefined && /\b(length|duration|long|make it|last|stretch|shorten|extend|lengthen)\b/.test(c)) {
    return [...out, act("retime_clip", { duration: seconds, stretch: true }, `Clip length ${seconds}s`)];
  }
  const retimePct = /\b(faster|slower|speed|shorter|longer)\b/.test(c) ? pctOf(c) : undefined;
  if (retimePct !== undefined && /\b(faster|shorter)\b/.test(c)) return [...out, act("retime_clip", { scale: Math.max(0.1, 1 - retimePct / 100), stretch: true }, `Retime ${retimePct}% faster`)];
  if (retimePct !== undefined && /\b(slower|longer)\b/.test(c)) return [...out, act("retime_clip", { scale: 1 + retimePct / 100, stretch: true }, `Retime ${retimePct}% slower`)];
  if (/\b(faster|snappier|quicker|speed (it )?up|tighter timing)\b/.test(c)) return [...out, act("retime_clip", { scale: 0.8, stretch: true }, "Retime 20% faster")];
  if (/\b(slower|slow (it )?down|more weight|heavier)\b/.test(c)) return [...out, act("retime_clip", { scale: 1.25, stretch: true }, "Retime 25% slower")];
  if (fps !== undefined) return [...out, act("retime_clip", { fps }, `${fps} fps`)];
  if (/\b(make it loop|loop it|loop on|looping|loop)\b/.test(c)) return [...out, act("retime_clip", { loop: true }, "Loop on")];

  // Clips, baking, events, skins.
  if (/\b(generate|regenerate|create|synthesi[sz]e|rebuild) (all |the )?(clips|animations|actions|moves)\b/.test(c)) return [act("generate_clips", {}, "Generate clips")];
  if (/\bevent\b|camera shake|\bsfx\b|\bsound\b|\bvfx\b/.test(c) && /\b(add|place|put|insert|fire|trigger)\b/.test(c)) {
    const name = /shake/.test(c) ? "CameraShake" : /\b(sfx|sound|audio)\b/.test(c) ? "PlaySFX" : /\b(vfx|effect|particle)\b/.test(c) ? "SpawnVFX" : "OnHit";
    const frame = num(/frame\s*(\d+)/, c);
    return [act("add_animation_event", { name, ...(frame !== undefined ? { frame } : {}) }, `Event ${name}${frame !== undefined ? ` at frame ${frame}` : ""}`)];
  }
  if (/\b(skin|tier|variant|outfit|costume)\b/.test(c)) {
    const skin = findNames(c, ctx.skins ?? [])[0] ?? c.match(/\b(?:skin|tier)\s+([a-z0-9-]+)/)?.[1];
    if (skin) return [act("set_skin_variant", { skinName: skin }, `Skin ${skin}`)];
  }

  // Tools and selection.
  const mode = c.match(
    /\b(?:open|switch to|go to|use)\s+(?:the\s+)?(import|auto rig|auto|rig|bones?|create|mesh|weight paint|weights?|pose|rotate|translate|move|scale|animate|warp|liquify|export)\b/,
  )?.[1];
  if (mode) {
    // Spine's tool names map onto Kinetic's: Create = Bones & IK, Rotate/Translate/Scale = Pose sub-tools.
    const transform: Record<string, string> = { pose: "pose", rotate: "rotate", translate: "translate", move: "translate", scale: "scale" };
    const map: Record<string, string> = { "auto rig": "auto", bone: "rig", bones: "rig", create: "rig", "weight paint": "weights", weight: "weights", warp: "liquify" };
    const args = transform[mode] ? { mode: "animate", tool: transform[mode] } : { mode: map[mode] ?? mode };
    return [...out, act("set_mode", args, `Use ${mode}`)];
  }
  if (/\bselect\b/.test(c) && (bones.length > 0 || parts.length > 0)) {
    return [act("select", { ...(bones[0] ? { bone: bones[0] } : {}), ...(parts[0] ? { part: parts[0] } : {}) }, `Select ${bones[0] ?? parts[0]}`)];
  }
  return out;
}

export const EXAMPLE_PROMPTS = [
  "Review this clip",
  "Add anticipation and overshoot",
  "Mesh the body dense with heat weights",
  "Add physics to the cape, then make it snappier",
  "Tilt the head 15° at frame 6, then ease it",
  "Preview the big win ladder",
  "Which bones have physics?",
];

export function planCommand(prompt: string, ctx: CopilotContext): Plan {
  const q = prompt.trim().toLowerCase();
  const answer = answerQuestion(q, ctx);
  if (answer) return answer;
  const clauses = splitClauses(q.replace(POLITE, "").replace(/\?\s*$/, ""));
  const actions: CopilotAction[] = [];
  const missed: string[] = [];
  const memo = { bones: [] as string[] };
  for (const c of clauses) {
    const a = planClause(c, ctx, memo);
    if (a.length === 0) missed.push(c);
    actions.push(...a);
  }
  if (actions.length === 0) {
    return {
      reply: `I couldn't map that to a tool. Try: “${EXAMPLE_PROMPTS[1]}”, “${EXAMPLE_PROMPTS[2]}” or “${EXAMPLE_PROMPTS[3]}”.`,
      actions,
    };
  }
  const reply = missed.length > 0 ? `I skipped “${missed.join("”, “")}” because I couldn't map it to a tool.` : "";
  return { reply, actions };
}
