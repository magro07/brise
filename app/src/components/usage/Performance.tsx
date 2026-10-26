import { useMemo, useState } from "react";
import { latency } from "../../lib/format";
import { clsx } from "../ui";
import type { UsageRecord } from "./usage";

// Leistung je Modell und Anbieter aus den Messwerten im Journal (`ttftMs`,
// `outputTps`, `durationMs`). Vibe-Turns und einzelne API-Aufrufe getrennt:
// Ein Turn enthält Werkzeuge und mehrere Modellaufrufe.

type Measure = "ttft" | "tps";
const LINES = 6;

const PROVIDER: Record<string, string> = { mistral: "Mistral", cortecs: "Cortecs (ZDR)", claude: "Anthropic", codex: "OpenAI", gemini: "Google" };

function provider(r: UsageRecord): string {
  const p = r.provider ?? (r.backend && r.backend !== "vibe" && r.backend !== "brise" ? r.backend : "mistral");
  return PROVIDER[p] ?? p;
}

/** Nächster Rang auf der sortierten Liste. */
function quantile(sorted: number[], q: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

const sorted = (values: (number | undefined)[]) => values.filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
const tps = (v?: number) => (v == null ? "–" : v.toLocaleString("de-DE", { maximumFractionDigits: v < 10 ? 1 : 0 }));
const ms = (v?: number) => (v == null ? "–" : latency(v));
const show = (m: Measure, v?: number) => (m === "ttft" ? ms(v) : `${tps(v)} t/s`);

interface Row {
  key: string;
  label: string;
  provider: string;
  turn: boolean;
  records: UsageRecord[];
  ttft: number[];
  tps: number[];
  duration: number[];
}

export function Performance({ records, bins, binOf }: { records: UsageRecord[]; bins: string[]; binOf: (ts: number) => number }) {
  const [measure, setMeasure] = useState<Measure>("tps");
  const [hover, setHover] = useState<number | null>(null);

  const rows = useMemo(() => {
    const map = new Map<string, Row>();
    for (const r of records) {
      if (r.ttftMs == null && r.outputTps == null && r.durationMs == null) continue;
      const turn = !!r.turns;
      const key = `${provider(r)}|${r.label}|${turn}`;
      const row = map.get(key) ?? { key, label: r.label, provider: provider(r), turn, records: [], ttft: [], tps: [], duration: [] };
      row.records.push(r);
      map.set(key, row);
    }
    for (const row of map.values()) {
      row.ttft = sorted(row.records.map((r) => r.ttftMs));
      row.tps = sorted(row.records.map((r) => r.outputTps));
      row.duration = sorted(row.records.map((r) => r.durationMs));
    }
    // Zeilen mit TTFT oder t/s vor denen, die nur eine Dauer haben (ältere Cortecs-Einträge).
    const rich = (r: Row) => r.ttft.length + r.tps.length;
    return [...map.values()].sort((a, b) => Number(rich(b) > 0) - Number(rich(a) > 0) || b.records.length - a.records.length);
  }, [records]);

  const chart = useMemo(() => {
    const lines = rows.filter((r) => (measure === "ttft" ? r.ttft : r.tps).length).slice(0, LINES);
    const points = lines.map((row) => {
      const perBin: number[][] = bins.map(() => []);
      for (const r of row.records) {
        const v = measure === "ttft" ? r.ttftMs : r.outputTps;
        const i = binOf(r.ts);
        if (v != null && i >= 0) perBin[i].push(v);
      }
      return perBin.map((list) => quantile(sorted(list), 0.5));
    });
    const max = Math.max(0, ...points.flat().filter((v): v is number => v != null));
    return { lines, points, max };
  }, [rows, measure, bins, binOf]);

  if (!rows.length)
    return (
      <div className="mt-4 rounded-xl border border-line bg-elev px-4 py-3.5 text-[0.86em] text-muted">
        <span className="font-medium text-fg">Leistung</span> – noch keine Messwerte in diesem Zeitraum. Brise misst seit dieser Version jeden Turn und jeden
        eigenen Modellaufruf.
      </div>
    );

  const color = (i: number) => `var(--series-${i + 1})`;
  const W = 600;
  const H = 120;
  const x = (i: number) => (bins.length > 1 ? (i / (bins.length - 1)) * W : W / 2);
  const y = (v: number) => H - (v / (chart.max || 1)) * (H - 8) - 4;

  return (
    <div className="mt-4 rounded-xl border border-line bg-elev p-4">
      <div className="mb-2 flex items-center gap-3 text-[0.8em]">
        <span className="font-medium">Leistung je Modell und Anbieter</span>
        <div className="ml-auto flex rounded-lg border border-line bg-panel p-0.5">
          {(
            [
              ["tps", "Tokens/s"],
              ["ttft", "Erstes Token"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} onClick={() => setMeasure(id)} className={clsx("rounded-md px-2.5 py-1", measure === id ? "bg-elev text-fg shadow-soft" : "text-muted hover:text-fg")}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34em] table-fixed text-[0.84em] tabular-nums">
          <thead className="text-[0.86em] text-muted">
            <tr className="text-right">
              <th className="w-[34%] py-1 text-left font-normal">Modell</th>
              <th className="font-normal">Messungen</th>
              <th className="font-normal" title="Zeit vom Senden bis zum ersten Token, nur bei gestreamten Antworten">
                Erstes Token Median
              </th>
              <th className="font-normal">p90</th>
              <th className="font-normal" title="Output-Tokens je Sekunde Generierungszeit">
                t/s Median
              </th>
              <th className="font-normal">p90</th>
              <th className="font-normal">Dauer Median</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.slice(0, 14).map((r) => {
              const line = chart.lines.indexOf(r);
              return (
                <tr key={r.key} className="text-right">
                  <td className="py-1.5 text-left">
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: line >= 0 ? color(line) : "transparent" }} />
                      <span className="truncate" title={r.label}>
                        {r.label}
                      </span>
                    </div>
                    <div className="truncate pl-3.5 text-[0.86em] text-muted">
                      {r.provider} · {r.turn ? "Vibe-Turn" : "Aufruf"}
                    </div>
                  </td>
                  <td className="text-muted">{r.records.length}</td>
                  <td>{ms(quantile(r.ttft, 0.5))}</td>
                  <td className="text-muted">{ms(quantile(r.ttft, 0.9))}</td>
                  <td>{tps(quantile(r.tps, 0.5))}</td>
                  <td className="text-muted">{tps(quantile(r.tps, 0.9))}</td>
                  <td>{ms(quantile(r.duration, 0.5))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {chart.lines.length > 0 && (
        <>
          <div className="mb-1 mt-4 flex items-center text-[0.78em] text-fg-2">
            <span>Verlauf (Median)</span>
            <span className="ml-auto tabular-nums text-muted">
              {hover != null
                ? `${bins[hover]}: ${chart.lines
                    .map((l, i) => (chart.points[i][hover] != null ? `${l.label} ${show(measure, chart.points[i][hover])}` : null))
                    .filter(Boolean)
                    .join(" · ") || "keine Messung"}`
                : `höchster Wert ${show(measure, chart.max)}`}
            </span>
          </div>
          <div className="relative" onMouseLeave={() => setHover(null)}>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-32 w-full overflow-visible">
              {hover != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="var(--line)" vectorEffect="non-scaling-stroke" />}
              {chart.points.map((pts, i) => {
                const path = pts.map((v, n) => (v == null ? null : `${x(n)},${y(v)}`)).filter(Boolean);
                return (
                  <g key={i} stroke={color(i)} fill={color(i)}>
                    <polyline points={path.join(" ")} fill="none" strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                  </g>
                );
              })}
            </svg>
            {/* Punkte als HTML, damit sie bei gestrecktem SVG rund bleiben. */}
            {chart.points.map((pts, i) =>
              pts.map((v, n) =>
                v == null ? null : (
                  <span
                    key={`${i}-${n}`}
                    className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{ left: `${(x(n) / W) * 100}%`, top: `${(y(v) / H) * 100}%`, background: color(i) }}
                  />
                ),
              ),
            )}
            <div className="absolute inset-0 flex">
              {bins.map((_, n) => (
                <div key={n} className="h-full flex-1" onMouseEnter={() => setHover(n)} />
              ))}
            </div>
          </div>
          <div className="mt-1.5 flex justify-between text-[0.72em] text-muted">
            <span>{bins[0]}</span>
            <span>{bins[bins.length - 1]}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.78em] text-fg-2">
            {chart.lines.map((l, i) => (
              <span key={l.key} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color(i) }} />
                {l.label} <span className="text-muted">{l.turn ? "Turn" : "Aufruf"}</span>
              </span>
            ))}
          </div>
        </>
      )}

      <p className="mt-2 text-[0.76em] text-muted">
        Turns: vom Senden bis zum ersten Text- oder Gedanken-Chunk; t/s über die Zeit, in der Vibe tatsächlich Text oder Werkzeugaufrufe erzeugte (ohne Werkzeuge,
        ohne Turns mit Subagents). Aufrufe ohne Stream (Task-Modell, Council, Codestral) haben kein „erstes Token“, ihre t/s rechnen über die ganze Dauer und sind
        daher eine Untergrenze. Cortecs-Turns misst der ZDR-Proxy je Modellaufruf.
      </p>
    </div>
  );
}
