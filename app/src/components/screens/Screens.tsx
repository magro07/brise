import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, BookOpen, Bug, CheckCircle2, Download, FileSearch, FolderOpen, FolderPlus, Gauge, GitBranch, Globe, KeyRound, LogIn, RefreshCw, Rocket, ShieldCheck, Sparkles, TestTube2, Wand2 } from "lucide-react";
import { api, type Suggestion } from "../../lib/acp";
import { basename, draftBackendOf, helperProvider, useStore } from "../../lib/store";
import { Button, Logo, Spinner, clsx } from "../ui";
import { pickProject } from "../layout/Sidebar";
import { BackendChoice } from "../agents/BackendChoice";
import { BACKEND_SHORT } from "../../lib/backends";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-bg p-6" data-tauri-drag-region>
      <div className="w-[min(460px,100%)] text-center fade-in">{children}</div>
    </div>
  );
}

export function StartScreen() {
  const phase = useStore((s) => s.phase);
  const error = useStore((s) => s.error);
  const { connect } = useStore.getState();

  return (
    <Shell>
      <div className="mb-6 flex justify-center">
        <Logo size={64} />
      </div>
      {phase === "connecting" && (
        <div className="flex items-center justify-center gap-2 text-muted">
          <Spinner /> Verbinde mit {useStore.getState().prefs.defaultBackend === "vibe" ? "Mistral Vibe" : "dem Agenten"} …
        </div>
      )}
      {phase === "login" && <LoginStep />}
      {phase === "no-vibe" && <InstallStep />}
      {(phase === "login" || phase === "no-vibe") && <BackendChoice />}
      {phase === "error" && (
        <>
          <div className="mb-3 flex justify-center text-bad">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h1 className="text-[1.4em] font-semibold">Verbindung zu Vibe unterbrochen</h1>
          <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-bad-soft p-3 text-left text-[0.85em] text-bad selectable">{error}</pre>
          <Button variant="primary" className="mt-5" onClick={() => connect()}>
            <RefreshCw className="h-4 w-4" /> Neu verbinden
          </Button>
        </>
      )}
    </Shell>
  );
}

/** Erster Start ohne Vibe: Brise installiert es selbst. */
function InstallStep() {
  const install = useStore((s) => s.install);
  const { installVibe, connect } = useStore.getState();
  const log = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [install.lines.length]);
  return (
    <>
      <h1 className="text-[1.6em] font-semibold tracking-tight">Willkommen bei Brise</h1>
      <p className="mt-2 text-fg-2">
        Brise arbeitet mit Mistral Vibe, dem Coding-Agenten von Mistral. Er fehlt auf diesem Rechner noch – Brise installiert ihn für dich in einen eigenen Ordner. Ein Terminal brauchst du dafür nicht.
      </p>
      {!install.running && install.lines.length === 0 && (
        <div className="mt-6 flex flex-col items-center gap-3">
          <Button variant="primary" size="lg" onClick={installVibe}>
            <Download className="h-4 w-4" /> Mistral Vibe installieren
          </Button>
          <button className="text-[0.86em] text-muted hover:text-fg" onClick={() => connect()}>
            Schon installiert? Erneut suchen
          </button>
        </div>
      )}
      {(install.running || install.lines.length > 0) && (
        <div className="mt-6 text-left">
          <div className="mb-2 flex items-center gap-2 text-[0.92em]">
            {install.running ? <Spinner className="text-accent" /> : install.error ? <AlertTriangle className="h-4 w-4 text-bad" /> : <CheckCircle2 className="h-4 w-4 text-ok" />}
            <span>{install.running ? "Installiere … (beim ersten Mal 1–2 Minuten)" : install.error ? "Installation fehlgeschlagen" : "Fertig"}</span>
          </div>
          <pre ref={log} className="h-40 overflow-y-auto rounded-lg border border-line bg-code p-3 font-mono text-[0.75em] text-fg-2 selectable">
            {install.lines.join("\n")}
          </pre>
          {install.error && (
            <>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-bad-soft p-2.5 text-[0.82em] text-bad selectable">{install.error}</pre>
              <Button variant="primary" className="mt-3" onClick={installVibe}>
                <RefreshCw className="h-4 w-4" /> Nochmal versuchen
              </Button>
            </>
          )}
        </div>
      )}
      <p className="mt-6 text-[0.78em] text-muted">Installiert wird das offizielle Paket „mistral-vibe“ mit uv von Astral. Systemdateien und PATH bleiben unverändert.</p>
    </>
  );
}

/** Anmeldung: Browser (Mistral-Konto) oder eingefügter Vibe-/API-Key. */
function LoginStep() {
  const login = useStore((s) => s.login);
  const { doLogin, saveKey } = useStore.getState();
  const [tab, setTab] = useState<"browser" | "key">("browser");
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ valid: boolean; message: string } | null>(null);

  const submitKey = async () => {
    setChecking(true);
    setResult(null);
    try {
      setResult(await saveKey(key));
    } catch (e) {
      setResult({ valid: false, message: String(e) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <h1 className="text-[1.6em] font-semibold tracking-tight">Mit Mistral verbinden</h1>
      <p className="mt-2 text-fg-2">Brise nutzt deinen Mistral-Vibe-Plan (Free, Pro oder Team) oder einen API-Key.</p>
      <div className="mx-auto mt-6 flex w-fit rounded-xl border border-line bg-panel p-1">
        {(
          [
            ["browser", "Im Browser anmelden", Globe],
            ["key", "Key einfügen", KeyRound],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={clsx("flex h-8 items-center gap-2 rounded-lg px-3.5 text-[0.9em]", tab === id ? "bg-elev text-fg shadow-soft" : "text-muted hover:text-fg")}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {tab === "browser" ? (
        <div className="mt-6">
          {login.waiting ? (
            <div className="space-y-3">
              <div className="flex items-center justify-center gap-2 text-muted">
                <Spinner /> Warte auf die Anmeldung im Browser …
              </div>
              {login.url && (
                <button className="text-[0.9em] text-accent hover:underline" onClick={() => openUrl(login.url!)}>
                  Browser hat sich nicht geöffnet? Hier klicken.
                </button>
              )}
            </div>
          ) : (
            <Button variant="primary" size="lg" onClick={doLogin}>
              <LogIn className="h-4 w-4" /> Mit Mistral-Konto anmelden
            </Button>
          )}
          <p className="mt-3 text-[0.82em] text-muted">Empfohlen: Vibe nutzt dann das Kontingent deines Plans.</p>
          {login.error && <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-bad-soft p-3 text-left text-[0.85em] text-bad selectable">{login.error}</pre>}
        </div>
      ) : (
        <div className="mt-6 text-left">
          <label className="mb-1.5 block text-[0.88em] font-medium">Vibe-Key oder API-Key</label>
          <input
            type="password"
            value={key}
            autoFocus
            onChange={(e) => (setKey(e.target.value), setResult(null))}
            onKeyDown={(e) => e.key === "Enter" && key && submitKey()}
            placeholder="Schlüssel einfügen …"
            className="h-10 w-full rounded-lg border border-line bg-elev px-3 font-mono text-[0.9em] outline-none focus:border-accent"
          />
          <p className="mt-2 text-[0.8em] text-muted">
            Vibe-Key: Mistral Studio → Code → Vibe CLI.{" "}
            <button className="text-accent hover:underline" onClick={() => openUrl("https://console.mistral.ai/")}>
              Studio öffnen
            </button>
            <br />
            Gespeichert wird im Schlüsselbund deines Systems – dort, wo auch Vibe selbst ihn ablegt.
          </p>
          {result && (
            <div className={clsx("mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-[0.88em]", result.valid ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad")}>
              {result.valid ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : <AlertTriangle className="mt-0.5 h-4 w-4" />}
              {result.message}
            </div>
          )}
          <Button variant="primary" className="mt-4 w-full" size="lg" disabled={!key.trim() || checking} onClick={submitKey}>
            {checking ? <Spinner /> : <KeyRound className="h-4 w-4" />} Prüfen und speichern
          </Button>
        </div>
      )}
    </>
  );
}

const FALLBACK: Suggestion[] = [
  { icon: "explain", title: "Projekt erklären", description: "Struktur und Architektur im Überblick", prompt: "Erkläre mir die Struktur und Architektur dieses Projekts." },
  { icon: "bug", title: "Fehler finden", description: "Bugs und riskante Stellen aufspüren", prompt: "Suche nach Bugs und riskanten Stellen im Code und schlage Korrekturen vor." },
  { icon: "test", title: "Tests schreiben", description: "Wichtige Funktionen absichern", prompt: "Schreibe sinnvolle Tests für die wichtigsten Funktionen und führe sie aus." },
  { icon: "refactor", title: "Aufräumen", description: "Code vereinfachen", prompt: "Finde Code, der sich vereinfachen lässt, und räume ihn auf." },
];

const ICONS: Record<string, typeof Bug> = {
  bug: Bug,
  test: TestTube2,
  docs: BookOpen,
  refactor: Wand2,
  feature: Rocket,
  explain: FileSearch,
  git: GitBranch,
  perf: Gauge,
  security: ShieldCheck,
};

export function DraftHero({ project }: { project: string }) {
  const send = useStore((s) => s.send);
  const index = useStore((s) => s.index);
  const quickActions = useStore((s) => s.quickActions);
  const agentName = useStore((s) => BACKEND_SHORT[draftBackendOf(s)] ?? "Der Agent");
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [personal, setPersonal] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = async (refresh = false) => {
    setLoading(true);
    const recent = index.filter((x) => x.cwd === project).slice(0, 8).map((x) => x.title ?? "").filter(Boolean);
    try {
      const provider = helperProvider(project);
      if (!provider) throw new Error("ZDR-Projekt ohne Cortecs");
      const list = await api.projectSuggestions(project, recent, useStore.getState().prefs.assistModel, refresh, provider);
      setSuggestions(list.slice(0, 4));
      setPersonal(true);
    } catch {
      setSuggestions((cur) => cur ?? FALLBACK);
      setPersonal(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSuggestions(null);
    load();
  }, [project]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-6">
      <Logo size={44} />
      <h1 className="mt-4 text-[1.6em] font-semibold tracking-tight">Was bauen wir in {basename(project)}?</h1>
      <p className="mt-1 text-muted">{agentName} liest den Code, ändert Dateien und fragt bei heiklen Schritten nach.</p>
      <div className="mt-8 w-full max-w-[720px]">
        <div className="mb-2 flex items-center gap-2 text-[0.78em] text-muted">
          {personal ? <Sparkles className="h-3.5 w-3.5 text-accent" /> : null}
          <span>{personal ? "Vorschläge für dieses Projekt" : loading ? "Analysiere das Projekt …" : "Vorschläge"}</span>
          <div className="flex-1" />
          <button className="flex items-center gap-1 hover:text-fg disabled:opacity-40" disabled={loading} onClick={() => load(true)}>
            <RefreshCw className={clsx("h-3 w-3", loading && "animate-spin")} /> Neu
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {[...quickActions, ...(suggestions ?? [0, 1, 2, 3].map(() => null))].map((s, n) =>
            s ? (
              <button
                key={n}
                onClick={() => send(s.prompt, [])}
                title={s.prompt}
                className="flex items-start gap-3 rounded-xl border border-line bg-elev px-4 py-3 text-left transition hover:border-line-strong hover:shadow-soft fade-in"
              >
                {(() => {
                  const Icon = ICONS[s.icon] ?? Sparkles;
                  return <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />;
                })()}
                <div className="min-w-0">
                  <div className="font-medium">{s.title}</div>
                  <div className="line-clamp-2 text-[0.86em] text-muted">{s.description}</div>
                </div>
              </button>
            ) : (
              <div key={n} className="h-[74px] animate-pulse rounded-xl border border-line bg-panel" />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

export function NoProject() {
  const projects = useStore((s) => s.projects);
  const openProject = useStore((s) => s.openProject);
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6" data-tauri-drag-region>
      <Logo size={56} />
      <h1 className="mt-5 text-[1.7em] font-semibold tracking-tight">Willkommen bei Brise</h1>
      <p className="mt-1 text-muted">Leg ein neues Projekt an oder öffne einen vorhandenen Ordner.</p>
      <div className="mt-6 flex gap-2">
        <Button variant="primary" size="lg" onClick={() => useStore.getState().set({ newProjectOpen: true })}>
          <FolderPlus className="h-4 w-4" /> Neues Projekt
        </Button>
        <Button size="lg" onClick={pickProject}>
          <FolderOpen className="h-4 w-4" /> Ordner öffnen
        </Button>
      </div>
      {projects.length > 0 && (
        <div className="mt-8 w-full max-w-[460px]">
          <div className="mb-1.5 text-[0.78em] font-medium uppercase tracking-wide text-muted">Zuletzt</div>
          <div className="overflow-hidden rounded-xl border border-line bg-elev">
            {projects.slice(0, 6).map((p) => (
              <button key={p} onClick={() => openProject(p)} className="flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left last:border-0 hover:bg-hover">
                <Globe className="h-4 w-4 text-muted" />
                <span className="font-medium">{basename(p)}</span>
                <span className="min-w-0 flex-1 truncate text-right text-[0.82em] text-muted">{p}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
