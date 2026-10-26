import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { basename, useStore } from "../../lib/store";
import { confirmAction } from "../../lib/dialogs";
import { placeholder, SCOPE_LABEL, secretsApi, type SecretMeta, type SecretScope } from "../../lib/secrets";
import { SecretCreate } from "../secrets/SecretPrompt";
import { Button } from "../ui";
import { Card, Row } from "./Settings";

const where = (m: SecretMeta) => (m.scope === "project" && m.project ? basename(m.project) : m.scope === "session" ? "bis Brise beendet wird" : "alle Projekte");

/** Einstellungen → Freigaben & Sicherheit: Secrets auflisten (nur Namen), löschen, Geltungsbereich ändern. */
export function SecretsCard() {
  const [list, setList] = useState<SecretMeta[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeProject = useStore((s) => s.activeProject);
  const reload = () => secretsApi.list().then(setList).catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
    reload();
  };

  return (
    <Card
      title="Secrets"
      description={
        <>
          Passwörter, API-Keys und Tokens für den Agenten. Die Werte liegen nur im Schlüsselbund des Systems; der Agent sieht nur Platzhalter wie{" "}
          <span className="font-mono">{placeholder("GITHUB_TOKEN")}</span> und setzt sie erst bei der Ausführung ein.
        </>
      }
    >
      {list?.length === 0 && !adding && <div className="px-4 py-3.5 text-[0.9em] text-muted">Noch keine Secrets gespeichert.</div>}
      {list?.map((m) => (
        <Row
          key={`${m.scope}:${m.project ?? m.sessionId ?? ""}:${m.name}`}
          title={
            <span className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 text-muted" />
              <span className="font-mono">{m.name}</span>
            </span>
          }
          description={
            <>
              {where(m)}
              {m.purpose && <> · {m.purpose}</>}
            </>
          }
          control={
            <div className="flex items-center gap-1.5">
              <select
                aria-label={`Gültigkeit von ${m.name}`}
                value={m.scope}
                onChange={(e) => {
                  const next = e.target.value as SecretScope;
                  const project = m.project ?? activeProject ?? undefined;
                  if (next === "project" && !project) return setError("Für „Dieses Projekt“ zuerst ein Projekt öffnen.");
                  act(() => secretsApi.setScope(m, next, project));
                }}
                className="h-8 rounded-lg border border-line bg-elev px-2 text-[0.9em] outline-none focus:border-accent"
              >
                {m.scope === "session" && <option value="session">{SCOPE_LABEL.session}</option>}
                <option value="project">{SCOPE_LABEL.project}</option>
                <option value="global">{SCOPE_LABEL.global}</option>
              </select>
              <Button
                variant="danger"
                size="sm"
                aria-label={`${m.name} löschen`}
                onClick={async () => {
                  if (await confirmAction(`Secret ${m.name} (${where(m)}) aus dem Schlüsselbund löschen?`, true)) act(() => secretsApi.remove(m));
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          }
        />
      ))}
      {adding ? (
        <div className="p-3">
          <SecretCreate
            project={activeProject ?? ""}
            onSaved={() => {
              setAdding(false);
              reload();
            }}
            onClose={() => setAdding(false)}
          />
        </div>
      ) : (
        <div className="px-4 py-2.5">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Secret hinzufügen
          </Button>
        </div>
      )}
      {error && <div className="px-4 py-2.5 text-[0.86em] text-bad">{error}</div>}
    </Card>
  );
}
