import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Award, CalendarDays, Coins, Flame, Gauge, PiggyBank, Rocket, Sparkles, Timer, Trophy } from "lucide-react";
import { basename, useStore } from "../../lib/store";
import { tokens } from "../../lib/format";
import { clsx } from "../ui";
import { AGENT_LABEL, agentOf, dayKey, eur, providerLabel, providerOf, syncVibeHistory, useUsage, usageApi, type UsageRecord } from "./usage";
import "./usage.css";

const DAY = 86_400_000;
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

const tok = (r: UsageRecord) => (r.input ?? 0) + (r.output ?? 0);
const dateLabel = (ts: number) => new Date(ts).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" });
const short = (ts: number) => new Date(ts).toLocaleDateString("de-DE", { day: "numeric", month: "short" });
const wait = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1).replace(".", ",")} s`);

interface Group {
  key: string;
  label: string;
  sub?: string;
  cost: number;
  tokens: number;
  turns: number;
}

function groupBy(list: UsageRecord[], keyOf: (r: UsageRecord) => string | undefined, labelOf: (k: string, r: UsageRecord) => string, subOf?: (r: UsageRecord) => string | undefined) {
  const map = new Map<string, Group>();
  for (const r of list) {
    const key = keyOf(r);
    if (!key) continue;
    const g = map.get(key) ?? { key, label: labelOf(key, r), sub: subOf?.(r), cost: 0, tokens: 0, turns: 0 };
    g.cost += r.cost;
    g.tokens += tok(r);
    g.turns += r.turns ?? 0;
    if (r.title && keyOf === sessionKey) g.label = r.title;
    map.set(key, g);
  }
  return [...map.values()];
}
const sessionKey = (r: UsageRecord) => r.session;

/** Aufeinanderfolgende aktive Tage: aktuelle Serie (bis heute oder gestern) und längste. */
function streaks(days: Set<string>) {
  const sorted = [...days].sort();
  let longest = { len: 0, from: "", to: "" };
  let run = { len: 0, from: "", to: "" };
  let prev: number | null = null;
  for (const d of sorted) {
    const t = new Date(`${d}T12:00:00`).getTime();
    run = prev != null && Math.round((t - prev) / DAY) === 1 ? { ...run, len: run.len + 1, to: d } : { len: 1, from: d, to: d };
    if (run.len > longest.len) longest = run;
    prev = t;
  }
  let current = 0;
  const cursor = new Date();
  if (!days.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dayKey(cursor.getTime()))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
}

const TOKEN_MILESTONES = [1e6, 1e7, 5e7, 1e8, 5e8, 1e9];
const PROMPT_MILESTONES = [10, 100, 500, 1000, 5000, 10000];

/** Einstellungen → Nutzung → Seit Beginn. */
export function AllTime() {
  const [records, setRecords] = useState<UsageRecord[] | null>(null);
  const [prices, setPrices] = useState<Record<string, { input: number; output: number }>>({});
  const loadedAt = useUsage((s) => s.loadedAt);
  const index = useStore((s) => s.index);

  useEffect(() => {
    // Vibe-Historie übernehmen, damit die Zahlen sofort gefüllt sind.
    syncVibeHistory().catch(() => {});
  }, []);
  useEffect(() => {
    usageApi
      .overview(0, Date.now() + 60_000)
      .then((o) => setRecords(o.records))
      .catch(() => setRecords([]));
  }, [loadedAt]);

  const v = useMemo(() => {
    const list = records ?? [];
    if (!list.length) return null;
    const first = Math.min(...list.map((r) => r.ts));
    const byDay = new Map<string, { tokens: number; cost: number; turns: number }>();
    for (const r of list) {
      const k = dayKey(r.ts);
      const d = byDay.get(k) ?? { tokens: 0, cost: 0, turns: 0 };
      d.tokens += tok(r);
      d.cost += r.cost;
      d.turns += r.turns ?? 0;
      byDay.set(k, d);
    }
    const busiest = [...byDay.entries()].sort((a, b) => b[1].tokens - a[1].tokens)[0];
    const sessions = new Set(list.filter((r) => r.session).map((r) => r.session));
    const turns = list.reduce((a, r) => a + (r.turns ?? 0), 0);
    const total = { cost: list.reduce((a, r) => a + r.cost, 0), tokens: list.reduce((a, r) => a + tok(r), 0), saving: list.reduce((a, r) => a + r.saving, 0), list: list.reduce((a, r) => a + (r.list ?? 0), 0) };
    const models = groupBy(list.filter((r) => r.kind === "chat" || r.kind === "council" || r.kind === "assist"), (r) => r.label, (k) => k, (r) => providerLabel(providerOf(r)));
    const agents = groupBy(list, agentOf, (k) => AGENT_LABEL[k] ?? k);
    const providers = groupBy(list, providerOf, (k) => providerLabel(k)).sort((a, b) => b.tokens - a.tokens);
    const projects = groupBy(list, (r) => r.project, (k) => basename(k), (r) => r.project).sort((a, b) => b.cost - a.cost);
    const titles = new Map(index.map((x) => [x.sessionId, x.title]));
    const topSessions = groupBy(list, sessionKey, (k) => titles.get(k) ?? "Session ohne Titel", (r) => (r.project ? basename(r.project) : undefined)).sort((a, b) => b.cost - a.cost);

    // Monate seit Beginn
    const months: { key: string; label: string; cost: number; tokens: number }[] = [];
    const start = new Date(first);
    for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d <= new Date(); d.setMonth(d.getMonth() + 1)) {
      months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: `${MONTHS[d.getMonth()]}${d.getMonth() === 0 || months.length === 0 ? ` ${String(d.getFullYear()).slice(2)}` : ""}`, cost: 0, tokens: 0 });
    }
    const monthIndex = new Map(months.map((m, i) => [m.key, i]));
    for (const r of list) {
      const d = new Date(r.ts);
      const m = months[monthIndex.get(`${d.getFullYear()}-${d.getMonth()}`) ?? -1];
      if (m) {
        m.cost += r.cost;
        m.tokens += tok(r);
      }
    }

    // Tempo je Modell aus dem Journal (mindestens drei Messungen)
    const perf = new Map<string, { label: string; provider: string; tps: number[]; ttft: number[] }>();
    for (const r of list) {
      if (r.outputTps == null && r.ttftMs == null) continue;
      const p = perf.get(r.label) ?? { label: r.label, provider: providerLabel(providerOf(r)), tps: [], ttft: [] };
      if (r.outputTps != null) p.tps.push(r.outputTps);
      if (r.ttftMs != null) p.ttft.push(r.ttftMs);
      perf.set(r.label, p);
    }
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const speed = [...perf.values()].filter((p) => p.tps.length >= 3).map((p) => ({ ...p, value: avg(p.tps) })).sort((a, b) => b.value - a.value);
    const latency = [...perf.values()].filter((p) => p.ttft.length >= 3).map((p) => ({ ...p, value: avg(p.ttft) })).sort((a, b) => a.value - b.value);

    // Meilensteine in zeitlicher Reihenfolge
    const chrono = [...list].sort((a, b) => a.ts - b.ts);
    const reached: { label: string; at: number; icon: ReactNode }[] = [{ label: "Erster Eintrag im Journal", at: first, icon: <Rocket className="h-3.5 w-3.5" /> }];
    let tSum = 0;
    let pSum = 0;
    let ti = 0;
    let pi = 0;
    for (const r of chrono) {
      tSum += tok(r);
      pSum += r.turns ?? 0;
      while (ti < TOKEN_MILESTONES.length && tSum >= TOKEN_MILESTONES[ti]) reached.push({ label: `${tokens(TOKEN_MILESTONES[ti++])} Tokens`, at: r.ts, icon: <Sparkles className="h-3.5 w-3.5" /> });
      while (pi < PROMPT_MILESTONES.length && pSum >= PROMPT_MILESTONES[pi]) reached.push({ label: `${PROMPT_MILESTONES[pi++].toLocaleString("de-DE")} Prompts`, at: r.ts, icon: <Trophy className="h-3.5 w-3.5" /> });
    }
    const st = streaks(new Set(byDay.keys()));
    if (st.longest.len >= 7) reached.push({ label: `${st.longest.len} Tage am Stück`, at: new Date(`${st.longest.to}T12:00:00`).getTime(), icon: <Flame className="h-3.5 w-3.5" /> });
    const next =
      ti < TOKEN_MILESTONES.length ? { label: `${tokens(TOKEN_MILESTONES[ti])} Tokens`, progress: tSum / TOKEN_MILESTONES[ti] } : pi < PROMPT_MILESTONES.length ? { label: `${PROMPT_MILESTONES[pi]} Prompts`, progress: pSum / PROMPT_MILESTONES[pi] } : null;

    return {
      list,
      first,
      byDay,
      busiest,
      sessions: sessions.size,
      turns,
      total,
      activeDays: byDay.size,
      models: models.sort((a, b) => b.tokens - a.tokens).slice(0, 5),
      agents: agents.sort((a, b) => b.tokens - a.tokens),
      providers,
      projects: projects.slice(0, 5),
      topSessions: topSessions.slice(0, 5),
      months,
      speed,
      latency,
      streak: st,
      reached: reached.sort((a, b) => a.at - b.at),
      next,
      imported: list.some((r) => /Import|außerhalb/.test(r.feature)),
    };
  }, [records, index]);

  // Ersparnis durch Arbeiter-Modelle der Master-Session: Arbeiter-Tokens zum Preis des Kurator-Modells.
  useEffect(() => {
    if (!v) return;
    const models = [...new Set(v.list.filter((r) => r.master || v.list.some((x) => x.master === r.session)).map((r) => r.model))];
    if (models.length) usageApi.modelPrices(models).then(setPrices).catch(() => {});
  }, [v]);
  const workerSaving = useMemo(() => {
    if (!v) return 0;
    let sum = 0;
    for (const r of v.list.filter((x) => x.master)) {
      const curator = v.list.find((x) => x.session === r.master && x.kind === "chat")?.model;
      const p = curator ? prices[curator] : undefined;
      if (!p) continue;
      const atCurator = ((r.input ?? 0) * p.input + (r.output ?? 0) * p.output) / 1e6;
      sum += Math.max(0, atCurator - r.cost);
    }
    return sum;
  }, [v, prices]);

  if (records == null) return <p className="text-muted">Lade Statistik …</p>;
  if (!v) return <p className="rounded-xl border border-line bg-elev px-4 py-6 text-center text-muted">Noch keine Einträge im Journal. Nach den ersten Prompts füllt sich diese Seite.</p>;

  return (
    <div className="space-y-4" data-testid="alltime">
      <div className="relative overflow-hidden rounded-2xl border border-line bg-elev p-5">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full opacity-60 blur-3xl" style={{ background: "var(--accent-soft)" }} />
        <div className="relative">
          <div className="text-[0.82em] text-muted">Seit {dateLabel(v.first)} · {Math.max(1, Math.round((Date.now() - v.first) / DAY))} Tage</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
            <span className="text-[2.4em] font-semibold tabular-nums tracking-tight">{tokens(v.total.tokens)}</span>
            <span className="text-fg-2">Tokens insgesamt</span>
          </div>
          <div className="mt-4 grid grid-cols-5 gap-2">
            <Hero icon={<Coins />} label="Kosten" value={`≈ ${eur(v.total.cost, 2)}`} hint={v.total.list > 0 ? `+ Abos ≈ ${eur(v.total.list, 2)}` : "geschätzt"} />
            <Hero icon={<Sparkles />} label="Prompts" value={v.turns.toLocaleString("de-DE")} hint={v.imported ? "seit Brise mitzählt" : v.sessions ? `Ø ${(v.turns / Math.max(1, v.sessions)).toFixed(1).replace(".", ",")} je Session` : undefined} />
            <Hero icon={<Rocket />} label="Sessions" value={v.sessions.toLocaleString("de-DE")} />
            <Hero icon={<CalendarDays />} label="Aktive Tage" value={v.activeDays.toLocaleString("de-DE")} />
            <Hero icon={<Flame />} label="Serie" value={`${v.streak.current} ${v.streak.current === 1 ? "Tag" : "Tage"}`} hint={`Rekord ${v.streak.longest.len}`} />
          </div>
        </div>
      </div>

      <Panel title="Aktivität" icon={<CalendarDays />} right={v.busiest ? `Aktivster Tag: ${short(new Date(`${v.busiest[0]}T12:00:00`).getTime())} · ${tokens(v.busiest[1].tokens)} Tokens` : undefined}>
        <Calendar byDay={v.byDay} />
        <div className="mt-2 flex flex-wrap gap-x-5 text-[0.8em] text-fg-2">
          <span>
            <Flame className="mr-1 inline h-3.5 w-3.5 text-[var(--series-2)]" />
            Aktuelle Serie: <b>{v.streak.current}</b> {v.streak.current === 1 ? "Tag" : "Tage"}
          </span>
          {v.streak.longest.len > 0 && (
            <span>
              Längste Serie: <b>{v.streak.longest.len}</b> Tage ({short(new Date(`${v.streak.longest.from}T12:00:00`).getTime())} – {short(new Date(`${v.streak.longest.to}T12:00:00`).getTime())})
            </span>
          )}
        </div>
      </Panel>

      <div className="grid grid-cols-3 gap-3">
        <Panel title="Lieblingsmodelle" icon={<Award />} right="nach Tokens">
          <Ranked rows={v.models.map((m) => ({ key: m.key, label: m.label, sub: m.sub, value: m.tokens, text: `${tokens(m.tokens)}${m.turns ? ` · ${m.turns} Prompts` : ""}` }))} />
        </Panel>
        <Panel title="Lieblingsagenten" icon={<Trophy />} right="nach Tokens">
          <Ranked rows={v.agents.map((m) => ({ key: m.key, label: m.label, value: m.tokens, text: `${tokens(m.tokens)}${m.turns ? ` · ${m.turns} Prompts` : ""}` }))} />
        </Panel>
        <Panel title="Anteil je Anbieter" icon={<PiggyBank />} right="nach Tokens">
          <Share rows={v.providers} total={v.total.tokens} />
        </Panel>
      </div>

      <Panel title="Verlauf je Monat" icon={<CalendarDays />} right="Kosten (geschätzt) · Tokens">
        <Months months={v.months} />
      </Panel>

      <div className="grid grid-cols-2 gap-3">
        <Panel title="Tempo" icon={<Gauge />} right="Ø aus dem Journal, ab 3 Messungen">
          {v.speed.length === 0 && v.latency.length === 0 ? (
            <p className="text-[0.86em] text-muted">Noch zu wenige Messungen.</p>
          ) : (
            <div className="space-y-2 text-[0.88em]">
              {v.speed[0] && <Fact icon={<Rocket />} label="Schnellstes Modell" value={`${v.speed[0].label} · ${v.speed[0].value.toFixed(0)} t/s`} sub={v.speed[0].provider} />}
              {v.speed.length > 1 && <Fact icon={<Timer />} label="Langsamstes Modell" value={`${v.speed[v.speed.length - 1].label} · ${v.speed[v.speed.length - 1].value.toFixed(0)} t/s`} sub={v.speed[v.speed.length - 1].provider} />}
              {v.latency[0] && <Fact icon={<Gauge />} label="Kürzeste Wartezeit" value={`${v.latency[0].label} · ${wait(v.latency[0].value)}`} sub="bis zum ersten Token" />}
              {v.latency.length > 1 && (
                <Fact icon={<Timer />} label="Längste Wartezeit" value={`${v.latency[v.latency.length - 1].label} · ${wait(v.latency[v.latency.length - 1].value)}`} sub="bis zum ersten Token" />
              )}
            </div>
          )}
        </Panel>
        <Panel title="Gespart" icon={<PiggyBank />} right="geschätzt">
          <div className="space-y-2 text-[0.88em]">
            <Fact icon={<Coins />} label="Durch den Prompt-Cache" value={eur(v.total.saving, 2)} sub="Cache-Tokens statt voller Eingabepreis" />
            <Fact icon={<Rocket />} label="Durch Arbeiter-Modelle" value={workerSaving > 0 ? eur(workerSaving, 2) : "–"} sub="Untersessions statt Kurator-Modell (Master-Session)" />
            {v.total.list > 0 && <Fact icon={<Sparkles />} label="Abos statt API" value={`≈ ${eur(v.total.list, 2)}`} sub="so viel hätten Abo-Turns zum Listenpreis gekostet" />}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Panel title="Teuerste Sessions" icon={<Coins />}>
          <Top rows={v.topSessions} onOpen={(k) => (useStore.getState().setView("chat"), useStore.getState().openTab(k))} />
        </Panel>
        <Panel title="Teuerste Projekte" icon={<Coins />}>
          <Top rows={v.projects} />
        </Panel>
      </div>

      <Panel title="Meilensteine" icon={<Trophy />} right={v.next ? `Nächster: ${v.next.label}` : undefined}>
        {v.next && (
          <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-active">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, v.next.progress * 100)}%` }} />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {v.reached.map((m) => (
            <span key={m.label} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-[0.82em]">
              <span className="text-accent">{m.icon}</span>
              {m.label}
              <span className="text-muted">· {short(m.at)}</span>
            </span>
          ))}
        </div>
      </Panel>

      <p className="text-[0.8em] text-muted">
        Ehrlich gerechnet: Kosten sind Schätzungen nach Preistabelle bzw. den Preisen des Anbieters (Cortecs meldet echte Kosten). Abo-Turns (Claude, Codex,
        Gemini) zählen mit 0 €; ihr Listenpreis steht nur zum Vergleich da.
        {v.imported && " Verlauf aus Vibes Session-Logs ist enthalten – dort gibt es nur Summen je Session, gebucht zum letzten Stand der Session."}
      </p>
    </div>
  );
}

function Hero({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel/70 px-3 py-2.5 backdrop-blur">
      <div className="flex items-center gap-1.5 text-[0.75em] text-muted [&>svg]:h-3.5 [&>svg]:w-3.5">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-[1.3em] font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="truncate text-[0.72em] text-muted">{hint}</div>}
    </div>
  );
}

function Panel({ title, icon, right, children }: { title: string; icon: ReactNode; right?: string; children: ReactNode }) {
  return (
    <div className="scroll-mt-4 rounded-xl border border-line bg-elev p-4" data-panel={title}>
      <div className="mb-3 flex items-center gap-2 text-[0.86em]">
        <span className="text-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        <span className="font-medium">{title}</span>
        {right && <span className="ml-auto truncate text-[0.9em] text-muted">{right}</span>}
      </div>
      {children}
    </div>
  );
}

/** Kalender der letzten 53 Wochen im GitHub-Stil (Tokens je Tag). */
function Calendar({ byDay }: { byDay: Map<string, { tokens: number; cost: number; turns: number }> }) {
  const weeks = useMemo(() => {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 52 * 7);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Montag
    const cols: { ts: number; key: string }[][] = [];
    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const w = Math.floor((d.getTime() - start.getTime()) / (7 * DAY) + 0.01);
      (cols[w] ??= []).push({ ts: d.getTime(), key: dayKey(d.getTime()) });
    }
    return cols;
  }, []);
  const max = Math.max(...[...byDay.values()].map((d) => d.tokens), 1);
  return (
    <div className="overflow-x-auto">
      <div className="flex gap-[3px]">
        {weeks.map((w, i) => (
          <div key={i} className="flex flex-col gap-[3px]">
            <div className="h-3 text-[0.62em] leading-3 text-muted">{new Date(w[0].ts).getDate() <= 7 ? MONTHS[new Date(w[0].ts).getMonth()] : ""}</div>
            {w.map((d) => {
              const v = byDay.get(d.key);
              const level = v ? 0.2 + 0.8 * Math.sqrt(v.tokens / max) : 0;
              return (
                <div
                  key={d.key}
                  title={`${new Date(d.ts).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" })}: ${v ? `${tokens(v.tokens)} Tokens, ${v.turns} Prompts, ${eur(v.cost)}` : "keine Aktivität"}`}
                  className="h-[11px] w-[11px] rounded-[3px]"
                  style={{ background: v ? `rgb(var(--heat) / ${level})` : "var(--hover)" }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-end gap-1 text-[0.7em] text-muted">
        weniger
        {[0, 0.3, 0.55, 0.8, 1].map((l) => (
          <span key={l} className="h-[10px] w-[10px] rounded-[3px]" style={{ background: l ? `rgb(var(--heat) / ${l})` : "var(--hover)" }} />
        ))}
        mehr
      </div>
    </div>
  );
}

function Ranked({ rows }: { rows: { key: string; label: string; sub?: string; value: number; text: string }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  if (!rows.length) return <p className="text-[0.86em] text-muted">Keine</p>;
  return (
    <div className="space-y-2.5">
      {rows.map((r, i) => (
        <div key={r.key}>
          <div className="flex items-baseline gap-2 text-[0.86em]">
            <span className={clsx("w-4 text-right tabular-nums", i === 0 ? "font-semibold text-accent" : "text-muted")}>{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            <span className="text-[0.86em] tabular-nums text-muted">{r.text}</span>
          </div>
          <div className="ml-6 mt-1 h-1 overflow-hidden rounded-full bg-active">
            <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: SERIES[i % SERIES.length] }} />
          </div>
          {r.sub && <div className="ml-6 truncate text-[0.74em] text-muted">{r.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function Share({ rows, total }: { rows: Group[]; total: number }) {
  if (!rows.length || total === 0) return <p className="text-[0.86em] text-muted">Keine</p>;
  return (
    <>
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-full">
        {rows.map((r, i) => (
          <div key={r.key} style={{ flexGrow: r.tokens, flexBasis: 0, background: SERIES[i % SERIES.length] }} title={`${r.label}: ${Math.round((r.tokens / total) * 100)} %`} />
        ))}
      </div>
      <div className="mt-3 space-y-1.5 text-[0.84em]">
        {rows.map((r, i) => (
          <div key={r.key} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: SERIES[i % SERIES.length] }} />
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            <span className="tabular-nums text-muted">{r.tokens / total < 0.005 ? "<1" : Math.round((r.tokens / total) * 100)} %</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Months({ months }: { months: { key: string; label: string; cost: number; tokens: number }[] }) {
  const max = Math.max(...months.map((m) => m.cost), 0.01);
  const [hover, setHover] = useState<number | null>(null);
  const shown = months.slice(-18);
  return (
    <>
      <div className="flex h-32 items-end gap-1.5" onMouseLeave={() => setHover(null)}>
        {shown.map((m, i) => (
          <div key={m.key} className="flex h-full min-w-0 flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
            <div className="mb-1 text-center text-[0.68em] tabular-nums text-muted">{hover === i || shown.length <= 8 ? eur(m.cost, m.cost >= 10 ? 0 : 2) : ""}</div>
            <div className={clsx("w-full rounded-t-[5px] bg-[var(--series-1)] transition-[filter]", hover === i && "brightness-110")} style={{ height: `${Math.max(2, (m.cost / max) * 80)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1.5">
        {shown.map((m) => (
          <div key={m.key} className="min-w-0 flex-1 text-center">
            <div className="truncate text-[0.7em] text-fg-2">{m.label}</div>
            <div className="truncate text-[0.62em] text-muted">{tokens(m.tokens)}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function Fact({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 rounded-md bg-accent-soft p-1 text-accent [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[0.86em] text-muted">{label}</div>
        <div className="truncate font-medium">{value}</div>
        {sub && <div className="truncate text-[0.78em] text-muted">{sub}</div>}
      </div>
    </div>
  );
}

function Top({ rows, onOpen }: { rows: Group[]; onOpen?: (key: string) => void }) {
  if (!rows.length) return <p className="text-[0.86em] text-muted">Keine</p>;
  return (
    <div className="-mx-2">
      {rows.map((r) => (
        <button key={r.key} disabled={!onOpen} onClick={() => onOpen?.(r.key)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.88em] enabled:hover:bg-hover">
          <div className="min-w-0 flex-1">
            <div className="truncate">{r.label}</div>
            <div className="truncate text-[0.8em] text-muted">
              {r.sub && r.sub !== r.label ? `${r.sub} · ` : ""}
              {tokens(r.tokens)} Tokens
            </div>
          </div>
          <span className="tabular-nums">{eur(r.cost)}</span>
        </button>
      ))}
    </div>
  );
}
