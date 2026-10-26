// Globaler App-Zustand (zustand). Hier laufen Vibe-Events und Nutzeraktionen
// zusammen; die Komponenten lesen nur und rufen Aktionen auf.

import { create } from "zustand";
import {
  api,
  type AuthStatus,
  type ConfigOption,
  type ConnectInfo,
  type ContentBlock,
  type PermissionOption,
  type PermissionRequest,
  type SessionSetup,
  type SessionSummary,
} from "./acp";
import { load, save } from "./persist";

// ---------- Modell ----------

export interface DiffContent {
  path: string;
  oldText: string | null;
  newText: string;
}

export interface Attachment {
  kind: "file" | "image";
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

export type Item =
  | { type: "user"; id: string; text: string; attachments?: Attachment[] }
  | { type: "assistant"; id: string; text: string }
  | { type: "thought"; id: string; text: string }
  | ToolItem
  | { type: "decision"; id: string; toolCallId: string; allowed: boolean; label: string }
  | { type: "notice"; id: string; text: string; tone: "info" | "warn" | "error" }
  | { type: "turn"; id: string; stopReason: string; ms: number; tokens?: number };

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
}

export type Phase = "connecting" | "no-vibe" | "error" | "login" | "ready";
export type PanelTab = "changes" | "context" | "agents" | "tasks";
export type Theme = "system" | "light" | "dark";

export interface Prefs {
  theme: Theme;
  fontSize: number;
  notify: boolean;
}

interface DraftConfig {
  mode?: string;
  model?: string;
  thinking?: string;
}

interface State {
  phase: Phase;
  error?: string;
  connectInfo?: ConnectInfo;
  auth: AuthStatus | null;
  login: { waiting: boolean; url?: string; error?: string };

  projects: string[];
  hiddenProjects: string[];
  index: SessionSummary[];
  sessions: Record<string, Session>;
  activeProject: string | null;
  activeSessionId: string | null;

  view: "chat" | "settings";
  settingsSection: string;
  panel: PanelTab | null;
  sidebarOpen: boolean;
  paletteOpen: boolean;
  prefs: Prefs;
  draft: DraftConfig;
  /** Modi und Optionen der zuletzt gesehenen Session – für Auswahlfelder vor dem ersten Prompt. */
  template?: { modes: Session["modes"]; config: ConfigOption[]; commands: SlashCommand[] };
  files: Record<string, string[]>;
  /** Im Hintergrund vorbereitete, noch leere Session je Projekt. */
  prepared: Record<string, string>;
}

interface Actions {
  prepare(project: string): Promise<void>;
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
  send(text: string, attachments: Attachment[]): Promise<void>;
  cancel(): Promise<void>;
  answerPermission(key: string, optionId: string | null): Promise<void>;
  setOption(configId: string, value: string): Promise<void>;
  loadFiles(cwd: string): Promise<string[]>;
  setView(view: State["view"], section?: string): void;
  togglePanel(tab?: PanelTab): void;
  set(partial: Partial<State>): void;
  setPrefs(p: Partial<Prefs>): void;

  onUpdate(sessionId: string, update: any): void;
  onPermission(key: string, request: PermissionRequest): void;
  onPermissionClosed(key: string, optionId: string | null): void;
  onClosed(generation: number): void;
}

// ---------- Hilfen ----------

let counter = 0;
const uid = () => `i${++counter}`;

export const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function emptySession(id: string, cwd: string): Session {
  return {
    id,
    cwd,
    items: [],
    pending: [],
    plan: [],
    modes: [],
    config: [],
    running: false,
    replaying: false,
    usage: {},
    commands: [],
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

// ---------- Store ----------

const initialPrefs: Prefs = { theme: "system", fontSize: 14, notify: true, ...load<Partial<Prefs>>("prefs", {}) };
applyTheme(initialPrefs.theme);
applyFontSize(initialPrefs.fontSize);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(useStore.getState().prefs.theme));

let generation = 0;
let connecting = false;

export const useStore = create<State & Actions>((set, get) => {
  const patchSession = (id: string, fn: (s: Session) => Session) =>
    set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } } : {}));

  const pushItem = (id: string, item: Item) => patchSession(id, (s) => ({ ...s, items: [...s.items, item] }));

  const rememberTemplate = (s: Session) => {
    if (s.modes.length || s.config.length) set({ template: { modes: s.modes, config: s.config, commands: s.commands } });
  };

  return {
    phase: "connecting",
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
    prefs: initialPrefs,
    draft: {},
    files: {},
    prepared: {},

    async prepare(project) {
      if (get().prepared[project] || get().phase !== "ready") return;
      set((s) => ({ prepared: { ...s.prepared, [project]: "…" } }));
      try {
        const r = await api.newSession(project);
        const session = applySetup(emptySession(r.sessionId, project), r);
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
      const prefs = { ...get().prefs, ...p };
      save("prefs", prefs);
      applyTheme(prefs.theme);
      applyFontSize(prefs.fontSize);
      set({ prefs });
    },

    async connect(reuse = false) {
      if (connecting) return;
      connecting = true;
      set({ phase: "connecting", error: undefined });
      try {
        const info = await api.connect(reuse);
        generation = info.generation;
        set({ connectInfo: info, auth: info.auth, phase: info.auth?.authenticated ? "ready" : "login" });
        if (info.auth?.authenticated) get().refreshIndex();
      } catch (e) {
        set(String(e) === "VIBE_NOT_FOUND" ? { phase: "no-vibe" } : { phase: "error", error: String(e) });
      } finally {
        connecting = false;
      }
    },

    async doLogin() {
      set({ login: { waiting: true } });
      try {
        const auth = await api.login();
        set({ auth, login: { waiting: false }, phase: auth.authenticated ? "ready" : "login" });
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
        const index = (r.sessions ?? []).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        const { projects, hiddenProjects } = get();
        const known = new Set(projects);
        const discovered = [...new Set(index.map((s) => s.cwd))].filter((c) => !known.has(c) && !hiddenProjects.includes(c));
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
      set((s) => ({
        sessions: { ...s.sessions, [id]: { ...emptySession(id, summary.cwd), title: summary.title ?? undefined, replaying: true } },
        activeSessionId: id,
        activeProject: summary.cwd,
      }));
      try {
        const r = await api.loadSession(summary.cwd, id);
        patchSession(id, (s) => ({ ...applySetup(s, r), replaying: false }));
        rememberTemplate(get().sessions[id]);
      } catch (e) {
        patchSession(id, (s) => ({ ...s, replaying: false }));
        pushItem(id, { type: "notice", id: uid(), text: `Session konnte nicht geladen werden: ${e}`, tone: "error" });
      }
    },

    async openChildSession(childId, cwd) {
      if (get().sessions[childId]) return set({ activeSessionId: childId, view: "chat" });
      set((s) => ({
        sessions: { ...s.sessions, [childId]: { ...emptySession(childId, cwd), title: "Subagent", replaying: true, readOnly: true } },
        activeSessionId: childId,
        view: "chat",
      }));
      try {
        await api.loadSession(cwd, childId);
        patchSession(childId, (s) => ({ ...s, replaying: false }));
      } catch (e) {
        patchSession(childId, (s) => ({ ...s, replaying: false }));
        pushItem(childId, { type: "notice", id: uid(), text: `Verlauf des Subagenten nicht verfügbar: ${e}`, tone: "warn" });
      }
    },

    async deleteSession(id) {
      await api.deleteSession(id);
      set((s) => {
        const sessions = { ...s.sessions };
        delete sessions[id];
        return {
          sessions,
          index: s.index.filter((x) => x.sessionId !== id),
          activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
        };
      });
    },

    async send(text, attachments) {
      const st = get();
      const project = st.activeProject;
      if (!project) return;
      let id = st.activeSessionId && st.sessions[st.activeSessionId] ? st.activeSessionId : null;

      // Vorbereitete Session übernehmen und gewählte Optionen anwenden.
      const preparedId = st.prepared[project];
      if (!id && preparedId && st.sessions[preparedId]) {
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
        set({ draft: {} });
      }

      if (!id) {
        try {
          const r = await api.newSession(project);
          id = r.sessionId;
          const session = applySetup(emptySession(id, project), r);
          set((s) => ({ sessions: { ...s.sessions, [id!]: session }, activeSessionId: id }));
          rememberTemplate(session);
          // Vor dem ersten Prompt gewählte Optionen übernehmen.
          const { draft } = get();
          for (const [configId, value] of Object.entries(draft)) {
            const current = configId === "mode" ? session.currentMode : session.config.find((o) => o.id === configId)?.currentValue;
            if (value && value !== current) await get().setOption(configId, value);
          }
          set({ draft: {} });
        } catch (e) {
          set({ error: `Session konnte nicht gestartet werden: ${e}` });
          return;
        }
      }

      const sid = id;
      const blocks: ContentBlock[] = [{ type: "text", text }];
      for (const a of attachments) {
        if (a.kind === "file") {
          const abs = a.path.startsWith("/") || /^[A-Za-z]:/.test(a.path) ? a.path : `${project}/${a.path}`;
          blocks.push({ type: "resource_link", uri: `file://${abs}`, name: a.name });
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
      patchSession(sid, (s) => ({
        ...s,
        running: true,
        turnStarted: started,
        items: [...s.items, { type: "user", id: uid(), text, attachments }],
      }));
      try {
        const res = await api.prompt(sid, blocks);
        pushItem(sid, {
          type: "turn",
          id: uid(),
          stopReason: res.stopReason,
          ms: Date.now() - started,
          tokens: res.usage?.totalTokens,
        });
        if (get().prefs.notify && document.hidden && "Notification" in window) {
          new Notification("Brise", { body: `${get().sessions[sid]?.title ?? "Session"} ist fertig.` });
        }
      } catch (e) {
        pushItem(sid, { type: "notice", id: uid(), text: String(e), tone: "error" });
      } finally {
        patchSession(sid, (s) => ({ ...s, running: false, turnStarted: undefined }));
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

    async setOption(configId, value) {
      const id = get().activeSessionId;
      const session = id ? get().sessions[id] : undefined;
      if (!session || session.readOnly) {
        set((s) => ({ draft: { ...s.draft, [configId]: value } }));
        return;
      }
      if (configId === "mode") await api.setMode(session.id, value);
      else await api.setConfigOption(session.id, configId, value);
      patchSession(session.id, (s) => ({
        ...s,
        currentMode: configId === "mode" ? value : s.currentMode,
        config: s.config.map((o) => (o.id === configId ? { ...o, currentValue: value } : o)),
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

    onClosed(gen) {
      if (gen === generation) set({ phase: "error", error: "Die Verbindung zu Vibe wurde beendet." });
    },
  };
});

export const useActiveSession = () =>
  useStore((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : undefined));
