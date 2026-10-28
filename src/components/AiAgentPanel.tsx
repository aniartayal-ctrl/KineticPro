"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { reviewClip, type CueCard } from "@/core/coach";
import { EXAMPLE_PROMPTS, planCommand } from "@/core/copilot/planner";
import { samplePose } from "@/core/keyframes";
import { trimTranscript, type AiProviderId, type ModelStep, type Turn } from "@/core/copilot/providers";
import type { BonePose } from "@/core/solver";
import { runAgentTurn, StepError, toolResults } from "@/copilot/agent-loop";
import { copilotContext, executeCopilotActions, type ActionResult, type ExecutorHost } from "@/copilot/executor";
import { usePreferencesStore } from "@/store/usePreferencesStore";
import { useStudioStore } from "@/store/useStudioStore";

type PoseDiff = { bone: string; dx: number; dy: number; dr: number };

type Item = { kind: "text"; text: string } | { kind: "result"; result: ActionResult };
type Message = { id: string; role: "user" | "assistant"; text?: string; items?: Item[]; note?: string; error?: string };
type ProviderStatus = Partial<Record<AiProviderId, { configured: boolean; model: string; keyEnv: string }>>;

const PROVIDERS: { id: AiProviderId; name: string }[] = [
  // "cursor" is the id of the offline planner (kept for saved-session compatibility).
  { id: "cursor", name: "Built-in" },
  { id: "claude", name: "Claude" },
  { id: "chatgpt", name: "ChatGPT" },
  { id: "grok", name: "Grok" },
];
const MODEL_SUGGESTIONS: Partial<Record<AiProviderId, string[]>> = {
  claude: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
};
const KEY_ENV: Record<string, string> = { claude: "ANTHROPIC_API_KEY", chatgpt: "OPENAI_API_KEY", grok: "XAI_API_KEY" };

/** Turns kept in memory; each request sends at most the provider limit from providers.ts. */
const KEEP_TURNS = 80;
const SEVERITY_COLOR = { warn: "#ff9f0a", tip: "#64b0ff" } as const;

const prettyModel = (id?: string) => {
  const m = id?.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : (id ?? "");
};
let seq = 0;
const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

function ResultRow({ r }: { r: ActionResult }) {
  const msg = r.message && r.message !== r.action.summary ? r.message : "";
  const long = msg.length > 140 || msg.includes("\n");
  const first = msg.split("\n")[0]!;
  return (
    <li className="flex items-start gap-1.5 text-[12px] leading-snug">
      <span className={`mt-[1px] shrink-0 ${r.ok ? "text-[#30d158]" : "text-[#ff453a]"}`} aria-label={r.ok ? "Done" : "Failed"}>
        {r.ok ? "✓" : "✕"}
      </span>
      <span className="min-w-0">
        <span className="text-[var(--label)]">{r.action.summary}</span>
        {msg &&
          (long ? (
            <details className="text-[var(--label-2)]">
              <summary className="cursor-pointer select-none truncate">{first.length > 110 ? `${first.slice(0, 110)}…` : first}</summary>
              <span className="block whitespace-pre-line mt-0.5">{msg}</span>
            </details>
          ) : (
            <span className="block text-[var(--label-2)]">{msg}</span>
          ))}
      </span>
    </li>
  );
}

export function AiAgentPanel({
  onExport,
  onSave,
  onOpenBudget,
  onOpenProject,
  onOpenSymbol,
  onHidePane,
}: {
  onExport: () => Promise<void>;
  onSave: () => Promise<boolean>;
  onOpenBudget: () => void;
  onOpenProject: (name?: string) => Promise<string>;
  onOpenSymbol: ExecutorHost["openSymbol"];
  onHidePane?: () => void;
}) {
  const project = useStudioStore((s) => s.project);
  const activeClip = useStudioStore((s) => s.activeClip);
  const [provider, setProvider] = useState<AiProviderId>("cursor");
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  // One key per provider, so a Claude key is never sent to another provider after switching tabs.
  const [keys, setKeys] = useState<Partial<Record<AiProviderId, string>>>({});
  const apiKey = keys[provider] ?? "";
  const setApiKey = (value: string) => setKeys((k) => ({ ...k, [provider]: value }));
  const [model, setModel] = useState("");
  const [lastModel, setLastModel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [showAllCards, setShowAllCards] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sent, setSent] = useState<string[]>([]);
  const [recall, setRecall] = useState(-1);
  const [listening, setListening] = useState(false);
  const [poseDiff, setPoseDiff] = useState<PoseDiff[] | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<Turn[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const pickedRef = useRef(false);
  const speechRef = useRef<{ stop: () => void } | null>(null);

  const snapshotPose = (): Record<string, BonePose> | null => {
    const s = useStudioStore.getState();
    const clip = s.project.animations[s.activeClip];
    if (!clip) return null;
    return samplePose(
      clip,
      s.project.bones.map((b) => b.name),
      s.currentTime,
    );
  };

  const diffPoses = (before: Record<string, BonePose> | null, after: Record<string, BonePose> | null): PoseDiff[] => {
    if (!before || !after) return [];
    const out: PoseDiff[] = [];
    for (const name of Object.keys(after)) {
      const a = after[name]!;
      const b = before[name];
      if (!b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dr = a.r - b.r;
      if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4 || Math.abs(dr) > 0.05) {
        out.push({ bone: name, dx, dy, dr });
      }
    }
    return out.slice(0, 12);
  };

  const toggleVoice = () => {
    const SR = (window as unknown as { SpeechRecognition?: new () => SpeechRecognition; webkitSpeechRecognition?: new () => SpeechRecognition })
      .SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "assistant", note: "Voice input isn’t supported in this WebView. Type your prompt instead." },
      ]);
      return;
    }
    if (listening) {
      speechRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (ev: SpeechRecognitionEvent) => {
      const text = ev.results[0]?.[0]?.transcript?.trim();
      if (text) setInput((v) => (v ? `${v} ${text}` : text));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    speechRef.current = { stop: () => rec.stop() };
    setListening(true);
    rec.start();
  };

  const cards = useMemo(() => reviewClip(project, activeClip), [project, activeClip]);
  const fixable = cards.filter((c) => c.apply).length;
  const host: ExecutorHost = { exportBundle: onExport, save: onSave, openBudget: onOpenBudget, openProject: onOpenProject, openSymbol: onOpenSymbol };

  // Preferences default provider/model; server keys may still prefer Claude when unset.
  useEffect(() => {
    let alive = true;
    const prefs = usePreferencesStore.getState();
    if (PROVIDERS.some((p) => p.id === prefs.copilotProviderDefault)) {
      setProvider(prefs.copilotProviderDefault);
      pickedRef.current = true;
    }
    if (prefs.copilotModelDefault) setModel(prefs.copilotModelDefault);
    fetch("/api/ai-agent")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { providers?: ProviderStatus } | null) => {
        if (!alive || !d?.providers) return;
        setStatus(d.providers);
        if (!pickedRef.current && d.providers.claude?.configured) setProvider("claude");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const pickProvider = (id: AiProviderId) => {
    setProvider(id);
    setModel("");
    setLastModel("");
    pickedRef.current = true;
    usePreferencesStore.getState().setCopilotProviderDefault(id);
  };

  const record = (...turns: Turn[]) => {
    transcriptRef.current = trimTranscript([...transcriptRef.current, ...turns], KEEP_TURNS);
  };
  const update = (id: string, fn: (m: Message) => Message) => setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  const addItems = (id: string, items: Item[]) => update(id, (m) => ({ ...m, items: [...(m.items ?? []), ...items] }));

  const providerName = PROVIDERS.find((p) => p.id === provider)!.name;
  const st = provider === "cursor" ? undefined : status?.[provider];
  const noKey = provider !== "cursor" && !apiKey.trim() && st?.configured === false;

  /** Offline planner. Its turns join the transcript, so a cloud model can pick up the thread. */
  const runPlanner = async (text: string, replyId: string, note?: string) => {
    const { reply, actions } = planCommand(text, copilotContext());
    const results = await executeCopilotActions(actions, host);
    const calls = actions.slice(0, results.length).map((a, i) => ({ id: `local_${nextId().replace(/-/g, "_")}_${i}`, tool: a.tool, args: a.args }));
    record({ role: "user", text }, { role: "assistant", text: reply, calls }, ...(calls.length > 0 ? [{ role: "tool" as const, results: toolResults(calls, results) }] : []));
    addItems(replyId, [...results.map((r) => ({ kind: "result" as const, result: r })), ...(reply ? [{ kind: "text" as const, text: reply }] : [])]);
    if (note) update(replyId, (m) => ({ ...m, note }));
  };

  /** Cloud agent loop: the model calls tools, sees every result, and continues until it answers. */
  const runAgent = async (text: string, replyId: string, signal: AbortSignal) => {
    const run = await runAgentTurn({
      prompt: text,
      transcript: transcriptRef.current,
      host,
      signal,
      onStep: setStep,
      onText: (t) => addItems(replyId, [{ kind: "text", text: t }]),
      onResults: (results) => addItems(replyId, results.map((r) => ({ kind: "result", result: r }))),
      callStep: async (transcript, context, sig) => {
        const res = await fetch("/api/ai-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: sig,
          body: JSON.stringify({ provider, model: model.trim() || undefined, apiKey: apiKey.trim() || undefined, transcript, context }),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<ModelStep> & { model?: string; error?: string; code?: string };
        if (!res.ok) throw new StepError(data.error ?? `Request failed (${res.status})`, data.code);
        if (data.model) setLastModel(data.model);
        return { text: data.text ?? "", calls: Array.isArray(data.calls) ? data.calls : [], done: Boolean(data.done), usage: data.usage };
      },
    });
    transcriptRef.current = trimTranscript(run.transcript, KEEP_TURNS);
    if (run.outcome === "error" && run.code === "no_key" && run.applied === 0) {
      setStatus((s) => ({ ...s, [provider]: { ...(s?.[provider] ?? { model: "", keyEnv: KEY_ENV[provider] ?? "" }), configured: false } }));
      await runPlanner(text, replyId, `No ${providerName} key, so the built-in planner ran this. Add one under Key, or set ${KEY_ENV[provider]} in .env.local and restart.`);
      return;
    }
    if (run.outcome !== "error") usePreferencesStore.getState().recordCopilotSpend();
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const cost = run.usage ? `${k(run.usage.input)} tokens in (${k(run.usage.cached)} cached), ${k(run.usage.output)} out` : "";
    const note =
      [
        run.outcome === "limit" ? `Paused after ${run.steps} steps. Say “continue” to keep going.` : run.outcome === "stopped" ? "Stopped." : "",
        run.steps > 1 ? `${run.steps} steps` : "",
        cost,
      ]
        .filter(Boolean)
        .join(" · ") || undefined;
    update(replyId, (m) => ({
      ...m,
      ...(note ? { note } : {}),
      ...(run.outcome === "error" ? { error: `${run.error}${run.applied > 0 ? " Earlier steps were applied." : ""}` } : {}),
    }));
  };

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    const replyId = nextId();
    const before = snapshotPose();
    setMessages((prev) => [...prev, { id: nextId(), role: "user", text }, { id: replyId, role: "assistant", items: [] }]);
    setSent((s) => [...s.filter((x) => x !== text), text].slice(-30));
    setRecall(-1);
    setInput("");
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const spendBlocked = provider !== "cursor" && usePreferencesStore.getState().isCopilotSpendBlocked();
      if (provider === "cursor") await runPlanner(text, replyId);
      else if (spendBlocked) {
        const cap = usePreferencesStore.getState().copilotSpendCapUsd;
        await runPlanner(
          text,
          replyId,
          `Monthly spend cap ($${cap.toFixed(2)}) reached, so the built-in planner ran this. Raise or reset the cap in Preferences → Copilot.`,
        );
      } else if (noKey)
        await runPlanner(text, replyId, `No ${providerName} key, so the built-in planner ran this. Add one under Key, or set ${st?.keyEnv ?? KEY_ENV[provider]} in .env.local and restart.`);
      else await runAgent(text, replyId, ctrl.signal);
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      update(replyId, (m) => (aborted ? { ...m, note: "Stopped." } : { ...m, error: err instanceof Error ? err.message : "Something went wrong" }));
    } finally {
      const diffs = diffPoses(before, snapshotPose());
      if (diffs.length) setPoseDiff(diffs);
      setBusy(false);
      setStep(0);
      abortRef.current = null;
    }
  };

  /** Coach buttons run through the same executor; a note keeps the model's history accurate. */
  const runDirect = async (tool: string, args: Record<string, unknown>, summary: string) => {
    const before = snapshotPose();
    const results = await executeCopilotActions([{ tool, args, summary }], host);
    setMessages((prev) => [...prev, { id: nextId(), role: "assistant", items: results.map((r) => ({ kind: "result", result: r })) }]);
    record({ role: "user", text: `[Studio note] I clicked “${summary}” in the suggestions. Result: ${results[0]?.message ?? ""}` });
    const diffs = diffPoses(before, snapshotPose());
    if (diffs.length) setPoseDiff(diffs);
  };
  const applyCard = (card: CueCard) => runDirect("apply_suggestion", { id: card.id }, card.fixLabel ?? card.title);
  const fixAll = () => runDirect("fix_all", {}, "Apply all coach fixes");
  const fixThisFrame = () => {
    const s = useStudioStore.getState();
    const frame = Math.round(s.currentTime * (s.project.animations[s.activeClip]?.fps || 30));
    const first = cards.find((c) => c.apply);
    if (!first) {
      setMessages((prev) => [...prev, { id: nextId(), role: "assistant", note: `No fixable coach suggestions at frame ${frame}.` }]);
      return;
    }
    void runDirect("apply_suggestion", { id: first.id, frame }, `Fix this frame (${first.title})`);
  };

  const newChat = () => {
    abortRef.current?.abort();
    transcriptRef.current = [];
    setMessages([]);
  };

  const visibleCards = showAllCards ? cards : cards.slice(0, 2);
  const badge =
    provider === "cursor"
      ? "Offline"
      : noKey
        ? "No key"
        : `${prettyModel(model.trim() || lastModel || st?.model)}${apiKey.trim() ? " · your key" : st?.configured ? " · server key" : ""}`;

  return (
    <aside className="pointer-events-auto w-full liquid-glass-pill rounded-[var(--radius-panel)] flex flex-col overflow-hidden flex-1 min-h-0" aria-label="Copilot">
      {/* Header */}
      <div className="px-3 pt-3 pb-2 space-y-2.5 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold">Copilot</span>
          <span className={`text-[11px] truncate ${noKey ? "text-[#ff9f0a]" : "text-[var(--label-3)]"}`} data-testid="copilot-badge">
            {badge}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={fixThisFrame}
            disabled={busy || fixable === 0}
            className="icon-btn h-7 w-auto px-2 text-[12px] disabled:opacity-40"
            data-tip="Apply the first coach fix at the playhead"
            data-tip-side="bottom"
          >
            Fix frame
          </button>
          {messages.length > 0 && (
            <button onClick={newChat} className="icon-btn h-7 w-auto px-2 text-[12px]" data-tip="Clear the conversation" data-tip-side="bottom">
              New
            </button>
          )}
          <button
            onClick={() => setShowKey((v) => !v)}
            aria-pressed={showKey}
            className="icon-btn h-7 w-auto px-2 text-[12px]"
            data-tip="API key and model for cloud models"
            data-tip-side="bottom"
          >
            Key
          </button>
          {onHidePane && (
            <button onClick={onHidePane} className="icon-btn h-7 w-7 text-[15px]" aria-label="Close copilot">
              ×
            </button>
          )}
        </div>
        <div className="segmented" role="tablist" aria-label="Model">
          {PROVIDERS.map((p) => (
            <button key={p.id} role="tab" aria-pressed={p.id === provider} onClick={() => pickProvider(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
        {showKey && (
          <div className="space-y-1.5 animate-panel-in">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider === "cursor" ? "Built-in planner needs no key" : st?.configured ? `Server key in use (optional override)` : `${providerName} API key`}
              disabled={provider === "cursor"}
              autoComplete="off"
              aria-label={`${providerName} API key`}
              className="w-full h-7 rounded-[6px] bg-[var(--fill-3)] border border-[var(--separator)] px-2 text-[12px] placeholder:text-[var(--label-3)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50"
            />
            {provider !== "cursor" && (
              <>
                <input
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    usePreferencesStore.getState().setCopilotModelDefault(e.target.value);
                  }}
                  placeholder={`Model (default ${st?.model ?? "from server"})`}
                  list={`models-${provider}`}
                  aria-label="Model id"
                  className="w-full h-7 rounded-[6px] bg-[var(--fill-3)] border border-[var(--separator)] px-2 text-[12px] placeholder:text-[var(--label-3)] focus:outline-none focus:border-[var(--accent)]"
                />
                <datalist id={`models-${provider}`}>
                  {(MODEL_SUGGESTIONS[provider] ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </>
            )}
            <p className="text-[10.5px] text-[var(--label-3)] leading-snug">
              {provider === "cursor"
                ? "Runs in the browser. No key, no network."
                : `Kept in this tab only. Or set ${st?.keyEnv ?? KEY_ENV[provider]} in .env.local and restart the server.`}
            </p>
          </div>
        )}
      </div>

      {/* Coach cue cards */}
      {cards.length > 0 && (
        <section className="px-3 pb-2 shrink-0" aria-label="Suggestions">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="section-title">Suggestions for {activeClip}</span>
            <span className="text-[11px] text-[var(--label-3)] tabular-nums">{cards.length}</span>
            <div className="flex-1" />
            {fixable > 1 && (
              <button onClick={() => void fixAll()} disabled={busy} className="text-[12px] text-[var(--accent-hover)] hover:underline disabled:opacity-50">
                Fix all
              </button>
            )}
          </div>
          <div className="space-y-1.5 max-h-[38vh] overflow-y-auto">
            {visibleCards.map((card) => (
              <article key={card.id} className="rounded-[10px] bg-[var(--fill-3)] border border-[var(--separator)] p-2.5">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: SEVERITY_COLOR[card.severity] }}>
                      {card.principle}
                    </div>
                    <div className="text-[12.5px] font-medium leading-snug mt-0.5">{card.title}</div>
                    <p className="text-[11.5px] leading-snug text-[var(--label-2)] mt-0.5">{card.detail}</p>
                  </div>
                  {card.apply && (
                    <button onClick={() => void applyCard(card)} disabled={busy} className="shrink-0 btn-primary h-7 px-2.5 text-[11.5px]">
                      {card.fixLabel}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {cards.length > 2 && (
            <button onClick={() => setShowAllCards((v) => !v)} className="mt-1 text-[11.5px] text-[var(--label-2)] hover:text-[var(--label)]">
              {showAllCards ? "Show fewer" : `Show all ${cards.length}`}
            </button>
          )}
        </section>
      )}

      {/* Conversation */}
      <div ref={threadRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2.5 border-t border-[var(--separator)]" aria-live="polite">
        {messages.length === 0 && (
          <div className="space-y-2 pt-1">
            <p className="text-[12px] text-[var(--label-2)] leading-snug">
              Ask in plain words. I can mesh, weight, rig, add physics, key, ease, break down, retime, review and export.
              {provider === "cursor" ? " Chain steps with “then”." : " I see the result of every step and remember the conversation."}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_PROMPTS.map((p) => (
                <button key={p} onClick={() => void send(p)} className="liquid-glass-button rounded-full px-2.5 py-1 text-[11.5px] text-left">
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-[12px] rounded-br-[4px] bg-[var(--accent)] text-white px-2.5 py-1.5 text-[12.5px] leading-snug whitespace-pre-line">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={m.id} className="space-y-1" data-testid="copilot-reply">
              {(m.items ?? []).length > 0 && (
                <ul className="space-y-1">
                  {m.items!.map((it, i) =>
                    it.kind === "result" ? (
                      <ResultRow key={i} r={it.result} />
                    ) : (
                      <li key={i} className="text-[12.5px] leading-snug text-[var(--label)] whitespace-pre-line">
                        {it.text}
                      </li>
                    ),
                  )}
                </ul>
              )}
              {m.error && <p className="text-[12px] leading-snug text-[#ff453a]">{m.error}</p>}
              {m.note && <p className="text-[10.5px] text-[var(--label-3)]">{m.note}</p>}
            </div>
          ),
        )}
        {busy && (
          <p className="text-[12px] text-[var(--label-3)]" role="status">
            {provider === "cursor" || noKey ? "Working…" : `${providerName} is working${step > 1 ? ` · step ${step}` : ""}…`}
          </p>
        )}
      </div>

      {poseDiff && poseDiff.length > 0 && (
        <div className="mx-2.5 mb-2 rounded-[10px] border border-[var(--separator)] bg-[var(--fill-3)] p-2 text-[11px] animate-panel-in">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="font-semibold text-[var(--label)]">{poseDiff.length} bones changed · Review</span>
            <button type="button" className="text-[var(--label-3)] hover:text-[var(--label)]" onClick={() => setPoseDiff(null)}>
              Dismiss
            </button>
          </div>
          <ul className="max-h-24 overflow-y-auto space-y-0.5 tabular-nums text-[var(--label-2)]">
            {poseDiff.map((d) => (
              <li key={d.bone}>
                {d.bone}: Δx {d.dx.toFixed(3)} · Δy {d.dy.toFixed(3)} · Δr {d.dr.toFixed(1)}°
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Composer */}
      <form
        className="p-2.5 border-t border-[var(--separator)] flex gap-2 items-end shrink-0"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <button
          type="button"
          onClick={toggleVoice}
          className={`icon-btn h-8 w-8 shrink-0 ${listening ? "bg-[var(--accent)] text-white" : ""}`}
          aria-pressed={listening}
          data-tip={listening ? "Stop listening" : "Voice prompt"}
          aria-label="Voice prompt"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z" />
            <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" />
          </svg>
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            } else if (e.key === "ArrowUp" && !input.includes("\n") && sent.length > 0) {
              e.preventDefault();
              const i = recall < 0 ? sent.length - 1 : Math.max(0, recall - 1);
              setRecall(i);
              setInput(sent[i]!);
            } else if (e.key === "ArrowDown" && recall >= 0) {
              e.preventDefault();
              const i = recall + 1;
              setRecall(i >= sent.length ? -1 : i);
              setInput(i >= sent.length ? "" : sent[i]!);
            } else if (e.key === "Escape") {
              if (busy) abortRef.current?.abort();
              else (e.target as HTMLTextAreaElement).blur();
            }
          }}
          rows={1}
          placeholder="Ask Copilot… (↑ for history)"
          aria-label="Ask Copilot"
          className="flex-1 min-h-8 max-h-28 resize-none rounded-[8px] bg-[var(--fill-3)] border border-[var(--separator)] px-2.5 py-1.5 text-[12.5px] placeholder:text-[var(--label-3)] focus:outline-none focus:border-[var(--accent)]"
        />
        {busy ? (
          <button type="button" onClick={() => abortRef.current?.abort()} className="liquid-glass-button h-8 px-3 rounded-[8px] text-[12.5px]">
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()} className="btn-primary h-8 px-3 text-[12.5px]">
            Run
          </button>
        )}
      </form>
    </aside>
  );
}

// Minimal DOM speech types (not always in TS lib for this target).
type SpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionEvent = { results: ArrayLike<ArrayLike<{ transcript?: string }>> };
