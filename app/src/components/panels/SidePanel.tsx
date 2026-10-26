import { useMemo } from "react";
import { Bot, Gauge, GitCompareArrows, History, ListChecks, Minimize2, X } from "lucide-react";
import { useStore, type PanelTab, type Session, type ToolItem } from "../../lib/store";
import { tokens } from "../../lib/format";
import { Button, IconButton, Ring, Spinner, clsx } from "../ui";
import { Diff, diffStats } from "../chat/Diff";
import { isSubagent } from "../chat/ToolCall";
import { Markdown } from "../chat/Markdown";
import { TaskList } from "../composer/Pinned";

export const PANEL_TABS: { id: PanelTab; label: string; icon: typeof Gauge }[] = [
  { id: "changes", label: "Änderungen", icon: GitCompareArrows },
  { id: "context", label: "Kontext", icon: Gauge },
  { id: "agents", label: "Subagents", icon: Bot },
  { id: "tasks", label: "Aufgaben", icon: ListChecks },
];

export function changedFiles(session?: Session) {
  const files = new Map<string, { path: string; diffs: { oldText: string | null; newText: string }[]; added: number; removed: number }>();
  for (const item of session?.items ?? []) {
    if (item.type !== "tool") continue;
    for (const d of item.diffs) {
      const entry = files.get(d.path) ?? { path: d.path, diffs: [], added: 0, removed: 0 };
      const s = diffStats(d.oldText, d.newText);
      entry.diffs.push(d);
      entry.added += s.added;
      entry.removed += s.removed;
      files.set(d.path, entry);
    }
  }
  return [...files.values()];
}

export function subagents(session?: Session): ToolItem[] {
  return (session?.items ?? []).filter((i): i is ToolItem => i.type === "tool" && isSubagent(i));
}

export function SidePanel({ session }: { session?: Session }) {
  const panel = useStore((s) => s.panel);
  const set = useStore((s) => s.set);
  if (!panel) return null;
  return (
    <aside className="flex h-full w-[min(400px,40vw)] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-12 items-center gap-1 border-b border-line px-2">
        {PANEL_TABS.map((t) => (
          <button
            key={t.id}
            title={t.label}
            onClick={() => set({ panel: t.id })}
            className={clsx(
              "flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[0.86em]",
              panel === t.id ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            <t.icon className="h-3.5 w-3.5 shrink-0" />
            {panel === t.id && <span className="truncate">{t.label}</span>}
          </button>
        ))}
        <div className="flex-1" />
        <IconButton label="Panel schließen (Strg+J)" onClick={() => set({ panel: null })}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!session ? (
          <Empty text="Starte oder öffne eine Session, um hier Details zu sehen." />
        ) : panel === "changes" ? (
          <Changes session={session} />
        ) : panel === "context" ? (
          <Context session={session} />
        ) : panel === "agents" ? (
          <Agents session={session} />
        ) : (
          <Tasks session={session} />
        )}
      </div>
    </aside>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-4 py-12 text-center text-[0.9em] text-muted">{text}</div>;
}

function Changes({ session }: { session: Session }) {
  const files = useMemo(() => changedFiles(session), [session.items]);
  if (!files.length) return <Empty text="In dieser Session wurden noch keine Dateien geändert." />;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2 text-[0.9em]">
        <span className="font-medium">{files.length === 1 ? "1 Datei" : `${files.length} Dateien`} geändert</span>
        <span className="font-mono text-ok">+{added}</span>
        <span className="font-mono text-bad">−{removed}</span>
      </div>
      {files.map((f) =>
        f.diffs.map((d, n) => <Diff key={`${f.path}-${n}`} path={f.path} oldText={d.oldText} newText={d.newText} cwd={session.cwd} defaultOpen={files.length < 4} />),
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-elev px-3 py-2.5">
      <div className="text-[0.78em] text-muted">{label}</div>
      <div className="mt-0.5 text-[1.15em] font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[0.75em] text-muted">{hint}</div>}
    </div>
  );
}

function Context({ session }: { session: Session }) {
  const send = useStore((s) => s.send);
  const u = session.usage;
  const ratio = u.used && u.size ? u.used / u.size : 0;
  const prompt = u.promptTokens ?? 0;
  const cached = u.cachedTokens ?? 0;
  const completion = u.completionTokens ?? 0;
  const total = Math.max(1, prompt + completion);
  const segments = [
    { label: "Eingabe (neu)", value: Math.max(0, prompt - cached), color: "var(--accent)" },
    { label: "Eingabe (Cache)", value: cached, color: "color-mix(in srgb, var(--accent) 45%, transparent)" },
    { label: "Ausgabe", value: completion, color: "var(--ok)" },
  ];
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4 rounded-2xl border border-line bg-elev p-4">
        <Ring value={ratio} size={72} stroke={7} />
        <div>
          <div className="text-[1.6em] font-semibold tabular-nums">{Math.round(ratio * 100)} %</div>
          <div className="text-[0.88em] text-muted">
            {tokens(u.used)} von {tokens(u.size)} Tokens im Kontext
          </div>
          {ratio > 0.75 && <div className="mt-1 text-[0.82em] text-warn">Bald voll – Komprimieren schafft Platz.</div>}
        </div>
      </div>

      <div>
        <div className="mb-2 text-[0.82em] font-medium uppercase tracking-wide text-muted">Verbrauch dieser Session</div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-line">
          {segments.map((s) => (
            <div key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
          ))}
        </div>
        <div className="mt-2 space-y-1">
          {segments.map((s) => (
            <div key={s.label} className="flex items-center gap-2 text-[0.88em]">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              <span className="flex-1 text-fg-2">{s.label}</span>
              <span className="tabular-nums">{tokens(s.value)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Tokens gesamt" value={tokens(u.totalTokens)} />
        <Stat label="Schritte" value={String(u.steps ?? 0)} />
        <Stat label="Geschwindigkeit" value={u.tokensPerSecond ? `${Math.round(u.tokensPerSecond)} T/s` : "–"} />
        <Stat
          label="Letzter Turn"
          value={u.lastTurnDuration ? `${u.lastTurnDuration.toFixed(1).replace(".", ",")} s` : "–"}
          hint={u.lastTurnTotalTokens ? `${tokens(u.lastTurnTotalTokens)} Tokens` : undefined}
        />
        {u.cost && <Stat label="Kosten (Schätzung)" value={`${u.cost.amount.toFixed(3).replace(".", ",")} ${u.cost.currency}`} hint="Vom Plan gedeckt, solange Kontingent reicht" />}
      </div>

      <Button variant="secondary" className="w-full" disabled={session.running || session.readOnly} onClick={() => send("/compact", [])}>
        <Minimize2 className="h-4 w-4" /> Kontext komprimieren
      </Button>
    </div>
  );
}

function Agents({ session }: { session: Session }) {
  const openChild = useStore((s) => s.openChildSession);
  const list = subagents(session);
  if (!list.length) return <Empty text="Vibe hat in dieser Session noch keine Subagents gestartet. Für größere Aufgaben verteilt Vibe Arbeit automatisch an Subagents, z. B. „explore“ zum Durchsuchen des Codes." />;
  return (
    <div className="space-y-2">
      {list.map((t) => {
        const m = t.meta ?? {};
        const running = t.status === "in_progress" || t.status === "pending";
        return (
          <div key={t.id} className="rounded-xl border border-line bg-elev p-3">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-accent" />
              <span className="font-mono text-[0.86em]">{String(m.agent ?? "subagent")}</span>
              <span className="ml-auto flex items-center gap-1.5 text-[0.8em] text-muted">
                {running ? <Spinner className="text-accent" /> : null}
                {running ? "läuft" : t.status === "failed" ? "fehlgeschlagen" : `fertig${m.turn_count != null ? ` · ${m.turn_count} Schritte` : ""}`}
              </span>
            </div>
            <div className="mt-1.5 text-[0.9em] text-fg-2">{String(m.task ?? t.title)}</div>
            {m.response && (
              <details className="mt-2">
                <summary className="cursor-default text-[0.84em] text-muted">Ergebnis</summary>
                <div className="mt-1.5 text-[0.9em]">
                  <Markdown text={String(m.response)} />
                </div>
              </details>
            )}
            {m.child_session_id && (
              <button className="mt-2 inline-flex items-center gap-1.5 text-[0.84em] text-accent hover:underline" onClick={() => openChild(String(m.child_session_id), session.cwd)}>
                <History className="h-3.5 w-3.5" /> Verlauf öffnen
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Tasks({ session }: { session: Session }) {
  if (!session.plan.length) return <Empty text="Vibe legt bei mehrstufigen Aufgaben eine Aufgabenliste an. Sie erscheint hier und über dem Eingabefeld." />;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-elev">
      <TaskList session={session} />
    </div>
  );
}
