import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type AuthStatus, type ConnectInfo, type Mode, type NewSessionResult, type PermissionRequest, type SessionSummary } from "./acp";
import { emptySession, reducer, uid, type Session } from "./store";
import { Messages } from "./components/Messages";
import { Composer } from "./components/Composer";
import "./App.css";

type Phase =
  | { kind: "connecting" }
  | { kind: "no-vibe" }
  | { kind: "error"; message: string }
  | { kind: "login" }
  | { kind: "ready" };

const MODE_LABEL: Record<string, string> = {
  ask: "Alles fragen",
  "accept-edits": "Edits automatisch",
  "smart-approve": "Smart",
  "auto-approve": "Alles automatisch",
};

const DEFAULT_MODES: Mode[] = [
  { id: "ask", name: "Ask" },
  { id: "accept-edits", name: "Accept Edits" },
  { id: "auto-approve", name: "Auto Approve" },
];

// Nur Komfort (zuletzt genutzte Ordner) – darf fehlen.
function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem("brise.recentProjects") ?? "[]");
  } catch {
    return [];
  }
}

function saveRecent(list: string[]) {
  try {
    localStorage.setItem("brise.recentProjects", JSON.stringify(list.slice(0, 8)));
  } catch {
    /* egal */
  }
}

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function sessionFromResult(id: string, cwd: string, r: Partial<NewSessionResult>): Partial<Session> {
  const model = r.configOptions?.find((o) => o.id === "model");
  return {
    modes: r.modes?.availableModes ?? [],
    currentMode: r.modes?.currentModeId,
    model: model?.options?.find((o) => o.value === model.currentValue)?.name ?? model?.currentValue,
    id,
    cwd,
  };
}

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [login, setLogin] = useState<{ waiting: boolean; url?: string; error?: string }>({ waiting: false });
  const [sessions, dispatch] = useReducer(reducer, {});
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [project, setProject] = useState<string | null>(() => loadRecent()[0] ?? null);
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [pendingMode, setPendingMode] = useState<string | null>(null);
  const generation = useRef(0);
  const connecting = useRef(false);
  const active = activeId ? sessions[activeId] : undefined;

  const connect = useCallback(async () => {
    if (connecting.current) return;
    connecting.current = true;
    setPhase({ kind: "connecting" });
    try {
      const i = await api.connect();
      generation.current = i.generation;
      setInfo(i);
      setAuth(i.auth);
      setPhase(i.auth?.authenticated ? { kind: "ready" } : { kind: "login" });
    } catch (e) {
      setPhase(String(e) === "VIBE_NOT_FOUND" ? { kind: "no-vibe" } : { kind: "error", message: String(e) });
    } finally {
      connecting.current = false;
    }
  }, []);

  // Events aus dem Rust-Backend abonnieren und einmal verbinden.
  useEffect(() => {
    let disposed = false;
    const unlisten: (() => void)[] = [];
    Promise.all([
      listen<{ sessionId: string; update: unknown }>("acp:update", (e) =>
        dispatch({ type: "update", sessionId: e.payload.sessionId, update: e.payload.update }),
      ),
      listen<{ key: string; request: PermissionRequest }>("acp:permission", (e) =>
        dispatch({ type: "permission", key: e.payload.key, request: e.payload.request }),
      ),
      listen<{ key: string; optionId: string | null }>("acp:permission-closed", (e) =>
        dispatch({ type: "permission-closed", key: e.payload.key, optionId: e.payload.optionId }),
      ),
      listen<{ url: string }>("acp:login-url", (e) => setLogin((l) => ({ ...l, url: e.payload.url }))),
      listen<{ generation: number }>("acp:closed", (e) => {
        if (e.payload.generation === generation.current) {
          setPhase({ kind: "error", message: "Die Verbindung zu Vibe wurde beendet." });
        }
      }),
    ]).then((fns) => {
      if (disposed) fns.forEach((f) => f());
      else unlisten.push(...fns);
    });
    connect();
    return () => {
      disposed = true;
      unlisten.forEach((f) => f());
    };
  }, [connect]);

  const refreshHistory = useCallback(async (cwd: string | null) => {
    if (!cwd) return setHistory([]);
    try {
      const r = await api.listSessions(cwd);
      setHistory((r.sessions ?? []).filter((s) => s.cwd === cwd));
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    if (phase.kind === "ready") refreshHistory(project);
  }, [phase.kind, project, refreshHistory]);

  const chooseProject = useCallback(async (path?: string) => {
    const picked = path ?? (await openDialog({ directory: true, title: "Projektordner wählen" }));
    if (typeof picked !== "string") return;
    setRecent((recent) => {
      const list = [picked, ...recent.filter((r) => r !== picked)];
      saveRecent(list);
      return list;
    });
    setProject(picked);
    setActiveId(null);
  }, []);

  // `brise <ordner>` öffnet direkt dieses Projekt.
  useEffect(() => {
    api.startupProject().then((p) => {
      if (p) chooseProject(p);
    });
  }, [chooseProject]);

  const doLogin = async () => {
    setLogin({ waiting: true });
    try {
      const status = await api.login();
      setAuth(status);
      setLogin({ waiting: false });
      if (status.authenticated) setPhase({ kind: "ready" });
    } catch (e) {
      setLogin({ waiting: false, error: String(e) });
    }
  };

  const doSignOut = async () => {
    if (!window.confirm("Wirklich abmelden? Der gespeicherte Vibe-Schlüssel wird entfernt.")) return;
    try {
      setAuth(await api.signOut());
      setPhase({ kind: "login" });
    } catch (e) {
      window.alert(String(e));
    }
  };

  const send = async (text: string) => {
    if (!project) return;
    let id = activeId && sessionsRef.current[activeId] ? activeId : null;
    try {
      if (!id) {
        const r = await api.newSession(project);
        id = r.sessionId;
        dispatch({ type: "add", session: { ...emptySession(id, project), ...sessionFromResult(id, project, r) } });
        setActiveId(id);
        if (pendingMode && pendingMode !== r.modes?.currentModeId) {
          await api.setMode(id, pendingMode);
          dispatch({ type: "patch", id, patch: { currentMode: pendingMode } });
        }
      }
    } catch (e) {
      window.alert(`Session konnte nicht gestartet werden: ${e}`);
      return;
    }
    const sid = id;
    dispatch({ type: "push", id: sid, item: { type: "user", id: uid(), text } });
    dispatch({ type: "patch", id: sid, patch: { running: true } });
    try {
      const res = await api.prompt(sid, text);
      if (res.stopReason === "cancelled") {
        dispatch({ type: "push", id: sid, item: { type: "notice", id: uid(), text: "Abgebrochen.", tone: "warn" } });
      } else if (res.stopReason !== "end_turn") {
        dispatch({
          type: "push",
          id: sid,
          item: { type: "notice", id: uid(), text: `Turn beendet: ${res.stopReason}`, tone: "warn" },
        });
      }
    } catch (e) {
      dispatch({ type: "push", id: sid, item: { type: "notice", id: uid(), text: String(e), tone: "error" } });
    } finally {
      dispatch({ type: "patch", id: sid, patch: { running: false } });
      refreshHistory(project);
    }
  };

  const openHistory = async (s: SessionSummary) => {
    if (sessionsRef.current[s.sessionId]) return setActiveId(s.sessionId);
    dispatch({
      type: "add",
      session: { ...emptySession(s.sessionId, s.cwd), title: s.title ?? undefined, replaying: true },
    });
    setActiveId(s.sessionId);
    try {
      const r = await api.loadSession(s.cwd, s.sessionId);
      dispatch({ type: "patch", id: s.sessionId, patch: { ...sessionFromResult(s.sessionId, s.cwd, r), replaying: false } });
    } catch (e) {
      dispatch({ type: "patch", id: s.sessionId, patch: { replaying: false } });
      dispatch({ type: "push", id: s.sessionId, item: { type: "notice", id: uid(), text: String(e), tone: "error" } });
    }
  };

  const changeMode = async (mode: string) => {
    if (!active) return setPendingMode(mode);
    try {
      await api.setMode(active.id, mode);
      dispatch({ type: "patch", id: active.id, patch: { currentMode: mode } });
    } catch (e) {
      window.alert(String(e));
    }
  };

  // ---------- Startbildschirme ----------

  if (phase.kind !== "ready") {
    return (
      <div className="splash">
        <div className="splash-card">
          <Logo />
          {phase.kind === "connecting" && <p className="muted">Verbinde mit Mistral Vibe …</p>}
          {phase.kind === "no-vibe" && (
            <>
              <h2>Mistral Vibe wurde nicht gefunden</h2>
              <p>Brise braucht den Coding-Agenten Mistral Vibe. Die automatische Installation folgt in einer späteren Version – bis dahin einmalig im Terminal:</p>
              <pre className="code">curl -LsSf https://mistral.ai/vibe/install.sh | bash</pre>
              <p className="muted small">Windows: <code>uv tool install mistral-vibe</code></p>
              <button className="btn btn-primary" onClick={connect}>
                Erneut prüfen
              </button>
            </>
          )}
          {phase.kind === "error" && (
            <>
              <h2>Etwas ist schiefgelaufen</h2>
              <pre className="code">{phase.message}</pre>
              <button className="btn btn-primary" onClick={connect}>
                Neu verbinden
              </button>
            </>
          )}
          {phase.kind === "login" && (
            <>
              <h2>Mit Mistral anmelden</h2>
              <p>Brise nutzt deinen Mistral-Vibe-Plan (Free, Pro oder Team) – du brauchst keinen API-Key.</p>
              {login.waiting ? (
                <>
                  <p className="muted">Im Browser anmelden und danach hierher zurückkehren …</p>
                  {login.url && (
                    <button className="link" onClick={() => openUrl(login.url!)}>
                      Browser hat sich nicht geöffnet? Hier klicken.
                    </button>
                  )}
                </>
              ) : (
                <button className="btn btn-primary btn-large" onClick={doLogin}>
                  Im Browser anmelden
                </button>
              )}
              {login.error && <pre className="code error">{login.error}</pre>}
            </>
          )}
        </div>
      </div>
    );
  }

  // ---------- Hauptansicht ----------

  const live = Object.values(sessions).filter((s) => s.cwd === project);
  const listed = [
    ...live.map((s) => ({ id: s.id, title: s.title, running: s.running })),
    ...history.filter((h) => !sessions[h.sessionId]).map((h) => ({ id: h.sessionId, title: h.title ?? undefined, running: false })),
  ];
  const modes = active?.modes.length ? active.modes : (live.find((s) => s.modes.length)?.modes ?? DEFAULT_MODES);
  const currentMode = active?.currentMode ?? pendingMode ?? "accept-edits";

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <Logo small /> <span>Brise</span>
        </div>
        <button className="project" onClick={() => chooseProject()} title={project ?? undefined}>
          <span className="project-icon">📁</span>
          <span className="project-name">{project ? basename(project) : "Projekt öffnen …"}</span>
        </button>
        {project && (
          <button className="btn new-session" onClick={() => setActiveId(null)}>
            + Neue Session
          </button>
        )}
        <nav className="session-list">
          {listed.map((s) => (
            <button
              key={s.id}
              className={`session-item ${s.id === activeId ? "active" : ""}`}
              onClick={() => {
                const h = history.find((x) => x.sessionId === s.id);
                if (sessions[s.id]) setActiveId(s.id);
                else if (h) openHistory(h);
              }}
            >
              {s.running && <span className="live-dot" />}
              <span className="session-title">{s.title || "Neue Session"}</span>
            </button>
          ))}
        </nav>
        <div className="account">
          <span className={`status-dot ${auth?.authenticated ? "ok" : ""}`} />
          <div className="account-text">
            <div>{auth?.authenticated ? "Angemeldet bei Mistral" : "Nicht angemeldet"}</div>
            <div className="muted small">
              {info?.init.agentInfo?.title} {info?.init.agentInfo?.version}
            </div>
          </div>
          {auth?.signOutAvailable && (
            <button className="link small" onClick={doSignOut}>
              Abmelden
            </button>
          )}
        </div>
      </aside>

      <main className="main">
        {!project ? (
          <div className="empty">
            <h1>Willkommen bei Brise</h1>
            <p className="muted">Wähle einen Projektordner, in dem Vibe arbeiten soll.</p>
            <button className="btn btn-primary btn-large" onClick={() => chooseProject()}>
              Projektordner öffnen
            </button>
            {recent.length > 0 && (
              <div className="recent">
                <div className="muted small">Zuletzt geöffnet</div>
                {recent.map((r) => (
                  <button key={r} className="recent-item" onClick={() => chooseProject(r)}>
                    📁 {basename(r)} <span className="muted small">{r}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <header className="header">
              <div className="header-title">{active?.title ?? basename(project)}</div>
              <div className="header-meta">
                {active?.model && <span className="pill">{active.model}</span>}
                {active?.usage?.lastTurnTotalTokens != null && (
                  <span className="pill muted" title="Kontextgröße des letzten Schritts">
                    {Math.round(active.usage.lastTurnTotalTokens / 1000)}k Tokens
                  </span>
                )}
                <select value={currentMode} onChange={(e) => changeMode(e.target.value)} title="Freigabe-Modus">
                  {modes.map((m) => (
                    <option key={m.id} value={m.id}>
                      {MODE_LABEL[m.id] ?? m.name}
                    </option>
                  ))}
                </select>
              </div>
            </header>
            {active ? (
              <Messages
                session={active}
                onAnswer={(key, optionId) => api.respondPermission(key, optionId).catch((e) => window.alert(String(e)))}
              />
            ) : (
              <div className="empty">
                <h1>Was soll Vibe in {basename(project)} tun?</h1>
                <p className="muted">Beschreibe die Aufgabe – Vibe liest den Code, ändert Dateien und fragt bei heiklen Schritten nach.</p>
              </div>
            )}
            <Composer
              running={!!active?.running}
              disabled={!!active?.replaying}
              placeholder={active ? "Antworten oder nächste Aufgabe …" : "Aufgabe beschreiben …"}
              onSend={send}
              onStop={() => active && api.cancel(active.id)}
            />
          </>
        )}
      </main>
    </div>
  );
}

function Logo({ small }: { small?: boolean }) {
  const size = small ? 22 : 56;
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#g)" />
      <path d="M14 24c10-6 20 6 30 0s8-4 8-4M12 34c12-6 22 6 34 0M16 44c8-4 16 4 24 0" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" />
    </svg>
  );
}
