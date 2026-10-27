// Globaler App-Zustand (zustand). Hier laufen Vibe-Events und Nutzeraktionen
// zusammen; die Komponenten lesen nur und rufen Aktionen auf.

import { create } from "zustand";
import {
  api,
  type BackendInfo,
  type CatalogModel,
  type AuthStatus,
  type ConfigOption,
  type ConnectInfo,
  type ContentBlock,
  type PermissionOption,
  type PermissionRequest,
  type PromptResult,
  type SessionSetup,
  type SessionSummary,
} from "./acp";
import { load, save } from "./persist";
import { cortecs } from "./cortecs";
import { refIsZdr, useProviders } from "./providers";
import { allowedPrefs } from "./policy";
import { promptWithReserve } from "./accounts";
import type { Suggestion } from "./acp";
import { budgetModel, perfEvent, perfFinish, perfStart, reportTurn, type TurnPerf } from "../components/usage/usage";
import { isDesignPath } from "./design";
import { isModelPath } from "./model3d";
import { isBenchPath } from "./bench";
import { forgetSub, isWorktreePath } from "./orchestra";

// ---------- Modell ----------

export interface DiffContent {
  path: string;
  oldText: string | null;
  newText: string;
}

export interface Attachment {
  /** document = PDF/Office, wird per Mistral OCR in Text umgewandelt */
  kind: "file" | "image" | "document";
  path: string;
  name: string;
}

export interface ToolItem {
  type: "tool";
  id: string;
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  diffs: DiffContent[];
  output: string[];
  rawInput?: unknown;
  rawOutput?: unknown;
  meta?: {
    agent?: string;
    task?: string;
    child_session_id?: string;
    turn_count?: number;
    response?: string;
    skill_name?: string;
    [k: string]: unknown;
  };
}

export interface Routed {
  model: string;
  level: "simple" | "standard" | "complex";
  reason: string;
  /** Wahrscheinlichkeiten je Stufe (Cortecs-Decision-Modelle). */
  probabilities?: Record<string, number>;
  /** Prompt ging an ein Modell mit Zero Data Retention. */
  zdr?: boolean;
}

export type Item =
  | { type: "user"; id: string; text: string; attachments?: Attachment[]; routed?: Routed; zdr?: boolean; author?: string }
  | { type: "assistant"; id: string; text: string }
  | { type: "thought"; id: string; text: string }
  | ToolItem
  | { type: "decision"; id: string; toolCallId: string; allowed: boolean; label: string }
  | { type: "notice"; id: string; text: string; tone: "info" | "warn" | "error" }
  | { type: "turn"; id: string; stopReason: string; ms: number; tokens?: number; ttftMs?: number; tps?: number }
  /** Vorschlags- oder Merge-Karte einer Master-Session (lib/orchestra.ts). */
  | { type: "orch"; id: string; kind: "proposal" | "merge"; ref: string }
  /** Council direkt aus der Oberfläche (z. B. Git-Panel), nicht über den Agenten. */
  | { type: "council"; id: string; tool: string; cwd: string; startedAt: number; runId?: string; error?: string };

export interface PendingPermission {
  key: string;
  toolCallId: string;
  options: PermissionOption[];
  rawInput?: unknown;
}

export interface PlanEntry {
  content: string;
  status: string;
  priority?: string;
}

export interface Usage {
  used?: number;
  size?: number;
  cost?: { amount: number; currency: string } | null;
  steps?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  tokensPerSecond?: number;
  lastTurnDuration?: number;
  lastTurnTotalTokens?: number;
}

export interface SlashCommand {
  name: string;
  description?: string;
  hint?: string;
}

export interface Session {
  id: string;
  cwd: string;
  /** Agent-Backend, dem die Session gehört (vibe, claude, …). */
  backend: string;
  title?: string;
  items: Item[];
  pending: PendingPermission[];
  plan: PlanEntry[];
  modes: { id: string; name: string; description?: string }[];
  currentMode?: string;
  config: ConfigOption[];
  running: boolean;
  turnStarted?: number;
  replaying: boolean;
  usage: Usage;
  commands: SlashCommand[];
  /** Nur lesbar, z. B. der Verlauf eines Subagenten. */
  readOnly?: boolean;
  /** Denkstufe steuert das Task-Modell (bis man sie von Hand wählt). */
  autoThinking: boolean;
  thinkingLog: ThinkingEvent[];
  /** Aufgabe des laufenden Turns – Kontext fürs Nachsteuern. */
  currentTask?: string;
  /** Session nur mit Modellen ohne Datenspeicherung (Cortecs ZDR). */
  zdr?: boolean;
  /** Fest gewähltes Modell (Kurator, Arbeiter): keine Auto-Modellwahl. */
  keepModel?: boolean;
  /** Geteilte Session eines anderen Rechners, der man beigetreten ist (lib/collab.ts). */
  guest?: { room: string; host: string; role: "viewer" | "collaborator" | "approver" | null; ended?: boolean };
}

export interface ThinkingEvent {
  at: number;
  from: string;
  to: string;
  reason: string;
  phase: "start" | "live";
  /** Wahrscheinlichkeiten je Stufe, wenn ein Cortecs-Decision-Modell entschied. */
  probabilities?: Record<string, number>;
}

export type Phase = "connecting" | "no-vibe" | "error" | "login" | "ready";
export type PanelTab = "changes" | "context" | "agents" | "tasks" | "search" | "git" | "files";
export type Theme = "system" | "light" | "dark";

export interface Prefs {
  theme: Theme;
  fontSize: number;
  notify: boolean;
  /** Sprache für die Spracheingabe (Voxtral erkennt sie meist auch selbst). */
  sttLanguage: string;
  /** Antworten nach jedem Turn automatisch vorlesen. */
  autoNarrate: boolean;
  embedModel: string;
  /** Vibe darf die semantische Suche als Werkzeug nutzen. */
  agentSearch: boolean;
  /** REA-Werkzeuge (Reverse Engineering) als MCP-Server mitgeben. */
  rea: boolean;
  /** Modell pro Prompt automatisch wählen. */
  autoModel: boolean;
  /** Welches Modell (Vibe-Alias) für welche Aufgabenstufe. */
  routing: { simple: string; standard: string; complex: string };
  /** Eigene Akzentfarbe (per Chat oder Einstellungen), null = Standard. */
  accent: string | null;
  /** Alt (bis 0.2): Mistral-Modell für Brises Helfer – nur noch für die Migration. */
  assistModel: string;
  /** Modell je Funktion von Brise als „anbieter/modell“; leer = automatisch (providers.rs). */
  taskModels: TaskModels;
  /** Auto: festes Modell + Denkstufe steuern ("reasoning") oder Modell je Stufe wechseln ("routing"). */
  autoStrategy: "reasoning" | "routing";
  /** Modell für Auto mit Denkstufen-Steuerung. */
  autoBaseModel: string;
  /** Codestral-Vervollständigung im Editor. */
  fim: boolean;
  /** Einführung schon gesehen. */
  tourDone: boolean;
  /** Model Council (liest auch der MCP-Server brise-council, siehe council.rs). */
  council: CouncilPrefs;
  /** Alt (bis 0.2): Entscheidungen über Mistral oder Cortecs – nur noch für die Migration. */
  decisionProvider: "mistral" | "cortecs";
  /** Prompts vor dem Senden auf sensible Daten prüfen. */
  sensitivityCheck: boolean;
  /** Projekte, die nur Modelle ohne Datenspeicherung nutzen. */
  zdrProjects: string[];
  /** Vibe-Alias des sicheren Modells für „Auf Cortecs (ZDR) wechseln“. */
  zdrModel: string;
  /** Backend für neue Sessions. */
  defaultBackend: string;
  /** Backends, mit denen Brise beim Start verbindet (Sessions in der Sidebar). */
  enabledBackends: string[];
  /** Master-Session (liest auch orchestra.rs über sync_prefs). */
  orchestra: OrchestraPrefs;
}

export interface TaskModels {
  /** Aufgabe einstufen (Auto) und Denkstufe nachsteuern. */
  decide: string;
  /** Vorschläge und Commit-Nachrichten. */
  helper: string;
  /** Zweite Prüfung auf sensible Daten nach lokalen Treffern. */
  sensitivity: string;
  /** Richtermodell für Benchmarks ohne eigenes Modell. */
  judge: string;
}

export interface OrchestraPrefs {
  enabled: boolean;
  /** Untersessions erst nach Klick auf „Neue Session“ starten. */
  confirmStart: boolean;
  /** Höchstzahl gleichzeitiger Untersessions. */
  maxParallel: number;
  /** Untersessions standardmäßig im eigenen Git-Worktree. */
  worktree: boolean;
  /** Kurator: Backend und Modell für „Neue Kurator-Session“. */
  curatorBackend: string;
  curatorModel: string;
  /** Arbeiter-Pool: Stufe 1 günstig … 3 stark (liest orchestra.rs). */
  workers: { backend: string; model: string; tier: number }[];
  /** Höchstens so viele Eskalationen je Teilaufgabe. */
  maxEscalation: number;
  /** Budget je Master-Lauf in Euro, 0 = ohne. */
  runBudgetEur: number;
}

export const ORCHESTRA_DEFAULTS: OrchestraPrefs = {
  enabled: true,
  confirmStart: true,
  maxParallel: 3,
  worktree: true,
  curatorBackend: "vibe",
  curatorModel: "mistral-large-4",
  workers: [
    { backend: "vibe", model: "glm-5-3", tier: 1 },
    { backend: "vibe", model: "mistral-medium-3.5", tier: 2 },
    { backend: "vibe", model: "mistral-large-4", tier: 3 },
  ],
  maxEscalation: 2,
  runBudgetEur: 2,
};

export interface CouncilPrefs {
  /** auto = Agent fragt von sich aus, request = nur auf Wunsch, off = kein Council */
  mode: "auto" | "request" | "off";
  review: string[];
  debug: string[];
  verify: string[];
  /** Führt die Urteile zusammen; leer = Brise gruppiert selbst. */
  chair: string;
  opinions: number;
  /** 0 = ohne Limit */
  dailyLimitEur: number;
  timeoutSecs: number;
  effort: "low" | "high";
}

export const COUNCIL_DEFAULTS: CouncilPrefs = {
  mode: "auto",
  review: ["mistral-large-4", "zai-glm-5-3", "codestral-latest"],
  debug: ["magistral-medium-latest", "mistral-large-4", "zai-glm-5-3"],
  verify: ["mistral-large-4", "zai-glm-5-3", "mistral-medium-3.5"],
  chair: "mistral-large-4",
  opinions: 3,
  dailyLimitEur: 2,
  timeoutSecs: 120,
  effort: "low",
};

export interface OpenFile {
  path: string;
  content: string;
  saved: string;
  /** Vergleich mit dem letzten Commit anzeigen. */
  diff?: string | null;
}

export interface InstallState {
  running: boolean;
  lines: string[];
  error?: string;
}

export interface Pane {
  tabs: string[];
  /** null = neue Session (Entwurf) */
  active: string | null;
}

interface DraftConfig {
  mode?: string;
  model?: string;
  thinking?: string;
}

type Template = { modes: Session["modes"]; config: ConfigOption[]; commands: SlashCommand[] };

interface State {
  phase: Phase;
  error?: string;
  /** Verbindung zu Vibe (Konto, Einstellungen, Sprache). */
  connectInfo?: ConnectInfo;
  /** Alle bekannten Backends mit Installationsstand. */
  backends: BackendInfo[];
  /** Verbundene Backends mit Init-Daten und Anmeldestatus. */
  agents: Record<string, ConnectInfo>;
  /** Backend für die nächste neue Session; null = Standard aus den Einstellungen. */
  draftBackend: string | null;
  /** Modi und Optionen je Backend (Vorlage für Auswahlfelder vor dem ersten Prompt). */
  templates: Record<string, Template>;
  auth: AuthStatus | null;
  login: { waiting: boolean; url?: string; error?: string };

  projects: string[];
  hiddenProjects: string[];
  index: SessionSummary[];
  sessions: Record<string, Session>;
  activeProject: string | null;
  activeSessionId: string | null;

  view: "chat" | "settings" | "design" | "3d";
  settingsSection: string;
  panel: PanelTab | null;
  sidebarOpen: boolean;
  paletteOpen: boolean;
  newProjectOpen: boolean;
  tourStep: number | null;
  /** Bereiche nebeneinander, jeder mit eigenen Tabs. */
  panes: Pane[];
  focusedPane: number;
  textPrompt: { title: string; placeholder: string; resolve: (v: string | null) => void } | null;
  prefs: Prefs;
  draft: DraftConfig;
  /** Modi und Optionen der zuletzt gesehenen Session – für Auswahlfelder vor dem ersten Prompt. */
  template?: Template;
  files: Record<string, string[]>;
  /** Im Hintergrund vorbereitete, noch leere Session je Projekt. */
  prepared: Record<string, string>;
  install: InstallState;
  recording: boolean;
  /** Live-Transkript der laufenden Spracheingabe. */
  transcript: string;
  narration: { itemId: string | null; state: "idle" | "prep" | "speaking" };
  indexing: Record<string, { done: number; total: number } | undefined>;
  /** Text, den der Composer übernehmen soll (z. B. @Datei aus der Suche). */
  composerInsert: { seq: number; text: string } | null;
  newModels: CatalogModel[];
  /** Eigene Schnellaktionen (per Chat angelegt). */
  quickActions: Suggestion[];
  terminalOpen: boolean;
  editor: { files: OpenFile[]; active: string | null };
  /** Cortecs-Schlüssel vorhanden und Aliase der Cortecs-Modelle (alle mit ZDR). */
  cortecs: { key: boolean; models: string[] };
}

interface Actions {
  /** Installationsstand aller Backends neu lesen. */
  refreshBackends(): Promise<void>;
  /** Mit einem Backend verbinden (startet den Agenten bei Bedarf). */
  connectBackend(id: string, restart?: boolean): Promise<ConnectInfo | undefined>;
  /** Backend für die nächste neue Session wählen. */
  setDraftBackend(id: string | null): void;
  prepare(project: string): Promise<void>;
  /** Vorbereitete Session verwerfen, z. B. weil jetzt ein Suchindex existiert. */
  resetPrepared(project: string): void;
  installVibe(): Promise<void>;
  saveKey(key: string): Promise<{ valid: boolean; message: string }>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<string>;
  cancelRecording(): Promise<void>;
  narrate(sessionId: string, itemId: string): Promise<void>;
  stopNarration(): Promise<void>;
  insertIntoComposer(text: string): void;
  focusPane(index: number): void;
  openTab(id: string, pane?: number): void;
  closeTab(pane: number, id: string): void;
  splitWith(id: string | null): void;
  applyCustomization(c: { settings: Record<string, any>; css: string }): void;
  openFile(path: string, diff?: boolean): Promise<void>;
  closeFile(path: string): void;
  saveFile(path: string): Promise<void>;
  onNotification(method: string, params: any): void;
  connect(reuse?: boolean): Promise<void>;
  doLogin(): Promise<void>;
  signOut(): Promise<void>;
  refreshIndex(): Promise<void>;
  openProject(path: string): void;
  removeProject(path: string): void;
  newDraft(project?: string): void;
  selectSession(id: string): Promise<void>;
  openChildSession(childId: string, cwd: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** Neue Session anlegen, ohne sie zu öffnen (Untersessions einer Master-Session). */
  createSession(cwd: string, backend: string, opts?: { parent?: string; model?: string; title?: string; thinking?: string }): Promise<string>;
  /** Vorhandene Session im Hintergrund laden, ohne sie zu öffnen. */
  attachSession(id: string, cwd: string, backend: string, title?: string): Promise<void>;
  /** `zdr`: diese Session ab jetzt nur mit Modellen ohne Datenspeicherung.
   *  `sessionId`/`author`: Prompt in einer bestimmten Session (Gast, Master-Session).
   *  `keepModel`: fest gewähltes Modell behalten (keine Auto-Modellwahl). */
  send(text: string, attachments: Attachment[], opts?: { zdr?: boolean; sessionId?: string; author?: string; keepModel?: boolean }): Promise<void>;
  refreshCortecs(): Promise<void>;
  cancel(): Promise<void>;
  answerPermission(key: string, optionId: string | null): Promise<void>;
  setOption(configId: string, value: string, sessionId?: string): Promise<void>;
  loadFiles(cwd: string): Promise<string[]>;
  setView(view: State["view"], section?: string): void;
  togglePanel(tab?: PanelTab): void;
  set(partial: Partial<State>): void;
  setPrefs(p: Partial<Prefs>): void;

  onUpdate(sessionId: string, update: any): void;
  onPermission(key: string, request: PermissionRequest): void;
  onPermissionClosed(key: string, optionId: string | null): void;
  onClosed(generation: number, backend?: string): void;
  onBackendAuth(backend: string, status: { kind?: string; label?: string; detail?: string }): void;
}

// ---------- Hilfen ----------

let counter = 0;
const uid = () => `i${++counter}`;

export const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function emptySession(id: string, cwd: string, backend = "vibe"): Session {
  return {
    id,
    cwd,
    backend,
    items: [],
    pending: [],
    plan: [],
    modes: [],
    config: [],
    running: false,
    replaying: false,
    usage: {},
    commands: [],
    autoThinking: true,
    thinkingLog: [],
  };
}

function applySetup(s: Session, r: SessionSetup): Session {
  const modeOption = r.configOptions?.find((o) => o.id === "mode");
  return {
    ...s,
    modes: r.modes?.availableModes ?? s.modes,
    currentMode: r.modes?.currentModeId ?? (modeOption?.currentValue as string) ?? s.currentMode,
    config: r.configOptions ?? s.config,
  };
}

function contentText(content: any): string {
  if (!content) return "";
  if (content.type === "text") return content.text ?? "";
  if (content.type === "resource_link") return "";
  return "";
}

function appendText(items: Item[], type: "assistant" | "thought" | "user", text: string): Item[] {
  if (!text) return items;
  const last = items[items.length - 1];
  if (last && last.type === type) return [...items.slice(0, -1), { ...last, text: last.text + text }];
  return [...items, { type, id: uid(), text }];
}

/** Wendet ein `session/update` von Vibe auf eine Session an. */
function applyUpdate(s: Session, u: any): Session {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return { ...s, items: appendText(s.items, "assistant", contentText(u.content)) };
    case "agent_thought_chunk":
      return { ...s, items: appendText(s.items, "thought", contentText(u.content)) };
    case "user_message_chunk":
      // Eigene Nachrichten zeigen wir sofort selbst – nur beim Laden übernehmen.
      return s.replaying ? { ...s, items: appendText(s.items, "user", contentText(u.content)) } : s;
    case "tool_call":
    case "tool_call_update": {
      const idx = s.items.findIndex((i) => i.type === "tool" && i.toolCallId === u.toolCallId);
      const base: ToolItem =
        idx >= 0
          ? (s.items[idx] as ToolItem)
          : { type: "tool", id: uid(), toolCallId: u.toolCallId, title: "Werkzeug", kind: "other", status: "pending", diffs: [], output: [] };
      let diffs = base.diffs;
      let output = base.output;
      if (Array.isArray(u.content)) {
        diffs = [];
        output = [];
        for (const c of u.content) {
          if (c.type === "diff") diffs.push({ path: c.path, oldText: c.oldText ?? null, newText: c.newText ?? "" });
          else if (c.type === "content" && c.content?.type === "text") output.push(c.content.text);
        }
      }
      const tool: ToolItem = {
        ...base,
        title: u.title ?? base.title,
        kind: u.kind ?? base.kind,
        status: u.status ?? base.status,
        rawInput: u.rawInput ?? base.rawInput,
        rawOutput: u.rawOutput ?? base.rawOutput,
        meta: u._meta ? { ...base.meta, ...u._meta } : base.meta,
        diffs,
        output,
      };
      const items = idx >= 0 ? s.items.map((i, n) => (n === idx ? tool : i)) : [...s.items, tool];
      return { ...s, items };
    }
    case "plan":
      return { ...s, plan: (u.entries ?? []).map((e: any) => ({ content: e.content, status: e.status, priority: e.priority })) };
    case "usage_update":
      return {
        ...s,
        usage: { ...s.usage, ...(u._meta ?? {}), used: u.used ?? s.usage.used, size: u.size ?? s.usage.size, cost: u.cost ?? s.usage.cost },
      };
    case "session_info_update":
      return u.title ? { ...s, title: u.title } : s;
    case "current_mode_update":
      return { ...s, currentMode: u.currentModeId };
    case "config_option_update":
      return u.configOptions ? { ...s, config: u.configOptions } : s;
    case "available_commands_update":
      return {
        ...s,
        commands: (u.availableCommands ?? []).map((c: any) => ({ name: c.name, description: c.description, hint: c.input?.hint })),
      };
    default:
      return s;
  }
}

const OPTION_LABEL: Record<string, string> = {
  allow_once: "Einmal erlaubt",
  allow_always: "Für diese Session erlaubt",
  allow_always_permanent: "Immer erlaubt",
  reject_once: "Abgelehnt",
};

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

function applyFontSize(size: number) {
  document.documentElement.style.setProperty("--app-font-size", `${size}px`);
}

function applyAccent(accent: string | null) {
  const root = document.documentElement.style;
  if (accent) {
    root.setProperty("--accent", accent);
    root.setProperty("--accent-soft", `color-mix(in srgb, ${accent} 14%, var(--bg))`);
  } else {
    root.removeProperty("--accent");
    root.removeProperty("--accent-soft");
  }
}

function applyCss(css: string) {
  let el = document.getElementById("brise-custom-css");
  if (!el) {
    el = document.createElement("style");
    el.id = "brise-custom-css";
    document.head.appendChild(el);
  }
  el.textContent = css;
}

// ---------- ZDR (Cortecs) ----------

/** Läuft diese Session nur mit Modellen ohne Datenspeicherung? */
export function isZdr(st: { prefs: Prefs }, s?: Session): boolean {
  return !!s && (!!s.zdr || st.prefs.zdrProjects.includes(s.cwd));
}

/** Modell für einen Helfer-Aufruf: `model` als „anbieter/modell“ (leer = Backend wählt), `provider` nur für Cortecs ohne Modell. */
export interface HelperModel {
  model: string;
  provider?: string;
}

/**
 * Wer entscheidet (Einstufung, Denkstufe)? In ZDR-Sessions nur Modelle ohne
 * Datenspeicherung (Cortecs, lokal, als ZDR markiert) – sonst ginge der Prompt
 * doch an einen Anbieter, der speichert. Ohne solches Modell: gar keins.
 */
function helperFor(st: { prefs: Prefs; cortecs: State["cortecs"] }, chosen: string, zdr: boolean): HelperModel | null {
  if (zdr) {
    if (chosen && refIsZdr(chosen)) return { model: chosen };
    return st.cortecs.key ? { model: "", provider: "cortecs" } : null;
  }
  if (!chosen && st.prefs.decisionProvider === "cortecs" && st.cortecs.key) return { model: "", provider: "cortecs" };
  return { model: chosen };
}

function deciderFor(st: { prefs: Prefs; cortecs: State["cortecs"] }, s?: Session): HelperModel | null {
  return helperFor(st, st.prefs.taskModels.decide, isZdr(st, s));
}

/** Modell für Brises Helfer (Vorschläge, Commit-Nachricht) in einem Projekt; null = nicht erlaubt. */
export function helperProvider(cwd: string): HelperModel | null {
  const st = useStore.getState();
  return helperFor(st, st.prefs.taskModels.helper, st.prefs.zdrProjects.includes(cwd));
}

// ---------- Store ----------

const initialPrefs: Prefs = {
  theme: "system",
  fontSize: 14,
  notify: true,
  sttLanguage: "de",
  autoNarrate: false,
  embedModel: "codestral-embed",
  agentSearch: true,
  rea: true,
  autoModel: true,
  routing: { simple: "zai-glm-5-3-flash", standard: "mistral-medium-3.5", complex: "mistral-large-4" },
  accent: null,
  assistModel: "mistral-small-latest",
  autoStrategy: "reasoning",
  autoBaseModel: "glm-5-3",
  fim: true,
  tourDone: false,
  council: COUNCIL_DEFAULTS,
  decisionProvider: "mistral",
  sensitivityCheck: true,
  zdrProjects: [],
  zdrModel: "cortecs-glm-5-3",
  defaultBackend: "vibe",
  enabledBackends: ["vibe"],
  orchestra: ORCHESTRA_DEFAULTS,
  taskModels: { decide: "", helper: "", sensitivity: "", judge: "" },
  ...load<Partial<Prefs>>("prefs", {}),
};
// Migration von 0.2: eigenes Task-Modell (Mistral) übernehmen; Cortecs als
// Entscheider bleibt über decisionProvider wirksam, bis man neu wählt.
if (!load<Partial<Prefs>>("prefs", {}).taskModels) {
  const legacy = initialPrefs.decisionProvider !== "cortecs" && initialPrefs.assistModel && initialPrefs.assistModel !== "mistral-small-latest" ? `mistral/${initialPrefs.assistModel}` : "";
  initialPrefs.taskModels = { decide: legacy, helper: legacy, sensitivity: "", judge: "" };
}
initialPrefs.council = { ...COUNCIL_DEFAULTS, ...initialPrefs.council };
initialPrefs.orchestra = { ...ORCHESTRA_DEFAULTS, ...initialPrefs.orchestra };

/** Grobe Einstufung ohne Netz, falls die KI-Einstufung nicht antwortet. */
function heuristicLevel(text: string): Routed["level"] {
  const t = text.toLowerCase();
  if (/(architektur|refactor|umbau|migr|sicherheit|security|performance|plan|design|warum.*fehler|debug|race|deadlock)/.test(t) || text.length > 1200) return "complex";
  if (text.length < 140 && /(\?|erkl|was ist|wie heißt|umbenenn|format|tippfehler|typo)/.test(t)) return "simple";
  return "standard";
}

export const THINKING_LABEL: Record<string, string> = { off: "Standard", low: "niedrig", medium: "mittel", high: "hoch", max: "maximal" };
const LEVEL_TO_THINKING: Record<Routed["level"], string> = { simple: "low", standard: "high", complex: "max" };
export const THINKING_ORDER = ["off", "low", "medium", "high", "max"];

/** Nächste verfügbare Denkstufe (nicht jedes Modell kann jede). */
export function nearestThinking(wanted: string, available: string[]): string | undefined {
  if (available.includes(wanted)) return wanted;
  const w = THINKING_ORDER.indexOf(wanted);
  return [...available].sort((a, b) => Math.abs(THINKING_ORDER.indexOf(a) - w) - Math.abs(THINKING_ORDER.indexOf(b) - w))[0];
}

/** Signale im laufenden Turn, die ein Nachsteuern rechtfertigen. */
const signals: Record<string, { failStreak: number; readStreak: number; lastAdjust: number; busy: boolean }> = {};

/** Nimmt das gewünschte Modell, sonst das nächstbeste verfügbare. */
function pickModel(level: Routed["level"], routing: Prefs["routing"], available: string[], needsVision: boolean): string | undefined {
  const order: Record<Routed["level"], (keyof Prefs["routing"])[]> = {
    simple: ["simple", "standard", "complex"],
    standard: ["standard", "complex", "simple"],
    complex: ["complex", "standard", "simple"],
  };
  const visionOk = (m: string) => !needsVision || !/glm-5-3(?!-flash)|codestral/.test(m);
  for (const k of order[level]) {
    const m = routing[k];
    if (available.includes(m) && visionOk(m)) return m;
  }
  return available.find(visionOk);
}
applyTheme(initialPrefs.theme);
applyFontSize(initialPrefs.fontSize);
applyAccent(initialPrefs.accent);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(useStore.getState().prefs.theme));

/** Generation je Backend – ein altes `acp:closed` beendet keine neue Verbindung. */
const generations: Record<string, number> = {};
let connecting = false;

/** Backend der nächsten neuen Session. */
export const draftBackendOf = (st: Pick<State, "draftBackend" | "prefs">) => st.draftBackend ?? st.prefs.defaultBackend;

export const useStore = create<State & Actions>((set, get) => {
  const patchSession = (id: string, fn: (s: Session) => Session) =>
    set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } } : {}));

  const pushItem = (id: string, item: Item) => patchSession(id, (s) => ({ ...s, items: [...s.items, item] }));

  /** Denkstufe während der Arbeit nachsteuern – nur bei klaren Signalen, höchstens alle 30 s. */
  const steerThinking = (sid: string, u: any) => {
    const st = get();
    const s = st.sessions[sid];
    const sig = signals[sid];
    if (!s || !sig || !st.prefs.autoModel || st.prefs.autoStrategy !== "reasoning" || !s.autoThinking) return;
    let trigger: string | null = null;
    if (u.sessionUpdate === "tool_call_update" && u.status) {
      const tool = s.items.find((i): i is ToolItem => i.type === "tool" && i.toolCallId === u.toolCallId);
      if (u.status === "failed") {
        sig.failStreak++;
        sig.readStreak = 0;
        if (sig.failStreak >= 2) trigger = `${sig.failStreak} Schritte in Folge fehlgeschlagen`;
      } else if (u.status === "completed") {
        sig.failStreak = 0;
        if (tool && (tool.kind === "read" || tool.kind === "search")) {
          sig.readStreak++;
          if (sig.readStreak >= 8) trigger = "lange reine Lese- und Suchphase";
        } else sig.readStreak = 0;
      }
    } else if (u.sessionUpdate === "plan" && (u.entries?.length ?? 0) >= 6) {
      trigger = `Aufgabenliste mit ${u.entries.length} Schritten`;
    }
    if (!trigger || sig.busy || Date.now() - sig.lastAdjust < 30_000) return;
    const opt = s.config.find((o) => o.id === "thinking");
    const current = String(opt?.currentValue ?? "");
    const levels = (opt?.options ?? []).map((o) => o.value);
    if (!levels.length) return;
    const decider = deciderFor(st, s);
    if (!decider) return;
    sig.busy = true;
    const progress = s.items
      .slice(-14)
      .map((i) => (i.type === "tool" ? `- ${i.title} (${i.status})` : i.type === "assistant" ? `- Agent: ${i.text.slice(0, 160)}` : ""))
      .filter(Boolean)
      .join("\n");
    api
      .adjustReasoning(s.currentTask ?? "", `${progress}\nSignal: ${trigger}`, current, decider.model, decider.provider)
      .then(async (r) => {
        const target = nearestThinking(r.level, levels);
        if (!target || target === current || !get().sessions[sid]?.running) return;
        await get().setOption("thinking", target, sid);
        patchSession(sid, (x) => ({
          ...x,
          thinkingLog: [...x.thinkingLog, { at: Date.now(), from: current, to: target, reason: `${trigger} · ${r.reason}`, phase: "live", probabilities: r.probabilities }],
        }));
      })
      .catch(() => {})
      .finally(() => {
        sig.busy = false;
        sig.lastAdjust = Date.now();
        sig.failStreak = 0;
        sig.readStreak = 0;
      });
  };

  const rememberTemplate = (s: Session) => {
    if (!s.modes.length && !s.config.length) return;
    const t: Template = { modes: s.modes, config: s.config, commands: s.commands };
    set((st) => ({ templates: { ...st.templates, [s.backend]: t }, ...(s.backend === draftBackendOf(st) ? { template: t } : {}) }));
  };

  const registerAgent = (info: ConnectInfo) => {
    generations[info.backend] = info.generation;
    set((st) => ({ agents: { ...st.agents, [info.backend]: info }, ...(info.backend === "vibe" ? { connectInfo: info, auth: info.auth } : {}) }));
  };

  return {
    phase: "connecting",
    backends: [],
    agents: {},
    draftBackend: null,
    templates: {},
    auth: null,
    login: { waiting: false },
    projects: load<string[]>("projects", []),
    hiddenProjects: load<string[]>("hiddenProjects", []),
    index: [],
    sessions: {},
    activeProject: load<string[]>("projects", [])[0] ?? null,
    activeSessionId: null,
    view: "chat",
    settingsSection: "general",
    panel: null,
    sidebarOpen: true,
    paletteOpen: false,
    newProjectOpen: false,
    tourStep: null,
    panes: [{ tabs: [], active: null }],
    focusedPane: 0,
    textPrompt: null,
    prefs: initialPrefs,
    draft: {},
    files: {},
    prepared: {},
    install: { running: false, lines: [] },
    recording: false,
    transcript: "",
    narration: { itemId: null, state: "idle" },
    indexing: {},
    composerInsert: null,
    newModels: [],
    quickActions: [],
    cortecs: { key: false, models: [] },
    terminalOpen: false,
    editor: { files: [], active: null },

    async openFile(path, diff) {
      const cwd = get().activeProject;
      if (!cwd) return;
      const open = get().editor.files.find((f) => f.path === path);
      if (open && !diff) {
        set((s) => ({ editor: { ...s.editor, active: path }, panel: "files", sidebarOpen: window.innerWidth >= 1400 && s.sidebarOpen }));
        return;
      }
      try {
        const content = await api.readFile(cwd, path);
        const head = diff ? await api.gitShowHead(cwd, path).catch(() => "") : null;
        set((s) => ({
          panel: "files",
          // Editor braucht Platz: in schmalen Fenstern die Seitenleiste einklappen.
          sidebarOpen: window.innerWidth >= 1400 && s.sidebarOpen,
          editor: {
            active: path,
            files: [...s.editor.files.filter((f) => f.path !== path), { path, content, saved: content, diff: head }],
          },
        }));
      } catch (e) {
        set({ error: String(e) });
      }
    },

    closeFile(path) {
      set((s) => {
        const files = s.editor.files.filter((f) => f.path !== path);
        return { editor: { files, active: s.editor.active === path ? (files[files.length - 1]?.path ?? null) : s.editor.active } };
      });
    },

    async saveFile(path) {
      const cwd = get().activeProject;
      const file = get().editor.files.find((f) => f.path === path);
      if (!cwd || !file) return;
      await api.writeFile(cwd, path, file.content);
      set((s) => ({ editor: { ...s.editor, files: s.editor.files.map((f) => (f.path === path ? { ...f, saved: f.content } : f)) } }));
    },

    resetPrepared(project) {
      set((s) => {
        const id = s.prepared[project];
        const prepared = { ...s.prepared };
        delete prepared[project];
        const sessions = { ...s.sessions };
        if (id && sessions[id] && sessions[id].items.length === 0) delete sessions[id];
        return { prepared, sessions };
      });
      if (!get().activeSessionId) get().prepare(project);
    },

    async installVibe() {
      set({ install: { running: true, lines: [] } });
      try {
        await api.installVibe();
        set((s) => ({ install: { ...s.install, running: false } }));
        await get().connect();
      } catch (e) {
        set((s) => ({ install: { ...s.install, running: false, error: String(e) } }));
      }
    },

    async saveKey(key) {
      const r = await api.saveApiKey(key);
      if (r.valid) await get().connect();
      return r;
    },

    async startRecording() {
      // Vibe braucht für Sprache eine offene Vibe-Session – auch wenn gerade
      // mit einem anderen Backend gearbeitet wird.
      const project = get().activeProject;
      const vibeOpen = Object.values(get().sessions).some((x) => x.backend === "vibe");
      if (!vibeOpen && project) {
        const r = await api.newSession(project, false, false, "vibe");
        set((s) => ({ sessions: { ...s.sessions, [r.sessionId]: applySetup(emptySession(r.sessionId, project, "vibe"), r) } }));
      }
      set({ transcript: "" });
      const r = await api.ext<{ ok: boolean; error?: string }>("voice/transcribeStart", { language: get().prefs.sttLanguage });
      if (!r.ok) throw new Error(r.error ?? "Spracheingabe konnte nicht starten");
      set({ recording: true });
      // Nur für die Pegelanzeige; schlägt das fehl, läuft eine Ersatz-Animation.
      api.meterStart().catch(() => {});
    },

    async stopRecording() {
      api.meterStop().catch(() => {});
      await api.ext("voice/transcribeStop");
      // Letzte Textstücke kommen kurz nach dem Stopp.
      await new Promise((r) => setTimeout(r, 400));
      const text = get().transcript;
      set({ recording: false, transcript: "" });
      return text;
    },

    async cancelRecording() {
      api.meterStop().catch(() => {});
      await api.ext("voice/transcribeCancel");
      set({ recording: false, transcript: "" });
    },

    async narrate(sessionId, itemId) {
      const s = get().sessions[sessionId];
      const idx = s?.items.findIndex((i) => i.id === itemId) ?? -1;
      const item = s?.items[idx];
      if (!s || !item || item.type !== "assistant") return;
      const user = [...s.items.slice(0, idx)].reverse().find((i) => i.type === "user");
      set({ narration: { itemId, state: "prep" } });
      const r = await api.ext<{ ok: boolean; error?: string }>("voice/narrate", {
        userMessage: user && user.type === "user" ? user.text : "",
        assistantText: item.text,
      });
      if (!r.ok) {
        set({ narration: { itemId: null, state: "idle" }, error: `Vorlesen fehlgeschlagen: ${r.error ?? "unbekannt"}` });
      }
    },

    async stopNarration() {
      await api.ext("voice/narrateCancel");
      set({ narration: { itemId: null, state: "idle" } });
    },

    focusPane(index) {
      const pane = get().panes[index];
      if (!pane || index === get().focusedPane) return;
      const session = pane.active ? get().sessions[pane.active] : undefined;
      set({ focusedPane: index, activeSessionId: pane.active, activeProject: session?.cwd ?? get().activeProject });
    },

    openTab(id, paneIndex) {
      const i = paneIndex ?? get().focusedPane;
      set((s) => ({
        panes: s.panes.map((p, n) => (n === i ? { tabs: p.tabs.includes(id) ? p.tabs : [...p.tabs, id], active: id } : p)),
        focusedPane: i,
      }));
      if (get().activeSessionId !== id) get().selectSession(id);
    },

    closeTab(paneIndex, id) {
      set((s) => {
        let panes = s.panes.map((p, n) => {
          if (n !== paneIndex) return p;
          const idx = p.tabs.indexOf(id);
          const tabs = p.tabs.filter((t) => t !== id);
          const active = p.active === id ? (tabs[Math.max(0, idx - 1)] ?? null) : p.active;
          return { tabs, active };
        });
        // Leere Zusatzbereiche schließen.
        if (panes.length > 1 && panes[paneIndex].tabs.length === 0) panes = panes.filter((_, n) => n !== paneIndex);
        const focusedPane = Math.min(s.focusedPane, panes.length - 1);
        const active = panes[focusedPane].active;
        return { panes, focusedPane, activeSessionId: active, activeProject: (active && s.sessions[active]?.cwd) || s.activeProject };
      });
    },

    splitWith(id) {
      if (get().panes.length >= 3) return;
      set((s) => ({ panes: [...s.panes, { tabs: id ? [id] : [], active: id }], focusedPane: s.panes.length, activeSessionId: id }));
      if (id) get().selectSession(id);
    },

    insertIntoComposer(text) {
      set((s) => ({ composerInsert: { seq: (s.composerInsert?.seq ?? 0) + 1, text } }));
    },

    onNotification(method, params) {
      const m = method.replace(/^_/, "");
      if (m === "voice/transcriptionDelta") {
        if (params?.error) set({ error: `Spracheingabe: ${params.error}`, recording: false });
        else if (params?.text) set((s) => ({ transcript: s.transcript + params.text }));
      } else if (m === "voice/narrationPrep") {
        set((s) => ({ narration: { ...s.narration, state: "prep" } }));
      } else if (m === "voice/narrationDone") {
        set({ narration: { itemId: null, state: "idle" } });
      } else if (m === "voice/narrationError") {
        set({ narration: { itemId: null, state: "idle" }, error: `Vorlesen: ${params?.error ?? "fehlgeschlagen"}` });
      }
    },

    async prepare(project) {
      const backend = draftBackendOf(get());
      const existing = get().prepared[project];
      if (get().phase !== "ready") return;
      if (existing && (existing === "…" || get().sessions[existing]?.backend === backend)) return;
      set((s) => {
        // Vorbereitete Session eines anderen Backends verwerfen, solange sie unbenutzt ist.
        const sessions = { ...s.sessions };
        if (existing && !sessions[existing]?.items.some((i) => i.type === "user")) delete sessions[existing];
        return { sessions, prepared: { ...s.prepared, [project]: "…" } };
      });
      try {
        const r = await api.newSession(project, get().prefs.agentSearch, get().prefs.rea, backend);
        const session = applySetup(emptySession(r.sessionId, project, backend), r);
        set((s) => ({ sessions: { ...s.sessions, [r.sessionId]: session }, prepared: { ...s.prepared, [project]: r.sessionId } }));
        rememberTemplate(session);
      } catch {
        set((s) => {
          const prepared = { ...s.prepared };
          delete prepared[project];
          return { prepared };
        });
      }
    },

    set: (partial) => set(partial),

    setPrefs: (p) => {
      // Vom Team-Admin gesperrte Bereiche bleiben unverändert – ohne Update,
      // sonst laufen Effekte, die einen Wert korrigieren wollen, im Kreis.
      const allowed = allowedPrefs(p);
      if (allowed !== p && Object.entries(allowed).every(([k, v]) => JSON.stringify(v) === JSON.stringify(get().prefs[k as keyof Prefs]))) return;
      const prefs = { ...get().prefs, ...allowed };
      save("prefs", prefs);
      applyTheme(prefs.theme);
      applyFontSize(prefs.fontSize);
      applyAccent(prefs.accent);
      set({ prefs });
      // Aktuellen Stand für Vibe lesbar machen (brise_get_settings).
      api.syncPrefs(prefs).catch(() => {});
    },

    applyCustomization(c) {
      applyCss(c.css ?? "");
      set({ quickActions: Array.isArray(c.settings?.quickActions) ? c.settings.quickActions : [] });
      const overrides = c.settings?.overrides;
      if (overrides && typeof overrides === "object" && Object.keys(overrides).length) {
        get().setPrefs(overrides as Partial<Prefs>);
      }
    },

    async refreshBackends() {
      const backends = await api.backends().catch(() => get().backends);
      set({ backends });
    },

    async connectBackend(id, restart = false) {
      // Beim Neustart endet der alte Prozess absichtlich – sein Ende ist kein Fehler.
      if (restart) generations[id] = -1;
      try {
        const info = await api.connect(!restart, id);
        registerAgent(info);
        // Vorbereitete leere Sessions gehörten zum alten Prozess.
        if (restart) {
          for (const [project, sid] of Object.entries(get().prepared)) {
            if (get().sessions[sid]?.backend === id) get().resetPrepared(project);
          }
        }
        return info;
      } catch (e) {
        set((st) => {
          const agents = { ...st.agents };
          delete agents[id];
          return { agents };
        });
        throw e;
      }
    },

    setDraftBackend(id) {
      // Optionen aus der Vorlage des alten Backends passen nicht zum neuen.
      set((st) => ({ draftBackend: id, draft: {}, template: st.templates[id ?? st.prefs.defaultBackend] }));
      const project = get().activeProject;
      if (project && !get().activeSessionId) get().prepare(project);
    },

    async connect(reuse = false) {
      if (connecting) return;
      connecting = true;
      set({ phase: "connecting", error: undefined });
      get().refreshBackends();
      const { defaultBackend, enabledBackends } = get().prefs;
      try {
        if (defaultBackend === "vibe" || enabledBackends.includes("vibe")) {
          try {
            const info = await get().connectBackend("vibe", !reuse);
            // Das Backend prüft vor dem Start von Vibe auf neue Modelle.
            if (info?.newModels?.length) set({ newModels: info.newModels });
            if (defaultBackend === "vibe") set({ phase: info?.auth?.authenticated ? "ready" : "login" });
          } catch (e) {
            if (defaultBackend === "vibe") {
              set(String(e) === "VIBE_NOT_FOUND" ? { phase: "no-vibe" } : { phase: "error", error: String(e) });
              return;
            }
          }
        }
        if (defaultBackend !== "vibe") {
          // Ohne Vibe ist die Oberfläche trotzdem bereit; Fehler stehen im Banner.
          try {
            const info = await get().connectBackend(defaultBackend, !reuse);
            if (info && !info.auth?.authenticated) set({ error: `${info.title} ist nicht angemeldet – Einstellungen → Agenten.` });
          } catch (e) {
            const title = get().backends.find((b) => b.id === defaultBackend)?.title ?? defaultBackend;
            set({ error: String(e) === "BACKEND_NOT_FOUND" ? `${title} ist nicht installiert – Einstellungen → Agenten.` : `${title}: ${e}` });
          }
          set({ phase: "ready" });
        }
        get().refreshCortecs();
        useProviders.getState().refresh();
        // Weitere aktivierte Backends im Hintergrund, damit ihre Sessions in der Sidebar stehen.
        const others = enabledBackends.filter((b) => b !== defaultBackend && b !== "vibe");
        Promise.allSettled(others.map((b) => get().connectBackend(b, false))).then(() => get().refreshIndex());
        if (get().phase === "ready") get().refreshIndex();
      } finally {
        connecting = false;
      }
    },

    async doLogin() {
      set({ login: { waiting: true } });
      try {
        const auth = await api.login();
        set((st) => ({
          auth,
          login: { waiting: false },
          phase: auth.authenticated ? "ready" : "login",
          agents: st.agents.vibe ? { ...st.agents, vibe: { ...st.agents.vibe, auth } } : st.agents,
        }));
        if (auth.authenticated) get().refreshIndex();
      } catch (e) {
        set({ login: { waiting: false, error: String(e) } });
      }
    },

    async signOut() {
      const auth = await api.signOut();
      set({ auth, phase: "login" });
    },

    async refreshIndex() {
      try {
        const r = await api.listSessions();
        // Sessions des Design- und 3D-Modus gehören zu keinem Projekt.
        const index = (r.sessions ?? []).filter((s) => !isDesignPath(s.cwd) && !isModelPath(s.cwd) && !isBenchPath(s.cwd)).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        const { projects, hiddenProjects } = get();
        const known = new Set(projects);
        // Worktrees von Untersessions sind keine eigenen Projekte.
        const discovered = [...new Set(index.map((s) => s.cwd))].filter((c) => !known.has(c) && !hiddenProjects.includes(c) && !isWorktreePath(c));
        set({ index, projects: [...projects, ...discovered] });
      } catch {
        /* Liste ist Komfort – Fehler nicht dramatisieren */
      }
    },

    openProject(path) {
      const projects = [path, ...get().projects.filter((p) => p !== path)];
      const hiddenProjects = get().hiddenProjects.filter((p) => p !== path);
      save("projects", projects);
      save("hiddenProjects", hiddenProjects);
      set({ projects, hiddenProjects, activeProject: path, activeSessionId: null, view: "chat" });
    },

    removeProject(path) {
      const projects = get().projects.filter((p) => p !== path);
      const hiddenProjects = [...get().hiddenProjects, path];
      save("projects", projects);
      save("hiddenProjects", hiddenProjects);
      set({
        projects,
        hiddenProjects,
        activeProject: get().activeProject === path ? (projects[0] ?? null) : get().activeProject,
      });
    },

    newDraft(project) {
      set({ activeProject: project ?? get().activeProject, activeSessionId: null, view: "chat" });
    },

    async selectSession(id) {
      const st = get();
      set({ view: "chat" });
      if (st.sessions[id]) {
        set({ activeSessionId: id, activeProject: st.sessions[id].cwd });
        return;
      }
      const summary = st.index.find((s) => s.sessionId === id);
      if (!summary) return;
      const backend = summary.backend ?? "vibe";
      set((s) => ({
        sessions: { ...s.sessions, [id]: { ...emptySession(id, summary.cwd, backend), title: summary.title ?? undefined, replaying: true } },
        activeSessionId: id,
        activeProject: summary.cwd,
      }));
      try {
        const r = await api.loadSession(summary.cwd, id, get().prefs.agentSearch, get().prefs.rea, backend);
        patchSession(id, (s) => ({ ...applySetup(s, r), replaying: false }));
        rememberTemplate(get().sessions[id]);
      } catch (e) {
        patchSession(id, (s) => ({ ...s, replaying: false }));
        pushItem(id, { type: "notice", id: uid(), text: `Session konnte nicht geladen werden: ${e}`, tone: "error" });
      }
    },

    async openChildSession(childId, cwd) {
      if (get().sessions[childId]) return set({ activeSessionId: childId, view: "chat" });
      const parent = get().activeSessionId ? get().sessions[get().activeSessionId!] : undefined;
      const backend = parent?.backend ?? "vibe";
      set((s) => ({
        sessions: { ...s.sessions, [childId]: { ...emptySession(childId, cwd, backend), title: "Subagent", replaying: true, readOnly: true } },
        activeSessionId: childId,
        view: "chat",
      }));
      try {
        await api.loadSession(cwd, childId, false, false, backend);
        patchSession(childId, (s) => ({ ...s, replaying: false }));
      } catch (e) {
        patchSession(childId, (s) => ({ ...s, replaying: false }));
        pushItem(childId, { type: "notice", id: uid(), text: `Verlauf des Subagenten nicht verfügbar: ${e}`, tone: "warn" });
      }
    },

    async deleteSession(id) {
      await api.deleteSession(id);
      forgetSub(id);
      set((s) => {
        const sessions = { ...s.sessions };
        delete sessions[id];
        return {
          sessions,
          index: s.index.filter((x) => x.sessionId !== id),
          activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
          panes: s.panes.map((p) => ({ tabs: p.tabs.filter((t) => t !== id), active: p.active === id ? null : p.active })),
        };
      });
    },

    async createSession(cwd, backend, opts) {
      const r = await api.newSession(cwd, get().prefs.agentSearch, get().prefs.rea, backend, opts?.parent);
      const session = { ...applySetup(emptySession(r.sessionId, cwd, backend), r), title: opts?.title, keepModel: !!opts?.model || undefined };
      set((s) => ({ sessions: { ...s.sessions, [r.sessionId]: session } }));
      rememberTemplate(session);
      if (opts?.model) {
        const available = session.config.find((o) => o.id === "model")?.options?.map((o) => o.value) ?? [];
        if (available.length && !available.includes(opts.model)) {
          pushItem(r.sessionId, { type: "notice", id: uid(), text: `Modell „${opts.model}“ gibt es bei diesem Backend nicht – es bleibt beim Standard.`, tone: "warn" });
        } else await get().setOption("model", opts.model, r.sessionId);
      }
      if (opts?.thinking) {
        const levels = get().sessions[r.sessionId]?.config.find((o) => o.id === "thinking")?.options?.map((o) => o.value) ?? [];
        const target = nearestThinking(opts.thinking, levels);
        if (target) {
          await get().setOption("thinking", target, r.sessionId).catch(() => {});
          patchSession(r.sessionId, (s) => ({ ...s, autoThinking: false }));
        }
      }
      return r.sessionId;
    },

    async attachSession(id, cwd, backend, title) {
      if (get().sessions[id]) return;
      set((s) => ({ sessions: { ...s.sessions, [id]: { ...emptySession(id, cwd, backend), title, replaying: true } } }));
      try {
        const r = await api.loadSession(cwd, id, get().prefs.agentSearch, get().prefs.rea, backend);
        patchSession(id, (s) => ({ ...applySetup(s, r), replaying: false }));
      } catch (e) {
        patchSession(id, (s) => ({ ...s, replaying: false }));
        throw e;
      }
    },

    async refreshCortecs() {
      try {
        const [status, models] = await Promise.all([cortecs.status(), api.configuredModels()]);
        set({ cortecs: { key: status.keyPresent, models: models.filter((m) => m.provider === "cortecs").map((m) => m.alias) } });
      } catch {
        /* ohne Cortecs läuft alles wie bisher */
      }
    },

    async send(text, attachments, opts) {
      const st = get();
      const target = opts?.sessionId ? st.sessions[opts.sessionId] : undefined;
      const project = target?.cwd ?? st.activeProject;
      if (!project) return;
      let id = target ? target.id : st.activeSessionId && st.sessions[st.activeSessionId] ? st.activeSessionId : null;

      // Vorbereitete Session übernehmen (wenn sie zum gewählten Backend gehört)
      // und gewählte Optionen anwenden.
      const backend = draftBackendOf(st);
      const preparedId = st.prepared[project];
      if (!id && preparedId && st.sessions[preparedId]?.backend === backend) {
        id = preparedId;
        set((s) => {
          const prepared = { ...s.prepared };
          delete prepared[project];
          return { prepared, activeSessionId: preparedId };
        });
        for (const [configId, value] of Object.entries(get().draft)) {
          const s = get().sessions[preparedId];
          const current = configId === "mode" ? s.currentMode : s.config.find((o) => o.id === configId)?.currentValue;
          if (value && value !== current) await get().setOption(configId, value);
        }
        set((s) => ({ draft: {}, draftBackend: null, template: s.templates[s.prefs.defaultBackend] ?? s.template }));
      }

      if (!id) {
        try {
          const r = await api.newSession(project, get().prefs.agentSearch, get().prefs.rea, backend);
          id = r.sessionId;
          const session = applySetup(emptySession(id, project, backend), r);
          set((s) => ({ sessions: { ...s.sessions, [id!]: session }, activeSessionId: id }));
          rememberTemplate(session);
          // Vor dem ersten Prompt gewählte Optionen übernehmen.
          const { draft } = get();
          for (const [configId, value] of Object.entries(draft)) {
            const current = configId === "mode" ? session.currentMode : session.config.find((o) => o.id === configId)?.currentValue;
            if (value && value !== current) await get().setOption(configId, value);
          }
          set((s) => ({ draft: {}, draftBackend: null, template: s.templates[s.prefs.defaultBackend] ?? s.template }));
        } catch (e) {
          set({ error: `Session konnte nicht gestartet werden: ${e}` });
          return;
        }
      }

      const sid = id;
      if (opts?.zdr) patchSession(sid, (s) => ({ ...s, zdr: true }));
      const zdr = isZdr(get(), get().sessions[sid]);
      if (zdr) {
        // Vor allem anderen: Modell ohne Datenspeicherung setzen.
        const modelOption = get().sessions[sid]?.config.find((o) => o.id === "model");
        const available = (modelOption?.options ?? []).map((o) => o.value);
        const safe = [get().prefs.zdrModel, ...get().cortecs.models].find((m) => available.includes(m));
        if (!safe) {
          pushItem(sid, { type: "notice", id: uid(), text: "Kein Cortecs-Modell mit Zero Data Retention eingerichtet – Prompt nicht gesendet. Cortecs-Key in den Einstellungen hinterlegen.", tone: "error" });
          return;
        }
        if (modelOption?.currentValue !== safe && !get().cortecs.models.includes(String(modelOption?.currentValue))) {
          await get().setOption("model", safe, sid);
        }
      }
      const blocks: ContentBlock[] = [{ type: "text", text }];
      for (const a of attachments) {
        if (a.kind === "document" && zdr) {
          // Mistral OCR speichert nicht garantiert nichts – Vibe liest die Datei selbst.
          const uri = /^[A-Za-z]:/.test(a.path) ? `file:///${a.path.replace(/\\/g, "/")}` : `file://${a.path}`;
          blocks.push({ type: "resource_link", uri: encodeURI(uri), name: a.name });
        } else if (a.kind === "document") {
          // PDF/Office per Mistral OCR als Text mitgeben.
          try {
            const text = await api.ocrDocument(a.path, get().sessions[sid]?.cwd);
            blocks.push({ type: "resource", resource: { uri: `file://${a.path.replace(/\\/g, "/")}`, mimeType: "text/markdown", text } });
          } catch (e) {
            pushItem(sid, { type: "notice", id: uid(), text: `OCR für ${a.name}: ${e}`, tone: "warn" });
          }
        } else if (a.kind === "file") {
          const abs = a.path.startsWith("/") || /^[A-Za-z]:/.test(a.path) ? a.path : `${project}/${a.path}`;
          // Windows: C:\a\b → file:///C:/a/b
          const uri = /^[A-Za-z]:/.test(abs) ? `file:///${abs.replace(/\\/g, "/")}` : `file://${abs}`;
          blocks.push({ type: "resource_link", uri: encodeURI(uri), name: a.name });
        } else {
          try {
            const [mimeType, data] = await api.readImage(a.path);
            blocks.push({ type: "image", mimeType, data });
          } catch (e) {
            pushItem(sid, { type: "notice", id: uid(), text: String(e), tone: "warn" });
          }
        }
      }

      const started = Date.now();
      const userItemId = uid();
      patchSession(sid, (s) => ({
        ...s,
        running: true,
        turnStarted: started,
        items: [...s.items, { type: "user", id: userItemId, text, attachments, zdr: zdr || undefined, author: opts?.author }],
      }));

      // Auto: Aufgabe einstufen. Standard: GLM-5.3 fest, Denkstufe passend setzen.
      const current = get().sessions[sid];
      const modelOption = current?.config.find((o) => o.id === "model");
      const thinkingOption = () => get().sessions[sid]?.config.find((o) => o.id === "thinking");
      const prefs = get().prefs;
      patchSession(sid, (s) => ({ ...s, currentTask: text }));
      signals[sid] = { failStreak: 0, readStreak: 0, lastAdjust: Date.now(), busy: false };
      const decider = deciderFor(get(), get().sessions[sid]);
      // Auto-Modellwahl nur bei Backends, deren Modelle und Denkstufen Brise kennt.
      const autoCapable = get().agents[current?.backend ?? "vibe"]?.caps.autoModel ?? current?.backend === "vibe";
      if (prefs.autoModel && autoCapable && !opts?.keepModel && !current?.keepModel && modelOption?.options?.length && !text.startsWith("/")) {
        const history = current.items
          .filter((i) => i.type === "user")
          .slice(-4, -1)
          .map((i) => (i.type === "user" ? i.text : ""))
          .join("\n");
        const fallback = { level: heuristicLevel(text), reason: "Schätzung ohne KI", probabilities: undefined };
        const verdict = decider ? await api.classifyTask(text, history, decider.model, decider.provider).catch(() => fallback) : fallback;
        const zdrModels = get().cortecs.models;
        const available = modelOption.options.map((o) => o.value).filter((m) => !zdr || zdrModels.includes(m));
        const needsVision = attachments.some((a) => a.kind === "image");
        const base = zdr ? prefs.zdrModel : prefs.autoBaseModel;
        const budget = await budgetModel(
          prefs.autoStrategy === "reasoning" && available.includes(base) && !(needsVision && /glm-5-3$/.test(base))
            ? base
            : pickModel(verdict.level, prefs.routing, available, needsVision),
          available,
          needsVision,
        );
        // ZDR-Projekte bleiben beim sicheren Modell, auch wenn das Budget knapp wird.
        const model = zdr ? (budget.model && available.includes(base) ? base : budget.model) : budget.model;
        if (budget.note && !zdr) verdict.reason = `${verdict.reason} · ${budget.note}`;
        if (model && model !== modelOption.currentValue) await get().setOption("model", model, sid).catch(() => {});
        let thinkingLabel: string | undefined;
        const sessionNow = get().sessions[sid];
        if (prefs.autoStrategy === "reasoning" && sessionNow?.autoThinking) {
          const opt = thinkingOption();
          const levels = (opt?.options ?? []).map((o) => o.value);
          const target = nearestThinking(LEVEL_TO_THINKING[verdict.level], levels);
          const from = String(opt?.currentValue ?? "");
          if (target && target !== from) {
            await get().setOption("thinking", target, sid).catch(() => {});
            patchSession(sid, (s) => ({
              ...s,
              thinkingLog: [...s.thinkingLog, { at: Date.now(), from, to: target, reason: verdict.reason, phase: "start", probabilities: verdict.probabilities }],
            }));
          }
          thinkingLabel = target ?? from;
        }
        const name = modelOption.options.find((o) => o.value === model)?.name ?? model ?? "";
        patchSession(sid, (s) => ({
          ...s,
          items: s.items.map((i) =>
            i.id === userItemId && i.type === "user"
              ? {
                  ...i,
                  routed: {
                    model: thinkingLabel ? `${name} · Denken ${THINKING_LABEL[thinkingLabel] ?? thinkingLabel}` : name,
                    level: verdict.level,
                    reason: verdict.reason,
                    probabilities: verdict.probabilities,
                    zdr,
                  },
                }
              : i,
          ),
        }));
      }

      let turnUsage: PromptResult["usage"];
      let timing: TurnPerf | undefined;
      const turnItemId = uid();
      perfStart(sid);
      try {
        const res = await promptWithReserve({ id: sid, cwd: get().sessions[sid]?.cwd ?? project }, blocks, {
          search: get().prefs.agentSearch,
          rea: get().prefs.rea,
          notice: (text, tone) => pushItem(sid, { type: "notice", id: uid(), text, tone }),
        });
        turnUsage = res.usage;
        timing = perfFinish(sid);
        pushItem(sid, {
          type: "turn",
          id: turnItemId,
          stopReason: res.stopReason,
          ms: Date.now() - started,
          tokens: res.usage?.totalTokens,
          ttftMs: timing?.ttftMs,
        });
        if (get().prefs.autoNarrate && res.stopReason === "end_turn") {
          const last = [...(get().sessions[sid]?.items ?? [])].reverse().find((i) => i.type === "assistant");
          if (last) get().narrate(sid, last.id).catch(() => {});
        }
        if (get().prefs.notify && document.hidden && "Notification" in window) {
          new Notification("Brise", { body: `${get().sessions[sid]?.title ?? "Session"} ist fertig.` });
        }
      } catch (e) {
        pushItem(sid, { type: "notice", id: uid(), text: String(e), tone: "error" });
      } finally {
        patchSession(sid, (s) => ({ ...s, running: false, turnStarted: undefined }));
        timing ??= perfFinish(sid);
        reportTurn(sid, turnUsage, timing).then((r) => {
          const tps = r?.outputTps;
          if (tps) patchSession(sid, (s) => ({ ...s, items: s.items.map((i) => (i.id === turnItemId && i.type === "turn" ? { ...i, tps } : i)) }));
        });
        get().refreshIndex();
      }
    },

    async cancel() {
      const id = get().activeSessionId;
      if (id) await api.cancel(id);
    },

    async answerPermission(key, optionId) {
      await api.respondPermission(key, optionId);
    },

    async setOption(configId, value, sessionId) {
      const id = sessionId ?? get().activeSessionId;
      const session = id ? get().sessions[id] : undefined;
      if (!session || session.readOnly) {
        set((s) => ({ draft: { ...s.draft, [configId]: value } }));
        return;
      }
      let fresh: ConfigOption[] | undefined;
      if (configId === "mode") await api.setMode(session.id, value);
      else fresh = ((await api.setConfigOption(session.id, configId, value)) as { configOptions?: ConfigOption[] } | null)?.configOptions;
      // Ein Modellwechsel ändert die verfügbaren Denkstufen; die Antwort enthält die neue Liste.
      patchSession(session.id, (s) => ({
        ...s,
        currentMode: configId === "mode" ? value : s.currentMode,
        config: fresh?.length ? fresh : s.config.map((o) => (o.id === configId ? { ...o, currentValue: value } : o)),
      }));
    },

    async loadFiles(cwd) {
      const cached = get().files[cwd];
      if (cached) return cached;
      const files = await api.listFiles(cwd).catch(() => [] as string[]);
      set((s) => ({ files: { ...s.files, [cwd]: files } }));
      return files;
    },

    setView(view, section) {
      set({ view, settingsSection: section ?? get().settingsSection });
    },

    togglePanel(tab) {
      const { panel } = get();
      set({ panel: tab === undefined ? (panel ? null : "changes") : panel === tab ? null : tab });
    },

    // ---------- Events aus dem Backend ----------

    onUpdate(sessionId, update) {
      patchSession(sessionId, (s) => applyUpdate(s, update));
      const s = get().sessions[sessionId];
      if (s && update.sessionUpdate === "available_commands_update") rememberTemplate(s);
      if (s?.running) {
        perfEvent(sessionId, update);
        steerThinking(sessionId, update);
      }
    },

    onPermission(key, request) {
      patchSession(request.sessionId, (s) => ({
        ...s,
        pending: [
          ...s.pending,
          { key, toolCallId: request.toolCall.toolCallId, options: request.options, rawInput: request.toolCall.rawInput },
        ],
      }));
    },

    onPermissionClosed(key, optionId) {
      set((st) => {
        const sessions = { ...st.sessions };
        for (const [id, s] of Object.entries(sessions)) {
          const p = s.pending.find((x) => x.key === key);
          if (!p) continue;
          const chosen = p.options.find((o) => o.optionId === optionId);
          const allowed = !!chosen && !chosen.kind.startsWith("reject");
          sessions[id] = {
            ...s,
            pending: s.pending.filter((x) => x.key !== key),
            items: [
              ...s.items,
              {
                type: "decision",
                id: uid(),
                toolCallId: p.toolCallId,
                allowed,
                label: chosen ? (OPTION_LABEL[chosen.optionId] ?? chosen.name) : "Abgebrochen",
              },
            ],
          };
        }
        return { sessions };
      });
    },

    onClosed(gen, backend = "vibe") {
      if (gen !== generations[backend]) return;
      const title = get().agents[backend]?.title ?? backend;
      set((st) => {
        const agents = { ...st.agents };
        delete agents[backend];
        return { agents };
      });
      if (backend === get().prefs.defaultBackend && backend === "vibe") set({ phase: "error", error: "Die Verbindung zu Vibe wurde beendet." });
      else set({ error: `Die Verbindung zu ${title} wurde beendet. Beim nächsten Prompt startet Brise den Agenten neu.` });
    },

    onBackendAuth(backend, status) {
      // Claude Code meldet seine Identität selbst (`_auth/status_update`).
      const agent = get().agents[backend];
      if (!agent || !status?.kind) return;
      const authenticated = status.kind !== "none";
      // „Nicht angemeldet“ der CLI ignorieren, wenn Brise Zugangsdaten aus Variablen bzw. settings.json kennt.
      if (!authenticated && agent.auth?.authenticated && agent.auth?.unverified) return;
      set((st) => ({ agents: { ...st.agents, [backend]: { ...agent, auth: { authenticated, label: status.label, detail: status.detail ?? null } } } }));
    },
  };
});

// Die aktive Session ist immer der aktive Tab des fokussierten Bereichs.
useStore.subscribe((st, prev) => {
  if (st.activeSessionId === prev.activeSessionId) return;
  const id = st.activeSessionId;
  const pane = st.panes[st.focusedPane];
  if (!pane || pane.active === id) return;
  useStore.setState({
    panes: st.panes.map((p, n) => (n === st.focusedPane ? { tabs: id && !p.tabs.includes(id) ? [...p.tabs, id] : p.tabs, active: id } : p)),
  });
});

export const useActiveSession = () =>
  useStore((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : undefined));

// Nur in der Entwicklung: Zustand über Hot-Reloads des Stores hinweg behalten.
if (import.meta.hot) {
  const previous = import.meta.hot.data.state as Partial<State> | undefined;
  if (previous) useStore.setState(previous);
  import.meta.hot.dispose((data) => {
    data.state = useStore.getState();
  });
}
