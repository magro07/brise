// Computer Use (computer/mod.rs): Agenten sehen den Bildschirm und bedienen
// Maus und Tastatur. Hier: Zustand für Hinweisleiste, Vorschauen im Chat und
// die Einstellungen; Freigaben laufen über die normalen Freigabekarten.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api } from "./acp";
import { useStore, type ToolItem } from "./store";

/** Zusatzdaten einer Computer-Use-Freigabekarte (`_meta.briseComputer`). */
export interface ComputerMeta {
  tool: string;
  summary: string;
  activate: boolean;
  /** Letzter Screenshot (verkleinert) und Ziel als Anteil von Breite/Höhe. */
  image?: string | null;
  point?: [number, number] | null;
  shortcut: string;
}

/** Ausgeführte Aktion mit Vorschau für den Werkzeugaufruf. */
export interface ComputerShot {
  sessionId: string;
  tool: string;
  summary: string;
  image?: string | null;
  point?: [number, number] | null;
  error?: string;
  at: number;
}

export interface ComputerCaps {
  backend: string;
  screenshot: boolean;
  screenshotDetail: string;
  input: boolean;
  inputDetail: string;
  windows: boolean;
  notes: string[];
}

export interface ComputerStatus {
  enabled: boolean;
  projects: string[];
  platform: ComputerCaps;
  shortcut: string;
  locked: string | null;
  active: string | null;
}

export const computerApi = {
  status: () => invoke<ComputerStatus>("cu_status"),
  setEnabled: (enabled: boolean) => invoke<void>("cu_set_enabled", { enabled }),
  setProject: (path: string, on: boolean) => invoke<void>("cu_set_project", { path, on }),
  stop: () => invoke<void>("cu_stop"),
  requestAccess: () => invoke<string>("cu_request_access"),
  prepare: () => invoke<string>("cu_prepare"),
};

interface ComputerState {
  /** Session, die gerade steuert, mit letzter Aktion. */
  active: { sessionId: string; summary: string; shortcut: string } | null;
  /** Vorschauen je Werkzeugaufruf (toolCallId). */
  shots: Record<string, ComputerShot[]>;
}

export const useComputer = create<ComputerState>(() => ({ active: null, shots: {} }));

const MAX_SHOTS = 12;

/** Werkzeugaufruf des Agenten, zu dem eine Aktion gehört (laufend bevorzugt). */
function toolFor(sessionId: string, tool: string): ToolItem | undefined {
  const items = useStore.getState().sessions[sessionId]?.items ?? [];
  const tools = items.filter((i): i is ToolItem => i.type === "tool" && `${i.title} ${JSON.stringify(i.rawInput ?? "")}`.includes(tool));
  return [...tools].reverse().find((t) => t.status === "in_progress" || t.status === "pending") ?? tools[tools.length - 1];
}

export function isComputerTool(t: ToolItem): boolean {
  return /computer_(screenshot|zoom|list_windows|click|double_click|move|drag|scroll|type|key|focus_window|open_app)/.test(t.title ?? "");
}

export function initComputer(): () => void {
  const unlisten = [
    listen<ComputerShot>("cu:action", (e) => {
      const shot = e.payload;
      const tool = toolFor(shot.sessionId, shot.tool);
      const key = tool?.toolCallId ?? `session:${shot.sessionId}`;
      useComputer.setState((s) => ({ shots: { ...s.shots, [key]: [...(s.shots[key] ?? []), shot].slice(-MAX_SHOTS) } }));
    }),
    listen<{ active: boolean; sessionId?: string; summary?: string; shortcut?: string }>("cu:state", (e) => {
      const p = e.payload;
      useComputer.setState({ active: p.active && p.sessionId ? { sessionId: p.sessionId, summary: p.summary ?? "", shortcut: p.shortcut ?? "" } : null });
    }),
    // Not-Aus: laufende Turns der steuernden Sessions abbrechen.
    listen<{ sessions: string[]; by: string }>("cu:stopped", (e) => {
      useComputer.setState({ active: null });
      for (const id of e.payload.sessions) {
        if (useStore.getState().sessions[id]?.running) api.cancel(id).catch(() => {});
      }
    }),
  ];
  return () => unlisten.forEach((p) => p.then((f) => f()));
}
