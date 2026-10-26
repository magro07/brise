// Master-Session (docs/adr/0006-master-session.md): Untersessions starten,
// steuern und ihre Rückmeldungen an die Master-Session weitergeben. Buch führt
// src-tauri/src/orchestra.rs; die Sessions laufen über den normalen Store.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api } from "./acp";
import { useStore, type Session } from "./store";

export type SubStatus = "starting" | "running" | "waiting" | "done" | "error" | "stopped" | "interrupted" | "merged";

export interface SubSession {
  id: string;
  master: string;
  title: string;
  task: string;
  backend: string;
  model?: string | null;
  cwd: string;
  repo: string;
  branch?: string | null;
  base?: string | null;
  worktree: boolean;
  status: SubStatus;
  stopReason?: string | null;
  report?: string | null;
  turns: number;
  created: number;
  updated: number;
}

export interface Proposal {
  id: string;
  master: string;
  masterCwd: string;
  title: string;
  task: string;
  backend: string;
  model?: string | null;
  worktree: boolean;
  state: "open" | "started" | "here" | "dismissed" | "failed";
  session?: string | null;
  error?: string | null;
  created: number;
  branch?: string | null;
}

export interface MergeRequest {
  id: string;
  master: string;
  session: string;
  title: string;
  branch: string;
  into: string;
  commits: string[];
  stat: string;
  state: "open" | "merged" | "rejected" | "failed";
  result?: string | null;
  created: number;
}

export interface Book {
  subs: SubSession[];
  proposals: Proposal[];
  merges: MergeRequest[];
}

interface Note {
  master: string;
  text: string;
}

export const STATUS_LABEL: Record<SubStatus, string> = {
  starting: "startet",
  running: "läuft",
  waiting: "wartet auf Freigabe",
  done: "fertig",
  error: "Fehler",
  stopped: "gestoppt",
  interrupted: "unterbrochen",
  merged: "gemerged",
};

/** Absender der Notizen im Chat der Master-Session. */
export const NOTE_AUTHOR = "Brise · Untersessions";

interface OrchestraState {
  book: Book;
  worktreeRoot: string;
  /** Grund, falls gesperrt oder ausgeschaltet. */
  blocked: string | null;
  maxParallel: number;
  /** Karten, deren Aktion gerade läuft. */
  busy: Record<string, boolean>;
  /** Fehler je Karte. */
  errors: Record<string, string>;
}

export const useOrchestra = create<OrchestraState>(() => ({
  book: { subs: [], proposals: [], merges: [] },
  worktreeRoot: "",
  blocked: null,
  maxParallel: 3,
  busy: {},
  errors: {},
}));

export const subOf = (id: string) => useOrchestra.getState().book.subs.find((s) => s.id === id);

/** Liegt der Ordner in Brises Worktree-Verzeichnis? */
export function isWorktreePath(cwd: string): boolean {
  const root = useOrchestra.getState().worktreeRoot;
  if (root) return cwd === root || cwd.startsWith(root + "/") || cwd.startsWith(root + "\\");
  // Noch nicht geladen: Muster von orchestra.rs (…/worktrees/<repo>-<8 hex>/<name>).
  return /[\\/]worktrees[\\/][^\\/]+-[0-9a-f]{8}[\\/][^\\/]+/.test(cwd);
}

/** Laufende Status: Rust kennt nur, was die Oberfläche meldet. */
export function liveStatus(sub: SubSession, live?: Session): SubStatus {
  if (live?.running) return live.pending.length ? "waiting" : "running";
  return sub.status;
}

export function useSubs(master: string): SubSession[] {
  return useOrchestra((s) => s.book.subs).filter((x) => x.master === master);
}

// ---------- Notizen und Nachrichten ----------

/** Notizen an Master-Sessions, die gerade arbeiten (oder noch nicht geladen sind). */
const notes: Record<string, string[]> = {};
/** Leise Notizen („gestartet“): gehen mit der nächsten richtigen Notiz raus. */
const quiet: Record<string, string[]> = {};
/** Nachrichten an Untersessions, die gerade arbeiten. */
const messages: Record<string, string[]> = {};

function deliver(note: Note | null | undefined, loud = true) {
  if (!note) return;
  (loud ? notes : quiet)[note.master] = [...((loud ? notes : quiet)[note.master] ?? []), note.text];
  if (loud) void flushNotes(note.master);
}

/** Vibes eingebautes Warten auf „eingehende Nachrichten“ (`wait`/`self.wait`). */
const WAIT_TOOL = /^(self\.)?wait\b|waiting for input/i;

/**
 * Läuft die Session nur, weil sie im Werkzeug `wait` auf Nachrichten wartet?
 * Vibe nimmt während eines Turns keinen Prompt an – Brise beendet dann das
 * Warten, damit die Notiz sofort zugestellt werden kann.
 */
export function idleWaiting(s: Session): boolean {
  if (!s.running || s.pending.length) return false;
  for (let i = s.items.length - 1; i >= 0; i--) {
    const item = s.items[i];
    if (item.type === "orch" || item.type === "thought") continue;
    return item.type === "tool" && (item.status === "pending" || item.status === "in_progress") && WAIT_TOOL.test(item.title);
  }
  return false;
}

/** Sessions, deren Warten Brise gerade beendet. */
const waking = new Set<string>();

function wake(s: Session) {
  if (waking.has(s.id) || !idleWaiting(s)) return;
  waking.add(s.id);
  api.cancel(s.id).catch(() => {}).finally(() => setTimeout(() => waking.delete(s.id), 5000));
}

async function ensureLoaded(id: string, cwd?: string, backend?: string, title?: string): Promise<Session | undefined> {
  const st = useStore.getState();
  if (st.sessions[id]) return st.sessions[id];
  const summary = st.index.find((x) => x.sessionId === id);
  const dir = cwd ?? summary?.cwd;
  if (!dir) return undefined;
  await st.attachSession(id, dir, backend ?? summary?.backend ?? "vibe", title ?? summary?.title ?? undefined);
  return useStore.getState().sessions[id];
}

async function flushNotes(master: string) {
  if (!notes[master]?.length) return;
  const s = await ensureLoaded(master).catch(() => undefined);
  if (s?.running) wake(s);
  if (!s || s.running || s.replaying || !notes[master]?.length) return;
  const text = [...(quiet[master] ?? []), ...notes[master]].join("\n\n---\n\n");
  notes[master] = [];
  quiet[master] = [];
  void useStore.getState().send(text, [], { sessionId: master, author: NOTE_AUTHOR });
}

function flushMessages(id: string) {
  const s = useStore.getState().sessions[id];
  if (!s || s.running || !messages[id]?.length) return;
  const text = messages[id].join("\n\n");
  messages[id] = [];
  void useStore.getState().send(text, [], { sessionId: id, author: "Master-Session", keepModel: true });
}

/** Ende eines Turns einer Untersession an Rust melden; liefert die Notiz. */
async function reportEnd(id: string, s: Session) {
  const lastUser = s.items.map((i) => i.type).lastIndexOf("user");
  const turn = s.items.slice(lastUser + 1);
  const end = [...turn].reverse().find((i) => i.type === "turn");
  const error = [...turn].reverse().find((i) => i.type === "notice" && i.tone === "error");
  const answer = [...turn].reverse().find((i) => i.type === "assistant");
  const status: SubStatus = end ? "done" : error ? "error" : "done";
  const report = answer?.type === "assistant" ? answer.text : error?.type === "notice" ? error.text : "";
  const note = await invoke<Note | null>("orch_status", {
    session: id,
    status,
    report,
    stopReason: end?.type === "turn" ? end.stopReason : null,
  }).catch(() => null);
  // Läuft schon die nächste Nachricht der Master-Session an, keine Notiz.
  if (messages[id]?.length) return;
  deliver(note);
}

function setStatus(id: string, status: SubStatus) {
  invoke("orch_status", { session: id, status, report: null, stopReason: null }).catch(() => {});
}

// ---------- Aufträge aus Rust (orch:call) ----------

async function handleCall(kind: string, p: any): Promise<unknown> {
  const st = useStore.getState();
  switch (kind) {
    case "info": {
      const s = st.sessions[p.session];
      const summary = st.index.find((x) => x.sessionId === p.session);
      return { cwd: s?.cwd ?? summary?.cwd ?? null, backend: s?.backend ?? summary?.backend ?? null, title: s?.title ?? summary?.title ?? null, running: !!s?.running };
    }
    case "start": {
      const sid = await st.createSession(p.cwd, p.backend, { parent: p.master, model: p.model ?? undefined, title: p.title });
      const sub = await invoke<SubSession>("orch_register", { proposal: p.proposal, session: sid });
      // Sofort eintragen – sonst geht der Turn-Beginn am Abonnement vorbei.
      useOrchestra.setState((o) => ({ book: { ...o.book, subs: [...o.book.subs.filter((x) => x.id !== sid), sub] } }));
      void useStore.getState().send(p.prompt, [], { sessionId: sid, author: "Master-Session", keepModel: !!p.model });
      useStore.getState().refreshIndex();
      return { sessionId: sid };
    }
    case "send": {
      const s = await ensureLoaded(p.session, p.cwd, p.backend, p.title);
      if (!s) throw new Error("Untersession nicht gefunden");
      if (s.running || s.replaying) {
        messages[p.session] = [...(messages[p.session] ?? []), p.text];
        wake(s);
        return { queued: true };
      }
      void useStore.getState().send(p.text, [], { sessionId: p.session, author: "Master-Session", keepModel: true });
      return { queued: false };
    }
    case "stop": {
      messages[p.session] = [];
      if (st.sessions[p.session]?.running) await api.cancel(p.session);
      return {};
    }
    default:
      throw new Error(`Unbekannter Auftrag ${kind}`);
  }
}

// ---------- Karten ----------

async function act(key: string, run: () => Promise<Note>, loud = true) {
  useOrchestra.setState((o) => ({ busy: { ...o.busy, [key]: true }, errors: { ...o.errors, [key]: "" } }));
  try {
    deliver(await run(), loud);
  } catch (e) {
    useOrchestra.setState((o) => ({ errors: { ...o.errors, [key]: String(e) } }));
  } finally {
    useOrchestra.setState((o) => ({ busy: { ...o.busy, [key]: false } }));
  }
}

/** „Neue Session“: Vorschlag starten. */
export const acceptProposal = (id: string) => act(id, () => invoke<Note>("orch_accept", { proposal: id }), false);
/** „Hier erledigen“ bzw. verwerfen. */
export const declineProposal = (id: string, here: boolean) => act(id, () => invoke<Note>("orch_decline", { proposal: id, here }), here);
/** „Mergen“ – die Freigabe des Nutzers. */
export const approveMerge = (id: string) => act(id, () => invoke<Note>("orch_merge", { request: id }));
export const rejectMerge = (id: string) => act(id, () => invoke<Note>("orch_reject", { request: id }));

export function forgetSub(id: string) {
  if (subOf(id)) invoke("orch_forget", { session: id }).catch(() => {});
}

/** Untersession als Tab (oder rechts daneben) öffnen – auch nach einem Neustart. */
export async function openSub(sub: SubSession, split = false) {
  const st = useStore.getState();
  if (!st.sessions[sub.id] && !st.index.some((x) => x.sessionId === sub.id)) {
    useStore.setState((s) => ({ index: [...s.index, { sessionId: sub.id, cwd: sub.cwd, title: sub.title, backend: sub.backend }] }));
  }
  if (split) st.splitWith(sub.id);
  else st.openTab(sub.id);
}

// ---------- Start ----------

function applyBook(book: Book) {
  const before = useOrchestra.getState().book;
  useOrchestra.setState({ book });
  // Neue Karten in den Chat der Master-Session (immer auf dem aktuellen Stand der Session).
  const add = (master: string, kind: "proposal" | "merge", ref: string) =>
    useStore.setState((x) => {
      const s = x.sessions[master];
      if (!s || s.items.some((i) => i.type === "orch" && i.ref === ref)) return {};
      return { sessions: { ...x.sessions, [master]: { ...s, items: [...s.items, { type: "orch", id: `orch-${ref}`, kind, ref }] } } };
    });
  for (const p of book.proposals) if (!before.proposals.some((x) => x.id === p.id)) add(p.master, "proposal", p.id);
  for (const m of book.merges) if (!before.merges.some((x) => x.id === m.id)) add(m.master, "merge", m.id);
}

export async function refreshOrchestra() {
  const r = await invoke<{ book: Book; worktreeRoot: string; blocked: string | null; maxParallel: number }>("orch_state").catch(() => null);
  if (r) {
    useOrchestra.setState({ worktreeRoot: r.worktreeRoot, blocked: r.blocked, maxParallel: r.maxParallel });
    applyBook(r.book);
  }
}

export function initOrchestra() {
  refreshOrchestra();
  const uns = [
    listen<Book>("orch:changed", (e) => applyBook(e.payload)),
    listen<{ id: number; kind: string; payload: unknown }>("orch:call", async (e) => {
      const { id, kind, payload } = e.payload;
      try {
        const value = await handleCall(kind, payload);
        await invoke("orch_reply", { id, ok: true, value: value ?? null });
      } catch (err) {
        await invoke("orch_reply", { id, ok: false, value: String(err) });
      }
    }),
    listen("policy:changed", () => refreshOrchestra()),
  ];
  // Turn-Beginn, Freigaben und Turn-Ende der Untersessions beobachten.
  const unsub = useStore.subscribe((st, prev) => {
    if (st.sessions === prev.sessions) return;
    for (const [id, s] of Object.entries(st.sessions)) {
      const before = prev.sessions[id];
      if (before === s) continue;
      const wasRunning = !!before?.running;
      if (subOf(id)) {
        const waiting = s.pending.length > 0;
        const wasWaiting = (before?.pending.length ?? 0) > 0;
        if (s.running && (!wasRunning || waiting !== wasWaiting)) setStatus(id, waiting ? "waiting" : "running");
        else if (!s.running && wasRunning) void reportEnd(id, s);
      }
      if (!s.running && wasRunning) {
        setTimeout(() => {
          flushMessages(id);
          void flushNotes(id);
        }, 0);
      }
    }
  });
  // Einstellungen ändern die Grenzen (sync_prefs schreibt sie für Rust).
  const unprefs = useStore.subscribe((st, prev) => {
    if (st.prefs.orchestra !== prev.prefs.orchestra) setTimeout(refreshOrchestra, 300);
  });
  return () => {
    uns.forEach((u) => u.then((f) => f()));
    unsub();
    unprefs();
  };
}
