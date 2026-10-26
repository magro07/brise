// Nutzungsanzeige: Aufrufe von src-tauri/src/usage.rs, Erfassung der Vibe-Turns
// und Auswertung des Journals. Alle Beträge sind Schätzungen nach Preistabelle.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useStore, type Session, type ToolItem } from "../../lib/store";
import { subOf } from "../../lib/orchestra";

export interface UsageRecord {
  ts: number;
  kind: string;
  feature: string;
  model: string;
  input?: number;
  cached?: number;
  output?: number;
  pages?: number;
  minutes?: number;
  chars?: number;
  calls?: number;
  project?: string;
  session?: string;
  title?: string;
  /** Master-Session, die diese Untersession gestartet hat. */
  master?: string;
  subagents?: number;
  turns?: number;
  toolCalls?: number;
  estimated?: boolean;
  /** Fingerabdruck des Zugangs (`key-…`), nie der Schlüssel. */
  account?: string;
  /** vibe, brise (direkt an die API), später weitere. */
  backend?: string;
  /** Anbieter, falls nicht Mistral (z. B. `cortecs`). */
  provider?: string;
  /** Leistung: Gesamtdauer, Zeit bis zum ersten Token (nur gestreamt), Output-Tokens je Sekunde. */
  durationMs?: number;
  ttftMs?: number;
  outputTps?: number;
  cost: number;
  saving: number;
  priced: boolean;
  label: string;
}

export interface UsageSettings {
  budgetEur: number;
  warnAt: number[];
  avoidExpensive: boolean;
  avoidAt: number;
  consoleEur?: number | null;
  consoleAt?: number | null;
  warned: Record<string, number[]>;
}

export interface Price {
  id: string;
  label: string;
  match: string[];
  input: number;
  cached: number;
  output: number;
  perPage: number;
  perMinute: number;
  perMillionChars: number;
  perCall: number;
  currency?: string;
  hinweis?: string;
}

export interface PriceTable {
  stand: string;
  quelle: string;
  currency: string;
  usdToEur: number;
  models: Price[];
}

export const usageApi = {
  overview: (from: number, to: number) =>
    invoke<{ records: UsageRecord[]; settings: UsageSettings; pricesStand: string; journalDir: string }>("usage_overview", { from, to }),
  turn: (report: Record<string, unknown>) => invoke<{ costEur: number; outputTps?: number | null }>("usage_turn", { report }),
  baseline: (session: string, input: number, cached: number, output: number) => invoke<void>("usage_baseline", { session, input, cached, output }),
  record: (entry: Partial<UsageRecord>) => invoke<void>("usage_record", { entry: { ts: 0, input: 0, output: 0, ...entry } }),
  saveSettings: (settings: UsageSettings) => invoke<void>("usage_save_settings", { settings }),
  prices: () => invoke<{ table: PriceTable; custom: boolean; defaultStand: string }>("usage_prices"),
  savePrices: (table: PriceTable | null) => invoke<void>("usage_save_prices", { table }),
  import: (skip: string[]) => invoke<{ sessions: number; imported: number; synced: number; records: number }>("usage_import", { skip }),
  modelPrices: (models: string[]) => invoke<Record<string, { input: number; output: number; label: string }>>("usage_model_prices", { models }),
};

// ---------- Zeiträume ----------

export function monthStart(d = new Date()): number {
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function monthEnd(d = new Date()): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1;
}

export function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function eur(n: number, digits?: number): string {
  const d = digits ?? (n >= 100 ? 0 : n >= 1 ? 2 : n === 0 ? 0 : 3);
  return `${n.toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d })} €`;
}

// ---------- Monatsstand (für Kopfzeile, Warnungen, Auto) ----------

interface UsageState {
  records: UsageRecord[];
  settings: UsageSettings | null;
  pricesStand: string;
  journalDir: string;
  loadedAt: number;
  /** Verbrauch im laufenden Monat (Console-Stand plus Journal danach, sonst Journal). */
  spent: number;
  /** Nur aus dem Journal. */
  journalSpent: number;
  percent: number;
  warning: { level: number; spent: number; budget: number } | null;
}

export const useUsage = create<UsageState>(() => ({
  records: [],
  settings: null,
  pricesStand: "",
  journalDir: "",
  loadedAt: 0,
  spent: 0,
  journalSpent: 0,
  percent: 0,
  warning: null,
}));

/** Console-Stand gilt nur im selben Monat; danach kommt das Journal ab der Ablesung dazu. */
export function monthSpent(records: UsageRecord[], settings: UsageSettings | null): { spent: number; journal: number } {
  const journal = records.reduce((a, r) => a + r.cost, 0);
  const at = settings?.consoleAt;
  if (settings?.consoleEur != null && at && at >= monthStart()) {
    return { spent: settings.consoleEur + records.filter((r) => r.ts > at).reduce((a, r) => a + r.cost, 0), journal };
  }
  return { spent: journal, journal };
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export async function refreshUsage(): Promise<void> {
  try {
    const o = await usageApi.overview(monthStart(), monthEnd());
    const { spent, journal } = monthSpent(o.records, o.settings);
    const percent = o.settings.budgetEur > 0 ? (spent / o.settings.budgetEur) * 100 : 0;
    useUsage.setState({ records: o.records, settings: o.settings, pricesStand: o.pricesStand, journalDir: o.journalDir, loadedAt: Date.now(), spent, journalSpent: journal, percent });
    await checkWarnings(o.settings, spent, percent);
  } catch (e) {
    console.warn("Nutzung:", e);
  }
}

/** Mehrere Meldungen kurz hintereinander zusammenfassen. */
export function scheduleRefresh(ms = 800) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshUsage, ms);
}

export async function saveUsageSettings(patch: Partial<UsageSettings>) {
  const current = useUsage.getState().settings;
  if (!current) return;
  const settings = { ...current, ...patch };
  useUsage.setState({ settings });
  await usageApi.saveSettings(settings);
  await refreshUsage();
}

async function checkWarnings(settings: UsageSettings, spent: number, percent: number) {
  const key = monthKey();
  const done = settings.warned[key] ?? [];
  const due = [...settings.warnAt].sort((a, b) => b - a).find((l) => percent >= l && !done.includes(l));
  if (due == null) return;
  const reached = settings.warnAt.filter((l) => percent >= l);
  const next = { ...settings, warned: { [key]: [...new Set([...done, ...reached])] } };
  useUsage.setState({ settings: next, warning: { level: due, spent, budget: settings.budgetEur } });
  await usageApi.saveSettings(next).catch(() => {});
  if (document.hidden && "Notification" in window) {
    new Notification("Brise – Budget", { body: `${due} % des Monatsbudgets erreicht (${eur(spent)} von ${eur(settings.budgetEur)}, geschätzt).` });
  }
}

// ---------- Auto-Modellwahl ----------

/** Bei aktivem „Teure Modelle meiden“ und erreichter Schwelle: günstigeres Modell aus der Auswahl. */
export async function budgetModel(model: string | undefined, available: string[], needsVision: boolean): Promise<{ model: string | undefined; note?: string }> {
  const { settings, percent } = useUsage.getState();
  if (!model || !settings?.avoidExpensive || percent < settings.avoidAt) return { model };
  const prices = await usageApi.modelPrices(available).catch(() => ({}) as Record<string, { input: number; output: number }>);
  const blended = (m: string) => (prices[m] ? prices[m].input * 3 + prices[m].output : Infinity);
  const visionOk = (m: string) => !needsVision || !/glm-5-3(?!-flash)|codestral/.test(m);
  const cheaper = available.filter((m) => visionOk(m) && blended(m) < blended(model)).sort((a, b) => blended(a) - blended(b));
  // Das stärkste Modell, das höchstens ein Drittel kostet; sonst das günstigste.
  const pick = cheaper.filter((m) => blended(m) <= blended(model) / 3).pop() ?? cheaper[0];
  return pick ? { model: pick, note: `Budget ${Math.round(percent)} % – günstigeres Modell` } : { model };
}

// ---------- Erfassung ----------

function cumulative(s: Session) {
  return { input: s.usage.promptTokens ?? 0, cached: s.usage.cachedTokens ?? 0, output: s.usage.completionTokens ?? 0 };
}

function isWebSearch(t: ToolItem) {
  return /web_?search/i.test(String(t.meta?.effect_kind ?? t.meta?.tool_name ?? "")) || /^web_?search/i.test(t.title);
}

/** Werkzeuge des letzten Turns (seit der letzten Nutzernachricht). */
function lastTurnTools(s: Session): ToolItem[] {
  const start = s.items.map((i) => i.type).lastIndexOf("user");
  return s.items.slice(start + 1).filter((i): i is ToolItem => i.type === "tool");
}

// ---------- Leistung je Turn ----------

export interface TurnPerf {
  /** Senden bis zum ersten Text- oder Gedanken-Chunk. */
  ttftMs?: number;
  durationMs: number;
  /** Zeit, in der das Modell sichtbar erzeugte – ohne Werkzeuge und Vorlauf weiterer Aufrufe. */
  generationMs: number;
}

const perf: Record<string, { sent: number; first?: number; last: number; lastKind?: string; generation: number }> = {};

/** Abstand zwischen zwei Chunks, ab dem das Modell nicht mehr gestreamt, sondern gewartet hat. */
const CHUNK_GAP = 2000;
/** Längste Zeit, die das Erzeugen der Argumente eines Werkzeugaufrufs zählen darf. */
const TOOL_GAP = 30_000;

/** Ab dem Absenden des Prompts messen. */
export function perfStart(sid: string) {
  const now = Date.now();
  perf[sid] = { sent: now, last: now, generation: 0 };
}

/**
 * Verfolgt die `session/update`-Ereignisse eines laufenden Turns. Generierungszeit
 * sind Abstände zwischen Chunks (und bis zu einem direkt folgenden Werkzeugaufruf);
 * Werkzeuglaufzeit und der Vorlauf bis zum ersten Token jedes weiteren Modellaufrufs
 * zählen nicht.
 */
export function perfEvent(sid: string, u: { sessionUpdate?: string; content?: { type?: string; text?: string } }) {
  const p = perf[sid];
  if (!p) return;
  const now = Date.now();
  const gap = now - p.last;
  const kind = u.sessionUpdate;
  const afterChunk = p.lastKind === "chunk" || p.lastKind === "tool_call";
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    if (!u.content?.text) return;
    if (p.first == null) p.first = now;
    else if (afterChunk && gap < CHUNK_GAP) p.generation += gap;
    p.last = now;
    p.lastKind = "chunk";
  } else if (kind === "tool_call") {
    if (p.first == null) p.first = now;
    else if (afterChunk) p.generation += Math.min(gap, TOOL_GAP);
    p.last = now;
    p.lastKind = "tool_call";
  } else if (kind === "tool_call_update") {
    p.last = now;
    p.lastKind = "tool";
  }
}

/** Messung beenden; `undefined`, wenn der Turn nicht gemessen wurde. */
export function perfFinish(sid: string): TurnPerf | undefined {
  const p = perf[sid];
  if (!p) return undefined;
  delete perf[sid];
  return { ttftMs: p.first != null ? p.first - p.sent : undefined, durationMs: Date.now() - p.sent, generationMs: p.generation };
}

/**
 * Meldet einen fertigen Turn. Vibe zählt je Session kumuliert; `res` ist
 * `PromptResponse.usage`, der Stand aus `usage_update` kommt manchmal erst danach.
 * Liefert die Output-Tokens je Sekunde, sobald die Tokens des Turns feststehen.
 */
export async function reportTurn(sid: string, res?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number } | null, timing?: TurnPerf) {
  await new Promise((r) => setTimeout(r, 600));
  const s = useStore.getState().sessions[sid];
  if (!s || s.readOnly) return;
  const c = cumulative(s);
  const tools = lastTurnTools(s);
  const model = s.config.find((o) => o.id === "model")?.currentValue;
  const subagents = tools.filter((t) => t.meta?.agent || t.meta?.task || t.meta?.child_session_id).length;
  const result = await usageApi
    .turn({
      session: sid,
      project: s.cwd,
      title: s.title ?? null,
      master: subOf(sid)?.master ?? null,
      model: String(model ?? "unbekannt"),
      input: Math.max(c.input, res?.inputTokens ?? 0),
      cached: Math.max(c.cached, res?.cachedReadTokens ?? 0),
      output: Math.max(c.output, res?.outputTokens ?? 0),
      subagents,
      toolCalls: tools.length,
      webSearches: tools.filter(isWebSearch).length,
      backend: s.backend,
      ttftMs: timing?.ttftMs,
      durationMs: timing?.durationMs,
      // Subagents erzeugen Tokens, deren Chunks hier nicht ankommen – t/s wäre zu hoch.
      generationMs: timing && timing.generationMs > 0 && !subagents ? timing.generationMs : undefined,
    })
    .catch((e) => (console.warn("Nutzung:", e), null));
  scheduleRefresh(0);
  return result;
}

const TTS_MODEL = "voxtral-mini-tts-latest";
const STT_MODEL = "voxtral-mini-transcribe-realtime";

/**
 * Beobachtet den Store: Turn-Beginn (Ausgangsstand merken), Spracheingabe
 * (Dauer) und Vorlesen (Zeichen, geschätzt). Einmal beim Start aufrufen.
 */
export function startUsageTracking() {
  let recordingSince: number | null = null;
  let narrating: { itemId: string; text: string; sid?: string } | null = null;
  const running = new Set<string>();

  useStore.subscribe((st, prev) => {
    for (const [id, s] of Object.entries(st.sessions)) {
      if (s.running && !running.has(id)) {
        running.add(id);
        const c = cumulative(s);
        usageApi.baseline(id, c.input, c.cached, c.output).catch(() => {});
      } else if (!s.running && running.has(id)) {
        running.delete(id);
      }
    }

    if (st.recording && !prev.recording) recordingSince = Date.now();
    if (!st.recording && prev.recording && recordingSince) {
      const minutes = (Date.now() - recordingSince) / 60000;
      recordingSince = null;
      const s = st.activeSessionId ? st.sessions[st.activeSessionId] : undefined;
      usageApi.record({ kind: "stt", backend: "vibe", feature: "Spracheingabe", model: STT_MODEL, minutes, project: s?.cwd, session: s?.id, estimated: true }).then(() => scheduleRefresh());
    }

    if (st.narration.itemId && st.narration.itemId !== prev.narration.itemId) {
      const sid = Object.keys(st.sessions).find((k) => st.sessions[k].items.some((i) => i.id === st.narration.itemId));
      const item = sid ? st.sessions[sid].items.find((i) => i.id === st.narration.itemId) : undefined;
      narrating = { itemId: st.narration.itemId, text: item && item.type === "assistant" ? item.text : "", sid };
    }
    if (!st.narration.itemId && prev.narration.itemId && narrating) {
      // Vibe fasst die Antwort vor dem Vorlesen zusammen; Länge daher grob geschätzt.
      const chars = Math.min(narrating.text.length, 900);
      const s = narrating.sid ? st.sessions[narrating.sid] : undefined;
      usageApi.record({ kind: "tts", backend: "vibe", feature: "Vorlesen", model: TTS_MODEL, chars, project: s?.cwd, session: s?.id, estimated: true }).then(() => scheduleRefresh());
      narrating = null;
    }
  });

  syncVibeHistory();
  // Brises Helfer (Einstufung, Index …) schreiben direkt ins Journal.
  setInterval(refreshUsage, 60_000);
  setInterval(syncVibeHistory, 15 * 60_000);
}

/**
 * Verlauf aus Vibes Session-Logs übernehmen (einmal je Session) und Verbrauch
 * außerhalb von Brise (Vibe-CLI, IDE) nachbuchen. Laufende Turns auslassen.
 */
export async function syncVibeHistory() {
  const running = Object.values(useStore.getState().sessions)
    .filter((s) => s.running)
    .map((s) => s.id);
  await usageApi.import(running).catch((e) => console.warn("Nutzung (Import):", e));
  await refreshUsage();
}

/** Funktion für die Aufschlüsselung, gröber als `feature`. */
export function category(r: UsageRecord): string {
  if (r.kind === "chat") return r.subagents || /Subagent/.test(r.feature) ? "Chat mit Subagents" : "Chat";
  if (r.kind === "assist") return "Task-Modell";
  if (r.kind === "embed") return "Semantische Suche";
  if (r.kind === "search") return "Websuche";
  if (r.kind === "ocr") return "OCR";
  if (r.kind === "fim") return "Codestral";
  if (r.kind === "stt" || r.kind === "tts") return "Sprache";
  return r.feature;
}
