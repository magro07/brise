// Model Council: Typen, Aufrufe (src-tauri/src/council.rs) und Aktionen.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useStore, type Item, type ToolItem } from "./store";

export type CouncilTool = "review" | "debug" | "verify";

export interface CouncilOpinion {
  index: number;
  model: string;
  role: string;
  status: "wartet" | "fertig" | "fehler";
  error?: string | null;
  ms: number;
  input: number;
  output: number;
  costEur: number;
  result: any;
}

export interface CouncilRun {
  id: string;
  tool: CouncilTool;
  cwd: string;
  startedAt: number;
  finishedAt?: number | null;
  status: "läuft" | "fertig" | "fehler";
  subject: string;
  opinions: CouncilOpinion[];
  chair?: CouncilOpinion | null;
  result: any;
  mergedBy: "vorsitz" | "brise" | "";
  input: number;
  output: number;
  costEur: number;
  contextChars: number;
  truncated: boolean;
  notes: string[];
  error?: string | null;
}

export const councilApi = {
  start: (cwd: string, tool: CouncilTool, args: Record<string, unknown>) => invoke<CouncilRun>("council_start", { cwd, tool, args }),
  run: (id: string) => invoke<CouncilRun | null>("council_run", { id }),
  find: (cwd: string, tool: string, since: number) => invoke<CouncilRun | null>("council_find", { cwd, tool, since }),
  today: () => invoke<{ spentEur: number; limitEur: number }>("council_today"),
};

export const TOOL_LABEL: Record<CouncilTool, string> = { review: "Review", debug: "Fehlersuche", verify: "Schlussprüfung" };

/** Werkzeugaufruf des MCP-Servers brise-council (Vibe stellt den Servernamen voran). */
export function councilToolName(t: ToolItem): CouncilTool | "result" | null {
  const m = /council_(review|debug|verify|result)/.exec(t.title ?? "");
  return m ? (m[1] as CouncilTool | "result") : null;
}

/** Lauf-ID aus der Antwort des Werkzeugs (`council-run:<id>`). */
export function councilRunId(t: ToolItem): string | undefined {
  const text = [...t.output, typeof t.rawOutput === "string" ? t.rawOutput : JSON.stringify(t.rawOutput ?? "")].join("\n");
  const ids = [...text.matchAll(/council-run:([0-9a-f]+-[0-9a-f]+)/g)];
  if (ids.length) return ids[ids.length - 1][1];
  const input = t.rawInput as { id?: string } | undefined;
  return typeof input?.id === "string" ? input.id.replace(/^council-run:/, "") : undefined;
}

/**
 * Lädt einen Lauf und folgt ihm, solange er läuft. Ohne ID (Werkzeug läuft
 * gerade) sucht er den passenden Lauf ab `find.since`.
 */
export function useCouncilRun(id: string | undefined, find?: { cwd: string; tool: string; since: number }) {
  const [run, setRun] = useState<CouncilRun | null>(null);
  const findKey = find ? `${find.cwd}|${find.tool}|${find.since}` : "";
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const r = id ? await councilApi.run(id) : find ? await councilApi.find(find.cwd, find.tool, find.since) : null;
        if (stop) return;
        if (r) setRun(r);
        if (!r || r.status === "läuft") timer = window.setTimeout(tick, 1500);
      } catch {
        if (!stop) timer = window.setTimeout(tick, 4000);
      }
    };
    tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, findKey]);
  return run;
}

function patchItems(sid: string, fn: (items: Item[]) => Item[]) {
  useStore.setState((s) => {
    const session = s.sessions[sid];
    return session ? { sessions: { ...s.sessions, [sid]: { ...session, items: fn(session.items) } } } : {};
  });
}

/**
 * Prüft den aktuellen Git-Diff direkt, ohne Agent. Das Ergebnis erscheint als
 * Karte in der aktiven Session des Projekts; gibt es keine, liefert die
 * Funktion den Lauf zurück, damit das Git-Panel ihn selbst zeigt.
 */
export async function reviewDiff(cwd: string): Promise<CouncilRun | null> {
  const st = useStore.getState();
  const sid = st.activeSessionId && st.sessions[st.activeSessionId]?.cwd === cwd ? st.activeSessionId : null;
  const itemId = `council-${Date.now()}`;
  if (sid) patchItems(sid, (items) => [...items, { type: "council", id: itemId, tool: "review", cwd, startedAt: Date.now() - 2000 }]);
  try {
    const run = await councilApi.start(cwd, "review", { git_diff: true });
    if (sid) patchItems(sid, (items) => items.map((i) => (i.id === itemId ? { ...i, runId: run.id } : i)));
    return sid ? null : run;
  } catch (e) {
    if (sid) patchItems(sid, (items) => items.map((i) => (i.id === itemId ? { ...i, error: String(e) } : i)));
    else throw e;
    return null;
  }
}

/** Schickt einen Prompt an eine bestimmte Session (send nimmt die aktive). */
export async function sendTo(sessionId: string, text: string) {
  const st = useStore.getState();
  if (st.activeSessionId !== sessionId) await st.selectSession(sessionId);
  await useStore.getState().send(text, []);
}

/** Bittet den Agenten der Session, seine Änderungen vom Council prüfen zu lassen. */
export async function askAgentForCouncil(sessionId: string) {
  await sendTo(
      sessionId,
      "Lass deine bisherigen Änderungen vom Model Council prüfen (council_review mit git_diff: true; bei einer Behauptung „fertig“ council_verify). Arbeite die bestätigten Befunde ab, prüfe umstrittene selbst und fasse am Ende kurz zusammen, was du übernommen hast und was nicht.",
  );
}

/** Ergebnis als Text für den Agenten (Karte → „An Agent übergeben“). */
export function runAsPrompt(run: CouncilRun): string {
  const r = run.result ?? {};
  const loc = (f: any) => (f.file ? `${f.file}${f.line != null ? `:${f.line}` : ""}` : "allgemein");
  const lines = [`Das Model Council (${TOOL_LABEL[run.tool]}, ${run.opinions.map((o) => o.model).join(", ")}) hat Folgendes gemeldet:`];
  if (r.summary) lines.push("", r.summary);
  const list: any[] = r.findings ?? r.hypotheses ?? r.objections ?? [];
  for (const f of list) {
    if (f.decision === "verworfen") continue;
    const head = f.title ?? f.cause ?? f.issue ?? "";
    lines.push(`- [${f.severity ?? f.likelihood ?? "?"} · ${f.agreement ?? "?"}${f.decision ? ` · ${f.decision}` : ""}] ${loc(f)} – ${head}`);
    if (f.reason) lines.push(`  Begründung: ${f.reason}`);
    if (f.fix) lines.push(`  Vorschlag: ${f.fix}`);
  }
  lines.push("", "Arbeite die bestätigten Befunde ab, prüfe umstrittene selbst am Code und sag mir kurz, was du übernommen hast und was nicht.");
  return lines.join("\n");
}

export const euro = (n: number) => `${n < 0.01 && n > 0 ? "< 0,01" : n.toFixed(n < 1 ? 3 : 2).replace(".", ",")} €`;
