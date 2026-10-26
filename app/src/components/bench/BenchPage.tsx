import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check as CheckIcon, Copy, FolderOpen, Pencil, Play, Plus, RotateCcw, Square, Trash2, X } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { benchApi, median, useBenchRun, watchBench, type BenchRun, type BenchSummary, type Benchmark, type TaskResult } from "../../lib/bench";
import { duration, latency, tokens } from "../../lib/format";
import { confirmAction } from "../../lib/dialogs";
import { Button, Spinner, Tip, clsx } from "../ui";
import { eur } from "../usage/usage";
import { BenchEditor } from "./BenchEditor";

function Card({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="flex-1 text-[0.95em] font-semibold">{title}</h3>
        {actions}
      </div>
      {description && <p className="mb-2 text-[0.88em] text-muted">{description}</p>}
      <div className="overflow-hidden rounded-xl border border-line bg-elev">{children}</div>
    </section>
  );
}

const dateTime = (ts: number) => new Date(ts).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const pct = (n: number) => `${Math.round(n * 100)} %`;

const STATUS: Record<string, string> = { running: "läuft", done: "fertig", cancelled: "abgebrochen", failed: "fehlgeschlagen" };

export function BenchPage() {
  const [list, setList] = useState<BenchSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Benchmark | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useBenchRun((s) => s.run);
  const seq = useBenchRun((s) => s.seq);

  const refresh = useCallback(() => {
    benchApi
      .list()
      .then((l) => {
        setList(l);
        setSelected((cur) => (cur && l.some((b) => b.id === cur) ? cur : (l[0]?.id ?? null)));
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    watchBench();
    refresh();
  }, [refresh]);

  // Nach dem Ende eines Laufs die Übersicht auffrischen.
  useEffect(() => {
    if (live && live.status !== "running") refresh();
  }, [live?.status, live?.id]);

  const start = async (id: string) => {
    setError(null);
    try {
      await benchApi.run(id);
      setSelected(id);
    } catch (e) {
      setError(String(e));
    }
  };

  const edit = async (id: string | null, copy = false) => {
    setError(null);
    if (!id) return setEditing({ name: "", description: "", tasks: [], targets: [] });
    try {
      const b = await benchApi.get(id);
      setEditing(copy ? { ...b, id: undefined, name: `${b.name} (Kopie)` } : b);
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (b: BenchSummary) => {
    if (!(await confirmAction(`Benchmark „${b.name}“ löschen? Die Datei ${b.id}.json wird entfernt, bisherige Läufe bleiben für den Verlauf erhalten.`, true))) return;
    await benchApi.remove(b.id, false).catch((e) => setError(String(e)));
    refresh();
  };

  if (editing)
    return (
      <BenchEditor
        initial={editing}
        onCancel={() => setEditing(null)}
        onSaved={(id) => {
          setEditing(null);
          setSelected(id);
          refresh();
        }}
      />
    );

  const running = live?.status === "running" ? live : null;

  return (
    <>
      <p className="mb-5 text-[0.9em] text-muted">
        Eigene Aufgaben mit Prüfkriterien gegen mehrere Modelle und Agenten laufen lassen – jede Kombination in einer frischen Session in einem eigenen Arbeitsordner, das
        echte Projekt bleibt unberührt. Dauer, Tokens, Kosten, erstes Token und t/s landen auch im Nutzungsjournal.
      </p>
      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[0.9em] text-bad selectable">
          <span className="flex-1 whitespace-pre-wrap">{error}</span>
          <button onClick={() => setError(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <Card
        title="Benchmarks"
        description="Definitionen liegen als JSON im Datenordner und lassen sich auch dort bearbeiten oder versionieren."
        actions={
          <>
            <Tip label="Ordner öffnen">
              <Button size="sm" variant="ghost" onClick={async () => revealItemInDir(await benchApi.dir())}>
                <FolderOpen className="h-3.5 w-3.5" />
              </Button>
            </Tip>
            <Tip label="Neu laden">
              <Button size="sm" variant="ghost" onClick={refresh}>
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </Tip>
            <Button size="sm" onClick={() => edit(null)}>
              <Plus className="h-3.5 w-3.5" /> Neu
            </Button>
          </>
        }
      >
        {list === null ? (
          <div className="flex items-center gap-2 px-4 py-3.5 text-muted">
            <Spinner /> Lade …
          </div>
        ) : list.length === 0 ? (
          <div className="px-4 py-3.5 text-muted">Noch keine Benchmarks.</div>
        ) : (
          <div className="divide-y divide-line">
            {list.map((b) => (
              <div
                key={b.id}
                onClick={() => setSelected(b.id)}
                className={clsx("flex cursor-pointer items-center gap-4 px-4 py-3", selected === b.id ? "bg-active" : "hover:bg-hover")}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{b.name}</div>
                  <div className="truncate text-[0.85em] text-muted">
                    {b.error ? (
                      <span className="text-bad">{b.error}</span>
                    ) : (
                      <>
                        {b.tasks} Aufgaben · {b.targets} Ziele
                        {b.lastRun && ` · zuletzt ${dateTime(b.lastRun.started)}: ${b.lastRun.passed}/${b.lastRun.total} bestanden`}
                        {b.lastRun && b.lastRun.status !== "done" && ` (${STATUS[b.lastRun.status] ?? b.lastRun.status})`}
                      </>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  {running?.benchId === b.id ? (
                    <Button size="sm" variant="danger" onClick={() => benchApi.cancel()}>
                      <Square className="h-3.5 w-3.5" /> Abbrechen
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" disabled={!!running || !!b.error} onClick={() => start(b.id)}>
                      <Play className="h-3.5 w-3.5" /> Starten
                    </Button>
                  )}
                  <Tip label="Bearbeiten">
                    <Button size="sm" variant="ghost" disabled={!!b.error} onClick={() => edit(b.id)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </Tip>
                  <Tip label="Kopieren">
                    <Button size="sm" variant="ghost" disabled={!!b.error} onClick={() => edit(b.id, true)}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </Tip>
                  <Tip label="Löschen">
                    <Button size="sm" variant="ghost" onClick={() => remove(b)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </Tip>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {selected && <BenchResults key={selected} id={selected} seq={seq} live={live?.benchId === selected ? live : null} onError={setError} />}
    </>
  );
}

// ---------- Ergebnisse eines Benchmarks ----------

function BenchResults({ id, seq, live, onError }: { id: string; seq: number; live: BenchRun | null; onError: (e: string) => void }) {
  const [runs, setRuns] = useState<BenchRun[] | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ task: string; target: string } | null>(null);

  useEffect(() => {
    benchApi
      .runs(id)
      .then(setRuns)
      .catch((e) => onError(String(e)));
  }, [id, live?.status, live?.id]);

  // Der laufende Lauf kommt live über das Event, nicht aus der Datei.
  const all = useMemo(() => {
    const list = (runs ?? []).filter((r) => r.id !== live?.id);
    return live ? [...list, live] : list;
  }, [runs, live, seq]);
  const run = all.find((r) => r.id === runId) ?? all[all.length - 1];

  if (runs === null) return null;
  if (!run)
    return (
      <Card title="Ergebnisse">
        <div className="px-4 py-3.5 text-muted">Noch kein Lauf. „Starten“ führt alle Aufgaben gegen alle Ziele aus.</div>
      </Card>
    );

  const index = all.indexOf(run);
  const previous = index > 0 ? all[index - 1] : null;
  const history = all.slice(0, index + 1);
  const shown = detail && run.results.find((r) => r.task === detail.task && r.target === detail.target);

  return (
    <>
      {run.status === "running" && <Progress run={run} />}
      <Card
        title={
          <span className="flex items-center gap-2">
            Ergebnisse
            <select
              value={run.id}
              onChange={(e) => (setRunId(e.target.value), setDetail(null))}
              className="h-7 rounded-md border border-line bg-elev px-1.5 text-[0.86em] font-normal"
            >
              {[...all].reverse().map((r) => (
                <option key={r.id} value={r.id}>
                  {dateTime(r.started)} · {STATUS[r.status] ?? r.status}
                </option>
              ))}
            </select>
          </span>
        }
        description="Zeilen sind Aufgaben, Spalten Ziele. Die Punkte darunter zeigen dieselbe Kombination in früheren Läufen (links alt, rechts dieser Lauf). Klick auf eine Zelle zeigt Details."
        actions={
          run.status !== "running" && (
            <Tip label="Diesen Lauf löschen">
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (!(await confirmAction("Diesen Lauf aus dem Verlauf löschen?", true))) return;
                  await benchApi.removeRun(id, run.id).catch((e) => onError(String(e)));
                  setRunId(null);
                  setRuns((rs) => rs?.filter((r) => r.id !== run.id) ?? null);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </Tip>
          )
        }
      >
        <Matrix run={run} previous={previous} history={history} selected={detail} onSelect={setDetail} />
      </Card>
      {shown && <ResultDetail result={shown} run={run} onClose={() => setDetail(null)} />}
      {all.length > 1 && <History runs={all} />}
    </>
  );
}

function Progress({ run }: { run: BenchRun }) {
  const done = run.results.length;
  return (
    <div className="mb-6 rounded-xl border border-line bg-elev px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[0.9em]">
        <Spinner />
        <span className="min-w-0 flex-1 truncate">{run.current ? `Läuft: ${run.current}` : "Bereite vor …"}</span>
        <span className="tabular-nums text-muted">
          {done}/{run.total}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-hover">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(done / Math.max(run.total, 1)) * 100}%` }} />
      </div>
    </div>
  );
}

function resultFor(run: BenchRun, task: string, target: string): TaskResult | undefined {
  return run.results.find((r) => r.task === task && r.target === target);
}

function Matrix({
  run,
  previous,
  history,
  selected,
  onSelect,
}: {
  run: BenchRun;
  previous: BenchRun | null;
  history: BenchRun[];
  selected: { task: string; target: string } | null;
  onSelect: (s: { task: string; target: string } | null) => void;
}) {
  const totals = run.targets.map((t) => {
    const rs = run.results.filter((r) => r.target === t.key);
    const prev = previous?.results.filter((r) => r.target === t.key) ?? [];
    const costs = rs.map((r) => r.costEur).filter((c): c is number => c != null);
    return {
      key: t.key,
      passed: rs.filter((r) => r.passed).length,
      count: rs.length,
      score: rs.length ? rs.reduce((a, r) => a + r.score, 0) / rs.length : null,
      prevScore: prev.length ? prev.reduce((a, r) => a + r.score, 0) / prev.length : null,
      ms: rs.reduce((a, r) => a + r.durationMs, 0),
      cost: costs.length ? costs.reduce((a, c) => a + c, 0) : null,
      tokens: rs.reduce((a, r) => a + r.input + r.output, 0),
      ttft: median(rs.map((r) => r.ttftMs)),
      tps: median(rs.map((r) => r.outputTps)),
    };
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[0.86em]">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="px-3 py-2 font-medium">Aufgabe</th>
            {run.targets.map((t) => (
              <th key={t.key} className="min-w-[130px] px-3 py-2 font-medium" title={t.key}>
                {t.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.tasks.map((task) => (
            <tr key={task.id} className="border-b border-line">
              <td className="px-3 py-2 align-top font-medium">{task.name}</td>
              {run.targets.map((t) => {
                const r = resultFor(run, task.id, t.key);
                const active = selected?.task === task.id && selected.target === t.key;
                const past = history.map((h) => resultFor(h, task.id, t.key));
                return (
                  <td key={t.key} className="px-1.5 py-1.5 align-top">
                    <button
                      disabled={!r}
                      onClick={() => onSelect(active ? null : { task: task.id, target: t.key })}
                      className={clsx("w-full rounded-lg px-1.5 py-1 text-left", active ? "bg-active" : r && "hover:bg-hover")}
                    >
                      {r ? <Cell r={r} /> : <span className="text-muted">{run.status === "running" ? "wartet" : "–"}</span>}
                      {past.filter(Boolean).length > 1 && <Trend past={past} />}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="text-fg-2">
            <td className="px-3 py-2 align-top font-medium">Summe</td>
            {totals.map((t) => (
              <td key={t.key} className="px-3 py-2 align-top tabular-nums">
                <div className="flex items-center gap-1 font-medium text-fg">
                  {t.passed}/{t.count}
                  {t.score != null && <span className="font-normal text-muted">· {pct(t.score)}</span>}
                  <Delta now={t.score} before={t.prevScore} />
                </div>
                <div>{t.count ? duration(t.ms) : "–"}</div>
                <div>
                  {tokens(t.tokens)} Tok. · {t.cost != null ? eur(t.cost) : "Preis ?"}
                </div>
                {(t.ttft != null || t.tps != null) && (
                  <div className="text-muted">
                    {t.ttft != null && `TTFT ${latency(t.ttft)}`}
                    {t.ttft != null && t.tps != null && " · "}
                    {t.tps != null && `${t.tps.toFixed(0)} t/s`}
                  </div>
                )}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Cell({ r }: { r: TaskResult }) {
  return (
    <>
      <div className={clsx("flex items-center gap-1 font-medium", r.passed ? "text-ok" : "text-bad")}>
        {r.passed ? <CheckIcon className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
        {r.error ? "Fehler" : r.passed ? "bestanden" : pct(r.score)}
      </div>
      <div className="tabular-nums text-muted">
        {latency(r.durationMs)} · {tokens(r.input + r.output)}
        {r.costEur != null && ` · ${eur(r.costEur)}`}
      </div>
    </>
  );
}

/** Ergebnis derselben Kombination über die Läufe: grün bestanden, rot nicht, Höhe = Score. */
function Trend({ past }: { past: (TaskResult | undefined)[] }) {
  const last = past.slice(-10);
  return (
    <div className="mt-1 flex h-3 items-end gap-[2px]">
      {last.map((r, i) => (
        <span
          key={i}
          title={r ? `${r.passed ? "bestanden" : "nicht bestanden"} · ${pct(r.score)}` : "nicht gelaufen"}
          className={clsx("w-1.5 rounded-sm", !r ? "bg-line" : r.passed ? "bg-ok" : "bg-bad")}
          style={{ height: r ? `${Math.max(25, r.score * 100)}%` : "25%" }}
        />
      ))}
    </div>
  );
}

function Delta({ now, before }: { now: number | null; before: number | null }) {
  if (now == null || before == null || Math.abs(now - before) < 0.005) return null;
  const up = now > before;
  return (
    <Tip label={`vorher ${pct(before)}`}>
      <span className={clsx("inline-flex items-center text-[0.9em]", up ? "text-ok" : "text-bad")}>
        {up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
        {Math.round(Math.abs(now - before) * 100)}
      </span>
    </Tip>
  );
}

function ResultDetail({ result, run, onClose }: { result: TaskResult; run: BenchRun; onClose: () => void }) {
  const task = run.tasks.find((t) => t.id === result.task)?.name ?? result.task;
  const target = run.targets.find((t) => t.key === result.target)?.label ?? result.target;
  return (
    <Card
      title={`${task} · ${target}`}
      actions={
        <Button size="sm" variant="ghost" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      }
    >
      <div className="space-y-3 px-4 py-3 text-[0.88em]">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-fg-2 tabular-nums">
          <span>Modell: {result.model ?? "Standard"}</span>
          <span>Dauer: {latency(result.durationMs)}</span>
          {result.ttftMs != null && <span>Erstes Token: {latency(result.ttftMs)}</span>}
          {result.outputTps != null && <span>{result.outputTps.toFixed(1)} t/s</span>}
          <span>
            Tokens: {tokens(result.input)} ein ({tokens(result.cached)} Cache) · {tokens(result.output)} aus
          </span>
          <span>Werkzeugaufrufe: {result.toolCalls}</span>
          <span>Kosten: {result.costEur != null ? eur(result.costEur) : "unbekannt"}</span>
        </div>
        {result.error && <div className="whitespace-pre-wrap rounded-lg bg-bad-soft px-3 py-2 text-bad [overflow-wrap:anywhere] selectable">{result.error}</div>}
        {result.checks.length > 0 && (
          <div className="divide-y divide-line rounded-lg border border-line">
            {result.checks.map((c, i) => (
              <div key={i} className="px-3 py-2">
                <div className={clsx("flex items-center gap-1.5 font-medium", c.passed ? "text-ok" : "text-bad")}>
                  {c.passed ? <CheckIcon className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                  <span className="min-w-0 truncate">{c.label}</span>
                  {c.kind === "judge" && <span className="font-normal text-muted">{pct(c.score)}</span>}
                </div>
                {c.detail && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[0.92em] text-fg-2 [overflow-wrap:anywhere] selectable">{c.detail}</pre>}
              </div>
            ))}
          </div>
        )}
        <div>
          <div className="mb-1 font-medium">Antwort</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-code px-3 py-2 font-mono text-[0.92em] [overflow-wrap:anywhere] selectable">{result.answer || "(keine Textantwort)"}</pre>
        </div>
        {!!result.notices?.length && <div className="whitespace-pre-wrap text-[0.92em] text-muted selectable">Hinweise des Agenten: {result.notices.join("\n")}</div>}
        {result.workdir && (
          <div className="flex items-center gap-2 text-fg-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[0.92em] selectable">{result.workdir}</span>
            <Button size="sm" variant="ghost" onClick={() => revealItemInDir(result.workdir!)}>
              <FolderOpen className="h-3.5 w-3.5" /> Arbeitsordner
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Läufe × Ziele: bestanden, Score und Veränderung zum vorigen Lauf. */
function History({ runs }: { runs: BenchRun[] }) {
  const targets = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of runs) for (const t of r.targets) seen.set(t.key, t.label);
    return [...seen.entries()];
  }, [runs]);
  const rows = [...runs].reverse().slice(0, 20);
  const score = (run: BenchRun | undefined, key: string) => {
    const rs = run?.results.filter((r) => r.target === key) ?? [];
    return rs.length ? { passed: rs.filter((r) => r.passed).length, count: rs.length, score: rs.reduce((a, r) => a + r.score, 0) / rs.length } : null;
  };
  return (
    <Card title="Verlauf" description="Je Lauf und Ziel: bestandene Aufgaben, mittlerer Score und Veränderung zum vorigen Lauf mit diesem Ziel.">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[0.86em]">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th className="px-3 py-2 font-medium">Lauf</th>
              {targets.map(([key, label]) => (
                <th key={key} className="px-3 py-2 font-medium" title={key}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((run) => {
              const at = runs.indexOf(run);
              return (
                <tr key={run.id} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-fg-2">
                    {dateTime(run.started)}
                    {run.status !== "done" && <span className="text-muted"> · {STATUS[run.status] ?? run.status}</span>}
                  </td>
                  {targets.map(([key]) => {
                    const s = score(run, key);
                    const before = runs
                      .slice(0, at)
                      .reverse()
                      .map((r) => score(r, key))
                      .find(Boolean);
                    return (
                      <td key={key} className="px-3 py-2 tabular-nums">
                        {s ? (
                          <span className="flex items-center gap-1">
                            {s.passed}/{s.count}
                            <span className="text-muted">· {pct(s.score)}</span>
                            <Delta now={s.score} before={before?.score ?? null} />
                          </span>
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
