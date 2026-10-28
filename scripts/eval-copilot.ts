/**
 * Copilot eval: plain-language requests run through the real agent loop against a real model, then
 * checked against the studio state they should produce.
 *
 *   ANTHROPIC_API_KEY=sk-... npm run eval:copilot              # Claude (KINETIC_CLAUDE_MODEL to pick a model)
 *   npm run eval:copilot -- --provider planner                  # offline planner baseline, no key
 *   npm run eval:copilot -- --provider chatgpt --only physics   # other providers, a subset
 *
 * Each scenario starts from the default project. Nothing is saved or exported (the host is fake).
 */

import { sampleTransformTrack } from "@/core/animator";
import { reviewClip } from "@/core/coach";
import { snapTime } from "@/core/keyframes";
import { planCommand } from "@/core/copilot/planner";
import type { CloudProvider } from "@/core/copilot/providers";
import { runAgentTurn, StepError, type StepFn } from "@/copilot/agent-loop";
import { copilotContext, executeCopilotActions, type ExecutorHost } from "@/copilot/executor";
import { callModel, PROVIDERS } from "@/server/copilot-relay";
import { useStudioStore } from "@/store/useStudioStore";

type Check = string | true;
type Scenario = { name: string; prompt: string; setup?: () => void | Promise<void>; check: (ctx: RunInfo) => Check };
type RunInfo = { tools: string[]; reply: string };

const initial = useStudioStore.getState();
const s = () => useStudioStore.getState();
const clip = () => s().project.animations[s().activeClip]!;
const at = (frame: number) => snapTime(frame / (clip().fps || 30), clip().fps || 30, clip().duration);
const pose = (bone: string, frame: number) => sampleTransformTrack(clip().boneTracks[bone], at(frame));
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const expect = (ok: boolean, why: string): Check => ok || why;
const DESTRUCTIVE = ["auto_rig", "generate_clips", "bake_springs_to_keys", "open_project", "export"];
const MUTATING = new Set([
  "add_bone", "move_pivot", "configure_ik", "configure_spring_physics", "lock_bone", "configure_mesh_and_weights", "reset_warp", "set_key",
  "breakdown", "paste_pose", "set_curve", "retime_clip", "add_animation_event", "apply_suggestion", "fix_all", "undo", "redo", ...DESTRUCTIVE,
]);

const SCENARIOS: Scenario[] = [
  { name: "key rotation", prompt: "Tilt the head 15 degrees at frame 6", check: () => expect(near(pose("head", 6).r, 15, 1), `head r at 6 is ${pose("head", 6).r.toFixed(1)}`) },
  {
    name: "relative key",
    prompt: "At frame 6, rotate the head 10 degrees further than it is now",
    setup: () => void executeCopilotActions([{ tool: "set_key", args: { bones: ["head"], r: 20, frame: 6 }, summary: "" }], host),
    check: () => expect(near(pose("head", 6).r, 30, 1), `head r at 6 is ${pose("head", 6).r.toFixed(1)}, wanted 30`),
  },
  {
    name: "squash pose",
    prompt: "Squash the chest at frame 10: scale Y to 0.85 and scale X to 1.15",
    check: () => expect(near(pose("chest", 10).sy, 0.85, 0.01) && near(pose("chest", 10).sx, 1.15, 0.01), `chest sx/sy ${pose("chest", 10).sx}/${pose("chest", 10).sy}`),
  },
  {
    name: "physics on",
    prompt: "Add physics to the cape with stiffness 50",
    setup: () => s().updateBone("cape", { spring: undefined }),
    check: () => expect(s().project.bones.find((b) => b.name === "cape")?.spring?.stiffness === 50, "cape stiffness is not 50"),
  },
  {
    name: "physics off",
    prompt: "Remove the physics from the cape tail",
    check: () => expect(!s().project.bones.find((b) => b.name === "cape-tail")?.spring, "cape-tail still has physics"),
  },
  {
    name: "mesh",
    prompt: "Re-mesh the hammer layer with high density and heat weights",
    check: ({ tools }) => expect(tools.includes("configure_mesh_and_weights"), "no mesh call"),
  },
  { name: "ik mix", prompt: "Set the arm IK to 70 percent", check: () => expect(near(s().project.ikConstraints![0]!.mix, 0.7, 0.01), `mix ${s().project.ikConstraints![0]!.mix}`) },
  { name: "lock", prompt: "Lock the hips bone so weight painting can't change it", check: () => expect(s().lockedBones.includes("hips"), "hips not locked") },
  {
    name: "add bone",
    prompt: "Add a bone called tassel under the head",
    check: () => expect(s().project.bones.find((b) => b.name === "tassel")?.parent === "head", "no tassel under head"),
  },
  { name: "open clip", prompt: "Open the idle clip", check: () => expect(s().activeClip === "idle", `active clip ${s().activeClip}`) },
  { name: "faster", prompt: "Make this clip 20% faster", check: () => expect(near(clip().duration, 1.6, 0.05), `duration ${clip().duration}`) },
  { name: "fps", prompt: "Change the frame rate to 30 fps", check: () => expect(clip().fps === 30, `fps ${clip().fps}`) },
  {
    name: "loop off",
    prompt: "Make this clip play once instead of looping",
    check: () => expect(clip().loop === false, "still loops"),
  },
  {
    name: "ease",
    prompt: "Ease all the keys on the weapon",
    check: () => expect((clip().boneTracks.weapon ?? []).slice(0, -1).every((k) => Array.isArray(k.curve)), "weapon keys not eased"),
  },
  {
    name: "event",
    prompt: "Add an OnHit event at frame 9",
    check: () => expect((clip().events ?? []).some((e) => e.name === "OnHit" && near(e.time * clip().fps, 9, 0.05)), "no OnHit at frame 9"),
  },
  {
    name: "copy paste",
    prompt: "Copy the pose at frame 12 and paste it at frame 30",
    check: () => expect(near(pose("weapon", 30).r, pose("weapon", 12).r, 0.5) && near(pose("head", 30).r, pose("head", 12).r, 0.5), "frame 30 does not match frame 12"),
  },
  {
    name: "coach fix",
    prompt: "Fix the follow-through problem the coach found",
    check: () => expect(!reviewClip(s().project, s().activeClip).some((c) => c.id === "follow-through"), "follow-through card still open"),
  },
  {
    name: "coach all",
    prompt: "Apply every coach fix you can",
    check: () => expect(reviewClip(s().project, s().activeClip).filter((c) => c.apply).length === 0, "fixable cards remain"),
  },
  { name: "skin", prompt: "Switch to the awakened skin", check: () => expect(s().activeSkinName === "awakened", `skin ${s().activeSkinName}`) },
  { name: "overlay", prompt: "Turn on onion skinning", check: () => expect(s().showOnionSkin, "onion skin off") },
  {
    name: "playback",
    prompt: "Play the animation backward at half speed",
    check: () => expect(s().isPlaying && s().playDirection === -1 && s().playbackSpeed === 0.5, `playing ${s().isPlaying}, dir ${s().playDirection}, speed ${s().playbackSpeed}`),
  },
  { name: "budget", prompt: "Will this rig fit the mobile symbol budget?", check: ({ tools }) => expect(tools.includes("check_budget"), "no budget check") },
  {
    name: "undo",
    prompt: "Undo that",
    setup: () => void executeCopilotActions([{ tool: "set_key", args: { bones: ["head"], r: 33, frame: 6 }, summary: "" }], host),
    check: () => expect(!near(pose("head", 6).r, 33, 0.1), "the key is still there"),
  },
  {
    name: "question only",
    prompt: "Which bones have physics?",
    check: ({ tools, reply }) => expect(!tools.some((t) => MUTATING.has(t)) && /cape/i.test(reply), `tools ${tools.join(",")}; reply: ${reply.slice(0, 80)}`),
  },
  {
    name: "no destructive guess",
    prompt: "Make it look better",
    check: ({ tools }) => expect(!tools.some((t) => DESTRUCTIVE.includes(t)), `destructive tools: ${tools.join(",")}`),
  },
  {
    name: "draw order",
    prompt: "Bring the head layer to the front",
    check: () => expect(s().project.parts[s().project.parts.length - 1]?.name === "head", `order ${s().project.parts.map((p) => p.name).join(",")}`),
  },
  {
    name: "delete key",
    prompt: "Delete the head's key at frame 7",
    setup: () => void executeCopilotActions([{ tool: "set_key", args: { bones: ["head"], r: 9, frame: 7 }, summary: "" }], host),
    check: () => expect(!(clip().boneTracks.head ?? []).some((k) => Math.round(k.time * clip().fps) === 7), "key at frame 7 still there"),
  },
  {
    name: "remove event",
    prompt: "Remove the camera shake event",
    check: () => expect(!(clip().events ?? []).some((e) => e.name === "CameraShake"), "camera shake still there"),
  },
  {
    name: "symbol rig",
    prompt: "Open the wild symbol so I can animate it",
    check: () => expect(/wild/.test(s().project.id), `project ${s().project.id}`),
  },
  {
    name: "generator",
    prompt: "Give every game clip more anticipation",
    check: () => expect(s().principles.anticipation > 1, `anticipation ${s().principles.anticipation}`),
  },
  {
    name: "anticipation",
    prompt: "Add a wind-up before the big swing",
    check: () => expect(!reviewClip(s().project, s().activeClip).some((c) => c.id === "anticipation"), "anticipation card still open"),
  },
];

const host: ExecutorHost = {
  exportBundle: async () => {},
  save: async () => true,
  openBudget: () => {},
  openProject: async () => "Showing projects",
  openSymbol: async (role, title) => (useStudioStore.getState().loadSymbolRig(role), `Opened ${title}`),
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const provider = (arg("provider") ?? (process.env.ANTHROPIC_API_KEY ? "claude" : "planner")) as CloudProvider | "planner";
  const only = arg("only");
  const scenarios = SCENARIOS.filter((x) => !only || x.name.includes(only) || x.prompt.toLowerCase().includes(only.toLowerCase()));
  let callStep: StepFn | null = null;
  let label = "built-in planner (offline)";
  if (provider !== "planner") {
    const p = PROVIDERS[provider];
    const key = process.env[p.keyEnv];
    if (!key) {
      console.error(`Set ${p.keyEnv} to evaluate ${p.label}, or pass --provider planner.`);
      process.exit(2);
    }
    const model = p.model();
    label = `${p.label} ${model}`;
    callStep = async (t, ctx) => {
      const r = await callModel(provider, key, model, t, ctx);
      if (!r.ok) throw new StepError(r.error, String(r.status));
      return r.step;
    };
  }
  console.log(`Copilot eval · ${label} · ${scenarios.length} scenarios\n`);
  let passed = 0;
  const started = Date.now();
  const tokens = { input: 0, output: 0, cached: 0 };
  for (const sc of scenarios) {
    useStudioStore.setState(initial, true);
    s().setIsPlaying(false);
    await sc.setup?.();
    const t0 = Date.now();
    const tools: string[] = [];
    let reply = "";
    let failure: string | null = null;
    try {
      if (callStep) {
        const run = await runAgentTurn({
          prompt: sc.prompt,
          transcript: [],
          callStep,
          host,
          onText: (t) => (reply = t),
          onResults: (rs) => tools.push(...rs.map((r) => `${r.action.tool}${r.ok ? "" : "✕"}`)),
        });
        if (run.outcome === "error") failure = run.error ?? "error";
        if (run.usage) for (const k of ["input", "output", "cached"] as const) tokens[k] += run.usage[k];
      } else {
        const plan = planCommand(sc.prompt, copilotContext());
        reply = plan.reply;
        const rs = await executeCopilotActions(plan.actions, host);
        tools.push(...rs.map((r) => `${r.action.tool}${r.ok ? "" : "✕"}`));
      }
      const verdict = failure ?? sc.check({ tools: tools.map((t) => t.replace("✕", "")), reply });
      if (verdict === true) passed++;
      else failure = verdict;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    const ms = Date.now() - t0;
    console.log(`${failure ? "✕" : "✓"} ${sc.name.padEnd(22)} ${String(ms).padStart(6)} ms  ${tools.join(" → ") || "(no tools)"}${failure ? `\n    ${failure}` : ""}`);
  }
  const total = scenarios.length;
  console.log(`\n${passed}/${total} passed (${Math.round((passed / Math.max(1, total)) * 100)}%) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (tokens.input > 0) console.log(`Tokens: ${tokens.input} in (${tokens.cached} cached), ${tokens.output} out`);
  process.exit(passed === total ? 0 : 1);
}

void main();
