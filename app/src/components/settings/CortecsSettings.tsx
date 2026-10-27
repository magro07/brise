import { useEffect, useMemo, useState } from "react";
import { KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { CORTECS_DECISION, useProviders } from "../../lib/providers";
import { ModelSelect } from "./ModelSelect";
import { cortecs, type CortecsModel, type CortecsSettings, type CortecsStatus } from "../../lib/cortecs";
import { useStore } from "../../lib/store";
import { Button, Spinner, Switch, clsx } from "../ui";
import { Card, Row } from "./Settings";

const eur = (v: number) => v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 3 });

function useCortecsStatus() {
  const [status, setStatus] = useState<CortecsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    cortecs
      .status()
      .then(setStatus)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);
  const saveSettings = async (patch: Partial<CortecsSettings>) => {
    if (!status) return;
    const settings = { ...status.settings, ...patch };
    await cortecs.saveSettings(settings);
    setStatus({ ...status, settings });
  };
  return { status, error, reload, saveSettings };
}

/** Datenschutz & Sicherheit: Prüfung auf sensible Daten, ZDR-Projekte und Cortecs-Routing. */
export function PrivacyView() {
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const activeProject = useStore((s) => s.activeProject);
  const setView = useStore((s) => s.setView);
  const providers = useProviders((s) => s.list);
  const { status, error, saveSettings } = useCortecsStatus();
  const zdrProviders = providers.filter((p) => p.usable && (p.zdr || p.local));

  return (
    <>
      <Card
        title="Sensible Daten"
        description="Vor dem Senden prüft Brise Prompt und angehängte Textdateien. Erst lokal (Muster, Prüfsummen), nur bei Treffern zusätzlich mit einem Modell – am besten einem ohne Datenspeicherung."
      >
        <Row
          title="Prompts vor dem Senden prüfen"
          description="Personenbezogene Daten und Art. 9 DSGVO, Geschäftsgeheimnisse, Zugangsdaten, § 203 StGB, EU AI Act (verbotene und Hochrisiko-Praktiken)."
          control={<Switch checked={prefs.sensitivityCheck} onChange={(v) => setPrefs({ sensitivityCheck: v })} />}
        />
        <Row
          title="Modell für die zweite Prüfung"
          description="Bekommt nur den Prompt und Ausschnitte rund um lokale Treffer. Automatisch: Cortecs-Decision-Modell, falls ein Cortecs-Schlüssel da ist, sonst nur lokal."
          control={
            <ModelSelect
              value={prefs.taskModels.sensitivity}
              emptyLabel="Automatisch"
              extra={{ cortecs: CORTECS_DECISION }}
              onChange={(sensitivity) => setPrefs({ taskModels: { ...prefs.taskModels, sensitivity } })}
            />
          }
        />
      </Card>

      <Card
        title="Projekte ohne Datenspeicherung (ZDR)"
        description={
          zdrProviders.length
            ? `In diesen Projekten gehen Prompts und Brises Helfer-Aufrufe nur an Modelle ohne Datenspeicherung: ${zdrProviders.map((p) => p.name).join(", ")}.`
            : "Dafür braucht es einen Anbieter ohne Datenspeicherung: Cortecs, einen lokalen Server (Ollama, LM Studio …) oder einen als ZDR markierten Anbieter."
        }
      >
        <Row
          title="Nur ZDR-Modelle in diesen Projekten"
          description={
            prefs.zdrProjects.length ? (
              <span className="flex flex-wrap gap-1">
                {prefs.zdrProjects.map((p) => (
                  <span key={p} className="inline-flex items-center gap-1 rounded border border-line bg-panel px-1.5 font-mono text-[0.9em]">
                    {p}
                    <button aria-label={`${p} entfernen`} className="text-muted hover:text-bad" onClick={() => setPrefs({ zdrProjects: prefs.zdrProjects.filter((x) => x !== p) })}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </span>
            ) : (
              "Noch keine. Im Hinweis über dem Eingabefeld „Immer für dieses Projekt ZDR“ wählen oder hier das aktuelle Projekt hinzufügen."
            )
          }
          control={
            <Button
              size="sm"
              disabled={!activeProject || prefs.zdrProjects.includes(activeProject)}
              onClick={() => activeProject && setPrefs({ zdrProjects: [...prefs.zdrProjects, activeProject] })}
            >
              <Plus className="h-3.5 w-3.5" /> Aktuelles Projekt
            </Button>
          }
        />
        <Row
          title="Sicheres Modell in Vibe"
          description="Ziel von „Auf sicheres Modell (ZDR) wechseln“ und Basis für Auto in ZDR-Sessions."
          control={
            <select
              value={prefs.zdrModel}
              onChange={(e) => setPrefs({ zdrModel: e.target.value })}
              className="h-8 rounded-lg border border-line bg-panel px-2 text-[0.88em]"
              disabled={!status?.vibeModels.length}
            >
              {(status?.vibeModels.length ? status.vibeModels : [prefs.zdrModel]).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          }
        />
      </Card>

      <Card
        title="Cortecs"
        description="Europäischer LLM-Router mit Zero Data Retention: Anbieter speichern weder Anfragen noch Antworten. Den Schlüssel verwaltest du unter Anbieter & Schlüssel."
      >
        {!status?.keyPresent && (
          <Row
            title="Kein Cortecs-Schlüssel"
            control={
              <Button size="sm" onClick={() => setView("settings", "providers")}>
                <KeyRound className="h-3.5 w-3.5" /> Anbieter & Schlüssel
              </Button>
            }
          />
        )}
        <Row
          title="ZDR erzwingen"
          description={
            status?.proxyRunning ? (
              <>
                Jede Cortecs-Anfrage von Vibe läuft über Brise (127.0.0.1:{status.proxyPort}) und bekommt <code>allow_zero_data_retention</code>. Ohne
                laufendes Brise scheitern Cortecs-Modelle in Vibe, statt ohne ZDR zu senden.
              </>
            ) : (
              "Der lokale ZDR-Proxy läuft nicht – Cortecs-Modelle in Vibe sind gesperrt."
            )
          }
          control={<ShieldCheck className={clsx("h-5 w-5", status?.proxyRunning ? "text-ok" : "text-bad")} />}
        />
        <Row
          title="Nur EU-Anbieter (Sovereign Cloud)"
          description="Nur Anbieter mit Sitz und Aufsicht in der EU (eu_native). Kann die Modellauswahl einschränken."
          control={<Switch checked={!!status?.settings.euNative} disabled={!status} onChange={(v) => saveSettings({ euNative: v })} />}
        />
        <Row
          title="Berufsgeheimnis (§ 203 StGB)"
          description={
            <>
              Nur die von Cortecs freigegebenen Anbieter ({status?.secrecyProviders.join(", ")}). Setzt den Professional Secrecy Addendum mit Cortecs
              voraus – ohne ihn reicht die Einschränkung allein nicht.
            </>
          }
          control={<Switch checked={!!status?.settings.secrecy203} disabled={!status} onChange={(v) => saveSettings({ secrecy203: v })} />}
        />
      </Card>
      {error && <p className="text-bad">{error}</p>}
    </>
  );
}

/** Agenten → Vibe: Cortecs-Modelle und Hilfsaufrufe in Vibe. */
export function CortecsVibe({ onModelsChanged }: { onModelsChanged: () => void }) {
  const refreshCortecs = useStore((s) => s.refreshCortecs);
  const { status, reload } = useCortecsStatus();
  const changed = () => {
    reload();
    refreshCortecs();
    onModelsChanged();
  };
  return (
    <>
      <Card title="Hilfsaufrufe von Vibe">
        <Row
          title="Titel und Smart-Approve über das aktive Modell"
          description="Sonst erzeugt Vibe sie mit einem schnellen Mistral-Modell direkt bei Mistral – mit Inhalten aus dem Prompt. Empfohlen bei ZDR-Projekten."
          control={
            <Switch
              checked={!!status?.utilityActive}
              disabled={!status}
              onChange={async (v) => {
                await cortecs.utilityActive(v);
                reload();
                onModelsChanged();
              }}
            />
          }
        />
      </Card>
      {status?.keyPresent && <CortecsModelsCard installed={status.vibeModels} onAdded={changed} />}
    </>
  );
}

function CortecsModelsCard({ installed, onAdded }: { installed: string[]; onAdded: () => void }) {
  const [models, setModels] = useState<CortecsModel[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    cortecs
      .models()
      .then(setModels)
      .catch((e) => setError(String(e)));
  }, []);
  const list = useMemo(
    () =>
      (models ?? [])
        .filter((m) => m.tags.includes("Tools") && (!filter || m.id.includes(filter.toLowerCase())))
        .sort((a, b) => Number(b.zdr) - Number(a.zdr) || a.id.localeCompare(b.id)),
    [models, filter],
  );
  const aliasOf = (id: string) => `cortecs-${id.replace(/[./:]/g, "-")}`;
  return (
    <Card title="Cortecs-Modelle für Vibe" description="Preise in EUR pro 1 Mio. Tokens (Eingabe / Ausgabe) laut Cortecs. Nur Modelle mit ZDR lassen sich hinzufügen.">
      <div className="px-4 py-2.5">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Modelle filtern …"
          className="h-8 w-full rounded-lg border border-line bg-bg px-3 text-[0.88em] outline-none focus:border-accent"
        />
      </div>
      {!models && !error && (
        <div className="flex items-center gap-2 px-4 py-3 text-muted">
          <Spinner /> Lade Katalog …
        </div>
      )}
      {error && <div className="px-4 py-3 text-bad">{error}</div>}
      <div className="max-h-96 overflow-y-auto">
        {list.map((m) => {
          const has = installed.includes(aliasOf(m.id));
          return (
            <Row
              key={m.id}
              title={
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-[0.92em]">{m.id}</span>
                  {m.zdr ? (
                    <span className="rounded bg-ok-soft px-1 text-[0.75em] font-medium text-ok">ZDR</span>
                  ) : (
                    <span className="rounded bg-bad-soft px-1 text-[0.75em] font-medium text-bad">speichert</span>
                  )}
                  {m.euNative && <span className="rounded bg-accent-soft px-1 text-[0.75em] text-accent">EU</span>}
                </span>
              }
              description={`${eur(m.inputPrice)} € / ${eur(m.outputPrice)} € · ${m.providers.join(", ")}${m.context ? ` · ${Math.round(m.context / 1000)}k Kontext` : ""}`}
              control={
                <Button
                  size="sm"
                  disabled={!m.zdr || has || busy === m.id}
                  onClick={async () => {
                    setBusy(m.id);
                    try {
                      await cortecs.addModel(m.id);
                      onAdded();
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {has ? "Eingetragen" : busy === m.id ? <Spinner /> : <Plus className="h-3.5 w-3.5" />}
                </Button>
              }
            />
          );
        })}
      </div>
    </Card>
  );
}
