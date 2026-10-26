import { useEffect, useState } from "react";
import { ArrowRight, Download } from "lucide-react";
import { api } from "../../lib/acp";
import { useStore } from "../../lib/store";
import { Spinner, clsx } from "../ui";

/**
 * Erststart: Agent wählen. Vibe ist dabei eines von mehreren Backends –
 * wer kein Vibe hat, startet gleichwertig mit Claude Code, Codex oder Gemini.
 * `withVibe` zeigt Vibe als ersten Eintrag (Erststart ohne Vibe); sonst nur
 * die übrigen Backends unter einer Trennlinie (Vibe da, aber nicht angemeldet).
 */
export function BackendChoice({ withVibe = false }: { withVibe?: boolean }) {
  const backends = useStore((s) => s.backends);
  const install = useStore((s) => s.install);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { refreshBackends, setPrefs, connect, installVibe } = useStore.getState();
  useEffect(() => {
    refreshBackends();
  }, []);
  const others = backends.filter((b) => b.id !== "vibe");
  if (!withVibe && !others.some((b) => b.installed || !b.installBlocker)) return null;

  const use = async (id: string, installed: boolean) => {
    setBusy(id);
    setError(null);
    try {
      if (!installed) {
        useStore.setState({ install: { running: true, lines: [] } });
        await api.installBackend(id);
        useStore.setState((s) => ({ install: { ...s.install, running: false } }));
      }
      const enabled = useStore.getState().prefs.enabledBackends;
      setPrefs({ defaultBackend: id, enabledBackends: [...new Set([...enabled, id])] });
      await connect();
    } catch (e) {
      useStore.setState((s) => ({ install: { ...s.install, running: false, error: String(e) } }));
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const vibe = backends.find((b) => b.id === "vibe");
  return (
    <div className={clsx("text-left", withVibe ? "mt-6" : "mt-8 border-t border-line pt-5")}>
      <div className="mb-2 text-[0.86em] text-muted">{withVibe ? "Womit möchtest du arbeiten?" : "Oder mit einem anderen Agenten arbeiten:"}</div>
      <div className="flex flex-col gap-1.5">
        {withVibe && (
          <Choice
            title="Mistral Vibe installieren und nutzen"
            description={vibe?.description ?? "Coding-Agent von Mistral. Mistral-Konto oder API-Key."}
            icon={<Download className="h-3.5 w-3.5" />}
            disabled={busy !== null || install.running}
            onClick={installVibe}
          />
        )}
        {others.map((b) => (
          <Choice
            key={b.id}
            title={b.installed ? `Mit ${b.title} arbeiten` : `${b.title} installieren und nutzen`}
            description={!b.installed && b.installBlocker ? b.installBlocker : b.description}
            icon={busy === b.id ? <Spinner className="h-3.5 w-3.5" /> : b.installed ? <ArrowRight className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
            disabled={busy !== null || install.running || (!b.installed && !!b.installBlocker)}
            onClick={() => use(b.id, b.installed)}
          />
        ))}
      </div>
      {withVibe && <p className="mt-2 text-[0.78em] text-muted">Weitere Agenten lassen sich später in den Einstellungen hinzunehmen, je Session wählst du, welcher arbeitet.</p>}
      {error && <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-bad-soft p-2.5 text-[0.82em] text-bad selectable">{error}</pre>}
    </div>
  );
}

function Choice({ title, description, icon, disabled, onClick }: { title: string; description: string; icon: React.ReactNode; disabled: boolean; onClick: () => void }) {
  return (
    <button
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-elev px-3 py-2 text-left text-[0.93em] font-medium text-fg transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="min-w-0">
        <span className="block">{title}</span>
        <span className="block whitespace-normal text-[0.8em] font-normal text-muted">{description.replace(/`/g, "")}</span>
      </span>
      <span className="shrink-0">{icon}</span>
    </button>
  );
}
