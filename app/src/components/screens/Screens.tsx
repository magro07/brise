import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, Bug, FileSearch, FolderOpen, Globe, LogIn, RefreshCw, TestTube2, Wand2 } from "lucide-react";
import { basename, useStore } from "../../lib/store";
import { Button, Logo, Spinner } from "../ui";
import { pickProject } from "../layout/Sidebar";

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
  const login = useStore((s) => s.login);
  const { connect, doLogin } = useStore.getState();

  return (
    <Shell>
      <div className="mb-6 flex justify-center">
        <Logo size={64} />
      </div>
      {phase === "connecting" && (
        <div className="flex items-center justify-center gap-2 text-muted">
          <Spinner /> Verbinde mit Mistral Vibe …
        </div>
      )}
      {phase === "login" && (
        <>
          <h1 className="text-[1.6em] font-semibold tracking-tight">Willkommen bei Brise</h1>
          <p className="mt-2 text-fg-2">Melde dich mit deinem Mistral-Konto an. Brise nutzt deinen Vibe-Plan (Free, Pro oder Team), du brauchst keinen API-Key.</p>
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
                <LogIn className="h-4 w-4" /> Mit Mistral anmelden
              </Button>
            )}
          </div>
          {login.error && <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-bad-soft p-3 text-left text-[0.85em] text-bad selectable">{login.error}</pre>}
        </>
      )}
      {phase === "no-vibe" && (
        <>
          <h1 className="text-[1.5em] font-semibold tracking-tight">Mistral Vibe fehlt noch</h1>
          <p className="mt-2 text-fg-2">Brise ist die Oberfläche, Vibe der Coding-Agent dahinter. Installiere Vibe einmalig – die automatische Installation folgt in einer späteren Version.</p>
          <pre className="mt-4 rounded-lg border border-line bg-code p-3 text-left font-mono text-[0.85em] selectable">curl -LsSf https://mistral.ai/vibe/install.sh | bash</pre>
          <p className="mt-2 text-[0.85em] text-muted">
            Windows: <code className="font-mono">uv tool install mistral-vibe</code>
          </p>
          <Button variant="primary" className="mt-5" onClick={() => connect()}>
            <RefreshCw className="h-4 w-4" /> Erneut prüfen
          </Button>
        </>
      )}
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

const SUGGESTIONS = [
  { icon: FileSearch, title: "Projekt erklären", prompt: "Erkläre mir die Struktur und Architektur dieses Projekts." },
  { icon: Bug, title: "Fehler finden", prompt: "Suche nach Bugs und riskanten Stellen im Code und schlage Korrekturen vor." },
  { icon: TestTube2, title: "Tests schreiben", prompt: "Schreibe sinnvolle Tests für die wichtigsten Funktionen und führe sie aus." },
  { icon: Wand2, title: "Aufräumen", prompt: "Finde Code, der sich vereinfachen lässt, und räume ihn auf." },
];

export function DraftHero({ project }: { project: string }) {
  const send = useStore((s) => s.send);
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-6">
      <Logo size={44} />
      <h1 className="mt-4 text-[1.6em] font-semibold tracking-tight">Was bauen wir in {basename(project)}?</h1>
      <p className="mt-1 text-muted">Vibe liest den Code, ändert Dateien und fragt bei heiklen Schritten nach.</p>
      <div className="mt-8 grid w-full max-w-[720px] grid-cols-2 gap-2.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            onClick={() => send(s.prompt, [])}
            className="flex items-start gap-3 rounded-xl border border-line bg-elev px-4 py-3 text-left transition hover:border-line-strong hover:shadow-soft"
          >
            <s.icon className="mt-0.5 h-4 w-4 text-accent" />
            <div>
              <div className="font-medium">{s.title}</div>
              <div className="text-[0.86em] text-muted">{s.prompt}</div>
            </div>
          </button>
        ))}
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
      <p className="mt-1 text-muted">Wähle einen Projektordner, in dem Vibe arbeiten soll.</p>
      <Button variant="primary" size="lg" className="mt-6" onClick={pickProject}>
        <FolderOpen className="h-4 w-4" /> Projektordner öffnen
      </Button>
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
