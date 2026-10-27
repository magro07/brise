import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, LogIn, RefreshCw, TerminalSquare } from "lucide-react";
import { api, type AuthStatus, type BackendInfo } from "../../lib/acp";
import { useTerminalRequest } from "../../lib/backends";
import { useStore } from "../../lib/store";
import { useProviders } from "../../lib/providers";
import { Button, Spinner, Switch, clsx } from "../ui";
import { Card, Row } from "../settings/Settings";
import { BackendBadge } from "./BackendPicker";

/** Einstellungen → Agenten: installierte Backends, Anmeldung, Standard. */
export function AgentsSettings() {
  const backends = useStore((s) => s.backends);
  const agents = useStore((s) => s.agents);
  const prefs = useStore((s) => s.prefs);
  const { setPrefs, refreshBackends } = useStore.getState();
  const [auth, setAuth] = useState<Record<string, AuthStatus | null>>({});
  const providers = useProviders((s) => s.list);

  const probe = (id: string) =>
    (agents[id]?.caps.vibeExtensions ? Promise.resolve(agents[id].auth) : api.backendAuth(id))
      .then((a) => setAuth((m) => ({ ...m, [id]: a })))
      .catch(() => setAuth((m) => ({ ...m, [id]: null })));

  useEffect(() => {
    refreshBackends();
    useProviders.getState().refresh();
  }, []);
  useEffect(() => {
    for (const b of backends) if (b.installed) probe(b.id);
  }, [backends.map((b) => `${b.id}:${b.installed}`).join()]);

  const toggleEnabled = (id: string, on: boolean) =>
    setPrefs({ enabledBackends: on ? [...new Set([...prefs.enabledBackends, id])] : prefs.enabledBackends.filter((b) => b !== id) });

  return (
    <>
      <Card
        title="Coding-Agenten"
        description="Brise spricht mit jedem Agenten über das Agent Client Protocol. Jede Session gehört einem Agenten; welchen eine neue Session nutzt, wählst du im Eingabefeld."
      >
        {backends.length === 0 && (
          <div className="flex items-center gap-2 px-4 py-3.5 text-muted">
            <Spinner /> Suche installierte Agenten …
          </div>
        )}
        {backends.map((b) => (
          <BackendRow key={b.id} backend={b} auth={auth[b.id]} connected={!!agents[b.id]} onChanged={() => (refreshBackends(), probe(b.id))} />
        ))}
      </Card>

      <Card title="Verhalten">
        <Row
          title="Standard-Agent"
          description="Mit diesem Agenten starten neue Sessions. Ohne Vibe als Standard braucht Brise beim Start kein Vibe."
          control={
            <select
              className="h-8 rounded-lg border border-line bg-panel px-2 text-[0.92em]"
              value={prefs.defaultBackend}
              onChange={(e) => {
                const id = e.target.value;
                setPrefs({ defaultBackend: id, enabledBackends: [...new Set([...prefs.enabledBackends, id])] });
                useStore.getState().setDraftBackend(null);
                useStore.getState().connectBackend(id).catch(() => {});
              }}
            >
              {backends
                .filter((b) => b.installed || b.id === prefs.defaultBackend)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
            </select>
          }
        />
        {backends
          .filter((b) => b.installed && b.id !== prefs.defaultBackend)
          .map((b) => (
            <Row
              key={b.id}
              title={`${b.title} beim Start verbinden`}
              description="Startet den Agenten mit Brise, damit seine bisherigen Sessions in der Seitenleiste stehen. Sonst startet er bei der ersten Session."
              control={<Switch checked={prefs.enabledBackends.includes(b.id)} onChange={(v) => toggleEnabled(b.id, v)} />}
            />
          ))}
      </Card>

      <Card title="API-Schlüssel der Anbieter" description="Für Brises eigene Modellaufrufe und für Modelle, die Brise in Vibe einträgt. Claude Code, Codex und Gemini melden sich selbst an (oben).">
        {providers.map((p) => (
          <Row
            key={p.id}
            title={p.name}
            description={p.hasKey ? (p.keySource === "vibe" ? "Schlüssel mit Vibe geteilt" : p.keySource === "env" ? "Schlüssel aus Umgebungsvariable" : "Schlüssel im Schlüsselbund") : p.keyOptional ? "lokal, ohne Schlüssel" : "kein Schlüssel"}
            control={p.usable ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <span className="text-[0.86em] text-muted">–</span>}
          />
        ))}
        <div className="px-4 py-2.5">
          <Button size="sm" onClick={() => useStore.getState().setView("settings", "providers")}>
            Anbieter & Schlüssel verwalten
          </Button>
        </div>
      </Card>
    </>
  );
}

function BackendRow({ backend: b, auth, connected, onChanged }: { backend: BackendInfo; auth: AuthStatus | null | undefined; connected: boolean; onChanged: () => void }) {
  const install = useStore((s) => s.install);
  const [busy, setBusy] = useState<"install" | "login" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const mine = useRef(false);
  const [plan, setPlan] = useState<string | null>(null);
  // Vibe-Plan (/whoami). Verbrauch oder Limit liefert Mistral dort nicht.
  useEffect(() => {
    if (b.id !== "vibe" || !connected) return;
    const st = useStore.getState();
    const sid = st.activeSessionId ?? Object.values(st.prepared).find((id) => id !== "…");
    if (sid)
      api
        .ext<{ plan?: { name?: string; title?: string | null; kind?: string } }>("account/read", { sessionId: sid })
        .then((a) => a.plan && setPlan(a.plan.title ?? `${a.plan.kind ?? ""} · ${a.plan.name ?? ""}`))
        .catch(() => {});
  }, [b.id, connected]);
  const log = useRef<HTMLPreElement>(null);

  // Installationsausgabe (install:progress) nur mitschreiben, solange diese Zeile installiert.
  useEffect(() => {
    if (mine.current) setLines(install.lines.slice(-60));
  }, [install.lines.length]);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [lines.length]);

  const doInstall = async () => {
    setBusy("install");
    setError(null);
    mine.current = true;
    useStore.setState({ install: { running: true, lines: [] } });
    try {
      await api.installBackend(b.id);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      mine.current = false;
      useStore.setState((s) => ({ install: { ...s.install, running: false } }));
      setBusy(null);
    }
  };

  const doLogin = async () => {
    setError(null);
    const command = await api.backendLoginCommand(b.id).catch(() => null);
    if (!command) return;
    const st = useStore.getState();
    if (!st.activeProject) {
      setError(`Öffne zuerst ein Projekt – die Anmeldung läuft im eingebauten Terminal. Alternativ in einem eigenen Terminal: ${command}`);
      return;
    }
    useTerminalRequest.getState().run(command);
    st.set({ view: "chat", terminalOpen: true });
  };

  const reconnect = async () => {
    setBusy("login");
    try {
      await api.disconnectBackend(b.id);
      await useStore.getState().connectBackend(b.id, true);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const status = !b.installed ? null : auth === undefined ? (
    <span className="inline-flex items-center gap-1.5 text-muted">
      <Spinner className="h-3 w-3" /> prüfe Anmeldung …
    </span>
  ) : auth?.authenticated ? (
    <span className={clsx("inline-flex items-center gap-1.5", auth.unverified ? "text-warn" : "text-ok")}>
      {auth.unverified ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
      {auth.label ?? "angemeldet"}
      {auth.detail ? <span className="text-muted">· {auth.detail}</span> : null}
      {auth.unverified ? <span className="text-muted">· nicht geprüft</span> : null}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-warn">
      <AlertTriangle className="h-3.5 w-3.5" /> {auth?.label ?? "nicht angemeldet"}
    </span>
  );

  return (
    <div className="px-4 py-3.5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-medium">
            {b.title}
            <BackendBadge backend={b.id} always />
            {connected && <span className="text-[0.78em] font-normal text-ok">läuft</span>}
          </div>
          <div className="mt-0.5 text-[0.86em] text-muted">{b.description}</div>
          <div className="mt-1.5 text-[0.84em]">
            {b.installed ? status : <span className="text-muted">{b.installBlocker ?? "nicht installiert"}</span>}
          </div>
          {b.id === "vibe" && plan && <div className="mt-1 text-[0.84em] text-fg-2">Plan: {plan} · Kosten schätzt Brise selbst (Nutzung & Budget)</div>}
          {b.id === "claude" && auth?.authenticated && /max|pro|abo/i.test(`${auth.label} ${auth.detail}`) && (
            <div className="mt-1 text-[0.84em] text-fg-2">Abo – die tatsächlichen Kosten kennt Brise nicht; die Nutzung zeigt Tokens und eine Schätzung.</div>
          )}
          {b.command && <div className="mt-1 break-all font-mono text-[0.75em] text-muted selectable">{b.command}</div>}
          {b.installed && !auth?.authenticated && b.loginHint && !b.loginAvailable && <div className="mt-1 text-[0.82em] text-muted">{b.loginHint}</div>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {!b.installed && (
            <Button size="sm" variant="primary" disabled={!!b.installBlocker || busy !== null || install.running} onClick={doInstall}>
              {busy === "install" ? <Spinner className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />} Installieren
            </Button>
          )}
          {b.installed && b.loginAvailable && (
            <Button size="sm" variant={auth?.authenticated ? "secondary" : "primary"} onClick={doLogin} title={b.loginHint ?? undefined}>
              <LogIn className="h-3.5 w-3.5" /> {auth?.authenticated ? "Anders anmelden" : "Anmelden"}
            </Button>
          )}
          {b.installed && b.id === "vibe" && (
            <Button size="sm" variant="ghost" onClick={() => useStore.getState().setView("settings", "agents/vibe")}>
              Vibe-Einstellungen
            </Button>
          )}
          {b.installed && b.id !== "vibe" && (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={reconnect} title="Agent neu starten und Anmeldung neu lesen">
              {busy === "login" ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />} Neu verbinden
            </Button>
          )}
        </div>
      </div>
      {lines.length > 0 && (
        <pre ref={log} className="mt-3 h-32 overflow-y-auto rounded-lg border border-line bg-code p-2.5 font-mono text-[0.72em] text-fg-2 selectable">
          {lines.join("\n")}
        </pre>
      )}
      {error && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[0.84em] text-bad selectable">
          <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}
