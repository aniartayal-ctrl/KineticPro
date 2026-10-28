/**
 * End-to-end Claude integration, offline: the shipped agent loop and relay talk to a strict mock of
 * the Messages API, which scripts tool calls covering the whole catalog and rejects malformed requests.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { SCRIPTS, startMockAnthropic } from "../../scripts/mock-anthropic.mjs";
import type { Turn } from "@/core/copilot/providers";
import { COPILOT_TOOLS } from "@/core/copilot/tools";
import { callModel } from "@/server/copilot-relay";
import { useStudioStore } from "@/store/useStudioStore";
import { runAgentTurn, StepError, type StepFn } from "./agent-loop";
import type { ExecutorHost } from "./executor";

const host: ExecutorHost = {
  exportBundle: async () => {},
  save: async () => true,
  openBudget: () => {},
  openProject: async () => "Showing projects",
  openSymbol: async (_role, title) => `Save or discard your changes to open ${title}`,
};

let mock: Awaited<ReturnType<typeof startMockAnthropic>>;
const claude: StepFn = async (transcript, context) => {
  const r = await callModel("claude", "test-key", "claude-sonnet-5-5", transcript, context);
  if (!r.ok) throw new StepError(r.error, String(r.status));
  return r.step;
};

before(async () => {
  mock = await startMockAnthropic(0);
  process.env.KINETIC_ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.port}`;
  useStudioStore.getState().setIsPlaying(false);
});
after(() => mock.server.close());

describe("Claude integration (mock Messages API)", () => {
  let transcript: Turn[] = [];

  it("runs every scripted conversation to the end with valid requests", async () => {
    for (const prompt of Object.keys(SCRIPTS).filter((p) => p !== "mock: memory")) {
      const run = await runAgentTurn({ prompt, transcript, callStep: claude, host });
      assert.equal(run.outcome, "done", `${prompt}: ${run.error ?? run.outcome}`);
      assert.equal(run.usage?.output, run.steps * 30, "token usage adds up across steps");
      transcript = run.transcript;
    }
    const report = mock.report();
    assert.deepEqual(report.errors, []);
    assert.ok(report.systemOk, "system prompt is cached and carries the studio state");
    assert.equal(report.lastModel, "claude-sonnet-5-5");
  });

  it("calls every tool in the catalog and gets results back", () => {
    const report = mock.report();
    const called = new Set(report.calls.map((c) => c.tool));
    const missing = COPILOT_TOOLS.map((t) => t.name).filter((n) => !called.has(n));
    assert.deepEqual(missing, [], `tools never exercised: ${missing.join(", ")}`);
    assert.equal(report.results.length, report.calls.length, "every tool_use got a tool_result");
    const failed = report.results.filter((r) => !r.ok).map((r) => `${r.tool}: ${r.content}`);
    assert.equal(failed.length, 1, failed.join("\n"));
    assert.match(failed[0]!, /^select: No bone named "tentacle"\. Bones: root, hips, chest, head/);
  });

  it("changed the studio the way the tools said", () => {
    const s = useStudioStore.getState();
    assert.equal(s.selectedBone, "head");
    assert.equal(s.activeSkinName, "awakened");
    assert.ok(mock.report().results.some((r) => r.tool === "set_vfx" && /coin fountain/i.test(r.content)));
  });

  it("remembers earlier prompts", async () => {
    const run = await runAgentTurn({ prompt: "mock: memory", transcript, callStep: claude, host });
    assert.equal(run.outcome, "done");
    const memory = mock.report().memory;
    const keys = Object.keys(SCRIPTS);
    const previous = keys[keys.indexOf("mock: memory") - 1]!;
    assert.ok(memory.includes(previous) && memory.includes("mock: memory"), memory.join(" | "));
  });

  it("reports provider errors without corrupting the transcript", async () => {
    process.env.KINETIC_ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
    const before = transcript.length;
    const run = await runAgentTurn({ prompt: "mock: inspect", transcript, callStep: claude, host });
    process.env.KINETIC_ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.port}`;
    assert.equal(run.outcome, "error");
    assert.match(run.error!, /Could not reach Claude/);
    assert.equal(run.transcript.length, before, "a failed first step leaves no trace");
  });

  it("stops between steps without leaving calls unanswered", async () => {
    const ctrl = new AbortController();
    const run = await runAgentTurn({
      prompt: "mock: rig",
      transcript: [],
      callStep: async (t, c) => {
        const step = await claude(t, c);
        ctrl.abort();
        return step;
      },
      host,
      signal: ctrl.signal,
    });
    assert.equal(run.outcome, "stopped");
    const last = run.transcript[run.transcript.length - 1]!;
    assert.equal(last.role, "tool");
    assert.ok(last.role === "tool" && last.results.every((r) => r.message === "Stopped by the user"));
  });

  it("pauses at the step limit with a valid transcript", async () => {
    const run = await runAgentTurn({ prompt: "mock: animate", transcript: [], callStep: claude, host, maxSteps: 2 });
    assert.equal(run.outcome, "limit");
    assert.equal(run.transcript[run.transcript.length - 1]!.role, "tool");
    const next = await runAgentTurn({ prompt: "continue", transcript: run.transcript, callStep: claude, host });
    assert.equal(next.outcome, "done");
    assert.deepEqual(mock.report().errors, []);
  });
});
