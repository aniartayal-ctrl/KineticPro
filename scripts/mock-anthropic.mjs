/**
 * Strict mock of the Anthropic Messages API for testing the copilot's Claude integration offline.
 *
 * - Validates every request the way the real API does where it matters for tool use (roles, block
 *   shapes, tool_use ↔ tool_result pairing and ordering, tool schemas, headers) and rejects bad ones
 *   with a 400, so protocol regressions fail loudly.
 * - Replays scripted tool calls for prompts that start with "mock:", reading the previous step's
 *   tool results like a model would, and records everything for /__report.
 *
 * Run: node scripts/mock-anthropic.mjs [port]   (default 4599)
 * Then start the app with KINETIC_ANTHROPIC_BASE_URL=http://127.0.0.1:4599 ANTHROPIC_API_KEY=mock.
 */

import http from "node:http";
import { pathToFileURL } from "node:url";

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Scripted runs. Each step returns tool calls ([name, input] pairs) or a final text reply. */
export const SCRIPTS = {
  "mock: inspect": [() => [["inspect", { bone: "head" }]], () => "The head is at rest."],
  "mock: rig": [
    () => [
      ["set_mode", { mode: "rig" }],
      ["add_bone", { name: "charm", parent: "head" }],
    ],
    () => [
      ["move_pivot", { bone: "charm", x: 0.5, y: 0.2 }],
      ["lock_bone", { bone: "charm", locked: true }],
    ],
    () => [["configure_spring_physics", { bone: "charm", enabled: true, stiffness: 50, damping: 5 }]],
    () => [["configure_ik", { mix: 0.6, flip: true }]],
    () => "Added a charm bone with physics and set the arm IK to 60%.",
  ],
  "mock: mesh": [
    () => [["configure_mesh_and_weights", { part: "body", density: "high", weightMode: "heat" }]],
    () => [["reset_warp", { part: "body" }]],
    () => "Body re-meshed with heat weights.",
  ],
  "mock: animate": [
    () => [["select", { clip: "strike", bone: "head" }]],
    () => [
      ["set_key", { bones: ["head"], r: 12, frame: 6 }],
      ["set_key", { bones: ["head"], r: 5, relative: true, frame: 6 }],
    ],
    () => [
      ["go_to", { frame: 3 }],
      ["breakdown", { fraction: 0.5, bones: ["head"] }],
    ],
    () => [
      ["copy_pose", {}],
      ["paste_pose", { frame: 12 }],
    ],
    () => [
      ["set_curve", { curve: "ease", bones: ["head"] }],
      ["add_animation_event", { name: "OnHit", frame: 9 }],
    ],
    () => "Keyed the head tilt with a breakdown, eased it and added a hit event.",
  ],
  "mock: timing": [
    () => [["retime_clip", { scale: 0.9 }]],
    () => [
      ["playback", { action: "play_backward" }],
      ["playback", { action: "pause" }],
    ],
    () => [["go_to", { key: "first" }]],
    () => "Tightened the clip by 10%.",
  ],
  "mock: coach": [
    () => [["review", {}]],
    (prev) => {
      const id = /^([a-z-]+) \[/m.exec(prev[0]?.content ?? "")?.[1];
      return id ? [["apply_suggestion", { id }]] : [["fix_all", {}]];
    },
    () => [["fix_all", {}]],
    () => "Applied the coach's fixes.",
  ],
  "mock: project": [
    () => [
      ["toggle_overlay", { overlay: "mesh", on: true }],
      ["set_skin_variant", { skinName: "awakened" }],
    ],
    () => [["check_budget", { target: "mobile-symbol" }]],
    () => [["undo", {}]],
    () => [["redo", {}]],
    () => [["save", {}]],
    () => "Saved. The rig fits the mobile symbol budget.",
  ],
  "mock: heavy": [
    () => [["generate_clips", {}]],
    () => [["bake_springs_to_keys", {}]],
    () => [["auto_rig", { archetype: "heavy_titan" }]],
    () => "Rebuilt the rig and clips.",
  ],
  "mock: layers": [
    () => [["set_draw_order", { part: "head", move: "front" }]],
    () => [["set_layer_visibility", { part: "head", visible: false }]],
    () => [["set_layer_visibility", { part: "head", visible: true }]],
    () => "The head now draws in front.",
  ],
  "mock: cleanup": [
    () => [["set_key", { bones: ["head"], r: 5, frame: 4 }]],
    () => [["delete_key", { bones: ["head"], frame: 4 }]],
    () => [["add_animation_event", { name: "PlaySFX", frame: 5 }]],
    () => [["remove_animation_event", { name: "PlaySFX", frame: 5 }]],
    () => "Removed the stray key and event.",
  ],
  "mock: present": [
    () => [["set_vfx", { vfx: "coin_fountain" }]],
    () => [["lip_sync", { phrase: "jackpot_call" }]],
    () => [["set_principles", { anticipation: 1.4, exaggeration: 1.2 }]],
    () => "Set coin VFX, lip-sync, and pushed anticipation.",
  ],
  "mock: correct": [
    () => [["select", { bone: "tentacle" }]],
    (prev, report) => {
      if (!prev[0]?.is_error) report.errors.push("correct: expected the first select to fail with is_error");
      return [["select", { bone: "head" }]];
    },
    () => "There is no tentacle, so I selected the head.",
  ],
  "mock: finish": [() => [["open_project", {}]], () => [["export", {}]], () => "Exported."],
  "mock: symbol": [() => [["open_symbol_rig", { role: "wild" }]], () => "Opening the wild symbol."],
  "mock: memory": [
    (_prev, report, req) => {
      const prompts = req.messages.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "text");
      report.memory = prompts.map((b) => b.text);
      return "I remember the conversation.";
    },
  ],
};

export function newReport() {
  return { requests: 0, errors: [], calls: [], results: [], memory: [], systemOk: false, lastModel: "" };
}

/** Throws with a message like the API's on an invalid request. */
export function validate(req, headers) {
  const bad = (m) => {
    throw new Error(m);
  };
  if (!headers["x-api-key"]) bad("x-api-key header is required");
  if (headers["anthropic-version"] !== "2023-06-01") bad("anthropic-version header must be 2023-06-01");
  if (!String(headers["content-type"] ?? "").includes("application/json")) bad("content-type must be application/json");
  if (typeof req.model !== "string" || !req.model) bad("model: field required");
  if (!Number.isInteger(req.max_tokens) || req.max_tokens < 1) bad("max_tokens: must be a positive integer");
  if (req.system !== undefined) {
    const blocks = typeof req.system === "string" ? [{ type: "text", text: req.system }] : req.system;
    if (!Array.isArray(blocks)) bad("system: must be a string or an array of text blocks");
    for (const b of blocks) {
      if (b.type !== "text" || typeof b.text !== "string" || !b.text) bad("system: text blocks must be non-empty");
      if (b.cache_control && b.cache_control.type !== "ephemeral") bad("system: cache_control.type must be ephemeral");
    }
  }
  const names = new Set();
  for (const t of req.tools ?? []) {
    if (!NAME.test(t.name ?? "")) bad(`tools: invalid name ${t.name}`);
    if (names.has(t.name)) bad(`tools: duplicate name ${t.name}`);
    names.add(t.name);
    if (typeof t.description !== "string") bad(`tools.${t.name}: description must be a string`);
    if (t.input_schema?.type !== "object") bad(`tools.${t.name}: input_schema.type must be "object"`);
    for (const r of t.input_schema.required ?? []) if (!(r in (t.input_schema.properties ?? {}))) bad(`tools.${t.name}: required ${r} is not a property`);
  }
  if (req.tool_choice && !["auto", "any", "tool", "none"].includes(req.tool_choice.type)) bad("tool_choice.type invalid");
  if (!Array.isArray(req.messages) || req.messages.length === 0) bad("messages: at least one message is required");
  if (req.messages[0].role !== "user") bad("messages: first message must use the user role");
  if (req.messages[req.messages.length - 1].role !== "user") bad("messages: the last message must be from the user");
  let pending = null;
  req.messages.forEach((m, i) => {
    if (m.role !== "user" && m.role !== "assistant") bad(`messages.${i}.role: must be user or assistant`);
    if (i > 0 && req.messages[i - 1].role === m.role) bad(`messages.${i}: roles must alternate`);
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (!Array.isArray(blocks) || blocks.length === 0) bad(`messages.${i}.content: must be non-empty`);
    if (m.role === "user") {
      const results = blocks.filter((b) => b.type === "tool_result");
      if (pending) {
        const answered = new Set(results.map((b) => b.tool_use_id));
        for (const id of pending) if (!answered.has(id)) bad(`messages.${i}: tool_use ids were found without tool_result blocks immediately after: ${id}`);
        const firstOther = blocks.findIndex((b) => b.type !== "tool_result");
        if (firstOther !== -1 && blocks.slice(firstOther).some((b) => b.type === "tool_result")) bad(`messages.${i}: tool_result blocks must come first`);
      }
      for (const b of results) {
        if (!pending?.has(b.tool_use_id)) bad(`messages.${i}: unexpected tool_use_id ${b.tool_use_id} in tool_result`);
        if (typeof b.content !== "string" && !Array.isArray(b.content)) bad(`messages.${i}: tool_result content must be a string or blocks`);
      }
      pending = null;
    } else {
      if (pending) bad(`messages.${i}: assistant turn while tool results are pending`);
      const ids = new Set();
      for (const b of blocks) {
        if (b.type === "tool_use") {
          if (!/^[a-zA-Z0-9_-]+$/.test(b.id ?? "")) bad(`messages.${i}: tool_use id ${b.id} is invalid`);
          if (ids.has(b.id)) bad(`messages.${i}: duplicate tool_use id ${b.id}`);
          if (!names.has(b.name)) bad(`messages.${i}: tool_use ${b.name} is not a declared tool`);
          if (!b.input || typeof b.input !== "object" || Array.isArray(b.input)) bad(`messages.${i}: tool_use input must be an object`);
          ids.add(b.id);
        }
      }
      pending = ids.size > 0 ? ids : null;
    }
    for (const b of blocks) {
      if (!["text", "tool_use", "tool_result", "image"].includes(b.type)) bad(`messages.${i}: unknown block type ${b.type}`);
      if (b.type === "text" && (typeof b.text !== "string" || b.text.length === 0)) bad(`messages.${i}: text content blocks must be non-empty`);
    }
  });
}

let ids = 0;

/** One scripted response for a validated request. */
export function respond(req, report) {
  report.requests++;
  report.lastModel = req.model;
  const sys = Array.isArray(req.system) ? req.system : [];
  report.systemOk = sys.length === 2 && sys[0].cache_control?.type === "ephemeral" && /Current studio state:\n.*Bones: /s.test(sys[1].text ?? "");
  // The run's prompt is the newest user text; steps taken since = assistant turns after it.
  let promptIndex = -1;
  let prompt = "";
  req.messages.forEach((m, i) => {
    const text = m.role === "user" && Array.isArray(m.content) ? m.content.filter((b) => b.type === "text").map((b) => b.text) : [];
    const real = text.filter((t) => !t.startsWith("[Studio note]"));
    if (real.length > 0) {
      promptIndex = i;
      prompt = real[real.length - 1];
    }
  });
  const step = req.messages.slice(promptIndex + 1).filter((m) => m.role === "assistant").length;
  const last = req.messages[req.messages.length - 1];
  const prev = step > 0 && Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_result") : [];
  // Record the results the app sent back, matched to the calls that produced them.
  for (const r of prev) {
    const call = report.calls.find((c) => c.id === r.tool_use_id);
    report.results.push({ id: r.tool_use_id, tool: call?.tool ?? "?", ok: !r.is_error, content: String(r.content) });
  }
  const script = SCRIPTS[prompt.trim().toLowerCase()];
  const out = script?.[step]?.(prev, report, req) ?? (script ? "Done." : `I only follow scripts in the mock. Try: ${Object.keys(SCRIPTS).join(", ")}`);
  if (typeof out === "string") {
    return { id: `msg_mock_${++ids}`, type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: out }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 4000 } };
  }
  const content = out.map(([name, input]) => {
    const id = `toolu_mock_${++ids}`;
    report.calls.push({ id, tool: name, input, prompt });
    return { type: "tool_use", id, name, input };
  });
  return { id: `msg_mock_${++ids}`, type: "message", role: "assistant", model: req.model, content, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 4000 } };
}

export function startMockAnthropic(port = 4599) {
  let report = newReport();
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/__report") return send(200, report);
    if (req.method === "POST" && req.url === "/__reset") {
      report = newReport();
      return send(200, { ok: true });
    }
    if (req.method !== "POST" || req.url !== "/v1/messages") return send(404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { type: "error", error: { type: "invalid_request_error", message: "Body is not JSON" } });
      }
      try {
        validate(body, req.headers);
      } catch (err) {
        report.errors.push(err.message);
        return send(400, { type: "error", error: { type: "invalid_request_error", message: err.message } });
      }
      try {
        send(200, respond(body, report));
      } catch (err) {
        report.errors.push(`mock: ${err.message}`);
        send(500, { type: "error", error: { type: "api_error", message: err.message } });
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, report: () => report })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // No top-level await: tests import this file through a CommonJS transform.
  void startMockAnthropic(Number(process.argv[2] ?? 4599)).then(({ port }) =>
    console.log(`Mock Anthropic API on http://127.0.0.1:${port} (scripts: ${Object.keys(SCRIPTS).join(", ")})`),
  );
}
