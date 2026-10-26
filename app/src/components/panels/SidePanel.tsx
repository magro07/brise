import { useEffect, useMemo, useState } from "react";
import { shortcut } from "../../lib/platform";
import { AtSign, Bot, DatabaseZap, FolderTree, Gauge, GitBranch, GitCompareArrows, History, ListChecks, Minimize2, RefreshCw, Search, X } from "lucide-react";
import { GitPanel } from "./GitPanel";
import { FilesPanel } from "./FilesPanel";
import { api, type IndexStatus, type SearchHit } from "../../lib/acp";
import { relativeTime } from "../../lib/format";
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
  { id: "search", label: "Suche", icon: Search },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "files", label: "Dateien", icon: FolderTree },
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
  const project = useStore((s) => s.activeProject);
  if (!panel) return null;
  const wide = panel === "files";
  const tools = panel === "git" || panel === "files";
  return (
    <aside data-brise="side-panel" className={clsx("flex h-full shrink-0 flex-col border-l border-line bg-panel", wide ? "w-[min(820px,50vw)]" : "w-[min(420px,40vw)]")}>
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
        <IconButton label={`Panel schließen (${shortcut("J")})`} onClick={() => set({ panel: null })}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className={clsx("min-h-0 flex-1", tools ? "overflow-hidden" : "overflow-y-auto p-4")}>
        {panel === "git" && project ? (
          <GitPanel cwd={session?.cwd ?? project} />
        ) : panel === "files" && project ? (
          <FilesPanel cwd={session?.cwd ?? project} />
        ) : panel === "search" && project ? (
          <SemanticSearch cwd={session?.cwd ?? project} />
        ) : !session ? (
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

/** Grobe Token-Schätzung (Mistral-Tokenizer: etwa 3,6 Zeichen pro Token). */
const est = (text: string) => Math.ceil(text.length / 3.6);
const str = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));

interface Part {
  key: string;
  label: string;
  hint: string;
  value: number;
  color: string;
}

function useContextParts(session: Session) {
  const [skills, setSkills] = useState(0);
  const [agentsMd, setAgentsMd] = useState(0);
  useEffect(() => {
    api.listSkills(session.cwd).then((l) => setSkills(l.reduce((n, sk) => n + est(sk.name + sk.description) + 12, 0)));
    Promise.all(["AGENTS.md", "CLAUDE.md", ".vibe/AGENTS.md"].map((f) => api.readFile(session.cwd, f).catch(() => ""))).then((t) =>
      setAgentsMd(t.reduce((n, x) => n + est(x), 0)),
    );
  }, [session.cwd]);

  return useMemo(() => {
    let user = 0;
    let assistant = 0;
    let thoughts = 0;
    let tools = 0;
    let agents = 0;
    const biggest: { label: string; tokens: number }[] = [];
    for (const i of session.items) {
      let t = 0;
      let label = "";
      if (i.type === "user") {
        t = est(i.text) + (i.attachments?.length ?? 0) * 30;
        user += t;
        label = `Du: ${i.text.slice(0, 60)}`;
      } else if (i.type === "assistant") {
        t = est(i.text);
        assistant += t;
        label = `Antwort: ${i.text.slice(0, 60)}`;
      } else if (i.type === "thought") {
        t = est(i.text);
        thoughts += t;
        label = "Gedankengang";
      } else if (i.type === "tool") {
        const result = i.rawOutput != null ? str(i.rawOutput) : i.output.join("\n");
        t = est(str(i.rawInput) + result) + 20;
        if (i.meta?.agent || i.meta?.task) {
          agents += t + est(str(i.meta.response));
          label = `Subagent: ${str(i.meta.task).slice(0, 50)}`;
        } else {
          tools += t;
          label = i.title;
        }
      }
      if (t > 0) biggest.push({ label, tokens: t });
    }
    biggest.sort((a, b) => b.tokens - a.tokens);
    const used = session.usage.used ?? 0;
    const messages = user + assistant + thoughts + tools + agents;
    // Nach dem Komprimieren ist der Verlauf kürzer als das, was wir sehen.
    const scale = used && messages > used * 0.92 ? (used * 0.92) / messages : 1;
    const scaled = (n: number) => Math.round(n * scale);
    const overhead = Math.max(0, used - scaled(messages));
    const project = Math.min(overhead, agentsMd + 350);
    const skillPart = Math.min(Math.max(0, overhead - project), skills);
    const system = Math.max(0, overhead - project - skillPart);
    const parts: Part[] = [
      { key: "system", label: "System & Werkzeuge", hint: "Vibes System-Prompt und Werkzeugbeschreibungen (inkl. MCP)", value: system, color: "#8b8f98" },
      { key: "skills", label: "Skills", hint: "Namen und Beschreibungen aller verfügbaren Skills", value: skillPart, color: "#b07cf0" },
      { key: "project", label: "Projektkontext", hint: "AGENTS.md, Git-Branch und letzte Commits", value: project, color: "#e0a03a" },
      { key: "user", label: "Deine Nachrichten", hint: "inkl. angehängter Dateien", value: scaled(user), color: "#3d6ef0" },
      { key: "assistant", label: "Antworten", hint: "Text von Vibe", value: scaled(assistant), color: "#18b6a4" },
      { key: "thoughts", label: "Gedankengang", hint: "Reasoning – je nach Modell nur teilweise im Kontext", value: scaled(thoughts), color: "#7aa7ff" },
      { key: "tools", label: "Werkzeug-Ergebnisse", hint: "Gelesene Dateien, Befehlsausgaben, Suchtreffer", value: scaled(tools), color: "#e06c75" },
      { key: "agents", label: "Subagents", hint: "Aufträge und Ergebnisse der Subagents", value: scaled(agents), color: "#56b366" },
    ];
    return { parts: parts.filter((p) => p.value > 0), biggest: biggest.slice(0, 6), compacted: scale < 1 };
  }, [session.items, session.usage.used, skills, agentsMd]);
}

function Context({ session }: { session: Session }) {
  const send = useStore((s) => s.send);
  const u = session.usage;
  const size = u.size ?? 0;
  const used = u.used ?? 0;
  const ratio = used && size ? used / size : 0;
  const { parts, biggest, compacted } = useContextParts(session);
  const free = Math.max(0, size - used);
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4 rounded-2xl border border-line bg-elev p-4">
        <Ring value={ratio} size={72} stroke={7} />
        <div>
          <div className="text-[1.6em] font-semibold tabular-nums">{Math.round(ratio * 100)} %</div>
          <div className="text-[0.88em] text-muted">
            {tokens(used)} von {tokens(size)} Tokens belegt · {tokens(free)} frei
          </div>
          {ratio > 0.75 && <div className="mt-1 text-[0.82em] text-warn">Bald voll – Komprimieren schafft Platz.</div>}
        </div>
      </div>

      {used === 0 ? (
        <Empty text="Nach dem ersten Turn siehst du hier, woraus der Kontext besteht." />
      ) : (
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[0.82em] font-medium uppercase tracking-wide text-muted">Zusammensetzung</span>
            <span className="text-[0.75em] text-muted">Summe exakt, Anteile geschätzt</span>
          </div>
          <div className="flex h-4 overflow-hidden rounded-md bg-line">
            {parts.map((p) => (
              <div key={p.key} title={`${p.label}: ${tokens(p.value)}`} style={{ width: `${(p.value / Math.max(size, used)) * 100}%`, background: p.color }} />
            ))}
          </div>
          <div className="mt-3 overflow-hidden rounded-xl border border-line bg-elev">
            {parts.map((p) => (
              <div key={p.key} className="flex items-center gap-2.5 border-b border-line px-3 py-2 last:border-0" title={p.hint}>
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: p.color }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[0.9em]">{p.label}</div>
                  <div className="truncate text-[0.75em] text-muted">{p.hint}</div>
                </div>
                <span className="text-[0.88em] tabular-nums">{tokens(p.value)}</span>
                <span className="w-10 text-right text-[0.78em] tabular-nums text-muted">{Math.round((p.value / used) * 100)} %</span>
              </div>
            ))}
            <div className="flex items-center gap-2.5 px-3 py-2 text-muted">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm border border-line-strong" />
              <span className="flex-1 text-[0.9em]">Frei</span>
              <span className="text-[0.88em] tabular-nums">{tokens(free)}</span>
            </div>
          </div>
          {compacted && <div className="mt-2 text-[0.78em] text-muted">Der Verlauf wurde komprimiert – ältere Nachrichten sind zusammengefasst.</div>}
        </div>
      )}

      {biggest.length > 0 && (
        <div>
          <div className="mb-2 text-[0.82em] font-medium uppercase tracking-wide text-muted">Größte Einträge</div>
          <div className="overflow-hidden rounded-xl border border-line bg-elev">
            {biggest.map((b, n) => (
              <div key={n} className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[0.86em] last:border-0">
                <span className="min-w-0 flex-1 truncate text-fg-2">{b.label}</span>
                <span className="tabular-nums text-muted">~{tokens(b.tokens)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 text-[0.82em] font-medium uppercase tracking-wide text-muted">Verbrauch dieser Session</div>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Eingabe" value={tokens(u.promptTokens)} hint={u.cachedTokens ? `davon ${tokens(u.cachedTokens)} aus dem Cache` : undefined} />
          <Stat label="Ausgabe" value={tokens(u.completionTokens)} />
          <Stat label="Schritte" value={String(u.steps ?? 0)} />
          <Stat label="Geschwindigkeit" value={u.tokensPerSecond ? `${Math.round(u.tokensPerSecond)} T/s` : "–"} />
          <Stat
            label="Letzter Turn"
            value={u.lastTurnDuration ? `${u.lastTurnDuration.toFixed(1).replace(".", ",")} s` : "–"}
            hint={u.lastTurnTotalTokens ? `${tokens(u.lastTurnTotalTokens)} Tokens` : undefined}
          />
          {u.cost && <Stat label="Kosten (Schätzung)" value={`${u.cost.amount.toFixed(3).replace(".", ",")} ${u.cost.currency}`} hint="Vom Plan gedeckt, solange Kontingent reicht" />}
        </div>
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

/** Semantische Codesuche über Mistral-Embeddings. */
function SemanticSearch({ cwd }: { cwd: string }) {
  const model = useStore((s) => s.prefs.embedModel);
  const progress = useStore((s) => s.indexing[cwd]);
  const insert = useStore((s) => s.insertIntoComposer);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    setHits(null);
    api.indexStatus(cwd).then(setStatus).catch(() => setStatus(null));
  }, [cwd]);

  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.indexProject(cwd, model));
      // Neue Sessions bekommen das Suchwerkzeug – die vorbereitete neu anlegen.
      useStore.getState().resetPrepared(cwd);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setHits(await api.semanticSearch(cwd, query.trim(), 12));
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-elev p-3">
        <div className="flex items-center gap-2">
          <DatabaseZap className="h-4 w-4 text-accent" />
          <span className="font-medium">Projektindex</span>
          {status?.indexed && !busy && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={build}>
              <RefreshCw className="h-3.5 w-3.5" /> Aktualisieren
            </Button>
          )}
        </div>
        {busy ? (
          <div className="mt-2">
            <div className="flex justify-between text-[0.82em] text-muted">
              <span>Bette Code ein …</span>
              <span>{progress ? `${progress.done}/${progress.total}` : ""}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress?.total ? (progress.done / progress.total) * 100 : 5}%` }} />
            </div>
          </div>
        ) : status?.indexed ? (
          <div className="mt-1 text-[0.84em] text-muted">
            {status.files} Dateien · {status.chunks} Abschnitte · {status.model} · {status.updatedAt ? relativeTime(new Date(status.updatedAt * 1000).toISOString()) : ""}
          </div>
        ) : (
          <>
            <p className="mt-1 text-[0.86em] text-muted">
              Brise zerlegt den Code in Abschnitte und bettet sie mit {model} ein. Danach findest du Stellen nach Bedeutung – und Vibe kann die Suche selbst als Werkzeug nutzen.
            </p>
            <Button variant="primary" size="sm" className="mt-2" onClick={build}>
              Projekt indexieren
            </Button>
          </>
        )}
      </div>

      {status?.indexed && (
        <div className="relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="z. B. „wo wird die Anmeldung geprüft?“"
            className="h-9 w-full rounded-lg border border-line bg-elev pl-9 pr-3 outline-none focus:border-accent"
          />
        </div>
      )}
      {error && <div className="rounded-lg bg-bad-soft px-3 py-2 text-[0.86em] text-bad selectable">{error}</div>}
      {searching && <div className="flex items-center gap-2 text-[0.88em] text-muted"><Spinner /> Suche …</div>}
      {hits && !searching && hits.length === 0 && <Empty text="Keine Treffer." />}
      {hits?.map((h) => (
        <div key={`${h.path}:${h.start}`} className="group overflow-hidden rounded-xl border border-line bg-elev">
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[0.8em]">
              {h.path}:{h.start}–{h.end}
            </span>
            <span className="text-[0.75em] tabular-nums text-muted">{Math.round(h.score * 100)} %</span>
            <button
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[0.78em] text-accent opacity-0 hover:bg-accent-soft group-hover:opacity-100"
              onClick={() => insert(`@${h.path} `)}
              title="Datei an den Prompt anhängen"
            >
              <AtSign className="h-3 w-3" /> Anhängen
            </button>
          </div>
          <pre className="max-h-40 overflow-auto p-2.5 font-mono text-[0.76em] leading-[1.5] text-fg-2 selectable">{h.snippet}</pre>
        </div>
      ))}
    </div>
  );
}
