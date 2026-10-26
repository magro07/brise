import { useEffect, useState } from "react";
import { ArrowRight, Download } from "lucide-react";
import { api } from "../../lib/acp";
import { useStore } from "../../lib/store";
import { Button, Spinner } from "../ui";

/**
 * Startbildschirm ohne (angemeldetes) Vibe: stattdessen mit einem anderen
 * Agenten arbeiten, z. B. Claude Code mit dem eigenen Claude-Abo.
 */
export function BackendChoice() {
  const backends = useStore((s) => s.backends);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { refreshBackends, setPrefs, connect } = useStore.getState();
  useEffect(() => {
    refreshBackends();
  }, []);
  const others = backends.filter((b) => b.id !== "vibe" && (b.installed || !b.installBlocker));
  if (!others.length) return null;

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
      useStore.setState((s) => ({ install: { ...s.install, running: false } }));
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-8 border-t border-line pt-5 text-left">
      <div className="mb-2 text-[0.86em] text-muted">Oder mit einem anderen Agenten arbeiten:</div>
      <div className="flex flex-col gap-1.5">
        {others.map((b) => (
          <Button key={b.id} variant="secondary" className="justify-between" disabled={busy !== null} onClick={() => use(b.id, b.installed)}>
            <span>{b.installed ? `Mit ${b.title} arbeiten` : `${b.title} installieren und nutzen`}</span>
            {busy === b.id ? <Spinner className="h-3.5 w-3.5" /> : b.installed ? <ArrowRight className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
          </Button>
        ))}
      </div>
      {error && <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-bad-soft p-2.5 text-[0.82em] text-bad selectable">{error}</pre>}
    </div>
  );
}
