import { useEffect, useMemo, useState } from "react";
import { basename, useStore } from "../../lib/store";
import { tokens } from "../../lib/format";
import { clsx } from "../ui";
import { Performance } from "./Performance";
import { AGENT_LABEL, agentOf, category, eur, providerLabel, providerOf, useUsage, usageApi, type UsageRecord } from "./usage";
import "./usage.css";

type Period = "today" | "week" | "month" | "year" | "all";
const PERIODS: { id: Period; label: string }[] = [
  { id: "today", label: "Heute" },
  { id: "week", label: "7 Tage" },
  { id: "month", label: "Monat" },
  { id: "year", label: "Jahr" },
  { id: "all", label: "Gesamt" },
];

type Metric = "cost" | "tokens";
type Group = "provider" | "agent" | "model" | "project" | "session" | "category" | "feature" | "account";
const GROUPS: { id: Group; label: string }[] = [
  { id: "provider", label: "Anbieter" },
  { id: "agent", label: "Agent" },
  { id: "model", label: "Modell" },
  { id: "project", label: "Projekt" },
  { id: "session", label: "Session" },
  { id: "category", label: "Funktion" },
  { id: "feature", label: "Detail" },
  { id: "account", label: "Zugang" },
];

const SERIES = 6;
const DAY = 86_400_000;
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function periodStart(p: Period): number {
  const now = new Date();
  if (p === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (p === "week") return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  if (p === "month") return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (p === "year") return new Date(now.getFullYear(), 0, 1).getTime();
  return 0;
}

const value = (r: UsageRecord, m: Metric) => (m === "cost" ? r.cost : (r.input ?? 0) + (r.output ?? 0));
const fmt = (n: number, m: Metric) => (m === "cost" ? eur(n) : tokens(Math.round(n)));
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : "–");

interface Bin {
  key: string;
  label: string;
  start: number;
  values: number[];
  total: number;
}

/** Zeitachse je Zeitraum: Stunden, Tage oder Monate. */
function makeBins(p: Period, records: UsageRecord[]): { bins: Bin[]; find: (ts: number) => Bin | undefined } {
  const now = new Date();
  const bins: Bin[] = [];
  const first = p === "all" ? Math.min(...records.map((r) => r.ts), now.getTime()) : periodStart(p);
  const unit = p === "today" ? "hour" : p === "year" || (p === "all" && now.getTime() - first > 62 * DAY) ? "month" : "day";
  const keyOf = (ts: number) => {
    const d = new Date(ts);
    return unit === "hour" ? `${d.getHours()}` : unit === "day" ? d.toDateString() : `${d.getFullYear()}-${d.getMonth()}`;
  };
  if (unit === "hour") {
    for (let h = 0; h < 24; h++) bins.push({ key: `${h}`, label: `${h} Uhr`, start: periodStart("today") + h * 3_600_000, values: [], total: 0 });
  } else if (unit === "day") {
    const s = new Date(first);
    const end = p === "month" ? new Date(now.getFullYear(), now.getMonth() + 1, 0) : now;
    for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d <= end; d.setDate(d.getDate() + 1))
      bins.push({ key: d.toDateString(), label: d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }), start: d.getTime(), values: [], total: 0 });
  } else {
    const s = new Date(first);
    const end = p === "year" ? new Date(now.getFullYear(), 11, 1) : now;
    for (let d = new Date(s.getFullYear(), s.getMonth(), 1); d <= end; d.setMonth(d.getMonth() + 1))
      bins.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString("de-DE", { month: "short", year: "numeric" }), start: d.getTime(), values: [], total: 0 });
  }
  const index = new Map(bins.map((b) => [b.key, b]));
  return { bins, find: (ts) => index.get(keyOf(ts)) };
}

interface Bucket {
  key: string;
  label: string;
  sub?: string;
  value: number;
  cost: number;
  input: number;
  cached: number;
  output: number;
  count: number;
  estimated: boolean;
  /** Abo-Anteil zum Listenpreis (nur Vergleich). */
  list: number;
  subscription: boolean;
}

function groupKey(r: UsageRecord, by: Group): string {
  if (by === "provider") return providerOf(r);
  if (by === "agent") return agentOf(r);
  if (by === "model") return r.label;
  if (by === "project") return r.project ?? "";
  if (by === "session") return r.session ?? "";
  if (by === "category") return category(r);
  if (by === "feature") return r.feature;
  return `${r.account ?? "unbekannt"} · ${r.backend || "vibe"}`;
}

function groupBy(records: UsageRecord[], by: Group, metric: Metric): Bucket[] {
  const map = new Map<string, Bucket>();
  const titles = by === "session" ? new Map(useStore.getState().index.map((x) => [x.sessionId, x.title])) : null;
  for (const r of records) {
    const key = groupKey(r, by);
    if (by === "session" && !key) continue;
    const b = map.get(key) ?? {
      key,
      label:
        by === "project"
          ? key
            ? basename(key)
            : "ohne Projekt"
          : by === "session"
            ? (titles?.get(key) ?? "Session ohne Titel")
            : by === "provider"
              ? providerLabel(key)
              : by === "agent"
                ? (AGENT_LABEL[key] ?? key)
                : key,
      list: 0,
      subscription: false,
      value: 0,
      cost: 0,
      input: 0,
      cached: 0,
      output: 0,
      count: 0,
      estimated: false,
    };
    b.value += value(r, metric);
    b.cost += r.cost;
    b.input += r.input ?? 0;
    b.cached += r.cached ?? 0;
    b.output += r.output ?? 0;
    b.count += r.turns || 1;
    b.estimated ||= !!r.estimated || !r.priced;
    b.list += r.list ?? 0;
    b.subscription ||= !!r.subscription;
    if (by === "session") {
      // Der Titel kommt oft erst nach dem ersten Turn.
      if (r.title) b.label = r.title;
      if (r.project) b.sub = basename(r.project);
    }
    if (by === "project" && key) b.sub = key;
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => b.value - a.value);
}

export function Stats() {
  const [period, setPeriod] = useState<Period>("month");
  const [metric, setMetric] = useState<Metric>("cost");
  const [group, setGroup] = useState<Group>("provider");
  const [records, setRecords] = useState<UsageRecord[] | null>(null);
  const [modelOrder, setModelOrder] = useState<string[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const loadedAt = useUsage((s) => s.loadedAt);

  useEffect(() => {
    usageApi
      .prices()
      .then((p) => setModelOrder(p.table.models.map((m) => m.label)))
      .catch(() => {});
  }, []);
  useEffect(() => {
    usageApi
      .overview(periodStart(period), Date.now() + 60_000)
      .then((o) => setRecords(o.records))
      .catch(() => setRecords([]));
  }, [period, loadedAt]);

  const view = useMemo(() => {
    const list = records ?? [];
    // Farbe folgt dem Modell, nicht dem Rang: feste Reihenfolge der Preistabelle.
    const seen = new Set(list.map((r) => r.label));
    const series = modelOrder.filter((m) => seen.has(m)).slice(0, SERIES);
    const slot = (label: string) => {
      const i = series.indexOf(label);
      return i >= 0 ? i : SERIES;
    };
    const { bins, find } = makeBins(period, list);
    for (const b of bins) b.values = Array(SERIES + 1).fill(0);
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    for (const r of list) {
      const v = value(r, metric);
      const bin = find(r.ts);
      if (bin) {
        bin.values[slot(r.label)] += v;
        bin.total += v;
      }
      const d = new Date(r.ts);
      heat[(d.getDay() + 6) % 7][d.getHours()] += v;
    }
    const sum = (f: (r: UsageRecord) => number) => list.reduce((a, r) => a + f(r), 0);
    const turns = sum((r) => r.turns ?? 0);
    const turnTokens = list.filter((r) => r.turns).reduce((a, r) => a + (r.input ?? 0) + (r.output ?? 0), 0);
    const byModel = groupBy(list, "model", metric);
    return {
      list,
      series,
      slot,
      bins,
      heat,
      heatMax: Math.max(...heat.flat(), 0),
      cost: sum((r) => r.cost),
      input: sum((r) => r.input ?? 0),
      cached: sum((r) => r.cached ?? 0),
      output: sum((r) => r.output ?? 0),
      saving: sum((r) => r.saving),
      sessions: new Set(list.filter((r) => r.session).map((r) => r.session)).size,
      projects: new Set(list.filter((r) => r.project).map((r) => r.project)).size,
      turns,
      toolCalls: sum((r) => r.toolCalls ?? 0),
      subagents: sum((r) => r.subagents ?? 0),
      avgTurn: turns ? turnTokens / turns : 0,
      imported: list.filter((r) => /Import|außerhalb/.test(r.feature)).length,
      byModel,
      total: byModel.reduce((a, b) => a + b.value, 0),
    };
  }, [records, modelOrder, period, metric]);

  const buckets = useMemo(() => groupBy(view.list, group, metric), [view.list, group, metric]);
  const topSessions = useMemo(() => groupBy(view.list, "session", "cost").slice(0, 8), [view.list]);
  const topProjects = useMemo(() => groupBy(view.list, "project", "cost").slice(0, 8), [view.list]);
  const timeline = useMemo(() => {
    const { bins, find } = makeBins(period, view.list);
    const index = new Map(bins.map((b, i) => [b, i]));
    return { labels: bins.map((b) => b.label), binOf: (ts: number) => index.get(find(ts)!) ?? -1 };
  }, [period, view.list]);
  const maxBin = Math.max(...view.bins.map((b) => b.total), 0);
  const color = (i: number) => (i < SERIES ? `var(--series-${i + 1})` : "var(--series-other)");
  const hovered = hover != null ? view.bins[hover] : null;

  return (
    <section className="mb-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="text-[0.95em] font-semibold">Statistik</h3>
        <Segmented value={period} onChange={setPeriod} options={PERIODS} className="ml-auto" />
        <Segmented
          value={metric}
          onChange={setMetric}
          options={[
            { id: "cost", label: "€" },
            { id: "tokens", label: "Tokens" },
          ]}
        />
      </div>

      {records == null ? (
        <p className="text-muted">Lade …</p>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-4 gap-2">
            <Tile label="Kosten" value={eur(view.cost, 2)} hint="geschätzt" />
            <Tile label="Eingabe" value={tokens(view.input)} hint={`${tokens(view.cached)} aus dem Cache`} />
            <Tile label="Ausgabe" value={tokens(view.output)} hint={`${tokens(view.input + view.output)} gesamt`} />
            <Tile label="Cache-Trefferquote" value={pct(view.cached, view.input)} hint={`${eur(view.saving, 2)} gespart`} />
            <Tile label="Sessions" value={String(view.sessions)} hint={`${view.projects} ${view.projects === 1 ? "Projekt" : "Projekte"}`} />
            <Tile label="Turns" value={String(view.turns)} hint={view.avgTurn ? `Ø ${tokens(Math.round(view.avgTurn))} Tokens je Turn` : "seit Journal-Beginn"} />
            <Tile label="Werkzeugaufrufe" value={String(view.toolCalls)} hint={view.turns ? `Ø ${(view.toolCalls / view.turns).toFixed(1).replace(".", ",")} je Turn` : undefined} />
            <Tile label="Subagents" value={String(view.subagents)} />
          </div>

          <div className="mb-4 rounded-xl border border-line bg-elev p-4">
            <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8em] text-fg-2">
              <span className="font-medium text-fg">Verlauf</span>
              {view.series.map((label, i) => (
                <span key={label} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color(i) }} />
                  {label}
                </span>
              ))}
              {view.byModel.some((b) => view.slot(b.label) === SERIES) && (
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color(SERIES) }} />
                  Andere
                </span>
              )}
              <span className="ml-auto tabular-nums text-muted">
                {hovered ? `${hovered.label}: ${fmt(hovered.total, metric)}` : `höchster Wert ${fmt(maxBin, metric)}`}
              </span>
            </div>
            <div className="flex h-36 items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
              {view.bins.map((b, n) => (
                <div key={b.key} className="flex h-full min-w-0 flex-1 cursor-default flex-col justify-end" onMouseEnter={() => setHover(n)}>
                  {b.total === 0 ? (
                    <div className="h-[2px] w-full rounded-sm bg-line" />
                  ) : (
                    <div className={clsx("flex w-full flex-col-reverse gap-[2px]", hover === n && "brightness-110")} style={{ height: `${Math.max(2, (b.total / (maxBin || 1)) * 100)}%` }}>
                      {b.values.map((v, i) =>
                        v > 0 ? <div key={i} className="w-full first:rounded-b-sm last:rounded-t-[4px]" style={{ flexGrow: v, flexBasis: 0, minHeight: 1, background: color(i) }} /> : null,
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex justify-between text-[0.72em] text-muted">
              <span>{view.bins[0]?.label}</span>
              <span>{view.bins[view.bins.length - 1]?.label}</span>
            </div>
            {hovered && hovered.total > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[0.78em] text-fg-2">
                {hovered.values.map((v, i) =>
                  v > 0 ? (
                    <span key={i} className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-[2px]" style={{ background: color(i) }} />
                      {i < SERIES ? view.series[i] : "Andere"}: {fmt(v, metric)}
                    </span>
                  ) : null,
                )}
              </div>
            )}
          </div>

          {view.total > 0 && (
            <div className="mb-4 rounded-xl border border-line bg-elev p-4">
              <div className="mb-2 text-[0.8em] font-medium">Verteilung nach Modell</div>
              <div className="flex h-3 gap-[2px] overflow-hidden rounded-full">
                {view.byModel.map((b) => (
                  <div key={b.key} title={`${b.label}: ${fmt(b.value, metric)} (${pct(b.value, view.total)})`} style={{ flexGrow: b.value, flexBasis: 0, background: color(view.slot(b.label)) }} />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.8em] text-fg-2">
                {view.byModel.slice(0, 8).map((b) => (
                  <span key={b.key} className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color(view.slot(b.label)) }} />
                    {b.label} <span className="tabular-nums text-muted">{pct(b.value, view.total)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mb-2 flex items-center gap-3">
            <span className="text-[0.86em] font-medium">Aufschlüsselung</span>
            <Segmented value={group} onChange={setGroup} options={GROUPS} className="ml-auto" />
          </div>
          <BucketList buckets={buckets} total={view.total} metric={metric} />

          <div className="mt-4 grid grid-cols-2 gap-3">
            <TopList title="Teuerste Sessions" buckets={topSessions} onOpen={(key) => (useStore.getState().setView("chat"), useStore.getState().openTab(key))} />
            <TopList title="Teuerste Projekte" buckets={topProjects} />
          </div>

          <Performance records={view.list} bins={timeline.labels} binOf={timeline.binOf} />

          <div className="mt-4 rounded-xl border border-line bg-elev p-4">
            <div className="mb-2 flex items-center text-[0.8em]">
              <span className="font-medium">Aktivität nach Wochentag und Uhrzeit</span>
              <span className="ml-auto text-muted">{metric === "cost" ? "Kosten" : "Tokens"} je Stunde</span>
            </div>
            <div className="grid gap-[2px]" style={{ gridTemplateColumns: "1.6em repeat(24, minmax(0, 1fr))" }}>
              {view.heat.map((row, d) => (
                <div key={d} className="contents">
                  <span className="text-[0.7em] leading-[14px] text-muted">{WEEKDAYS[d]}</span>
                  {row.map((v, h) => (
                    <div
                      key={h}
                      title={`${WEEKDAYS[d]} ${h}–${h + 1} Uhr: ${fmt(v, metric)}`}
                      className="h-[14px] rounded-[3px]"
                      style={{ background: v > 0 ? `rgb(var(--heat) / ${0.15 + 0.85 * Math.sqrt(v / (view.heatMax || 1))})` : "var(--hover)" }}
                    />
                  ))}
                </div>
              ))}
              <span />
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h} className="text-center text-[0.62em] text-muted">
                  {h % 6 === 0 ? h : ""}
                </span>
              ))}
            </div>
          </div>
          {view.imported > 0 && (
            <p className="mt-2 text-[0.8em] text-muted">
              Enthält Verlauf aus Vibes Session-Logs (vor Brises Journal oder außerhalb von Brise). Dort speichert Vibe nur Summen je Session ohne Modell und
              Uhrzeit der einzelnen Aufrufe: gebucht zum letzten Stand der Session mit ihrem zuletzt aktiven Modell. Abos (Claude, Codex, Gemini) zählen mit
              0 € – ihre echten Kosten kennt Brise nicht.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[]; className?: string }) {
  return (
    <div className={clsx("flex rounded-lg border border-line bg-panel p-0.5 text-[0.84em]", className)}>
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)} className={clsx("rounded-md px-2.5 py-1", value === o.id ? "bg-elev text-fg shadow-soft" : "text-muted hover:text-fg")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-elev px-3 py-2.5">
      <div className="text-[0.75em] text-muted">{label}</div>
      <div className="text-[1.25em] font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="truncate text-[0.72em] text-muted">{hint}</div>}
    </div>
  );
}

function BucketList({ buckets, total, metric }: { buckets: Bucket[]; total: number; metric: Metric }) {
  if (buckets.length === 0) return <div className="rounded-xl border border-line bg-elev px-4 py-3.5 text-muted">Keine Einträge in diesem Zeitraum.</div>;
  return (
    <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-elev">
      {buckets.slice(0, 12).map((b) => (
        <div key={b.key} className="px-4 py-2.5">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate" title={b.sub}>
              {b.label}
              {b.sub && b.sub !== b.label && <span className="ml-2 text-[0.82em] text-muted">{b.sub}</span>}
            </span>
            <span className="text-[0.8em] text-muted">
              {b.input + b.output > 0 ? `${tokens(b.input)} ein · ${tokens(b.cached)} Cache · ${tokens(b.output)} aus` : `${b.count}×`}
            </span>
            <span className="w-14 text-right text-[0.8em] tabular-nums text-muted">{pct(b.value, total)}</span>
            <span className="w-20 text-right tabular-nums" title={b.subscription ? `Abo – echte Kosten unbekannt${b.list ? `, zum Listenpreis ≈ ${eur(b.list)}` : ""}` : undefined}>
              {metric === "cost" && b.subscription && b.value === 0 ? (
                <span className="rounded bg-hover px-1.5 py-px text-[0.85em] text-fg-2">Abo</span>
              ) : (
                <>
                  {metric === "cost" && b.estimated ? "≈" : ""}
                  {fmt(b.value, metric)}
                </>
              )}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-active">
            <div className="h-full rounded-full bg-accent/70" style={{ width: `${total > 0 ? (b.value / total) * 100 : 0}%` }} />
          </div>
        </div>
      ))}
      {buckets.length > 12 && <div className="px-4 py-2 text-[0.8em] text-muted">und {buckets.length - 12} weitere</div>}
    </div>
  );
}

function TopList({ title, buckets, onOpen }: { title: string; buckets: Bucket[]; onOpen?: (key: string) => void }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-elev">
      <div className="border-b border-line px-3 py-2 text-[0.8em] font-medium">{title}</div>
      {buckets.length === 0 && <div className="px-3 py-2.5 text-[0.86em] text-muted">Keine</div>}
      {buckets.map((b) => (
        <button
          key={b.key}
          disabled={!onOpen}
          onClick={() => onOpen?.(b.key)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[0.88em] enabled:hover:bg-hover"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate">{b.label}</div>
            <div className="truncate text-[0.82em] text-muted">
              {b.sub && b.sub !== b.label ? `${b.sub} · ` : ""}
              {tokens(b.input + b.output)} Tokens
            </div>
          </div>
          <span className="tabular-nums">{eur(b.cost)}</span>
        </button>
      ))}
    </div>
  );
}
