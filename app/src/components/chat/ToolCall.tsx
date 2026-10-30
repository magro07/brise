import { useState } from "react";
import {
  ArrowRightLeft,
  Bot,
  Brain,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  History,
  Repeat,
  Search,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { Item, ToolItem } from "../../lib/store";
import { useStore } from "../../lib/store";
import { short } from "../../lib/format";
import { Spinner, clsx } from "../ui";
import { Diff } from "./Diff";
import { Markdown } from "./Markdown";
import { CouncilToolCard } from "./Council";
import { councilToolName } from "../../lib/council";
import { isComputerTool } from "../../lib/computer";
import { ComputerShots } from "../computer/Computer";

export function isSubagent(t: ToolItem) {
  return !!(t.meta?.agent || t.meta?.task || t.meta?.child_session_id);
}

/** Eigene Karten statt Zeilen: Subagents und Council. */
const isCard = (t: ToolItem) => isSubagent(t) || councilToolName(t) != null;

export function toolIcon(t: ToolItem) {
  if (isSubagent(t)) return Bot;
  if (t.meta?.skill_name) return Sparkles;
  switch (t.kind) {
    case "read":
      return FileText;
    case "edit":
      return FilePen;
    case "delete":
      return Trash2;
    case "move":
      return ArrowRightLeft;
    case "search":
      return Search;
    case "execute":
      return Terminal;
    case "think":
      return Brain;
    case "fetch":
      return Globe;
    case "switch_mode":
      return Repeat;
    default:
      return Wrench;
  }
}

/** Kurzer, deutscher Titel: Vibes Titel ohne englische Verlaufsform. */
export function toolTitle(t: ToolItem): { verb: string; target: string } {
  const title = t.title ?? "";
  if (title.includes("semantic_code_search")) {
    const q = (t.rawInput as { query?: string } | undefined)?.query;
    return { verb: "Semantische Suche", target: q ? `„${q}“` : "" };
  }
  if (title === "Searching for relevant tools") return { verb: "Werkzeuge gesucht", target: "" };
  if (/^Writing \d+ todos?$/.test(title)) return { verb: "Aufgabenliste aktualisiert", target: "" };
  const m = /^(Reading|Editing|Writing|Creating|Deleting|Searching|Listing|Fetching|Moving)\s+(.*)$/i.exec(title);
  const verbs: Record<string, string> = {
    reading: "Gelesen",
    editing: "Bearbeitet",
    writing: "Geschrieben",
    creating: "Erstellt",
    deleting: "Gelöscht",
    searching: "Gesucht",
    listing: "Aufgelistet",
    fetching: "Abgerufen",
    moving: "Verschoben",
  };
  if (m) return { verb: verbs[m[1].toLowerCase()] ?? m[1], target: m[2] };
  const bash = /^bash:\s*(.*)$/s.exec(title);
  if (bash) return { verb: "Befehl", target: bash[1] };
  return { verb: "", target: title };
}

function StatusIcon({ status }: { status: string }) {
  if (status === "in_progress" || status === "pending") return <Spinner className="text-muted" />;
  if (status === "failed") return <X className="h-3.5 w-3.5 text-bad" />;
  return null;
}

export function ToolRow({ tool, cwd }: { tool: ToolItem; cwd: string }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(tool);
  const { verb, target } = toolTitle(tool);
  const shortTarget = target.startsWith(cwd) ? target.slice(cwd.length).replace(/^[\\/]/, "") : target;
  const hasDetails = tool.rawInput != null || tool.output.length > 0 || tool.rawOutput != null;
  return (
    <div>
      <button
        className="group flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-hover"
        onClick={() => hasDetails && setOpen(!open)}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
        {verb && <span className="shrink-0 text-muted">{verb}</span>}
        <span className={clsx("min-w-0 flex-1 truncate", tool.kind === "execute" ? "font-mono text-[0.86em] text-muted" : "text-muted")}>
          {shortTarget}
        </span>
        <StatusIcon status={tool.status} />
        {hasDetails && (
          <ChevronRight className={clsx("h-3.5 w-3.5 text-muted opacity-0 transition group-hover:opacity-100", open && "rotate-90 opacity-100")} />
        )}
      </button>
      {open && (
        <div className="mb-2 ml-6 mt-1 space-y-2">
          {tool.rawInput != null && (
            <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-code p-2.5 font-mono text-[0.8em] whitespace-pre-wrap selectable">
              {formatInput(tool)}
            </pre>
          )}
          {tool.output.map((o, n) => (
            <pre key={n} className="max-h-80 overflow-auto rounded-lg border border-line bg-code p-2.5 font-mono text-[0.8em] whitespace-pre-wrap selectable">
              {short(o, 20000)}
            </pre>
          ))}
          {tool.output.length === 0 && tool.rawOutput != null && (
            <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-code p-2.5 font-mono text-[0.8em] whitespace-pre-wrap selectable">
              {short(tool.rawOutput, 20000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function formatInput(tool: ToolItem): string {
  const input = tool.rawInput as Record<string, unknown> | string;
  if (typeof input === "object" && input && typeof input.command === "string") return `$ ${input.command}`;
  return short(input, 20000);
}

export function SubagentCard({ tool, cwd }: { tool: ToolItem; cwd: string }) {
  const [open, setOpen] = useState(false);
  const openChild = useStore((s) => s.openChildSession);
  const m = tool.meta ?? {};
  const running = tool.status === "in_progress" || tool.status === "pending";
  return (
    <div className="my-1 overflow-hidden rounded-xl border border-line bg-elev">
      <button className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-hover" onClick={() => setOpen(!open)}>
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">Subagent</span>
            {m.agent && <span className="rounded bg-hover px-1.5 font-mono text-[0.78em] text-fg-2">{String(m.agent)}</span>}
            {m.turn_count != null && <span className="text-[0.8em] text-muted">{m.turn_count} Schritte</span>}
          </div>
          <div className={clsx("mt-0.5 text-[0.9em] text-fg-2", !open && "line-clamp-2")}>{String(m.task ?? tool.title)}</div>
        </div>
        <div className="mt-1">
          <StatusIcon status={tool.status} />
        </div>
      </button>
      {(open || running) && (
        <div className="border-t border-line px-3 py-2.5">
          {m.response ? (
            <Markdown text={String(m.response)} />
          ) : (
            <div className="shimmer-text text-[0.9em]">{running ? "Arbeitet an der Aufgabe …" : "Keine Antwort"}</div>
          )}
          {m.child_session_id && (
            <button
              className="mt-2 inline-flex items-center gap-1.5 text-[0.86em] text-accent hover:underline"
              onClick={() => openChild(String(m.child_session_id), cwd)}
            >
              <History className="h-3.5 w-3.5" /> Verlauf des Subagenten öffnen
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const KIND_SUMMARY: Record<string, [string, string]> = {
  read: ["Datei gelesen", "Dateien gelesen"],
  edit: ["Datei bearbeitet", "Dateien bearbeitet"],
  delete: ["Datei gelöscht", "Dateien gelöscht"],
  move: ["verschoben", "verschoben"],
  search: ["Suche", "Suchen"],
  execute: ["Befehl", "Befehle"],
  fetch: ["Abruf", "Abrufe"],
  think: ["Gedanke", "Gedanken"],
  other: ["Aktion", "Aktionen"],
};

function summarize(tools: ToolItem[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.kind in KIND_SUMMARY ? t.kind : "other", (counts.get(t.kind in KIND_SUMMARY ? t.kind : "other") ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${n} ${KIND_SUMMARY[k][n === 1 ? 0 : 1]}`).join(" · ");
}

/** Aufeinanderfolgende Werkzeugaufrufe, wie in Claude Code zusammengefasst. */
export function ToolGroup({ items, cwd, live }: { items: Item[]; cwd: string; live: boolean }) {
  const tools = items.filter((i): i is ToolItem => i.type === "tool");
  const plain = tools.filter((t) => !isCard(t));
  const anyRunning = tools.some((t) => t.status === "in_progress" || t.status === "pending");
  const [open, setOpen] = useState(false);
  const collapsible = plain.length > 2;
  const expanded = !collapsible || open;
  const lastRunning = [...plain].reverse().find((t) => t.status === "in_progress" || t.status === "pending");

  return (
    <div data-brise="tool-group" className="space-y-1">
      {collapsible && (
        <button
          className="flex h-7 items-center gap-2 rounded-md px-1.5 text-[0.9em] text-muted hover:bg-hover hover:text-fg"
          onClick={() => setOpen(!open)}
        >
          <ChevronRight className={clsx("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} />
          {anyRunning && live ? <span className="shimmer-text">Arbeitet …</span> : <span>{summarize(plain)}</span>}
        </button>
      )}
      <div className={clsx(collapsible && "ml-3 border-l border-line pl-2")}>
        {items.map((item, idx) => {
          if (item.type === "tool") {
            if (isSubagent(item)) return <SubagentCard key={item.id} tool={item} cwd={cwd} />;
            if (councilToolName(item)) return <CouncilToolCard key={item.id} tool={item} cwd={cwd} />;
            if (!expanded && item !== lastRunning) return null;
            return <ToolRow key={item.id} tool={item} cwd={cwd} />;
          }
          if (item.type === "decision" && expanded) {
            // Gleiche Freigaben direkt hintereinander zu einer Zeile zusammenfassen.
            const prev = items[idx - 1];
            if (prev?.type === "decision" && prev.label === item.label && prev.allowed === item.allowed) return null;
            let count = 1;
            for (let k = idx + 1; k < items.length; k++) {
              const next = items[k];
              if (next.type === "decision" && next.label === item.label && next.allowed === item.allowed) count++;
              else break;
            }
            return (
              <div key={item.id} className={clsx("flex h-6 items-center gap-2 px-1.5 text-[0.84em]", item.allowed ? "text-ok" : "text-bad")}>
                {item.allowed ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldX className="h-3.5 w-3.5" />}
                {count > 1 ? `${count}× ${item.label.charAt(0).toLowerCase()}${item.label.slice(1)}` : item.label}
              </div>
            );
          }
          return null;
        })}
      </div>
      {plain.some(isComputerTool) && <ComputerShots toolCallIds={plain.filter(isComputerTool).map((t) => t.toolCallId)} />}
      {/* Änderungen immer sichtbar, wie in Claude Code. */}
      {plain.flatMap((t) => t.diffs.map((d, n) => <Diff key={`${t.id}-${n}`} {...d} cwd={cwd} />))}
    </div>
  );
}
