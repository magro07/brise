import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FolderOpen, Info, RotateCcw } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../../lib/acp";
import { useStore } from "../../lib/store";
import { Button, Switch, clsx } from "../ui";
import { barTone } from "./HeaderMeter";
import { Stats } from "./Stats";
import { AGENT_LABEL, agentOf, eur, monthEnd, monthStart, providerLabel, providerOf, refreshUsage, saveUsageSettings, useUsage, usageApi, type PriceTable, type UsageRecord } from "./usage";
import { tokens } from "../../lib/format";

function Card({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-1 text-[0.95em] font-semibold">{title}</h3>
      {description && <p className="mb-2 text-[0.88em] text-muted">{description}</p>}
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-elev">{children}</div>
    </section>
  );
}

function Row({ title, description, control }: { title: ReactNode; description?: ReactNode; control: ReactNode }) {
  return (
    <div className="flex items-center gap-6 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        {description && <div className="mt-0.5 text-[0.86em] text-muted">{description}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

const dateFmt = (ts: number) => new Date(ts).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });

export function UsagePage() {
  const { records, settings, spent, journalSpent, percent, pricesStand, journalDir, loadedAt } = useUsage();
  const [plan, setPlan] = useState<string | null>(null);

  useEffect(() => {
    refreshUsage();
    // Plan laut Vibe (/whoami). Verbrauch oder Limit liefert Mistral dort nicht.
    const sid = useStore.getState().activeSessionId ?? Object.values(useStore.getState().prepared).find((id) => id !== "…");
    if (sid)
      api
        .ext<{ plan?: { name?: string; title?: string | null; kind?: string } }>("account/read", { sessionId: sid })
        .then((a) => a.plan && setPlan(a.plan.title ?? `${a.plan.kind ?? ""} · ${a.plan.name ?? ""}`))
        .catch(() => {});
  }, []);

  const stats = useMemo(() => {
    const now = Date.now();
    const start = monthStart();
    const end = monthEnd();
    const elapsedDays = Math.max((now - start) / 86_400_000, 0.25);
    const totalDays = (end + 1 - start) / 86_400_000;
    const rate = spent / elapsedDays;
    const budget = settings?.budgetEur ?? 0;
    const projected = rate * totalDays;
    const reachAt = rate > 0 && budget > spent ? now + ((budget - spent) / rate) * 86_400_000 : null;
    const unpriced = [...new Set(records.filter((r) => !r.priced).map((r) => r.model))];
    const sumOf = (f: (r: UsageRecord) => boolean) => records.filter(f).reduce((a, r) => a + r.cost, 0);
    const imported = sumOf((r) => /Import|außerhalb/.test(r.feature));
    const estimated = sumOf((r) => !!r.estimated) - imported;
    return { rate, projected, reachAt, unpriced, estimated, imported, end };
  }, [records, spent, settings?.budgetEur]);

  if (!settings) return <p className="text-muted">Lade Nutzung …</p>;
  const consoleBased = settings.consoleEur != null && (settings.consoleAt ?? 0) >= monthStart();

  return (
    <>
      <div className="mb-6 rounded-xl border border-line bg-elev p-5">
        <div className="flex items-baseline gap-2">
          <span className="text-[2em] font-semibold tabular-nums tracking-tight">{eur(spent, 2)}</span>
          <span className="text-muted">von {eur(settings.budgetEur, 0)} im {new Date().toLocaleDateString("de-DE", { month: "long" })}</span>
          <span className="ml-auto rounded bg-hover px-1.5 py-0.5 text-[0.75em] text-muted">{consoleBased ? "Console-Stand + Schätzung" : "geschätzt"}</span>
        </div>
        <div className="relative mt-3 h-2.5 overflow-hidden rounded-full bg-active">
          <div className={clsx("absolute inset-y-0 left-0 rounded-full", barTone(percent))} style={{ width: `${Math.min(100, percent)}%` }} />
          {settings.warnAt.map((l) => (
            <div key={l} className="absolute inset-y-0 w-px bg-fg/25" style={{ left: `${l}%` }} title={`Warnung bei ${l} %`} />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[0.86em] text-fg-2">
          <span>{percent.toFixed(1).replace(".", ",")} % verbraucht</span>
          <span>≈ {eur(stats.rate, 2)} pro Tag</span>
          <span>Prognose Monatsende: {eur(stats.projected, 0)}</span>
          <span className={clsx(stats.reachAt && stats.reachAt <= stats.end && "font-medium text-bad")}>
            {spent >= settings.budgetEur
              ? "Budget erreicht"
              : stats.reachAt && stats.reachAt <= stats.end
                ? `Bei diesem Tempo am ${dateFmt(stats.reachAt)} erreicht`
                : "Reicht bei diesem Tempo bis Monatsende"}
          </span>
        </div>
        {consoleBased && (
          <p className="mt-2 text-[0.82em] text-muted">
            {eur(settings.consoleEur ?? 0, 2)} laut Console am {dateFmt(settings.consoleAt ?? 0)}, dazu {eur(spent - (settings.consoleEur ?? 0), 2)} aus Brises Journal seitdem.
            Journal allein: {eur(journalSpent, 2)}.
          </p>
        )}
      </div>

      <ProviderCard records={records} />

      <Stats />

      <MasterCard records={records} />
      <BudgetCard />
      <ConsoleCard />
      <PricesCard />

      <div className="mb-6 flex items-start gap-2 rounded-lg bg-hover px-3 py-2.5 text-[0.84em] text-fg-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <div className="space-y-1">
          <p>
            Kein Anbieter liefert Brise verlässlich Verbrauch und Limit (Mistral weder über Vibe noch über die API{plan ? `; Plan laut Vibe: ${plan}` : ""}). Brise
            protokolliert deshalb jeden Vorgang selbst – Turns aller Agenten, eigene Aufrufe (Einstufung, Council, Benchmarks …) und Modelle weiterer Anbieter in
            Vibe über den lokalen Proxy – und rechnet mit der Preistabelle (Stand {pricesStand}) bzw. den Preisen des Anbieters; Cortecs meldet echte Kosten.
            Abos (Claude Max, ChatGPT, Google-Konto) zählen mit 0 €, weil ihre Kosten unbekannt sind. Spracheingabe (Dauer), Vorlesen (Zeichen) und
            Websuche (pro Aufruf) sind als Menge geschätzt{stats.estimated > 0 ? ` (diesen Monat ${eur(stats.estimated, 2)})` : ""}.
            {stats.imported > 0 && ` Aus Vibes Session-Logs übernommen: ${eur(stats.imported, 2)}, gebucht zum letzten Stand jeder Session mit ihrem zuletzt aktiven Modell.`} Subagents laufen im Turn ihrer Session mit. Jeder Eintrag trägt Anbieter, Agent und Zugang (Fingerabdruck des Schlüssels, nie der Schlüssel).
          </p>
          {stats.unpriced.length > 0 && <p className="text-warn">Ohne Preis (mit 0 € gezählt): {stats.unpriced.join(", ")}</p>}
          <p className="flex items-center gap-2">
            Journal: <span className="font-mono text-[0.92em] selectable">{journalDir}</span>
            <button className="text-muted hover:text-fg" onClick={() => revealItemInDir(journalDir).catch(() => {})} title="Im Dateimanager zeigen">
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
            <span className="ml-auto text-muted">aktualisiert {new Date(loadedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</span>
          </p>
        </div>
      </div>
    </>
  );
}

interface Share {
  key: string;
  label: string;
  cost: number;
  list: number;
  tokens: number;
  calls: number;
  subscription: boolean;
  onlySubscription: boolean;
}

function shares(records: UsageRecord[], keyOf: (r: UsageRecord) => string, labelOf: (k: string) => string): Share[] {
  const map = new Map<string, Share>();
  for (const r of records) {
    const key = keyOf(r);
    const s = map.get(key) ?? { key, label: labelOf(key), cost: 0, list: 0, tokens: 0, calls: 0, subscription: false, onlySubscription: true };
    s.cost += r.cost;
    s.list += r.list ?? 0;
    s.tokens += (r.input ?? 0) + (r.output ?? 0);
    s.calls += r.turns || r.calls || 1;
    s.subscription ||= !!r.subscription;
    s.onlySubscription &&= !!r.subscription;
    map.set(key, s);
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}

/** Diesen Monat je Anbieter und je Agent – Abos ehrlich gekennzeichnet. */
function ProviderCard({ records }: { records: UsageRecord[] }) {
  const byProvider = useMemo(() => shares(records, providerOf, providerLabel), [records]);
  const byAgent = useMemo(() => shares(records, agentOf, (k) => AGENT_LABEL[k] ?? k), [records]);
  if (!records.length) return null;
  const total = byProvider.reduce((a, s) => a + s.cost, 0);
  const List = ({ title, rows }: { title: string; rows: Share[] }) => (
    <div className="overflow-hidden rounded-xl border border-line bg-elev">
      <div className="border-b border-line px-4 py-2 text-[0.84em] font-medium">{title}</div>
      {rows.map((s) => (
        <div key={s.key} className="px-4 py-2.5" data-testid={`usage-share-${s.key}`}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            {s.onlySubscription ? (
              <span className="rounded bg-hover px-1.5 py-px text-[0.8em] text-fg-2" title="Über ein Abo – echte Kosten unbekannt">
                Abo · Kosten unbekannt
              </span>
            ) : (
              <span className="tabular-nums">{eur(s.cost, 2)}</span>
            )}
          </div>
          <div className="mt-0.5 flex gap-3 text-[0.78em] text-muted">
            <span>{tokens(s.tokens)} Tokens</span>
            <span>{s.calls.toLocaleString("de-DE")} Aufrufe</span>
            {s.subscription && s.list > 0 && <span title="Nur zum Vergleich">zum Listenpreis ≈ {eur(s.list, 2)}</span>}
          </div>
          {total > 0 && !s.onlySubscription && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-active">
              <div className="h-full rounded-full bg-accent/70" style={{ width: `${(s.cost / total) * 100}%` }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
  return (
    <section className="mb-6" id="card-anbieter-und-agenten">
      <h3 className="mb-1 text-[0.95em] font-semibold">Anbieter und Agenten</h3>
      <p className="mb-2 text-[0.88em] text-muted">Diesen Monat. Das Budget gilt über alle Anbieter; Abos zählen mit 0 €.</p>
      <div className="grid grid-cols-2 gap-3">
        <List title="Je Anbieter" rows={byProvider} />
        <List title="Je Agent" rows={byAgent} />
      </div>
    </section>
  );
}

/** Kosten je Master-Session: eigene Turns plus die ihrer Untersessions. */
function MasterCard({ records }: { records: UsageRecord[] }) {
  const titles = useStore((s) => s.sessions);
  const index = useStore((s) => s.index);
  const rows = useMemo(() => {
    const masters = new Set(records.flatMap((r) => (r.master ? [r.master] : [])));
    return [...masters]
      .map((m) => {
        const own = records.filter((r) => r.session === m);
        const subs = records.filter((r) => r.master === m);
        const tokens = [...own, ...subs].reduce((a, r) => a + (r.input ?? 0) + (r.output ?? 0), 0);
        return {
          id: m,
          title: titles[m]?.title ?? index.find((x) => x.sessionId === m)?.title ?? own.find((r) => r.title)?.title ?? m.slice(0, 8),
          sessions: new Set(subs.map((r) => r.session)).size,
          own: own.reduce((a, r) => a + r.cost, 0),
          sub: subs.reduce((a, r) => a + r.cost, 0),
          tokens,
        };
      })
      .sort((a, b) => b.own + b.sub - (a.own + a.sub));
  }, [records, titles, index]);
  if (!rows.length) return null;
  return (
    <Card title="Master-Sessions" description="Diesen Monat: Kurator (die Master-Session selbst) und Arbeiter (ihre Untersessions), geschätzt nach Preistabelle.">
      {rows.map((r) => (
        <Row
          key={r.id}
          title={r.title}
          description={`${r.sessions} Untersession${r.sessions === 1 ? "" : "s"} · ${r.tokens.toLocaleString("de-DE")} Tokens · Kurator ${eur(r.own, 2)}, Arbeiter ${eur(r.sub, 2)}`}
          control={<span className="font-medium tabular-nums">{eur(r.own + r.sub, 2)}</span>}
        />
      ))}
    </Card>
  );
}

function NumberInput({ value, onCommit, step = 1, className }: { value: number; onCommit: (v: number) => void; step?: number; className?: string }) {
  const [draft, setDraft] = useState(String(value).replace(".", ","));
  useEffect(() => setDraft(String(value).replace(".", ",")), [value]);
  const commit = () => {
    const n = Number(draft.replace(",", "."));
    if (Number.isFinite(n) && n >= 0 && n !== value) onCommit(n);
    else setDraft(String(value).replace(".", ","));
  };
  return (
    <input
      inputMode="decimal"
      step={step}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      className={clsx("h-8 rounded-lg border border-line bg-panel px-2 text-right tabular-nums outline-none focus:border-accent", className ?? "w-24")}
    />
  );
}

function BudgetCard() {
  const settings = useUsage((s) => s.settings)!;
  const [levels, setLevels] = useState(settings.warnAt.join(", "));
  useEffect(() => setLevels(settings.warnAt.join(", ")), [settings.warnAt]);
  return (
    <Card title="Budget und Warnungen">
      <Row title="Monatsbudget" description="Über alle Anbieter zusammen (Standard 255 €). Abos (Claude, Codex, Gemini) zählen nicht mit – ihre Kosten kennt Brise nicht." control={<span className="flex items-center gap-1.5"><NumberInput value={settings.budgetEur} onCommit={(v) => saveUsageSettings({ budgetEur: v })} /> €</span>} />
      <Row
        title="Warnungen bei"
        description="Prozent des Budgets, je einmal pro Monat."
        control={
          <span className="flex items-center gap-1.5">
            <input
              value={levels}
              onChange={(e) => setLevels(e.target.value)}
              onBlur={() => {
                const list = [...new Set(levels.split(/[,; ]+/).map(Number).filter((n) => n > 0 && n <= 100))].sort((a, b) => a - b);
                if (list.length) saveUsageSettings({ warnAt: list });
              }}
              className="h-8 w-28 rounded-lg border border-line bg-panel px-2 text-right outline-none focus:border-accent"
            />
            %
          </span>
        }
      />
      <Row
        title={`Ab ${settings.avoidAt} % teure Modelle meiden`}
        description="Die Auto-Modellwahl nimmt dann ein deutlich günstigeres Modell aus deiner Auswahl. Manuell gewählte Modelle bleiben unverändert."
        control={<Switch checked={settings.avoidExpensive} onChange={(v) => saveUsageSettings({ avoidExpensive: v })} />}
      />
    </Card>
  );
}

function ConsoleCard() {
  const settings = useUsage((s) => s.settings)!;
  const [amount, setAmount] = useState("");
  return (
    <Card
      title="Abgleich mit der Mistral-Console (Vibe)"
      description={
        <>
          Den echten Stand zeigt die Console unter{" "}
          <a className="text-accent hover:underline" href="https://console.mistral.ai/usage" target="_blank" rel="noreferrer">
            console.mistral.ai/usage
          </a>
          . Trägst du ihn ein, rechnet Brise ab da mit diesem Betrag weiter.
        </>
      }
    >
      <Row
        title="Stand laut Console"
        description={
          settings.consoleEur != null
            ? `${eur(settings.consoleEur, 2)}, eingetragen am ${new Date(settings.consoleAt ?? 0).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}${(settings.consoleAt ?? 0) < monthStart() ? " (Vormonat, gilt nicht mehr)" : ""}`
            : "Noch nicht eingetragen – die Anzeige beruht nur auf Brises Journal."
        }
        control={
          <span className="flex items-center gap-1.5">
            <input
              inputMode="decimal"
              placeholder="z. B. 62,40"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-8 w-24 rounded-lg border border-line bg-panel px-2 text-right outline-none focus:border-accent"
            />
            €
            <Button
              size="sm"
              disabled={!Number.isFinite(Number(amount.replace(",", "."))) || !amount.trim()}
              onClick={() => (saveUsageSettings({ consoleEur: Number(amount.replace(",", ".")), consoleAt: Date.now() }), setAmount(""))}
            >
              Übernehmen
            </Button>
            {settings.consoleEur != null && (
              <Button size="sm" variant="ghost" onClick={() => saveUsageSettings({ consoleEur: null, consoleAt: null })}>
                Entfernen
              </Button>
            )}
          </span>
        }
      />
    </Card>
  );
}

const PRICE_FIELDS: { key: "input" | "cached" | "output" | "perPage" | "perMinute" | "perMillionChars" | "perCall"; label: string }[] = [
  { key: "input", label: "Eingabe" },
  { key: "cached", label: "Cache" },
  { key: "output", label: "Ausgabe" },
];

function PricesCard() {
  const [data, setData] = useState<{ table: PriceTable; custom: boolean; defaultStand: string } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    usageApi.prices().then(setData).catch(() => {});
  }, []);
  if (!data) return null;
  const { table } = data;
  const cur = table.currency === "USD" ? "$" : "€";

  const save = async (next: PriceTable | null) => {
    await usageApi.savePrices(next);
    setData(await usageApi.prices());
    refreshUsage();
  };
  const patchModel = (i: number, key: string, v: number) =>
    save({ ...table, stand: new Date().toISOString().slice(0, 10), models: table.models.map((m, n) => (n === i ? { ...m, [key]: v } : m)) });

  return (
    <Card
      title="Preistabelle"
      description={
        <>
          Preise in {table.currency} (Standard-Inferenz) {data.custom ? `– eigene Tabelle, Stand ${table.stand}` : `– mitgeliefert, Stand ${table.stand}`}. Die Anbieter
          haben keine einheitliche Preis-API; Quellen: {table.quelle}. Einträge mit Anbieter gelten nur für dessen Aufrufe. Eigene Preise je Anbieter (z. B.
          für OpenAI-kompatible) unter Anbieter &amp; Schlüssel.
        </>
      }
    >
      <Row
        title="Währung der Tabelle"
        description={table.currency === "USD" ? `Umrechnung 1 $ = ${table.usdToEur} €` : "Beträge werden direkt in Euro gerechnet."}
        control={
          <span className="flex items-center gap-2">
            <select value={table.currency} onChange={(e) => save({ ...table, currency: e.target.value })} className="h-8 rounded-lg border border-line bg-panel px-2 outline-none">
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
            </select>
            {table.currency === "USD" && <NumberInput value={table.usdToEur} step={0.01} onCommit={(v) => save({ ...table, usdToEur: v })} className="w-20" />}
          </span>
        }
      />
      <Row
        title={open ? "Preise je Modell" : `${table.models.length} Modelle`}
        description={open ? `${cur} pro Mio. Tokens, OCR pro Seite, Audio pro Minute, Vorlesen pro Mio. Zeichen, Websuche pro Aufruf` : undefined}
        control={
          <span className="flex items-center gap-1.5">
            {data.custom && (
              <Button size="sm" variant="ghost" onClick={() => save(null)} title={`Mitgelieferte Tabelle (Stand ${data.defaultStand}) wiederherstellen`}>
                <RotateCcw className="h-3.5 w-3.5" /> Standard
              </Button>
            )}
            <Button size="sm" onClick={() => setOpen(!open)}>
              {open ? "Zuklappen" : "Bearbeiten"}
            </Button>
          </span>
        }
      />
      {open &&
        table.models.map((m, i) => {
          const fields = m.perPage
            ? [{ key: "perPage" as const, label: "pro Seite" }]
            : m.perMinute
              ? [{ key: "perMinute" as const, label: "pro Minute" }]
              : m.perMillionChars
                ? [{ key: "perMillionChars" as const, label: "pro Mio. Zeichen" }]
                : m.perCall
                  ? [{ key: "perCall" as const, label: "pro Aufruf" }]
                  : PRICE_FIELDS;
          return (
            <div key={m.id} className="flex items-center gap-3 px-4 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  {m.label}
                  {m.provider && <span className="ml-1.5 text-[0.8em] text-muted">{providerLabel(m.provider)}{m.currency ? ` · ${m.currency}` : ""}</span>}
                </div>
                <div className="truncate text-[0.78em] text-muted" title={m.hinweis}>
                  {m.hinweis ?? m.match.join(", ")}
                </div>
              </div>
              {fields.map((f) => (
                <label key={f.key} className="flex flex-col items-end text-[0.72em] text-muted">
                  {f.label}
                  <NumberInput value={m[f.key] ?? 0} step={0.001} onCommit={(v) => patchModel(i, f.key, v)} className="w-20 text-[1.25em]" />
                </label>
              ))}
            </div>
          );
        })}
    </Card>
  );
}
