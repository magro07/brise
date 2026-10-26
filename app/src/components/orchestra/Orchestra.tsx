// Oberfläche der Master-Session (lib/orchestra.ts): Karten im Chat, Leiste
// über dem Composer, Untersessions in der Seitenleiste, Einstellungen.

import { useEffect, useState } from "react";
import { ArrowUp, ChevronDown, Columns2, Crown, GitBranch, GitMerge, MoreHorizontal, Network, Plus, SquareArrowOutUpRight, Trash2, X } from "lucide-react";
import { useStore, type Session } from "../../lib/store";
import {
  LEVEL_LABEL,
  STATUS_LABEL,
  masterCosts,
  startCurator,
  type Decision,
  type MasterCosts,
  acceptProposal,
  approveMerge,
  declineProposal,
  liveStatus,
  openSub,
  rejectMerge,
  useOrchestra,
  useSubs,
  type MergeRequest,
  type Proposal,
  type SubSession,
  type SubStatus,
} from "../../lib/orchestra";
import { useAccess, managedBy } from "../../lib/policy";
import { BackendBadge } from "../agents/BackendPicker";
import { Button, Menu, MenuContent, MenuItem, MenuTrigger, Spinner, Switch, clsx } from "../ui";
import { Card, Row } from "../settings/Settings";

const BACKEND_NAME: Record<string, string> = { vibe: "Vibe", claude: "Claude Code", codex: "Codex", gemini: "Gemini" };

const TONE: Record<SubStatus, string> = {
  starting: "text-accent",
  running: "text-accent",
  waiting: "text-warn",
  done: "text-ok",
  error: "text-bad",
  stopped: "text-muted",
  interrupted: "text-warn",
  merged: "text-muted",
  escalated: "text-muted",
};

export function StatusDot({ status }: { status: SubStatus }) {
  if (status === "running" || status === "starting") return <Spinner className="text-accent" />;
  return (
    <span
      title={STATUS_LABEL[status]}
      className={clsx(
        "h-2 w-2 shrink-0 rounded-full",
        status === "waiting" && "bg-warn pulse-dot",
        status === "done" && "bg-ok",
        status === "error" && "bg-bad",
        status === "interrupted" && "bg-warn",
        (status === "stopped" || status === "merged" || status === "escalated") && "bg-muted",
      )}
    />
  );
}

// ---------- Karten im Chat ----------

function CardShell({ icon, title, children, state }: { icon: React.ReactNode; title: React.ReactNode; children: React.ReactNode; state?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-elev fade-in" data-brise="orch-card">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2 text-[0.9em]">
        <span className="text-accent">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {state}
      </div>
      <div className="px-3.5 py-3">{children}</div>
    </div>
  );
}

function ProposalCard({ p }: { p: Proposal }) {
  const busy = useOrchestra((s) => !!s.busy[p.id]);
  const error = useOrchestra((s) => s.errors[p.id]);
  const sub = useOrchestra((s) => s.book.subs.find((x) => x.id === p.session));
  const [open, setOpen] = useState(false);
  const long = p.task.length > 280;
  const state =
    p.state === "started" ? <span className="text-[0.8em] text-ok">gestartet</span>
    : p.state === "here" ? <span className="text-[0.8em] text-muted">hier erledigt</span>
    : p.state === "dismissed" ? <span className="text-[0.8em] text-muted">verworfen</span>
    : p.state === "failed" ? <span className="text-[0.8em] text-bad">fehlgeschlagen</span>
    : <span className="text-[0.8em] text-muted">Vorschlag</span>;
  return (
    <CardShell icon={<Network className="h-4 w-4" />} title={p.title} state={state}>
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[0.8em] text-muted">
        <BackendBadge backend={p.backend} always />
        <span>{BACKEND_NAME[p.backend] ?? p.backend}{p.model ? ` · ${p.model}` : ""}</span>
        {p.tier > 0 && <span className="rounded bg-hover px-1">Stufe {p.tier}</span>}
        {p.level && <span>· {LEVEL_LABEL[p.level] ?? p.level}</span>}
        <span>·</span>
        <span className="inline-flex items-center gap-1">
          <GitBranch className="h-3 w-3" />
          {p.worktree ? "eigener Worktree und Branch" : "im selben Ordner"}
        </span>
      </div>
      {p.choice && (
        <div className="mb-2 text-[0.8em] text-muted" data-testid="orch-choice">
          {p.choice}
          {p.thinking && ` · Denkstufe ${p.thinking}`}
          {p.budget != null && ` · Budget ${euro(p.budget)}`}
        </div>
      )}
      <div className={clsx("whitespace-pre-wrap text-[0.9em] text-fg-2 selectable", long && !open && "line-clamp-4")}>{p.task}</div>
      {long && (
        <button className="mt-1 inline-flex items-center gap-1 text-[0.8em] text-muted hover:text-fg" onClick={() => setOpen(!open)}>
          {open ? "Weniger" : "Ganzen Auftrag zeigen"} <ChevronDown className={clsx("h-3 w-3", open && "rotate-180")} />
        </button>
      )}
      {error && <p className="mt-2 text-[0.85em] text-bad selectable">{error}</p>}
      {p.state === "failed" && p.error && <p className="mt-2 text-[0.85em] text-bad selectable">{p.error}</p>}
      {p.state === "open" && (
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => acceptProposal(p.id)} data-testid="orch-accept">
            {busy ? <Spinner /> : <Network className="h-3.5 w-3.5" />} Neue Session
          </Button>
          <Button size="sm" disabled={busy} onClick={() => declineProposal(p.id, true)} data-testid="orch-here">
            Hier erledigen
          </Button>
          <button className="ml-auto text-[0.8em] text-muted hover:text-fg" disabled={busy} onClick={() => declineProposal(p.id, false)}>
            Verwerfen
          </button>
        </div>
      )}
      {sub && (
        <button className="mt-2 inline-flex items-center gap-1.5 text-[0.85em] text-accent hover:underline" onClick={() => openSub(sub)}>
          <SquareArrowOutUpRight className="h-3.5 w-3.5" /> Untersession öffnen
        </button>
      )}
    </CardShell>
  );
}

function MergeCard({ m }: { m: MergeRequest }) {
  const busy = useOrchestra((s) => !!s.busy[m.id]);
  const error = useOrchestra((s) => s.errors[m.id]);
  const state =
    m.state === "merged" ? <span className="text-[0.8em] text-ok">gemerged</span>
    : m.state === "rejected" ? <span className="text-[0.8em] text-muted">abgelehnt</span>
    : m.state === "failed" ? <span className="text-[0.8em] text-bad">fehlgeschlagen</span>
    : <span className="text-[0.8em] text-warn">wartet auf Freigabe</span>;
  return (
    <CardShell icon={<GitMerge className="h-4 w-4" />} title={`Mergen: ${m.title}`} state={state}>
      <div className="mb-2 font-mono text-[0.85em] text-fg-2">
        {m.branch} → {m.into}
      </div>
      {m.stat && <div className="mb-1 text-[0.8em] text-muted">{m.stat}</div>}
      {m.commits.length > 0 && (
        <ul className="mb-1 space-y-0.5 font-mono text-[0.8em] text-fg-2">
          {m.commits.slice(0, 8).map((c) => (
            <li key={c} className="truncate">{c}</li>
          ))}
          {m.commits.length > 8 && <li className="text-muted">… {m.commits.length - 8} weitere</li>}
        </ul>
      )}
      {m.result && <p className={clsx("mt-2 text-[0.85em] selectable", m.state === "failed" ? "text-bad" : "text-muted")}>{m.result}</p>}
      {error && <p className="mt-2 text-[0.85em] text-bad selectable">{error}</p>}
      {m.state === "open" && (
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => approveMerge(m.id)} data-testid="orch-merge">
            {busy ? <Spinner /> : <GitMerge className="h-3.5 w-3.5" />} Mergen
          </Button>
          <Button size="sm" disabled={busy} onClick={() => rejectMerge(m.id)} data-testid="orch-reject">
            Ablehnen
          </Button>
        </div>
      )}
    </CardShell>
  );
}

export function OrchCard({ kind, refId }: { kind: "proposal" | "merge"; refId: string }) {
  const p = useOrchestra((s) => (kind === "proposal" ? s.book.proposals.find((x) => x.id === refId) : undefined));
  const m = useOrchestra((s) => (kind === "merge" ? s.book.merges.find((x) => x.id === refId) : undefined));
  if (p) return <ProposalCard p={p} />;
  if (m) return <MergeCard m={m} />;
  return null;
}

/** Offene Karten, die (z. B. nach einem Neustart) nicht im Verlauf stehen. */
export function OpenCards({ session }: { session: Session }) {
  const proposals = useOrchestra((s) => s.book.proposals);
  const merges = useOrchestra((s) => s.book.merges);
  const shown = new Set(session.items.flatMap((i) => (i.type === "orch" ? [i.ref] : [])));
  const open = [
    ...proposals.filter((p) => p.master === session.id && p.state === "open" && !shown.has(p.id)).map((p) => <ProposalCard key={p.id} p={p} />),
    ...merges.filter((m) => m.master === session.id && m.state === "open" && !shown.has(m.id)).map((m) => <MergeCard key={m.id} m={m} />),
  ];
  return open.length ? <>{open}</> : null;
}

// ---------- Leiste über dem Composer ----------

export function OrchStrip({ session }: { session: Session }) {
  const subs = useSubs(session.id);
  const live = useStore((s) => s.sessions);
  const parent = useOrchestra((s) => s.book.subs.find((x) => x.id === session.id));
  const masterTitle = useStore((s) => (parent ? (s.sessions[parent.master]?.title ?? s.index.find((x) => x.sessionId === parent.master)?.title) : undefined));
  if (parent) {
    return (
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-elev px-3 py-1.5 text-[0.85em] text-muted" data-brise="orch-strip">
        <Network className="h-3.5 w-3.5 text-accent" />
        <span className="min-w-0 flex-1 truncate">
          Untersession von <button className="text-fg hover:underline" onClick={() => useStore.getState().openTab(parent.master)}>„{masterTitle ?? "Master-Session"}“</button>
          {parent.branch && <span className="font-mono"> · {parent.branch}</span>}
          {parent.model && <span> · Arbeiter {parent.model}{parent.tier ? ` (Stufe ${parent.tier})` : ""}</span>}
          {parent.escalations > 0 && <span className="text-warn"> · {parent.escalations}× eskaliert</span>}
        </span>
      </div>
    );
  }
  if (!subs.length) return null;
  return <MasterStrip session={session} subs={subs} live={live} />;
}

/** Laufkosten der Master-Session (Journal), aktualisiert nach jedem Turn. */
function useMasterCosts(master: string, deps: unknown[]): MasterCosts | null {
  const [costs, setCosts] = useState<MasterCosts | null>(null);
  useEffect(() => {
    let alive = true;
    // Das Journal bekommt den Turn kurz nach dessen Ende.
    const t = setTimeout(() => masterCosts(master).then((c) => alive && setCosts(c)).catch(() => {}), 1500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [master, ...deps]);
  return costs;
}

const euro = (n: number) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: n < 0.1 ? 3 : 2 });

function MasterStrip({ session, subs, live }: { session: Session; subs: SubSession[]; live: Record<string, Session> }) {
  const busy = subs.map((s) => `${s.id}:${live[s.id]?.running ? 1 : 0}`).join(",");
  const costs = useMasterCosts(session.id, [busy, session.running]);
  const model = String(session.config.find((o) => o.id === "model")?.currentValue ?? "");
  const workers = costs?.costs.workers.reduce((a, w) => a + w.cost, 0) ?? 0;
  const [log, setLog] = useState(false);
  const decisions = subs.flatMap((s) => (s.decisions ?? []).map((d) => ({ ...d, title: s.title }))).sort((a, b) => a.at - b.at);
  const active = subs.filter((s) => ["starting", "running", "waiting"].includes(liveStatus(s, live[s.id]))).length;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-elev px-3 py-1.5 text-[0.85em]" data-brise="orch-strip">
      <span className="mr-1 inline-flex items-center gap-1.5 font-medium">
        <Network className="h-3.5 w-3.5 text-accent" /> Untersessions {active > 0 && <span className="text-muted">· {active} aktiv</span>}
      </span>
      {decisions.length > 0 && (
        <button className="mr-1 inline-flex items-center gap-0.5 text-[0.85em] text-muted hover:text-fg" onClick={() => setLog(!log)} data-testid="orch-log-toggle">
          Entscheidungen ({decisions.length}) <ChevronDown className={clsx("h-3 w-3", log && "rotate-180")} />
        </button>
      )}
      {costs && (
        <span className="mr-1 text-[0.85em] text-muted" data-testid="orch-costs" title="Geschätzt nach Preistabelle (Nutzungsjournal)">
          <Crown className="mr-0.5 inline h-3 w-3" />Kurator {model && `${model} `}{euro(costs.costs.curator)} · Arbeiter {euro(workers)}
          {costs.budget > 0 && ` · Budget ${euro(costs.budget)}`}
        </span>
      )}
      {subs.map((s) => {
        const status = liveStatus(s, live[s.id]);
        return (
          <button
            key={s.id}
            onClick={(e) => openSub(s, e.altKey || e.metaKey)}
            title={`${STATUS_LABEL[status]} · ${s.backend}/${s.model ?? "Standard"}${s.tier ? ` (Stufe ${s.tier})` : ""}${s.models.length > 1 ? ` · bisher ${s.models.join(" → ")}` : ""}${s.branch ? ` · ${s.branch}` : ""} – Klick: als Tab öffnen, Alt+Klick: daneben`}
            className="inline-flex h-6 max-w-[220px] items-center gap-1.5 rounded-md border border-line px-2 hover:bg-hover"
            data-testid="orch-chip"
          >
            <StatusDot status={status} />
            <span className="truncate">{s.title}</span>
            {s.model && <span className="text-[0.85em] text-muted">{s.model}</span>}
            {s.escalations > 0 && (
              <span className="inline-flex items-center text-[0.85em] text-warn" title={`${s.escalations}× eskaliert`}>
                <ArrowUp className="h-3 w-3" />
                {s.escalations}
              </span>
            )}
          </button>
        );
      })}
      {log && <DecisionLog decisions={decisions} />}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = { start: "Start", wechsel: "Wechsel", eskalation: "Eskalation" };

/** Wer hat welchen Arbeiter warum gewählt – wie das Denkstufen-Protokoll der Auto-Modellwahl. */
function DecisionLog({ decisions }: { decisions: (Decision & { title: string })[] }) {
  return (
    <ol className="mt-1 w-full space-y-1 border-t border-line pt-1.5 text-[0.85em]" data-testid="orch-log">
      {decisions.map((d, i) => (
        <li key={i} className="flex gap-2">
          <span className="shrink-0 tabular-nums text-muted">{new Date(d.at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</span>
          <span className="min-w-0">
            <span className="font-medium">{d.title}</span>
            <span className="text-muted"> · {ACTION_LABEL[d.action] ?? d.action} durch {d.by === "kurator" ? "Kurator" : "Automatik"} → </span>
            <span className="font-mono">{d.backend}/{d.model ?? "Standard"}</span>
            {d.thinking && <span className="text-muted"> · {d.thinking}</span>}
            {d.budget != null && <span className="text-muted"> · {euro(d.budget)}</span>}
            <span className="block text-fg-2">{d.reason}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---------- Seitenleiste ----------

export function SubRows({ master, activeId }: { master: string; activeId: string | null }) {
  const subs = useSubs(master);
  const live = useStore((s) => s.sessions);
  if (!subs.length) return null;
  return (
    <div className="ml-3 border-l border-line pl-1.5" data-brise="orch-subs">
      {subs.map((s) => (
        <SubRow key={s.id} sub={s} status={liveStatus(s, live[s.id])} active={s.id === activeId} title={live[s.id]?.title ?? s.title} />
      ))}
    </div>
  );
}

function SubRow({ sub, status, active, title }: { sub: SubSession; status: SubStatus; active: boolean; title: string }) {
  return (
    <div className={clsx("group flex h-7 items-center gap-1.5 rounded-lg pl-1.5 pr-1 text-[0.86em] text-fg-2 hover:bg-hover", active && "bg-active text-fg")} data-testid="orch-sub-row">
      <button
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        onClick={() => openSub(sub)}
        title={`${STATUS_LABEL[status]} · ${sub.model ?? "Standardmodell"}${sub.tier ? ` (Stufe ${sub.tier})` : ""}${sub.decisions?.length ? ` · ${sub.decisions[sub.decisions.length - 1].reason}` : sub.choice ? ` · ${sub.choice}` : ""}${sub.branch ? ` · ${sub.branch}` : ""}`}
      >
        <StatusDot status={status} />
        <span className="truncate">{sub.title || title}</span>
        <BackendBadge backend={sub.backend} />
        {sub.escalations > 0 && <ArrowUp className="h-3 w-3 shrink-0 text-warn" aria-label={`${sub.escalations}× eskaliert`} />}
      </button>
      <span className={clsx("text-[0.8em] group-hover:hidden", TONE[status])}>{STATUS_LABEL[status]}</span>
      <Menu>
        <MenuTrigger asChild>
          <button className="hidden h-5 w-5 items-center justify-center rounded-md text-muted hover:bg-active hover:text-fg group-hover:flex" aria-label="Untersession">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<SquareArrowOutUpRight />} onSelect={() => openSub(sub)}>
            Als Tab öffnen
          </MenuItem>
          <MenuItem icon={<Columns2 />} onSelect={() => openSub(sub, true)}>
            Rechts daneben öffnen
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

// ---------- Einstellungen ----------

export function OrchestraSettings() {
  const prefs = useStore((s) => s.prefs.orchestra);
  const setPrefs = useStore((s) => s.setPrefs);
  const blocked = useOrchestra((s) => s.blocked);
  const max = useOrchestra((s) => s.maxParallel);
  const access = useAccess("orchestra");
  const locked = access !== "edit";
  const set = (patch: Partial<typeof prefs>) => setPrefs({ orchestra: { ...prefs, ...patch } });
  const policyBlocked = blocked?.startsWith("POLICY:");
  return (
    <>
      <Card
        description={
          <>
            Eine Session kann Teilaufgaben als eigene Sessions starten (z. B. Code mit Vibe, Review mit Claude Code), ihnen Nachrichten schicken und
            nach deiner Freigabe ihre Branches mergen. Sie bekommt automatisch eine Notiz, wenn eine Untersession fertig ist.
          </>
        }
      >
        {(locked || policyBlocked) && (
          <div className="flex items-center gap-2 bg-warn-soft px-4 py-2 text-[0.85em] text-warn">
            <X className="h-3.5 w-3.5" /> {policyBlocked ? blocked!.replace(/^POLICY: /, "") : `Dieser Bereich wird ${managedBy()} verwaltet.`}
          </div>
        )}
        <Row title="Master-Session erlauben" description="Gibt jeder neuen Session die Werkzeuge start_session, send_message, merge_session usw." control={<Switch checked={prefs.enabled} disabled={locked} onChange={(enabled) => set({ enabled })} />} />
        <Row
          title="Erst nach Bestätigung starten"
          description="Vorschläge erscheinen als Karte mit „Neue Session“ und „Hier erledigen“. Aus: Untersessions starten sofort."
          control={<Switch checked={prefs.confirmStart} disabled={locked || !prefs.enabled} onChange={(confirmStart) => set({ confirmStart })} />}
        />
        <Row
          title="Gleichzeitige Untersessions"
          description={max < prefs.maxParallel ? `Dein Team erlaubt höchstens ${max}.` : "Weitere Starts warten, bis eine fertig ist."}
          control={
            <input
              type="number"
              min={1}
              max={12}
              value={prefs.maxParallel}
              disabled={locked || !prefs.enabled}
              onChange={(e) => set({ maxParallel: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })}
              className="h-8 w-[80px] rounded-md border border-line bg-bg px-2 outline-none focus:border-accent"
            />
          }
        />
        <Row
          title="Eigener Git-Worktree"
          description="Jede Untersession arbeitet auf eigenem Branch in einem Worktree; gemerged wird erst nach deiner Freigabe."
          control={<Switch checked={prefs.worktree} disabled={locked || !prefs.enabled} onChange={(worktree) => set({ worktree })} />}
        />
      </Card>
      <CuratorCard locked={locked || !prefs.enabled} />
      <p className="text-[0.85em] text-muted">
        Grenzen: Monatsbudget (Nutzung) und Team-Richtlinien gelten auch für Untersessions. Änderungen wirken für neue Sessions.
      </p>
    </>
  );
}

const input = "h-8 rounded-md border border-line bg-bg px-2 outline-none focus:border-accent disabled:opacity-50";
const BACKENDS = ["vibe", "claude", "codex", "gemini"];

/** Kurator-Modell, Arbeiter-Pool, Eskalation und Budget je Lauf. */
function CuratorCard({ locked }: { locked: boolean }) {
  const prefs = useStore((s) => s.prefs.orchestra);
  const setPrefs = useStore((s) => s.setPrefs);
  const project = useStore((s) => s.activeProject);
  const set = (patch: Partial<typeof prefs>) => setPrefs({ orchestra: { ...prefs, ...patch } });
  const workers = prefs.workers;
  const setWorker = (i: number, patch: Partial<(typeof workers)[number]>) => set({ workers: workers.map((w, n) => (n === i ? { ...w, ...patch } : w)) });
  return (
    <Card
      title="Kurator und Arbeiter"
      description="Ein starkes Modell (Kurator) plant, entscheidet je Teilaufgabe selbst über Delegation, Backend, Modell, Denkstufe und Budget (mit Begründung im Protokoll), prüft und stuft um. Diese Einstellungen sind nur Leitplanken: erlaubter Pool, Budget, Team-Richtlinie. Gibt der Kurator nichts vor, wählt Brise als Rückfall aus dem Pool (einfach/normal → Stufe 1, komplex → Stufe 2, Eskalation → nächste Stufe)."
    >
      <Row
        title="Kurator"
        description="Backend und Modell für „Neue Kurator-Session“. Claude Code läuft über dein Claude-Abo – nur für dich, nicht für geteilte Sessions."
        control={
          <div className="flex gap-2">
            <select value={prefs.curatorBackend} disabled={locked} onChange={(e) => set({ curatorBackend: e.target.value })} className={clsx(input, "w-[120px]")}>
              {BACKENDS.map((b) => (
                <option key={b} value={b}>{BACKEND_NAME[b]}</option>
              ))}
            </select>
            <input value={prefs.curatorModel} disabled={locked} onChange={(e) => set({ curatorModel: e.target.value.trim() })} placeholder="z. B. opus, mistral-large-4" className={clsx(input, "w-[170px]")} data-testid="orch-curator-model" />
          </div>
        }
      />
      <div className="px-4 py-3">
        <div className="mb-2 font-medium">Arbeiter-Pool</div>
        <div className="space-y-1.5">
          {workers.map((w, i) => (
            <div key={i} className="flex items-center gap-2" data-testid="orch-worker">
              <select value={w.tier} disabled={locked} onChange={(e) => setWorker(i, { tier: Number(e.target.value) })} className={clsx(input, "w-[100px]")}>
                {[1, 2, 3].map((t) => (
                  <option key={t} value={t}>Stufe {t}</option>
                ))}
              </select>
              <select value={w.backend} disabled={locked} onChange={(e) => setWorker(i, { backend: e.target.value })} className={clsx(input, "w-[120px]")}>
                {BACKENDS.map((b) => (
                  <option key={b} value={b}>{BACKEND_NAME[b]}</option>
                ))}
              </select>
              <input value={w.model} disabled={locked} onChange={(e) => setWorker(i, { model: e.target.value.trim() })} placeholder="Modell-Alias" className={clsx(input, "min-w-0 flex-1")} />
              <button className="text-muted hover:text-bad disabled:opacity-40" disabled={locked || workers.length <= 1} onClick={() => set({ workers: workers.filter((_, n) => n !== i) })} aria-label="Entfernen">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <Button size="sm" variant="ghost" className="mt-2" disabled={locked} onClick={() => set({ workers: [...workers, { backend: "vibe", model: "", tier: 1 }] })}>
          <Plus className="h-3.5 w-3.5" /> Arbeiter hinzufügen
        </Button>
        <p className="mt-1 text-[0.8em] text-muted">Innerhalb einer Stufe gewinnt das günstigste Modell (Preistabelle), bei Gleichstand das schnellere (t/s im Journal). Modelle, die dein Team nicht erlaubt, werden übersprungen.</p>
      </div>
      <Row
        title="Höchste Eskalation"
        description="So viele Stufen darf eine Teilaufgabe aufsteigen – automatisch, wenn ein Arbeiter scheitert, oder auf Wunsch des Kurators."
        control={<input type="number" min={0} max={3} value={prefs.maxEscalation} disabled={locked} onChange={(e) => set({ maxEscalation: Math.max(0, Math.min(3, Number(e.target.value) || 0)) })} className={clsx(input, "w-[80px]")} />}
      />
      <Row
        title="Budget je Master-Lauf"
        description="Kurator und Arbeiter zusammen (geschätzt). Ab 70 % nur noch Stufe 1, bei 100 % keine neuen Arbeiter. 0 = ohne."
        control={
          <span className="flex items-center gap-1.5">
            <input type="number" min={0} step={0.5} value={prefs.runBudgetEur} disabled={locked} onChange={(e) => set({ runBudgetEur: Math.max(0, Number(e.target.value) || 0) })} className={clsx(input, "w-[90px]")} /> €
          </span>
        }
      />
      <div className="flex items-center gap-3 px-4 py-3">
        <Button size="sm" variant="primary" disabled={locked || !project} onClick={() => project && startCurator(project)} data-testid="orch-start-curator">
          <Crown className="h-3.5 w-3.5" /> Neue Kurator-Session
        </Button>
        <span className="text-[0.85em] text-muted">{project ? `im Projekt ${project.split(/[\\/]/).pop()}` : "Erst ein Projekt öffnen."}</span>
      </div>
    </Card>
  );
}
