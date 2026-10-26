// Zustand aller Sessions. `session/update`-Nachrichten von Vibe werden hier
// zu Chat-Einträgen zusammengesetzt.

import type { Mode, PermissionOption, PermissionRequest } from "./acp";

export interface DiffContent {
  path: string;
  oldText: string | null;
  newText: string;
}

export type Item =
  | { type: "user"; id: string; text: string }
  | { type: "assistant"; id: string; text: string }
  | { type: "thought"; id: string; text: string }
  | {
      type: "tool";
      id: string;
      toolCallId: string;
      title: string;
      kind: string;
      status: string;
      diffs: DiffContent[];
      output: string[];
      rawInput?: unknown;
    }
  | {
      type: "permission";
      id: string;
      key: string;
      toolCallId: string;
      options: PermissionOption[];
      rawInput?: unknown;
      answer?: string | null;
      open: boolean;
    }
  | { type: "plan"; id: string; entries: { content: string; status: string }[] }
  | { type: "notice"; id: string; text: string; tone: "info" | "warn" | "error" };

export interface Usage {
  lastTurnTotalTokens?: number;
  totalTokens?: number;
  steps?: number;
  tokensPerSecond?: number;
}

export interface Session {
  id: string;
  cwd: string;
  title?: string;
  items: Item[];
  modes: Mode[];
  currentMode?: string;
  model?: string;
  running: boolean;
  /** Während `session/load` spielt Vibe den Verlauf inklusive Nutzer-Nachrichten ab. */
  replaying: boolean;
  usage?: Usage;
  commands: string[];
}

export type Sessions = Record<string, Session>;

export type Action =
  | { type: "add"; session: Session }
  | { type: "patch"; id: string; patch: Partial<Session> }
  | { type: "push"; id: string; item: Item }
  | { type: "update"; sessionId: string; update: any }
  | { type: "permission"; key: string; request: PermissionRequest }
  | { type: "permission-closed"; key: string; optionId: string | null };

let counter = 0;
export const uid = () => `i${++counter}`;

export function emptySession(id: string, cwd: string): Session {
  return { id, cwd, items: [], modes: [], running: false, replaying: false, commands: [] };
}

export function reducer(state: Sessions, action: Action): Sessions {
  switch (action.type) {
    case "add":
      return { ...state, [action.session.id]: action.session };
    case "patch":
      return withSession(state, action.id, (s) => ({ ...s, ...action.patch }));
    case "push":
      return withSession(state, action.id, (s) => ({ ...s, items: [...s.items, action.item] }));
    case "update":
      return withSession(state, action.sessionId, (s) => applyUpdate(s, action.update));
    case "permission":
      return withSession(state, action.request.sessionId, (s) => ({
        ...s,
        items: [
          ...s.items,
          {
            type: "permission",
            id: uid(),
            key: action.key,
            toolCallId: action.request.toolCall.toolCallId,
            options: action.request.options,
            rawInput: action.request.toolCall.rawInput,
            open: true,
          },
        ],
      }));
    case "permission-closed": {
      const next: Sessions = {};
      for (const [id, s] of Object.entries(state)) {
        const hit = s.items.some((i) => i.type === "permission" && i.key === action.key);
        next[id] = hit
          ? {
              ...s,
              items: s.items.map((i) =>
                i.type === "permission" && i.key === action.key
                  ? { ...i, open: false, answer: action.optionId }
                  : i,
              ),
            }
          : s;
      }
      return next;
    }
  }
}

function withSession(state: Sessions, id: string, fn: (s: Session) => Session): Sessions {
  const s = state[id];
  return s ? { ...state, [id]: fn(s) } : state;
}

function contentText(content: any): string {
  if (!content) return "";
  if (content.type === "text") return content.text ?? "";
  return `[${content.type}]`;
}

/** Hängt Text an den letzten Eintrag an, wenn er vom selben Typ ist. */
function appendText(items: Item[], type: "assistant" | "thought" | "user", text: string): Item[] {
  const last = items[items.length - 1];
  if (last && last.type === type) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...items, { type, id: uid(), text }];
}

function applyUpdate(s: Session, u: any): Session {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return { ...s, items: appendText(s.items, "assistant", contentText(u.content)) };
    case "agent_thought_chunk":
      return { ...s, items: appendText(s.items, "thought", contentText(u.content)) };
    case "user_message_chunk":
      // Live-Nachrichten zeigen wir selbst sofort an; nur den Verlauf übernehmen.
      return s.replaying ? { ...s, items: appendText(s.items, "user", contentText(u.content)) } : s;
    case "tool_call":
    case "tool_call_update": {
      const idx = s.items.findIndex((i) => i.type === "tool" && i.toolCallId === u.toolCallId);
      type Tool = Extract<Item, { type: "tool" }>;
      const base: Tool =
        idx >= 0
          ? (s.items[idx] as Tool)
          : {
              type: "tool",
              id: uid(),
              toolCallId: u.toolCallId,
              title: "Werkzeug",
              kind: "other",
              status: "pending",
              diffs: [],
              output: [],
            };
      const diffs: DiffContent[] = [];
      const output: string[] = [];
      for (const c of u.content ?? []) {
        if (c.type === "diff") diffs.push({ path: c.path, oldText: c.oldText ?? null, newText: c.newText ?? "" });
        else if (c.type === "content" && c.content?.type === "text") output.push(c.content.text);
      }
      const tool = {
        ...base,
        title: u.title ?? base.title,
        kind: u.kind ?? base.kind,
        status: u.status ?? base.status,
        rawInput: u.rawInput ?? base.rawInput,
        diffs: u.content ? diffs : base.diffs,
        output: u.content ? output : base.output,
      };
      const items = idx >= 0 ? s.items.map((i, n) => (n === idx ? tool : i)) : [...s.items, tool];
      return { ...s, items };
    }
    case "plan": {
      const entries = (u.entries ?? []).map((e: any) => ({ content: e.content, status: e.status }));
      const lastUser = s.items.map((i) => i.type).lastIndexOf("user");
      const idx = s.items.findIndex((i, n) => n > lastUser && i.type === "plan");
      const plan: Item = { type: "plan", id: idx >= 0 ? s.items[idx].id : uid(), entries };
      const items = idx >= 0 ? s.items.map((i, n) => (n === idx ? plan : i)) : [...s.items, plan];
      return { ...s, items };
    }
    case "usage_update":
      return { ...s, usage: u._meta ?? s.usage };
    case "session_info_update":
      return u.title ? { ...s, title: u.title } : s;
    case "current_mode_update":
      return { ...s, currentMode: u.currentModeId };
    case "available_commands_update":
      return { ...s, commands: (u.availableCommands ?? []).map((c: any) => c.name) };
    default:
      return s;
  }
}
