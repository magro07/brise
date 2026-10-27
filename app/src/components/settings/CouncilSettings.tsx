import { useEffect, useState } from "react";
import { Plus, RotateCcw, Scale, X } from "lucide-react";
import { COUNCIL_DEFAULTS, useStore, type CouncilPrefs } from "../../lib/store";
import { CouncilCard } from "../chat/Council";
import { councilApi, euro, reviewDiff, type CouncilRun } from "../../lib/council";
import { Button, Spinner, clsx } from "../ui";
import { refLabel, refUsable, useProviders } from "../../lib/providers";
import { ModelSelect } from "./ModelSelect";
import { Card, Row } from "./Settings";

const SELECT = "h-8 min-w-[200px] rounded-lg border border-line bg-elev px-2 text-[0.92em] outline-none focus:border-accent";

/** Modelle einer Rolle als Chips, Reihenfolge = Reihenfolge der Meinungen. Jeder Anbieter mit Schlüssel. */
function ModelList({ value, onChange, testId }: { value: string[]; onChange: (v: string[]) => void; testId?: string }) {
  const [adding, setAdding] = useState(false);
  const list = useProviders((s) => s.list);
  return (
    <div className="flex max-w-[380px] flex-wrap items-center justify-end gap-1" data-testid={testId}>
      {value.map((m, n) => (
        <span
          key={`${m}-${n}`}
          className={clsx("inline-flex items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-0.5 font-mono text-[0.8em]", !refUsable(m, list) && list.length > 0 && "text-muted line-through")}
          title={refUsable(m, list) || !list.length ? undefined : "Kein Schlüssel für diesen Anbieter – wird übersprungen"}
        >
          {refLabel(m, list)}
          {value.length > 1 && (
            <button className="text-muted hover:text-bad" onClick={() => onChange(value.filter((_, i) => i !== n))} aria-label={`${m} entfernen`}>
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {adding ? (
        <ModelSelect
          value=""
          emptyLabel="Modell wählen …"
          onChange={(m) => {
            if (m) onChange([...value, m]);
            setAdding(false);
          }}
          className="h-7 min-w-[200px] text-[0.85em]"
          testId={testId && `${testId}-add`}
        />
      ) : (
        value.length < 5 && (
          <button className="flex h-6 w-6 items-center justify-center rounded-md border border-dashed border-line text-muted hover:text-fg" onClick={() => setAdding(true)} aria-label="Modell hinzufügen">
            <Plus className="h-3 w-3" />
          </button>
        )
      )}
    </div>
  );
}

export function CouncilSettings() {
  const council = useStore((s) => s.prefs.council);
  const setPrefs = useStore((s) => s.setPrefs);
  const [today, setToday] = useState<{ spentEur: number; limitEur: number } | null>(null);
  const [limit, setLimit] = useState(String(council.dailyLimitEur));
  const set = (p: Partial<CouncilPrefs>) => setPrefs({ council: { ...council, ...p } });

  useEffect(() => {
    councilApi.today().then(setToday).catch(() => {});
  }, []);
  useEffect(() => setLimit(String(council.dailyLimitEur)), [council.dailyLimitEur]);

  const off = council.mode === "off";
  return (
    <>
      <Card
        title="Model Council"
        description="Der Agent kann andere Modelle um Rat fragen: Sie prüfen Änderungen unabhängig voneinander in eigenen Rollen (Gutachter, Bug-Jäger, Skeptiker), ein Vorsitz-Modell führt die Urteile zusammen. Im Chat erscheint dazu eine eigene Karte."
      >
        <Row
          title={
            <span className="flex items-center gap-2">
              <Scale className="h-4 w-4 text-accent" /> Wann
            </span>
          }
          description="Gilt für neue Sessions. „Mit Council prüfen“ unter Antworten und im Git-Panel geht immer, außer bei „Aus“."
          control={
            <select value={council.mode} onChange={(e) => set({ mode: e.target.value as CouncilPrefs["mode"] })} className={SELECT}>
              <option value="auto">Automatisch (Agent entscheidet)</option>
              <option value="request">Nur auf Wunsch</option>
              <option value="off">Aus</option>
            </select>
          }
        />
        <Row
          title="Meinungen je Aufruf"
          description="Drei erlauben eine echte Mehrheit. Jede Meinung kostet einen Modellaufruf."
          control={
            <select value={council.opinions} disabled={off} onChange={(e) => set({ opinions: Number(e.target.value) })} className={SELECT}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          }
        />
        <Row
          title="Tageslimit"
          description={
            <>
              Darüber lehnt das Council ab (0 = ohne Limit). Heute verbraucht: {today ? euro(today.spentEur) : "…"}. Geschätzt nach Preistabelle bzw. den Preisen des Anbieters.
            </>
          }
          control={
            <div className="flex items-center gap-1.5">
              <input
                value={limit}
                type="number"
                min={0}
                step={0.5}
                disabled={off}
                onChange={(e) => setLimit(e.target.value)}
                onBlur={() => {
                  const n = Math.max(0, parseFloat(limit.replace(",", ".")) || 0);
                  if (n !== council.dailyLimitEur) set({ dailyLimitEur: n });
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                className="h-8 w-[90px] rounded-lg border border-line bg-elev px-2.5 text-right text-[0.92em] outline-none focus:border-accent"
              />
              <span className="text-muted">€</span>
            </div>
          }
        />
      </Card>

      <Card title="Modelle je Rolle" description="Meinung 1 bekommt das erste Modell, Meinung 2 das zweite usw. Modelle verschiedener Anbieter mischen sich gut – unterschiedliche Modellfamilien übersehen unterschiedliche Fehler. Durchgestrichen: kein Schlüssel für den Anbieter.">
        <Row title="Review" description="council_review: Befunde mit Schweregrad und Datei:Zeile" control={<ModelList testId="council-review" value={council.review} onChange={(review) => set({ review })} />} />
        <Row title="Fehlersuche" description="council_debug: priorisierte Hypothesen" control={<ModelList testId="council-debug" value={council.debug} onChange={(debug) => set({ debug })} />} />
        <Row title="Schlussprüfung" description="council_verify: bestätigt, Einwände oder unklar" control={<ModelList testId="council-verify" value={council.verify} onChange={(verify) => set({ verify })} />} />
        <Row
          title="Vorsitz"
          description="Führt die Urteile zusammen und prüft jeden Befund am Code. Ohne Vorsitz gruppiert Brise selbst (günstiger, ungenauer)."
          control={
            <ModelSelect value={council.chair} emptyLabel="Ohne – Brise gruppiert" onChange={(chair) => set({ chair })} testId="council-chair" />
          }
        />
        <Row
          title="Denkaufwand"
          description="Wie lange Denk-Modelle nachdenken (wo der Anbieter das unterstützt). Hoch ist gründlicher, aber deutlich langsamer."
          control={
            <select value={council.effort} onChange={(e) => set({ effort: e.target.value as CouncilPrefs["effort"] })} className={SELECT}>
              <option value="low">Niedrig (schnell)</option>
              <option value="high">Hoch</option>
            </select>
          }
        />
        <Row
          title="Zeitlimit je Modell"
          description="Antwortet ein Modell nicht rechtzeitig, zählt das Ergebnis der übrigen."
          control={
            <select value={council.timeoutSecs} onChange={(e) => set({ timeoutSecs: Number(e.target.value) })} className={SELECT}>
              {[60, 120, 180, 300].map((n) => (
                <option key={n} value={n}>
                  {n} s
                </option>
              ))}
            </select>
          }
        />
      </Card>
      <Button variant="ghost" size="sm" onClick={() => setPrefs({ council: COUNCIL_DEFAULTS })}>
        <RotateCcw className="h-3.5 w-3.5" /> Auf Standard zurücksetzen
      </Button>
    </>
  );
}

/** Git-Panel: aktuellen Diff direkt vom Council prüfen lassen. */
export function CouncilDiffButton({ cwd }: { cwd: string }) {
  const off = useStore((s) => s.prefs.council.mode === "off");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<CouncilRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (off) return null;
  return (
    <div className="mt-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setRun(null);
          try {
            setRun(await reviewDiff(cwd));
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner /> : <Scale className="h-3.5 w-3.5" />} Mit Council prüfen
      </Button>
      {busy && !run && <p className="px-2 text-[0.8em] text-muted">Mehrere Modelle prüfen den Diff – das Ergebnis erscheint im Chat.</p>}
      {(run || error) && (
        <div className="mt-2">
          <CouncilCard run={run} tool="review" running={false} error={error ?? undefined} />
        </div>
      )}
    </div>
  );
}
