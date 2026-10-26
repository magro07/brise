import { useState } from "react";
import { ChevronDown, CircleCheck, CircleDot, Circle, ListChecks, ShieldAlert } from "lucide-react";
import { useStore, type PendingPermission, type Session, type ToolItem } from "../../lib/store";
import { maskSecrets, short } from "../../lib/format";
import { Button, clsx } from "../ui";
import { toolIcon, toolTitle } from "../chat/ToolCall";

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
  const tool = session.items.find((i): i is ToolItem => i.type === "tool" && i.toolCallId === pending.toolCallId);
  const Icon = tool ? toolIcon(tool) : ShieldAlert;
  const { verb, target } = tool ? toolTitle(tool) : { verb: "", target: "Werkzeug ausführen" };
  const input = pending.rawInput as Record<string, unknown> | undefined;
  const command = typeof input?.command === "string" ? input.command : null;
  // „Immer erlauben“ ohne Muster würde den kompletten Befehl dauerhaft speichern – samt Passwörtern.
  const options = pending.options.filter((o) => o.optionId !== "allow_always_permanent" || scopeOf(o));

  return (
    <div className="mb-2 overflow-hidden rounded-2xl border border-accent/50 bg-elev shadow-pop fade-in">
      <div className="flex items-center gap-2 border-b border-line bg-accent-soft px-4 py-2.5">
        <ShieldAlert className="h-4 w-4 text-accent" />
        <span className="font-medium">Vibe möchte {verb ? verb.toLowerCase().replace(/^befehl$/, "einen Befehl ausführen") : "etwas ausführen"}</span>
        {session.pending.length > 1 && <span className="ml-auto text-[0.82em] text-muted">+{session.pending.length - 1} weitere</span>}
      </div>
      <div className="px-4 py-3">
        <div className="flex items-start gap-2">
          <Icon className="mt-1 h-4 w-4 shrink-0 text-muted" />
          <pre className="max-h-40 flex-1 overflow-auto whitespace-pre-wrap break-all font-mono text-[0.86em] selectable">
            {command ? `$ ${maskSecrets(command)}` : target.startsWith(session.cwd) ? target.slice(session.cwd.length + 1) : target}
          </pre>
        </div>
        {!command && input && Object.keys(input).length > 0 && tool?.kind !== "edit" && (
          <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-code p-2 font-mono text-[0.78em] text-fg-2 selectable">{short(input, 1500)}</pre>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {options.map((o, n) => {
            const scope = scopeOf(o);
            const reject = o.kind.startsWith("reject");
            return (
              <Button
                key={o.optionId}
                variant={reject ? "danger" : n === 0 ? "primary" : "secondary"}
                onClick={() => answer(pending.key, o.optionId)}
                title={o.name}
              >
                {OPTION_LABEL[o.optionId] ?? NAME_LABEL[o.name] ?? o.name}
                {scope && (
                  <span className="font-mono text-[0.85em] opacity-70">
                    {Object.entries(SCOPE_LABEL).reduce((t, [en, de]) => t.replace(en, de), scope)}
                  </span>
                )}
              </Button>
            );
          })}
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
