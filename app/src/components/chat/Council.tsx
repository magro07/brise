import { useState } from "react";
import { Check, ChevronRight, Scale, Send, X } from "lucide-react";
import { useStore, type Item, type ToolItem } from "../../lib/store";
import { TOOL_LABEL, councilRunId, councilToolName, euro, runAsPrompt, sendTo, useCouncilRun, type CouncilOpinion, type CouncilRun, type CouncilTool } from "../../lib/council";
import { duration, short, tokens } from "../../lib/format";
import { Spinner, clsx } from "../ui";

const SEVERITY_STYLE: Record<string, string> = {
  kritisch: "bg-bad-soft text-bad",
  hoch: "bg-warn-soft text-warn",
  mittel: "bg-accent-soft text-accent",
  niedrig: "bg-hover text-muted",
};

const DECISION_STYLE: Record<string, string> = {
  bestätigt: "text-ok",
  umstritten: "text-warn",
  verworfen: "text-muted line-through",
};

const VERDICT_STYLE: Record<string, string> = {
  bestätigt: "bg-ok-soft text-ok",
  einwände: "bg-bad-soft text-bad",
  unklar: "bg-warn-soft text-warn",
};

/** Kurzname für die Modell-Chips. */
const modelName = (m: string) =>
  m
    .replace(/^zai-/, "")
    .replace(/-latest$/, "")
    .replace(/^glm-5-3/, "GLM-5.3")
    .replace(/^mistral-large-4/, "Large 4")
    .replace(/^mistral-medium-3\.5/, "Medium 3.5")
    .replace(/^magistral-medium/, "Magistral")
    .replace(/^codestral/, "Codestral");

function Loc({ f }: { f: any }) {
  const openFile = useStore((s) => s.openFile);
  if (!f.file) return <span className="text-muted">allgemein</span>;
  return (
    <button className="font-mono text-[0.88em] text-accent hover:underline" onClick={() => openFile(String(f.file))} title="Datei öffnen">
      {f.file}
      {f.line != null && `:${f.line}`}
    </button>
  );
}

/** Ein Befund, eine Hypothese oder ein Einwand. */
function Entry({ f, tool, compact }: { f: any; tool: CouncilTool; compact?: boolean }) {
  const level = tool === "debug" ? f.likelihood : f.severity;
  const head = f.title ?? f.cause ?? f.issue ?? "";
  return (
    <li className={clsx("rounded-lg px-2.5 py-2", !compact && "border border-line bg-panel", f.decision === "verworfen" && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {level && (
          <span className={clsx("rounded px-1.5 text-[0.75em] font-medium", SEVERITY_STYLE[level] ?? SEVERITY_STYLE.mittel)}>
            {tool === "debug" ? `Wahrscheinlichkeit ${level}` : level}
          </span>
        )}
        {f.agreement && (
          <span className="rounded bg-hover px-1.5 font-mono text-[0.75em] text-fg-2" title="Von so vielen Mitgliedern unabhängig genannt">
            {f.agreement}
          </span>
        )}
        {f.decision && <span className={clsx("text-[0.78em] font-medium", DECISION_STYLE[f.decision])}>{f.decision}</span>}
        <Loc f={f} />
      </div>
      <div className={clsx("mt-1 font-medium", f.decision === "verworfen" && "line-through")}>{head}</div>
      {!compact && (
        <div className="mt-0.5 space-y-0.5 text-[0.9em] text-fg-2 selectable">
          {f.reason && <p>{f.reason}</p>}
          {f.evidence && <p>{f.evidence}</p>}
          {f.check && (
            <p>
              <span className="text-muted">Prüfen: </span>
              {f.check}
            </p>
          )}
          {f.fix && (
            <p>
              <span className="text-muted">Vorschlag: </span>
              {f.fix}
            </p>
          )}
          {f.note && <p className="text-[0.92em] italic text-muted">Vorsitz: {f.note}</p>}
        </div>
      )}
    </li>
  );
}

function entries(result: any): any[] {
  return result?.findings ?? result?.hypotheses ?? result?.objections ?? [];
}

function Verdict({ result }: { result: any }) {
  if (!result?.verdict) return null;
  const v = result.votes ?? {};
  return (
    <div className="flex items-center gap-2">
      <span className={clsx("rounded-md px-2 py-0.5 text-[0.85em] font-semibold", VERDICT_STYLE[result.verdict])}>{result.verdict}</span>
      <span className="text-[0.82em] text-muted">
        bestätigt {v["bestätigt"] ?? 0} · Einwände {v["einwände"] ?? 0} · unklar {v["unklar"] ?? 0}
      </span>
    </div>
  );
}

function OpinionChip({ o }: { o: CouncilOpinion }) {
  return (
    <span
      className={clsx("inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-1.5 py-0.5 text-[0.78em]", o.status === "fehler" && "border-bad/40")}
      title={o.error ?? `${o.model} als ${o.role}${o.ms ? ` · ${duration(o.ms)}` : ""}`}
    >
      {o.status === "wartet" ? <Spinner className="text-accent" /> : o.status === "fehler" ? <X className="h-3 w-3 text-bad" /> : <Check className="h-3 w-3 text-ok" />}
      <span className="font-medium">{modelName(o.model)}</span>
      <span className="text-muted">{o.role}</span>
    </span>
  );
}

function Opinion({ o, tool }: { o: CouncilOpinion; tool: CouncilTool }) {
  const [open, setOpen] = useState(false);
  const list = entries(o.result);
  return (
    <div className="rounded-lg border border-line">
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.86em] hover:bg-hover" onClick={() => setOpen(!open)}>
        <ChevronRight className={clsx("h-3.5 w-3.5 text-muted transition-transform", open && "rotate-90")} />
        <span className="font-medium">#{o.index || "V"} {o.model}</span>
        <span className="text-muted">{o.role}</span>
        <span className="flex-1" />
        {o.status === "fehler" ? (
          <span className="truncate text-bad">{o.error}</span>
        ) : o.status === "wartet" ? (
          <Spinner />
        ) : (
          <span className="text-muted">
            {o.result?.verdict ? `${o.result.verdict} · ` : `${list.length} Punkte · `}
            {duration(o.ms)} · {tokens(o.input + o.output)} · {euro(o.costEur)}
          </span>
        )}
      </button>
      {open && o.status === "fertig" && (
        <div className="border-t border-line px-2.5 py-2">
          {o.result?.summary && <p className="mb-1.5 text-[0.9em] text-fg-2">{o.result.summary}</p>}
          <ul className="space-y-1">
            {list.map((f, n) => (
              <Entry key={n} f={f} tool={tool} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Die Karte: Modelle, Ergebnis, Einzelurteile, Kosten. */
export function CouncilCard({ run, tool, running, error, sessionId }: { run: CouncilRun | null; tool: CouncilTool; running: boolean; error?: string; sessionId?: string }) {
  const [showAll, setShowAll] = useState(false);
  const [showOpinions, setShowOpinions] = useState(false);
  const busy = running || run?.status === "läuft";
  const list = entries(run?.result);
  const visible = showAll ? list : list.slice(0, 6);
  const done = run?.opinions.filter((o) => o.status !== "wartet").length ?? 0;
  const ms = run?.finishedAt ? run.finishedAt - run.startedAt : 0;
  const sessionBusy = useStore((s) => (sessionId ? s.sessions[sessionId]?.running : true));

  return (
    <div data-brise="council" className="my-1 overflow-hidden rounded-xl border border-line bg-elev">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Scale className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Model Council</span>
            <span className="rounded bg-hover px-1.5 text-[0.78em] text-fg-2">{TOOL_LABEL[run?.tool ?? tool]}</span>
            {busy && run && (
              <span className="shimmer-text text-[0.82em]">
                {done < run.opinions.length ? `${done} von ${run.opinions.length} Meinungen …` : "Vorsitz führt zusammen …"}
              </span>
            )}
            {busy && !run && <span className="shimmer-text text-[0.82em]">Fragt die Modelle …</span>}
          </div>
          {run?.subject && <div className="mt-0.5 line-clamp-2 text-[0.88em] text-fg-2">{run.subject}</div>}
          {run && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {run.opinions.map((o) => (
                <OpinionChip key={o.index} o={o} />
              ))}
              {run.chair && <OpinionChip o={run.chair} />}
            </div>
          )}
        </div>
        <div className="mt-1">{busy ? <Spinner className="text-accent" /> : run?.status === "fertig" ? <Check className="h-3.5 w-3.5 text-ok" /> : <X className="h-3.5 w-3.5 text-bad" />}</div>
      </div>

      {(error || run?.error) && <div className="border-t border-line bg-bad-soft/50 px-3 py-2 text-[0.88em] text-bad selectable">{short(error ?? run?.error, 600)}</div>}

      {run?.status === "fertig" && (
        <div className="space-y-2 border-t border-line px-3 py-2.5">
          <Verdict result={run.result} />
          {run.result?.summary && <p className="text-[0.92em] selectable">{run.result.summary}</p>}
          {list.length === 0 && !run.result?.verdict && <p className="text-[0.9em] text-ok">Keine Befunde – das Council hat nichts Belastbares gefunden.</p>}
          {list.length > 0 && (
            <ul className="space-y-1.5">
              {visible.map((f, n) => (
                <Entry key={n} f={f} tool={run.tool} />
              ))}
            </ul>
          )}
          {list.length > visible.length && (
            <button className="text-[0.84em] text-accent hover:underline" onClick={() => setShowAll(true)}>
              {list.length - visible.length} weitere anzeigen
            </button>
          )}
          {run.notes.map((n, i) => (
            <p key={i} className="text-[0.82em] text-warn">
              {n}
            </p>
          ))}
        </div>
      )}

      {run && run.opinions.some((o) => o.status !== "wartet") && (
        <div className="border-t border-line px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8em] text-muted">
            <button className="inline-flex items-center gap-1 hover:text-fg" onClick={() => setShowOpinions(!showOpinions)}>
              <ChevronRight className={clsx("h-3.5 w-3.5 transition-transform", showOpinions && "rotate-90")} />
              Einzelurteile ({run.opinions.length})
            </button>
            {ms > 0 && <span>{duration(ms)}</span>}
            <span>{tokens(run.input + run.output)} Tokens</span>
            <span>≈ {euro(run.costEur)}</span>
            {run.mergedBy && (
              <span>
                {run.mergedBy === "vorsitz" ? `zusammengeführt von ${modelName(run.chair?.model ?? "")}` : run.tool === "verify" ? "Mehrheitsentscheid" : "von Brise gruppiert"}
              </span>
            )}
            <span className="flex-1" />
            {sessionId && run.status === "fertig" && list.length > 0 && (
              <button
                className="inline-flex items-center gap-1 text-accent hover:underline disabled:opacity-50"
                disabled={sessionBusy}
                onClick={() => sendTo(sessionId, runAsPrompt(run))}
              >
                <Send className="h-3 w-3" /> An Agent übergeben
              </button>
            )}
          </div>
          {showOpinions && (
            <div className="mt-2 space-y-1.5">
              {run.opinions.map((o) => (
                <Opinion key={o.index} o={o} tool={run.tool} />
              ))}
              {run.chair && <Opinion o={run.chair} tool={run.tool} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Karte für einen Werkzeugaufruf des Agenten (MCP-Server brise-council). */
export function CouncilToolCard({ tool, cwd }: { tool: ToolItem; cwd: string }) {
  const name = councilToolName(tool) ?? "review";
  const running = tool.status === "in_progress" || tool.status === "pending";
  // council_result wartet nur auf einen Lauf, dessen Karte schon weiter oben steht.
  if (name === "result")
    return (
      <div className="flex h-7 items-center gap-2 px-1.5 text-[0.9em] text-muted">
        <Scale className="h-3.5 w-3.5" />
        {running ? <span className="shimmer-text">Wartet auf das Council …</span> : <span>Auf das Council gewartet</span>}
      </div>
    );
  return <RunToolCard tool={tool} cwd={cwd} name={name} running={running} />;
}

function RunToolCard({ tool, cwd, name, running }: { tool: ToolItem; cwd: string; name: CouncilTool; running: boolean }) {
  // Beim Start kennt die Oberfläche die Lauf-ID noch nicht – sie sucht den Lauf.
  const [since] = useState(() => Date.now() - 20_000);
  const id = councilRunId(tool);
  const run = useCouncilRun(id, !id && running ? { cwd, tool: name, since } : undefined);
  const failed = tool.status === "failed" || (!running && !run && !id);
  const errorText = failed ? tool.output.join("\n") || short(tool.rawOutput, 600) || "Council-Aufruf fehlgeschlagen" : undefined;
  return <CouncilCard run={run} tool={name} running={running} error={errorText} />;
}

/** Direkt gestarteter Lauf (Git-Panel) im Chat. */
export function CouncilItemCard({ item, sessionId }: { item: Extract<Item, { type: "council" }>; sessionId: string }) {
  const run = useCouncilRun(item.runId, !item.runId && !item.error ? { cwd: item.cwd, tool: item.tool, since: item.startedAt } : undefined);
  return <CouncilCard run={run} tool={item.tool as CouncilTool} running={!item.runId && !item.error} error={item.error} sessionId={sessionId} />;
}
