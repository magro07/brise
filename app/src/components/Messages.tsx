import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PermissionOption } from "../acp";
import type { Item, Session } from "../store";
import { Diff } from "./Diff";

const KIND_ICON: Record<string, string> = {
  read: "📄",
  edit: "✏️",
  delete: "🗑",
  move: "↔",
  search: "🔍",
  execute: "▶",
  think: "💭",
  fetch: "🌐",
  switch_mode: "⇄",
  other: "⚙",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "wartet",
  in_progress: "läuft",
  completed: "fertig",
  failed: "fehlgeschlagen",
};

const OPTION_LABEL: Record<string, string> = {
  allow_once: "Einmal erlauben",
  allow_always: "Für diese Session erlauben",
  allow_always_permanent: "Immer erlauben",
  reject_once: "Ablehnen",
};

const Markdown = memo(({ text }: { text: string }) => (
  <div className="markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
  </div>
));

function short(value: unknown, max = 400): string {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function ToolCard({ item }: { item: Extract<Item, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const hasDetails = item.diffs.length > 0 || item.output.length > 0 || item.rawInput != null;
  return (
    <div className={`tool tool-${item.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} disabled={!hasDetails}>
        <span className="tool-icon">{KIND_ICON[item.kind] ?? KIND_ICON.other}</span>
        <span className="tool-title">{item.title}</span>
        <span className={`badge badge-${item.status}`}>{STATUS_LABEL[item.status] ?? item.status}</span>
        {hasDetails && <span className="chevron">{open ? "▾" : "▸"}</span>}
      </button>
      {/* Diffs sind das Wichtigste – die zeigen wir immer. */}
      {item.diffs.map((d, n) => (
        <Diff key={n} {...d} />
      ))}
      {open && (
        <div className="tool-details">
          {item.rawInput != null && <pre className="code">{short(item.rawInput, 2000)}</pre>}
          {item.output.map((o, n) => (
            <pre key={n} className="code output">
              {short(o, 4000)}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}

function optionScope(opt: PermissionOption): string | null {
  const labels = (opt._meta?.required_permissions ?? []).map((p) => p.label).filter(Boolean);
  return labels.length ? labels.join(", ") : null;
}

function PermissionCard({
  item,
  title,
  onAnswer,
}: {
  item: Extract<Item, { type: "permission" }>;
  title: string;
  onAnswer: (key: string, optionId: string | null) => void;
}) {
  // „Immer erlauben“ ohne Muster würde den kompletten Befehl dauerhaft
  // speichern – samt eventueller Passwörter. Das bieten wir nicht an.
  const options = item.options.filter((o) => o.optionId !== "allow_always_permanent" || optionScope(o));
  if (!item.open) {
    const chosen = item.options.find((o) => o.optionId === item.answer);
    const denied = !chosen || chosen.kind.startsWith("reject");
    return (
      <div className={`permission done ${denied ? "denied" : "allowed"}`}>
        {denied ? "✕ Abgelehnt" : "✓ Erlaubt"}: {title}
        {chosen && !denied && <span className="muted"> · {OPTION_LABEL[chosen.optionId] ?? chosen.name}</span>}
      </div>
    );
  }
  return (
    <div className="permission">
      <div className="permission-title">
        <span className="permission-icon">🔐</span> Vibe möchte: <strong>{title}</strong>
      </div>
      {item.rawInput != null && <pre className="code">{short(item.rawInput)}</pre>}
      <div className="permission-actions">
        {options.map((o) => {
          const scope = optionScope(o);
          const reject = o.kind.startsWith("reject");
          return (
            <button
              key={o.optionId}
              className={reject ? "btn btn-danger" : o.kind === "allow_once" ? "btn btn-primary" : "btn"}
              onClick={() => onAnswer(item.key, o.optionId)}
              title={o.name}
            >
              {OPTION_LABEL[o.optionId] ?? o.name}
              {scope && <span className="scope">{scope}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Thought({ text }: { text: string }) {
  return (
    <details className="thought">
      <summary>💭 Gedanken</summary>
      <div className="thought-body">{text}</div>
    </details>
  );
}

function Plan({ entries }: { entries: { content: string; status: string }[] }) {
  return (
    <div className="plan">
      <div className="plan-title">Plan</div>
      {entries.map((e, n) => (
        <div key={n} className={`plan-entry plan-${e.status}`}>
          <span className="plan-mark">{e.status === "completed" ? "☑" : e.status === "in_progress" ? "◐" : "☐"}</span>
          {e.content}
        </div>
      ))}
    </div>
  );
}

export function Messages({
  session,
  onAnswer,
}: {
  session: Session;
  onAnswer: (key: string, optionId: string | null) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Mitscrollen, solange der Nutzer unten ist.
  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ block: "end" });
  }, [session.items]);

  const titles = new Map<string, string>();
  for (const i of session.items) if (i.type === "tool") titles.set(i.toolCallId, i.title);

  return (
    <div
      className="messages"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="messages-inner">
        {session.items.map((item) => {
          switch (item.type) {
            case "user":
              return (
                <div key={item.id} className="msg user">
                  {item.text}
                </div>
              );
            case "assistant":
              return (
                <div key={item.id} className="msg assistant">
                  <Markdown text={item.text} />
                </div>
              );
            case "thought":
              return <Thought key={item.id} text={item.text} />;
            case "tool":
              return <ToolCard key={item.id} item={item} />;
            case "permission":
              return (
                <PermissionCard
                  key={item.id}
                  item={item}
                  title={titles.get(item.toolCallId) ?? "Werkzeug ausführen"}
                  onAnswer={onAnswer}
                />
              );
            case "plan":
              return <Plan key={item.id} entries={item.entries} />;
            case "notice":
              return (
                <div key={item.id} className={`notice notice-${item.tone}`}>
                  {item.text}
                </div>
              );
          }
        })}
        {session.running && (
          <div className="working">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </div>
        )}
        <div ref={end} />
      </div>
    </div>
  );
}
