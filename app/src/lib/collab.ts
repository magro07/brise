// Kollaboration: geteilte Sessions als Host spiegeln und als Gast anzeigen.
//
// Transport, Verschlüsselung und Rollen liegen im Rust-Modul `collab`. Hier
// entsteht, was gespiegelt wird (ACP-Updates, Prompts, Turn-Ende, Freigaben),
// und beim Gast wird daraus mit dem vorhandenen Store dieselbe Ansicht gebaut.
// Protokoll: docs/collab-protocol.md

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PermissionRequest } from "./acp";
import { load, save } from "./persist";
import { useStore, type Item, type Session } from "./store";

export type CollabRole = "viewer" | "collaborator" | "approver";

export const ROLE_LABEL: Record<CollabRole, string> = {
  viewer: "Betrachter",
  collaborator: "Mitarbeiter",
  approver: "Freigeber",
};

export const ROLE_DESCRIPTION: Record<CollabRole, string> = {
  viewer: "sieht live zu",
  collaborator: "darf Prompts in deine Warteschlange stellen",
  approver: "darf zusätzlich Freigaben entscheiden",
};

export interface Participant {
  id: string;
  name: string;
  role: CollabRole;
  online: boolean;
}

export interface Queued {
  id: string;
  author: string;
  authorId: string;
  text: string;
}

export interface HostView {
  sessionId: string;
  link: string;
  relay: string;
  lan: boolean;
  connected: boolean;
  error: string | null;
  participants: Participant[];
  queue: Queued[];
  defaultRole: CollabRole;
  showOutputs: boolean;
  expires: number | null;
}

export interface GuestState {
  room: string;
  sessionId: string;
  relay: string;
  /** Eigene Teilnehmer-ID (öffentlicher Schlüssel). */
  me: string;
  connected: boolean;
  error: string | null;
  hostName?: string;
  participants: Participant[];
  queue: Queued[];
  myRole: CollabRole | null;
  ended?: boolean;
}

export interface CollabPrefs {
  /** Name, den andere sehen. */
  name: string;
  /** „lan“: Brise bietet den WebSocket selbst an, „relay“: eigenes Relay. */
  mode: "lan" | "relay";
  relayUrl: string;
  lanPort: number;
  defaultRole: CollabRole;
  /** Werkzeug-Ausgaben (gelesene Dateien, Befehlsausgaben) an Gäste schicken. */
  showOutputs: boolean;
  /** Link läuft nach so vielen Minuten ab (0 = nie). */
  expiresMinutes: number;
  /** Gast-Prompts automatisch ausführen, sobald die Session frei ist. */
  autoRun: boolean;
}

const defaultPrefs: CollabPrefs = {
  name: "",
  mode: "lan",
  relayUrl: "",
  lanPort: 47800,
  defaultRole: "viewer",
  showOutputs: false,
  expiresMinutes: 24 * 60,
  autoRun: false,
};

interface CollabStore {
  prefs: CollabPrefs;
  hosts: Record<string, HostView>;
  guests: Record<string, GuestState>;
  /** Teilen-Dialog für diese Session offen. */
  shareFor: string | null;
  joinOpen: boolean;
  setPrefs(p: Partial<CollabPrefs>): void;
}

export const useCollab = create<CollabStore>((set, get) => ({
  prefs: { ...defaultPrefs, ...load<Partial<CollabPrefs>>("collab", {}) },
  hosts: {},
  guests: {},
  shareFor: null,
  joinOpen: false,
  setPrefs(p) {
    const prefs = { ...get().prefs, ...p };
    save("collab", prefs);
    set({ prefs });
  },
}));

// ---------- Hilfen ----------

let counter = 0;
const cid = () => `c${++counter}`;

const patchSession = (id: string, fn: (s: Session) => Session) =>
  useStore.setState((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } } : {}));

const pushItem = (id: string, item: Item) => patchSession(id, (s) => ({ ...s, items: [...s.items, item] }));

/** „Immer erlauben“ ändert die Konfiguration des Hosts – das bleibt dem Host vorbehalten. */
const guestOption = (optionId: string | null) => optionId !== "allow_always_permanent";

// ---------- Host: spiegeln ----------

const outbox: Record<string, unknown[]> = {};
const flushing: Record<string, boolean> = {};
/** Freigabe-Schlüssel → Session, damit auch das Schließen gespiegelt wird. */
const permissionSession: Record<string, string> = {};

/** Ereignis in Reihenfolge an Rust geben – nie zwei Aufrufe gleichzeitig. */
function publish(sessionId: string, event: unknown) {
  if (!useCollab.getState().hosts[sessionId]) return;
  (outbox[sessionId] ??= []).push(event);
  void flush(sessionId);
}

async function flush(sessionId: string) {
  if (flushing[sessionId]) return;
  flushing[sessionId] = true;
  try {
    while (outbox[sessionId]?.length) {
      const events = outbox[sessionId].splice(0);
      await invoke("collab_publish", { sessionId, events }).catch(() => {});
    }
  } finally {
    flushing[sessionId] = false;
  }
}

function snapshot(s: Session) {
  return {
    t: "snapshot",
    session: {
      title: s.title,
      cwd: s.cwd,
      running: s.running,
      // Uhren der Rechner weichen ab: nur die verstrichene Zeit schicken.
      elapsed: s.turnStarted ? Date.now() - s.turnStarted : 0,
      currentMode: s.currentMode,
      plan: s.plan,
      usage: s.usage,
      // Pfade von Anhängen bleiben beim Host.
      items: s.items.map((i) =>
        i.type === "user" && i.attachments ? { ...i, attachments: i.attachments.map((a) => ({ kind: a.kind, name: a.name, path: a.name })) } : i,
      ),
      pending: s.pending.map((p) => ({ ...p, options: p.options.filter((o) => guestOption(o.optionId)) })),
    },
  };
}

function hostName() {
  return useCollab.getState().prefs.name.trim() || "Host";
}

/** Gast-Prompt aus der Warteschlange ausführen – mit den Rechten des Hosts. */
export async function runQueued(sessionId: string, id: string) {
  const item = await invoke<Queued | null>("collab_queue_take", { sessionId, id });
  if (item) await useStore.getState().send(item.text, [], { sessionId, author: item.author });
}

export async function dropQueued(sessionId: string, id: string) {
  await invoke("collab_queue_take", { sessionId, id });
}

const autoRunning: Record<string, boolean> = {};

/** Nächsten Gast-Prompt starten, wenn die Session frei ist und Automatik an. */
function maybeRun(sessionId: string) {
  const host = useCollab.getState().hosts[sessionId];
  const session = useStore.getState().sessions[sessionId];
  const next = host?.queue[0];
  // Slash-Befehle von Gästen nur von Hand.
  if (!useCollab.getState().prefs.autoRun || !next || next.text.startsWith("/") || !session) return;
  if (session.running || session.pending.length || autoRunning[sessionId]) return;
  autoRunning[sessionId] = true;
  runQueued(sessionId, next.id)
    .catch(() => {})
    .finally(() => (autoRunning[sessionId] = false));
}

export async function share(sessionId: string) {
  const { prefs } = useCollab.getState();
  const view = await invoke<HostView>("collab_share", {
    sessionId,
    options: {
      name: hostName(),
      relay: prefs.mode === "relay" ? prefs.relayUrl : null,
      lanPort: prefs.lanPort,
      defaultRole: prefs.defaultRole,
      showOutputs: prefs.showOutputs,
      expiresMinutes: prefs.expiresMinutes || null,
    },
  });
  useCollab.setState((s) => ({ hosts: { ...s.hosts, [sessionId]: view } }));
  // Gast-Prompts laufen mit den Rechten des Hosts: deshalb jede Aktion fragen.
  const session = useStore.getState().sessions[sessionId];
  if (session && session.currentMode !== "ask" && session.modes.some((m) => m.id === "ask")) {
    await useStore.getState().setOption("mode", "ask", sessionId).catch(() => {});
  }
  const current = useStore.getState().sessions[sessionId];
  if (current) publish(sessionId, snapshot(current));
  return view;
}

export async function unshare(sessionId: string) {
  await invoke("collab_unshare", { sessionId });
  useCollab.setState((s) => {
    const hosts = { ...s.hosts };
    delete hosts[sessionId];
    return { hosts };
  });
}

export const setRole = (sessionId: string, participant: string, role: CollabRole) =>
  invoke("collab_set_role", { sessionId, participant, role });
export const removeParticipant = (sessionId: string, participant: string) => invoke("collab_remove", { sessionId, participant });
export const setDefaultRole = (sessionId: string, role: CollabRole) => invoke("collab_set_default_role", { sessionId, role });

// ---------- Gast ----------

export async function join(link: string) {
  const name = useCollab.getState().prefs.name.trim() || "Gast";
  const view = await invoke<Omit<GuestState, "participants" | "queue" | "myRole">>("collab_join", { link: link.trim(), name });
  useCollab.setState((s) => ({
    guests: { ...s.guests, [view.room]: { participants: [], queue: [], myRole: null, ...(s.guests[view.room] as GuestState | undefined), ...view } },
    joinOpen: false,
  }));
  const st = useStore.getState();
  if (!st.sessions[view.sessionId]) {
    // Platzhalter, bis der Snapshot des Hosts da ist.
    useStore.setState((x) => ({
      sessions: { ...x.sessions, [view.sessionId]: guestSession(view.sessionId, view.room, { title: "Geteilte Session", replaying: true }) },
    }));
  }
  rememberProject();
  st.openTab(view.sessionId);
}

export async function leave(room: string) {
  await invoke("collab_leave", { room });
  const sessionId = useCollab.getState().guests[room]?.sessionId ?? `collab-${room}`;
  useCollab.setState((s) => {
    const guests = { ...s.guests };
    delete guests[room];
    return { guests };
  });
  const st = useStore.getState();
  st.panes.forEach((p, n) => p.tabs.includes(sessionId) && useStore.getState().closeTab(n, sessionId));
  useStore.setState((x) => {
    const sessions = { ...x.sessions };
    delete sessions[sessionId];
    return { sessions, activeSessionId: x.activeSessionId === sessionId ? null : x.activeSessionId };
  });
  restoreProject();
}

export const guestPrompt = (room: string, text: string) => invoke("collab_guest_prompt", { room, text });
export const guestCancel = (room: string) => invoke("collab_guest_cancel", { room });

function guestSession(id: string, room: string, extra: Partial<Session> = {}): Session {
  const g = useCollab.getState().guests[room];
  return {
    id,
    cwd: "geteilt",
    items: [],
    pending: [],
    plan: [],
    modes: [],
    config: [],
    running: false,
    replaying: false,
    usage: {},
    commands: [],
    readOnly: true,
    autoThinking: false,
    thinkingLog: [],
    guest: { room, host: g?.hostName ?? "Host", role: g?.myRole ?? null, ended: g?.ended },
    ...extra,
  };
}

/** Eigenes Projekt merken: Gast-Sessions zeigen den Ordner des Hosts. */
let ownProject: string | null = null;
function rememberProject() {
  const st = useStore.getState();
  if (!st.activeSessionId || !st.sessions[st.activeSessionId]?.guest) ownProject = st.activeProject;
}
function restoreProject() {
  const st = useStore.getState();
  const active = st.activeSessionId ? st.sessions[st.activeSessionId] : undefined;
  if (!active?.guest && ownProject !== null && st.activeProject !== ownProject && !st.projects.includes(st.activeProject ?? "")) {
    useStore.setState({ activeProject: ownProject });
  }
}

function patchGuest(room: string, fn: (g: GuestState) => Partial<GuestState>) {
  useCollab.setState((s) => (s.guests[room] ? { guests: { ...s.guests, [room]: { ...s.guests[room], ...fn(s.guests[room]) } } } : {}));
}

function onGuestEvent(room: string, sessionId: string, body: any) {
  const st = useStore.getState();
  const key = (k: string) => `collab:${room}:${k}`;
  switch (body.t) {
    case "snapshot": {
      const s = body.session ?? {};
      const session = guestSession(sessionId, room, {
        cwd: s.cwd || "geteilt",
        title: s.title,
        // Eigene IDs, damit sie nicht mit lokal erzeugten kollidieren.
        items: (s.items ?? []).map((i: Item) => ({ ...i, id: `h${i.id}` })),
        pending: (s.pending ?? []).map((p: any) => ({ ...p, key: key(p.key) })),
        plan: s.plan ?? [],
        usage: s.usage ?? {},
        currentMode: s.currentMode,
        running: !!s.running,
        turnStarted: s.running ? Date.now() - (s.elapsed ?? 0) : undefined,
      });
      useStore.setState((x) => ({
        sessions: { ...x.sessions, [sessionId]: session },
        activeProject: x.activeSessionId === sessionId ? session.cwd : x.activeProject,
      }));
      break;
    }
    case "update":
      st.onUpdate(sessionId, body.update);
      break;
    case "prompt":
      patchSession(sessionId, (s) => ({
        ...s,
        running: true,
        turnStarted: Date.now(),
        items: [...s.items, { type: "user", id: cid(), text: body.text ?? "", author: body.author, attachments: body.attachments }],
      }));
      break;
    case "turn_end":
      pushItem(sessionId, { type: "turn", id: cid(), stopReason: body.stopReason, ms: body.ms ?? 0, tokens: body.tokens });
      patchSession(sessionId, (s) => ({ ...s, running: false, turnStarted: undefined }));
      break;
    case "notice":
      pushItem(sessionId, { type: "notice", id: cid(), text: String(body.text ?? ""), tone: body.tone ?? "info" });
      break;
    case "permission":
      st.onPermission(key(body.key), { ...(body.request as PermissionRequest), sessionId });
      break;
    case "permission_closed":
      st.onPermissionClosed(key(body.key), body.optionId ?? null);
      break;
    case "roster": {
      const participants: Participant[] = body.participants ?? [];
      const g = useCollab.getState().guests[room];
      const myRole = participants.find((p) => p.id === g?.me)?.role ?? null;
      patchGuest(room, () => ({ participants, hostName: body.host?.name, myRole }));
      patchSession(sessionId, (s) => ({ ...s, guest: { room, host: body.host?.name ?? "Host", role: myRole, ended: s.guest?.ended } }));
      break;
    }
    case "queue":
      patchGuest(room, () => ({ queue: body.items ?? [] }));
      break;
    case "ended":
      patchGuest(room, () => ({ ended: true }));
      patchSession(sessionId, (s) => ({
        ...s,
        running: false,
        pending: [],
        guest: s.guest ? { ...s.guest, ended: true } : s.guest,
        items: [...s.items, { type: "notice", id: cid(), text: "Der Host hat die Freigabe beendet.", tone: "warn" }],
      }));
      break;
  }
}

// ---------- Verdrahtung ----------

/** Einmal beim Start: Backend-Events abonnieren und den Store beobachten. */
export function initCollab(): () => void {
  const unlisten: Promise<() => void>[] = [
    // Host: Vibe-Ereignisse geteilter Sessions spiegeln.
    listen<{ sessionId: string; update: any }>("acp:update", (e) => {
      publish(e.payload.sessionId, { t: "update", update: e.payload.update });
    }),
    listen<{ key: string; request: PermissionRequest }>("acp:permission", (e) => {
      const { key, request } = e.payload;
      if (!useCollab.getState().hosts[request.sessionId]) return;
      permissionSession[key] = request.sessionId;
      publish(request.sessionId, {
        t: "permission",
        key,
        request: { toolCall: request.toolCall, options: request.options.filter((o) => guestOption(o.optionId)) },
      });
    }),
    listen<{ key: string; optionId: string | null }>("acp:permission-closed", (e) => {
      const sessionId = permissionSession[e.payload.key];
      if (!sessionId) return;
      delete permissionSession[e.payload.key];
      publish(sessionId, { t: "permission_closed", key: e.payload.key, optionId: e.payload.optionId });
    }),
    listen<HostView>("collab:host", (e) => {
      useCollab.setState((s) => (s.hosts[e.payload.sessionId] ? { hosts: { ...s.hosts, [e.payload.sessionId]: e.payload } } : {}));
      maybeRun(e.payload.sessionId);
    }),
    listen<{ sessionId: string }>("collab:snapshot-request", (e) => {
      const s = useStore.getState().sessions[e.payload.sessionId];
      if (s) publish(e.payload.sessionId, snapshot(s));
    }),
    listen<{ sessionId: string; key: string; optionId: string | null; by: string }>("collab:decide", (e) => {
      const { sessionId, key, optionId, by } = e.payload;
      const pending = useStore.getState().sessions[sessionId]?.pending.find((p) => p.key === key);
      if (!pending || !guestOption(optionId)) return;
      const option = pending.options.find((o) => o.optionId === optionId);
      if (optionId !== null && !option) return;
      pushItem(sessionId, { type: "notice", id: cid(), text: `${by} hat entschieden: ${option?.name ?? "abgebrochen"}`, tone: "info" });
      useStore.getState().answerPermission(key, optionId).catch(() => {});
    }),
    listen<{ sessionId: string; by: string }>("collab:cancel", (e) => {
      const { sessionId, by } = e.payload;
      if (!useStore.getState().sessions[sessionId]?.running) return;
      pushItem(sessionId, { type: "notice", id: cid(), text: `${by} hat den Turn abgebrochen.`, tone: "warn" });
      invoke("cancel", { sessionId }).catch(() => {});
    }),
    // Gast
    listen<{ room: string; sessionId: string; body: any }>("collab:guest", (e) => onGuestEvent(e.payload.room, e.payload.sessionId, e.payload.body)),
    listen<{ room: string; connected: boolean; error: string | null }>("collab:guest-status", (e) =>
      patchGuest(e.payload.room, () => ({ connected: e.payload.connected, error: e.payload.error })),
    ),
  ];

  // Prompts, Turn-Enden und Hinweise entstehen im Store, nicht bei Vibe.
  const unsubscribe = useStore.subscribe((st, prev) => {
    for (const sessionId of Object.keys(useCollab.getState().hosts)) {
      const cur = st.sessions[sessionId];
      const old = prev.sessions[sessionId];
      if (!cur || !old) continue;
      if (cur.items !== old.items && cur.items.length > old.items.length) {
        for (const i of cur.items.slice(old.items.length)) {
          if (i.type === "user") {
            publish(sessionId, { t: "prompt", text: i.text, author: i.author ?? hostName(), attachments: i.attachments?.map((a) => ({ kind: a.kind, name: a.name, path: a.name })) });
          } else if (i.type === "turn") {
            publish(sessionId, { t: "turn_end", stopReason: i.stopReason, ms: i.ms, tokens: i.tokens });
          } else if (i.type === "notice") {
            publish(sessionId, { t: "notice", text: i.text, tone: i.tone });
          }
        }
      }
      if (old.running && !cur.running) maybeRun(sessionId);
    }
    // Zurück im eigenen Projekt, sobald keine Gast-Session mehr aktiv ist.
    if (st.activeSessionId !== prev.activeSessionId && prev.activeSessionId && prev.sessions[prev.activeSessionId]?.guest) restoreProject();
  });

  // Nach einem Neuladen der Oberfläche laufen Freigaben im Backend weiter.
  invoke<{ hosts: HostView[] }>("collab_status")
    .then((r) => useCollab.setState({ hosts: Object.fromEntries(r.hosts.map((h) => [h.sessionId, h])) }))
    .catch(() => {});

  return () => {
    unsubscribe();
    unlisten.forEach((p) => p.then((f) => f()));
  };
}
