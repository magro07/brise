import { useEffect, useState } from "react";
import { ChevronDown, CircleCheck, CircleDot, Circle, ListChecks, MonitorCog, ShieldAlert } from "lucide-react";
import { useStore, type PendingPermission, type Session, type ToolItem } from "../../lib/store";
import { maskSecrets, short } from "../../lib/format";
import { Button, Menu, MenuContent, MenuItem, MenuTrigger, clsx } from "../ui";
import { toolIcon, toolTitle } from "../chat/ToolCall";
import { agentName } from "../../lib/backends";
import { ComputerAskPreview } from "../computer/Computer";

const OPTION_LABEL: Record<string, string> = {
  allow_once: "Erlauben",
  allow_always: "Für diese Session erlauben",
  allow_always_permanent: "Immer erlauben",
  reject_once: "Ablehnen",
};

/** Vibe schickt manche Optionen nur mit englischem Namen. */
const NAME_LABEL: Record<string, string> = {
  "Allow once": "Erlauben",
  "Allow for remainder of this session": "Für diese Session erlauben",
  "Always allow": "Immer erlauben",
  "Allow this folder for this session": "Ordner für diese Session erlauben",
  "Always allow this folder": "Ordner immer erlauben",
  "Allow these paths only for this session": "Pfade für diese Session erlauben",
  "Always allow these paths": "Pfade immer erlauben",
  Deny: "Ablehnen",
};

const SCOPE_LABEL: Record<string, string> = { "outside workdir": "außerhalb des Projekts" };

function scopeOf(o: PendingPermission["options"][number]) {
  const labels = (o._meta?.required_permissions ?? []).map((p) => p.label).filter(Boolean);
  return labels.length ? labels.join(", ") : null;
}

/** Freigabe-Abfrage direkt über dem Eingabefeld (wie in Claude Code). */
export function PermissionPrompt({ session, pending }: { session: Session; pending: PendingPermission }) {
  const answer = useStore((s) => s.answerPermission);
  const [menu, setMenu] = useState(false);
  const tool = session.items.find((i): i is ToolItem => i.type === "tool" && i.toolCallId === pending.toolCallId);
  if (pending.computer) return <ComputerPrompt session={session} pending={pending} answer={answer} />;
  const Icon = tool ? toolIcon(tool) : ShieldAlert;
  const { verb, target } = tool ? toolTitle(tool) : { verb: "", target: "Werkzeug ausführen" };
  const input = pending.rawInput as Record<string, unknown> | undefined;
  const command = typeof input?.command === "string" ? input.command : null;
  // „Immer erlauben“ ohne Muster würde den kompletten Befehl dauerhaft speichern – samt Passwörtern.
  const options = pending.options.filter((o) => o.optionId !== "allow_always_permanent" || scopeOf(o));

  const reject = options.find((o) => o.kind.startsWith("reject"));
  const allow = options.filter((o) => !o.kind.startsWith("reject"));
  const labelOf = (o: PendingPermission["options"][number]) => OPTION_LABEL[o.optionId] ?? NAME_LABEL[o.name] ?? o.name;

  // Enter und Esc beantworten die Abfrage, solange kein Menü offen ist und im Eingabefeld nichts getippt wird.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menu || e.isComposing || (e.key !== "Enter" && e.key !== "Escape")) return;
      const el = e.target as HTMLInputElement;
      if (el.value || el.tagName === "BUTTON") return;
      const option = e.key === "Enter" ? allow[0] : reject;
      if (!option) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      answer(pending.key, option.optionId);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="mb-2 rounded-3xl border border-line bg-elev px-5 py-4 shadow-pop fade-in">
      <div className="flex items-center gap-2 text-[0.9em] text-muted">
        <Icon className="h-4 w-4 shrink-0" />
        <span>{tool?.kind === "execute" ? "Terminal" : verb || "Werkzeug"}</span>
        {session.pending.length > 1 && <span className="ml-auto text-[0.9em]">+{session.pending.length - 1} weitere</span>}
      </div>
      <div className="mt-2 selectable">{agentName(session.backend)} möchte {verb ? verb.toLowerCase().replace(/^befehl$/, "einen Befehl ausführen") : "etwas ausführen"}.</div>
      <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[0.86em] text-muted selectable">
        {command ? maskSecrets(command) : target.startsWith(session.cwd) ? target.slice(session.cwd.length + 1) : target}
      </pre>
      {!command && input && Object.keys(input).length > 0 && tool?.kind !== "edit" && (
        <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-code p-2 font-mono text-[0.78em] text-fg-2 selectable">{short(input, 1500)}</pre>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        {reject && (
          <button className="flex h-8 items-center gap-2 rounded-full border border-line px-3 text-[0.9em] hover:bg-hover" onClick={() => answer(pending.key, reject.optionId)}>
            {labelOf(reject)}
            <kbd className="rounded-md bg-hover px-1.5 font-sans text-[0.85em] text-muted">Esc</kbd>
          </button>
        )}
        {allow[0] && (
          <div className="flex h-8 items-center rounded-full bg-fg text-[0.9em] text-bg">
            <button className="flex h-full items-center gap-2 rounded-l-full pl-3 pr-1.5" onClick={() => answer(pending.key, allow[0].optionId)}>
              Einmal zulassen
              <kbd className="rounded-md bg-bg/15 px-1.5 font-sans text-[0.85em]">↵</kbd>
            </button>
            {allow.length > 1 && (
              <Menu open={menu} onOpenChange={setMenu}>
                <MenuTrigger asChild>
                  <button aria-label="Weitere Freigaben" className="flex h-full items-center rounded-r-full pl-0.5 pr-2.5 opacity-70 hover:opacity-100">
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </MenuTrigger>
                <MenuContent side="top" align="end" className="max-w-[420px]">
                  {allow.slice(1).map((o) => {
                    const scope = scopeOf(o);
                    return (
                      <MenuItem key={o.optionId} description={scope ? Object.entries(SCOPE_LABEL).reduce((t, [en, de]) => t.replace(en, de), scope) : undefined} onSelect={() => answer(pending.key, o.optionId)}>
                        {labelOf(o)}
                      </MenuItem>
                    );
                  })}
                </MenuContent>
              </Menu>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Freigabe für Computer Use: Aktion in Worten, Screenshot mit Zielpunkt. */
function ComputerPrompt({ session, pending, answer }: { session: Session; pending: PendingPermission; answer: (key: string, optionId: string | null) => Promise<void> }) {
  const c = pending.computer!;
  const observe = /computer_(screenshot|zoom|list_windows)/.test(c.tool);
  return (
    <div className="mb-2 overflow-hidden rounded-2xl border border-accent/50 bg-elev shadow-pop fade-in" data-brise="computer-ask">
      <div className="flex items-center gap-2 border-b border-line bg-accent-soft px-4 py-2.5">
        <MonitorCog className="h-4 w-4 text-accent" />
        <span className="font-medium">
          {agentName(session.backend)} möchte {c.activate ? "Computer Use einschalten" : observe ? "den Bildschirm sehen" : "den Computer bedienen"}
        </span>
        {session.pending.length > 1 && <span className="ml-auto text-[0.82em] text-muted">+{session.pending.length - 1} weitere</span>}
      </div>
      <div className="px-4 py-3">
        <div className="font-medium selectable">{c.summary.charAt(0).toUpperCase() + c.summary.slice(1)}</div>
        <ComputerAskPreview image={c.image} point={c.point} activate={c.activate} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {pending.options.map((o, n) => (
            <Button key={o.optionId} variant={o.kind.startsWith("reject") ? "danger" : n === 0 ? "primary" : "secondary"} onClick={() => answer(pending.key, o.optionId)}>
              {o.name}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Aufgabenliste des Agenten, angeheftet über dem Eingabefeld. */
export function TaskStrip({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const plan = session.plan;
  if (!plan.length) return null;
  const done = plan.filter((e) => e.status === "completed").length;
  if (done === plan.length && !session.running) return null;
  const current = plan.find((e) => e.status === "in_progress") ?? plan.find((e) => e.status !== "completed");
  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-line bg-elev">
      <button className="flex h-9 w-full items-center gap-2 px-3 text-left text-[0.9em] hover:bg-hover" onClick={() => setOpen(!open)}>
        <ListChecks className="h-4 w-4 text-accent" />
        <span className="font-medium">
          Aufgaben {done}/{plan.length}
        </span>
        {!open && current && <span className="min-w-0 flex-1 truncate text-muted">· {current.content}</span>}
        <div className="ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(done / plan.length) * 100}%` }} />
        </div>
        <ChevronDown className={clsx("h-3.5 w-3.5 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && <TaskList session={session} />}
    </div>
  );
}

export function TaskList({ session }: { session: Session }) {
  return (
    <div className="space-y-0.5 border-t border-line px-3 py-2">
      {session.plan.map((e, n) => (
        <div key={n} className="flex items-start gap-2 py-0.5 text-[0.9em]">
          {e.status === "completed" ? (
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
          ) : e.status === "in_progress" ? (
            <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          ) : (
            <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          )}
          <span className={clsx(e.status === "completed" && "text-muted line-through", e.status === "in_progress" && "font-medium")}>{e.content}</span>
        </div>
      ))}
    </div>
  );
}
