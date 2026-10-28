#!/usr/bin/env node
/**
 * Whole-studio smoke test. Start the app first (`npm run build && npm start`), then:
 *   npm run test:ui            (KINETIC_URL overrides http://127.0.0.1:3460, SHOTS=dir saves screenshots,
 *                               ONLY=claude,projects runs a subset)
 *
 * Exercises every tool, overlay, inspector tab, budget target, clip, timeline view, shortcut,
 * copilot command and coach fix, then runs a seeded random "monkey" pass and an autosave/restore
 * cycle on a fast-forwarded clock. Fails on any page error, console error or dead UI.
 */
import { chromium } from "playwright";
import { SCRIPTS, startMockAnthropic } from "./mock-anthropic.mjs";

const URL = process.env.KINETIC_URL ?? "http://127.0.0.1:3460";
const SHOTS = process.env.SHOTS;
const MOCK = process.env.MOCK_ANTHROPIC_PORT ?? "4599";
const report = { steps: 0, copilot: { ok: 0, failed: [] }, claude: "not run", import: "not run", coachFixes: 0, monkeyClicks: 0, errors: [] };

// The mock Messages API stays up for the whole run, so stray Claude requests (the monkey) get answers.
const mockUrl = `http://127.0.0.1:${MOCK}`;
const mock = (await fetch(`${mockUrl}/__report`).then((r) => r.ok).catch(() => false)) ? null : await startMockAnthropic(Number(MOCK));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => report.errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && report.errors.push(`console: ${m.text()}`));
// Name the failing request, since the console only says "Failed to load resource".
page.on("response", async (r) => {
  if (r.status() < 400 || !r.url().includes("/api/")) return;
  const body = await r.text().catch(() => "");
  report.errors.push(`http ${r.status()} ${r.request().method()} ${new globalThis.URL(r.url()).pathname}: ${body.slice(0, 160)}`);
});

const ONLY = process.env.ONLY?.split(",");
const step = async (name, fn) => {
  if (ONLY && !ONLY.includes(name)) return;
  report.steps++;
  const t0 = Date.now();
  try {
    await fn();
  } catch (err) {
    // Playwright puts the locator it was waiting for on the following lines.
    report.errors.push(`${name}: ${err.message.split("\n").slice(0, 3).join(" ").replace(/\s+/g, " ").slice(0, 300)}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/fail-${name.replace(/\W+/g, "-")}.png` }).catch(() => {});
  }
  console.error(`· ${name} ${((Date.now() - t0) / 1000).toFixed(1)}s, errors so far: ${report.errors.length}`);
};
const alive = async (where) => {
  if (!(await page.locator("header").first().isVisible())) report.errors.push(`studio not visible after ${where}`);
};
// Software WebGL in headless Chromium makes frames slow while a clip plays; give clicks room.
const click = (loc) => loc.click({ timeout: 8000 });
const studio = (fn, ...args) => page.evaluate(([f, a]) => window.__kineticTest[f](...a), [fn, args]);
/** Stops playback so dialogs and menus are not competing with a busy render loop. */
const pause = async () => {
  if ((await studio("state")).isPlaying) {
    await page.locator("body").click({ position: { x: 800, y: 300 } });
    await page.keyboard.press("Space");
  }
};

await page.goto(`${URL}/?test`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.keyboard.press("Space"); // pause playback for stable interaction

await step("tools", async () => {
  for (const name of ["Import", "Auto Rig", "Bones & IK", "Mesh", "Weight Paint", "Pose", "Rotate", "Translate", "Scale", "Warp", "Export"]) {
    await page.getByRole("button", { name, exact: true }).click({ timeout: 4000, noWaitAfter: true });
    await page.waitForTimeout(name === "Export" ? 9000 : 250); // the server bakes atlas + sprite sheet
    await alive(`tool ${name}`);
  }
});

await step("overlays", async () => {
  const labels = ["Bones", "Mesh Wireframe", "Weight Heatmap", "IK Capsules", "Solo Selected Layer", "Onion Skin", "Motion Arcs", "Weapon Trail", "Hitboxes", "Normal-Map Lighting"];
  await click(page.getByRole("button", { name: "Viewport overlays" })); // the menu stays open while toggling
  for (const label of labels) {
    for (let i = 0; i < 2; i++) {
      await click(page.getByRole("menuitemcheckbox", { name: label }));
      await page.waitForTimeout(100);
    }
  }
  await page.keyboard.press("Escape");
  await alive("overlays");
});

await step("inspector", async () => {
  for (const tab of ["Bones", "History", "Budget", "Layers"]) {
    await click(page.getByRole("tab", { name: tab, exact: true }));
    if (tab === "Budget") for (const t of ["Symbol", "Desktop", "Mobile"]) await click(page.getByRole("button", { name: t, exact: true }));
  }
});

await step("clips and timeline", async () => {
  await page.keyboard.press("t");
  const options = await page.locator('select[aria-label="Animation clip"] option').allTextContents();
  for (const clip of [...new Set([options[0], options[Math.floor(options.length / 2)], options.at(-1), "strike"])].filter(Boolean)) {
    await page.selectOption('select[aria-label="Animation clip"]', clip);
    await click(page.getByRole("tab", { name: "Curves" }));
    const key = page.locator('circle[data-kind="key"]').first();
    if (await key.count()) await key.click({ force: true });
    await click(page.getByRole("tab", { name: "Keys" }));
    await page.waitForTimeout(80);
  }
  for (const s of ["0.25×", "0.5×", "1×"]) await click(page.getByRole("button", { name: s, exact: true }));
  await click(page.getByRole("button", { name: "Copy Pose" }));
  await click(page.getByRole("button", { name: "Paste Pose" }));
  await click(page.getByRole("button", { name: "Key", exact: true }));
  await alive("timeline");
});

await step("shortcuts", async () => {
  await page.locator("body").click({ position: { x: 800, y: 300 } });
  // Every binding in src/core/keymap.ts, plus the Spine keys Kinetic explains instead of supporting.
  const keys = ["o", "Shift+A", "n", "m", "Shift+W", "b", "c", "v", "x", "Shift+L", "c", "ArrowLeft", "Shift+ArrowRight", "ArrowUp", "ArrowDown",
    "k", "l", "Control+l", "Control+Shift+L", "d", "d", "a", "a", "Space", "Space", "q", "e", "w", "s", "r", "Shift+R", "f", "Shift+F",
    "Control+r", "Control+r", "h", "h", "Equal", "Minus", "Shift+Equal", "Shift+Minus", "Control+z", "Control+Shift+z", "Control+y",
    "Control+c", "Control+v", "i", "i", "Control+k", "Control+k", "t", "g", "g", "Tab", "Tab", "[", "]", "F1", "F1", "z", "p", "F2", "?", "Escape"];
  for (const key of keys) {
    await page.keyboard.press(key);
    await page.waitForTimeout(60);
  }
  await alive("shortcuts");
});

await step("spine keys", async () => {
  const T = (fn, ...args) => page.evaluate(([f, a]) => window.__kineticTest[f](...a), [fn, args]);
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  await page.locator("body").click({ position: { x: 800, y: 300 } });
  for (const [key, tool] of [["c", "rotate"], ["v", "translate"], ["x", "scale"], ["b", "pose"]]) {
    await page.keyboard.press(key);
    const st = await T("state");
    expect(st.mode === "animate" && st.transformTool === tool, `${key} gave ${st.mode}/${st.transformTool}`);
  }
  await page.keyboard.press("n");
  expect((await T("state")).mode === "rig", "N did not open Bones & IK");

  // Time keys (Spine: Q start, R/F frames, ⇧ = 10, E last key, W/S keys)
  await page.keyboard.press("c");
  const { fps } = await T("state");
  const at = async () => (await T("state")).currentTime;
  await page.keyboard.press("q");
  expect((await at()) === 0, "Q did not jump to start");
  await page.keyboard.press("r");
  expect(Math.abs((await at()) - 1 / fps) < 1e-3, "R did not step one frame");
  await page.keyboard.press("Shift+R");
  expect(Math.abs((await at()) - 11 / fps) < 1e-3, "Shift+R did not step ten frames");
  await page.keyboard.press("f");
  expect(Math.abs((await at()) - 10 / fps) < 1e-3, "F did not step back");
  await page.keyboard.press("e");
  const last = await at();
  expect(last > 0, "E did not jump to the last key");
  await page.keyboard.press("q");
  await page.keyboard.press("w");
  const next = await at();
  expect(next > 0 && next <= last, "W did not go to the next key");
  await page.keyboard.press("s");
  expect((await at()) < next, "S did not go to the previous key");

  // Playback (Spine: D forward, A backward, again to stop)
  await page.keyboard.press("d");
  let st = await T("state");
  expect(st.isPlaying && st.playDirection === 1, "D did not play forward");
  await page.keyboard.press("d");
  expect(!(await T("state")).isPlaying, "D did not stop");
  await page.keyboard.press("a");
  st = await T("state");
  expect(st.isPlaying && st.playDirection === -1, "A did not play backward");
  await page.keyboard.press("a");
  expect(!(await T("state")).isPlaying, "A did not stop");

  // ⌘R loop toggle and the explanation for unsupported Spine keys
  const loop0 = (await T("state")).loop;
  await page.keyboard.press("Control+r");
  expect((await T("state")).loop === !loop0, "Ctrl+R did not toggle looping");
  await page.keyboard.press("Control+r");
  await page.keyboard.press("z");
  await page.getByRole("status").filter({ hasText: "Shear" }).waitFor({ timeout: 3000 });

  // A translate drag in the viewport keys a whole frame and is exactly one undo step.
  await page.keyboard.press("v");
  await page.keyboard.press("q");
  for (let i = 0; i < 5; i++) await page.keyboard.press("r");
  const before = (await T("state")).historyIndex;
  const p = await T("boneScreen", "chest");
  expect(p, "chest bone not found on screen");
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 40, p.y + 12, { steps: 15 });
  await page.mouse.up();
  const afterDrag = (await T("state")).historyIndex;
  expect(afterDrag === before + 1, `drag made ${afterDrag - before} undo steps`);
  const key = (await T("boneKeys", "chest")).find((k) => Math.abs(k.time - 5 / fps) < 1e-3);
  expect(key && Math.abs(key.x ?? 0) > 1, "drag did not key chest's translation on frame 5");
  await page.keyboard.press("Control+z");
  expect((await T("state")).historyIndex === before, "one undo did not revert the whole drag");

  // Right-click on the canvas returns to the previous tool, as in Spine.
  await page.mouse.click(p.x, p.y, { button: "right" });
  expect((await T("state")).transformTool === "rotate", "right-click did not return to the previous tool");
});

await step("copilot", async () => {
  await click(page.getByRole("button", { name: /Toggle AI copilot/ }));
  await click(page.getByRole("tab", { name: "Built-in" }));
  const commands = [
    "review this clip",
    "mesh the body dense with heat weights",
    "add physics to the cape, then make it snappier",
    "set ik to 40% then flip the elbow",
    "add a bone called tassel under head",
    "lock chest then unlock chest",
    "go to frame 10 then key all bones then breakdown 30% on arm",
    "copy pose then go to frame 20 then paste pose",
    "ease in on the arm",
    "make it 1.5 seconds long then 30 fps then loop it",
    "add a camera shake event at frame 12",
    "show onion skin and motion arcs then hide the bones",
    "add anticipation and overshoot",
    "fix everything",
    "check the budget",
    "play the idle animation then pause",
    "undo then redo",
  ];
  const box = page.getByRole("textbox", { name: "Ask Copilot" });
  for (const c of commands) {
    await box.fill(c);
    await box.press("Enter");
    await page.waitForTimeout(300);
  }
  const marks = await page.locator('aside[aria-label="Copilot"] li span[aria-label]').evaluateAll((els) =>
    els.map((e) => ({ ok: e.getAttribute("aria-label") === "Done", text: e.parentElement?.innerText ?? "" })),
  );
  report.copilot.ok = marks.filter((m) => m.ok).length;
  report.copilot.failed = marks.filter((m) => !m.ok).map((m) => m.text.replace(/\s+/g, " ").trim());
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/copilot.png` });
});

/**
 * Claude through the real UI, agent loop and /api/ai-agent relay, against the strict mock Messages API.
 * Needs the app started with KINETIC_ANTHROPIC_BASE_URL=http://127.0.0.1:4599 ANTHROPIC_API_KEY=mock;
 * the mock itself starts with this script when nothing is listening on that port.
 */
await step("claude", async () => {
  try {
    const { providers } = await (await page.request.get(`${URL}/api/ai-agent`)).json();
    if (!providers?.claude?.configured) {
      report.claude = `skipped: start the app with KINETIC_ANTHROPIC_BASE_URL=${mockUrl} ANTHROPIC_API_KEY=mock`;
      return;
    }
    await fetch(`${mockUrl}/__reset`, { method: "POST" });
    const box = page.getByRole("textbox", { name: "Ask Copilot" });
    if (!(await box.count())) await click(page.getByRole("button", { name: /Toggle AI copilot/ }));
    await click(page.getByRole("tab", { name: "Claude" }));
    const fresh = page.getByRole("button", { name: "New" });
    if (await fresh.count()) await click(fresh);
    const badge = await page.getByTestId("copilot-badge").innerText();
    if (!/server key/.test(badge)) throw new Error(`badge reads "${badge}"`);
    for (const prompt of Object.keys(SCRIPTS)) {
      await box.fill(prompt);
      await box.press("Enter");
      await page.locator('aside[aria-label="Copilot"]').getByRole("button", { name: "Run", exact: true }).waitFor({ timeout: 20000 });
      if (prompt === "mock: finish") await page.keyboard.press("Escape"); // the project list it opened
      if (prompt === "mock: symbol") {
        // Unsaved work: the switch asks first, and Cancel keeps the hero.
        await page.getByRole("alertdialog").waitFor({ timeout: 4000 });
        await click(page.getByRole("button", { name: "Cancel" }));
      }
    }
    const r = await (await fetch(`${mockUrl}/__report`)).json();
    const called = new Set(r.calls.map((c) => c.tool));
    const failed = r.results.filter((x) => !x.ok).map((x) => `${x.tool}: ${x.content}`);
    const replies = await page.getByTestId("copilot-reply").allInnerTexts();
    const problems = [
      ...r.errors.map((e) => `protocol: ${e}`),
      ...(r.systemOk ? [] : ["system prompt missing cache_control or studio state"]),
      ...(r.results.length === r.calls.length ? [] : [`${r.calls.length} calls but ${r.results.length} results`]),
      ...(failed.length === 1 && /tentacle/.test(failed[0]) ? [] : [`unexpected failures: ${failed.join(" | ")}`]),
      ...(r.memory.includes("mock: symbol") ? [] : ["conversation memory lost the previous prompt"]),
      ...(replies.some((t) => /Saved\. The rig fits/.test(t)) ? [] : ["final replies not shown"]),
    ];
    report.claude = { requests: r.requests, tools: called.size, calls: r.calls.length, problems };
    if (problems.length > 0) throw new Error(problems.join("; "));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/claude.png` });
  } finally {
    // Later steps drive the copilot offline; leave it on the built-in planner.
    await click(page.getByRole("tab", { name: "Built-in" })).catch(() => {});
  }
});

await step("coach", async () => {
  for (let i = 0; i < 10; i++) {
    const fix = page.locator('section[aria-label="Suggestions"] article button').first();
    if (!(await fix.count())) break;
    await fix.click();
    report.coachFixes++;
    await page.waitForTimeout(150);
  }
});

await step("help", async () => {
  await page.keyboard.press("?");
  for (const tab of await page.locator('[role="dialog"] button, .fixed button').allTextContents()) void tab;
  await page.keyboard.press("Escape");
});

await step("projects", async () => {
  const titleButton = () => page.getByRole("button", { name: /^Project:/ });
  const status = () => page.getByRole("button", { name: /^Save\./ }).getAttribute("aria-label");
  await page.locator("body").click({ position: { x: 800, y: 300 } });
  await pause();

  // ⌘S lands in projects/, not in the shipped presets.
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(1200);
  const { projects } = await (await page.request.get(`${URL}/api/projects`)).json();
  if (!projects?.some((p) => p.id === "astral-forge")) throw new Error("save did not appear in /api/projects");
  if (!/Saved/.test(await status())) throw new Error(`status after save: ${await status()}`);

  // An edit marks the document as edited; opening a template asks first.
  await page.keyboard.press("Control+Shift+L");
  await page.waitForTimeout(200);
  if (!/Edited/.test(await status())) throw new Error(`status after edit: ${await status()}`);
  await page.keyboard.press("Control+o");
  await click(page.getByRole("menuitem", { name: /Sands of Solara/ }));
  await click(page.getByRole("button", { name: /Don.t Save/ }));
  await page.waitForTimeout(800);
  if (!/Solara/i.test((await titleButton().getAttribute("aria-label")) ?? "")) throw new Error("template did not open");
  if (SHOTS) {
    await click(titleButton());
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/projects-menu.png` });
    await page.keyboard.press("Escape");
  }

  // Reopen the saved project from the menu; it opens clean.
  await click(titleButton());
  await click(page.getByRole("menuitem", { name: /Astral Forge \(Star-Smith\)/ }));
  await page.waitForTimeout(800);
  if (!/Astral/.test((await titleButton().getAttribute("aria-label")) ?? "")) throw new Error("saved project did not reopen");
  if (/Edited/.test(await status())) throw new Error("freshly opened project shows as edited");

  // Copilot path: an edit, then "open project sands" shows the prompt; Cancel keeps the work.
  await page.keyboard.press("Control+Shift+L");
  const box = page.getByRole("textbox", { name: "Ask Copilot" });
  if (!(await box.count())) await click(page.getByRole("button", { name: /Toggle AI copilot/ }));
  await click(page.getByRole("tab", { name: "Built-in" }));
  await box.fill("open project sands");
  await box.press("Enter");
  await page.getByRole("alertdialog").waitFor({ timeout: 4000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/unsaved-dialog.png` });
  await click(page.getByRole("button", { name: "Cancel" }));
  if (!/Astral/.test((await titleButton().getAttribute("aria-label")) ?? "")) throw new Error("Cancel still switched projects");

  // Template and symbol buttons elsewhere in the studio ask too (they used to replace the document silently).
  await page.locator("body").click({ position: { x: 800, y: 300 } });
  await page.keyboard.press("Control+Shift+L");
  await page.keyboard.press("o");
  await click(page.getByRole("button", { name: /^WILD · /i }).first());
  await page.getByRole("alertdialog").waitFor({ timeout: 4000 });
  await click(page.getByRole("button", { name: "Cancel" }));
  if (!/Astral/.test((await titleButton().getAttribute("aria-label")) ?? "")) throw new Error("Cancel on a symbol switch still replaced the document");
  await page.getByLabel("Open a template").selectOption("sands-of-solara");
  await page.getByRole("alertdialog").waitFor({ timeout: 4000 });
  await click(page.getByRole("button", { name: "Cancel" }));
  if (!/Astral/.test((await titleButton().getAttribute("aria-label")) ?? "")) throw new Error("Cancel on a template switch still replaced the document");

  // Malformed requests are rejected cleanly.
  const bad = await page.request.get(`${URL}/api/projects/..%2F..%2Fpackage`);
  if (bad.status() !== 400 && bad.status() !== 404) throw new Error(`path traversal returned ${bad.status()}`);
  const missing = await page.request.get(`${URL}/api/projects/does-not-exist`);
  if (missing.status() !== 404) throw new Error(`missing project returned ${missing.status()}`);
  const notJson = await page.request.post(`${URL}/api/projects`, { data: "nope", headers: { "content-type": "text/plain" } });
  if (notJson.status() !== 400) throw new Error(`non-JSON save returned ${notJson.status()}`);
});

/** Import a flat character: cut by the Python worker, opened, auto-rigged (needs vision/requirements.txt). */
await step("import", async () => {
  const T = (fn, ...args) => page.evaluate(([f, a]) => window.__kineticTest[f](...a), [fn, args]);
  const health = await page.request.get(`${URL}/api/cut-parts`);
  if (!health.ok()) throw new Error(`cut-parts health ${health.status()}`);
  await page.locator("body").click({ position: { x: 800, y: 300 } });
  await page.keyboard.press("o");
  const input = page.getByLabel("Import a PSD or PNG character");
  await input.setInputFiles(new globalThis.URL("../public/presets/astral-forge/hero.webp", import.meta.url).pathname);
  const dialog = page.getByRole("alertdialog");
  const status = page.locator('[role="status"]').filter({ hasText: /Cut \d+ layers|Python|failed|no layers/i });
  await Promise.race([dialog.waitFor({ timeout: 90000 }), status.waitFor({ timeout: 90000 })]);
  if (await dialog.isVisible()) await click(page.getByRole("button", { name: /Don.t Save/ }));
  await page.waitForTimeout(1500);
  const text = (await status.first().innerText().catch(() => "")) || "";
  if (/needs the Python package|Python 3 was not found/.test(text)) {
    report.import = `skipped: ${text}`;
    return;
  }
  const p = await T("project");
  report.import = p;
  if (!/^hero/.test(p.id) || p.bones < 5 || p.parts < 3 || p.clips < 10) throw new Error(`imported project looks wrong: ${JSON.stringify(p)} · ${text}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/import.png` });
});

await step("autosave", async () => {
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const p2 = await ctx2.newPage();
  p2.on("pageerror", (e) => report.errors.push(`autosave pageerror: ${e.message}`));
  await p2.clock.install();
  await p2.goto(URL, { waitUntil: "domcontentloaded" });
  await p2.waitForTimeout(800);
  await p2.evaluate(() => localStorage.removeItem("kinetic-pro:autosave"));
  await p2.locator("body").click({ position: { x: 700, y: 300 } });
  await p2.keyboard.press("Control+Shift+L"); // key every bone: a real change to autosave
  await p2.clock.fastForward("05:05");
  const saved = await p2.evaluate(() => localStorage.getItem("kinetic-pro:autosave"));
  if (!saved) throw new Error("no autosave after 5 minutes");
  await p2.reload({ waitUntil: "domcontentloaded" });
  await p2.waitForTimeout(800);
  await p2.getByRole("button", { name: "Restore" }).click({ timeout: 4000 });
  await p2.waitForTimeout(300);
  const restored = await p2.locator("aside[aria-label='Inspector']").count();
  if (!restored) throw new Error("studio not visible after restore");
  await ctx2.close();
});

await step("monkey", async () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 150; i++) {
    const buttons = page.locator("button:visible");
    const n = await buttons.count();
    if (n === 0) break;
    const b = buttons.nth(Math.floor(rand() * n));
    const label = ((await b.getAttribute("aria-label", { timeout: 400 }).catch(() => "")) ?? (await b.innerText({ timeout: 400 }).catch(() => ""))).toLowerCase();
    if (/download|record|discard|restore/.test(label)) continue; // file dialogs and data loss are tested elsewhere
    // Forced clicks skip actionability waits; covered buttons still receive the event, which is what a crash hunt wants.
    await b.click({ timeout: 400, force: true }).catch(() => {});
    report.monkeyClicks++;
    if (i % 25 === 0) await page.keyboard.press(["k", "g", "Space", "Escape", "i"][Math.floor(rand() * 5)]);
  }
  await page.keyboard.press("Escape");
  await alive("monkey");
});

await browser.close();
mock?.server.close();
console.log(JSON.stringify(report, null, 2));
process.exit(report.errors.length > 0 ? 1 : 0);
