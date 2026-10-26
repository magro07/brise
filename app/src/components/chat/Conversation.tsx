import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, Brain, Check, Wand2, CheckCircle2, ChevronRight, CircleSlash, Copy, FileText, Image, Info, Square, Volume2 } from "lucide-react";
import { useStore } from "../../lib/store";
import type { Item, Session } from "../../lib/store";
import { duration, tokens } from "../../lib/format";
import { Spinner, Tip, clsx } from "../ui";
import { Markdown } from "./Markdown";
import { ToolGroup } from "./ToolCall";

type Block = { kind: "item"; item: Item } | { kind: "tools"; id: string; items: Item[] };

/** Fasst aufeinanderfolgende Werkzeugaufrufe und Freigaben zu Gruppen zusammen. */
function toBlocks(items: Item[]): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    if (item.type === "tool" || item.type === "decision") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "tools") last.items.push(item);
      else blocks.push({ kind: "tools", id: item.id, items: [item] });
    } else {
      blocks.push({ kind: "item", item });
    }
  }
  return blocks;
}

function Thought({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="flex h-7 items-center gap-2 rounded-md px-1.5 text-[0.9em] text-muted hover:bg-hover hover:text-fg" onClick={() => setOpen(!open)}>
        <Brain className="h-3.5 w-3.5" />
        {live ? <span className="shimmer-text">Denkt nach …</span> : <span>Gedankengang</span>}
        <ChevronRight className={clsx("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="ml-3 mt-1 whitespace-pre-wrap border-l-2 border-line pl-3 text-[0.9em] text-muted selectable">{text}</div>
      )}
    </div>
  );
}

function Working({ since }: { since?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex items-center gap-2.5 py-1 text-[0.9em]">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1.5 w-1.5 rounded-full bg-accent pulse-dot" style={{ animationDelay: `${i * 0.2}s` }} />
        ))}
      </span>
      <span className="shimmer-text">Vibe arbeitet</span>
      {since && <span className="text-muted">{duration(Date.now() - since)}</span>}
    </div>
  );
}

function TurnFooter({ item }: { item: Extract<Item, { type: "turn" }> }) {
  const ok = item.stopReason === "end_turn";
  const label =
    item.stopReason === "cancelled"
      ? "Abgebrochen"
      : item.stopReason === "max_tokens"
        ? "Token-Limit erreicht"
        : item.stopReason === "max_turn_requests"
          ? "Schrittlimit erreicht"
          : item.stopReason === "refusal"
            ? "Abgelehnt"
            : "Fertig";
  return (
    <div className="flex items-center gap-2 pt-1 text-[0.8em] text-muted">
      {ok ? <CheckCircle2 className="h-3.5 w-3.5 text-ok" /> : <CircleSlash className="h-3.5 w-3.5 text-warn" />}
      <span>{label}</span>
      <span>·</span>
      <span>{duration(item.ms)}</span>
      {item.tokens != null && (
        <>
          <span>·</span>
          <span>{tokens(item.tokens)} Tokens</span>
        </>
      )}
    </div>
  );
}

const LEVEL_LABEL = { simple: "einfach", standard: "normal", complex: "komplex" } as const;

function MessageActions({ sessionId, itemId, text }: { sessionId: string; itemId: string; text: string }) {
  const narration = useStore((s) => s.narration);
  const { narrate, stopNarration } = useStore.getState();
  const [copied, setCopied] = useState(false);
  const active = narration.itemId === itemId && narration.state !== "idle";
  return (
    <div className={clsx("mt-1 flex items-center gap-0.5 text-muted transition-opacity", active ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100")}>
      <Tip label="Kopieren">
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover hover:text-fg"
          onClick={() => {
            navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          aria-label="Kopieren"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </Tip>
      <Tip label={active ? "Vorlesen stoppen" : "Vorlesen (Voxtral, als kurze Zusammenfassung)"}>
        <button
          className={clsx("flex h-7 items-center gap-1.5 rounded-md px-1.5 hover:bg-hover hover:text-fg", active && "text-accent")}
          onClick={() => (active ? stopNarration() : narrate(sessionId, itemId))}
          aria-label="Vorlesen"
        >
          {active ? (
            <>
              {narration.state === "prep" ? <Spinner /> : <Square className="h-3 w-3 fill-current" />}
              <span className="text-[0.8em]">Liest vor …</span>
            </>
          ) : (
            <Volume2 className="h-3.5 w-3.5" />
          )}
        </button>
      </Tip>
    </div>
  );
}

export function Conversation({ session }: { session: Session }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const blocks = useMemo(() => toBlocks(session.items), [session.items]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [session.items, session.running, session.pending.length]);

  // Beim Wechsel der Session ganz nach unten.
  useEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.id]);

  const lastIndex = blocks.length - 1;

  return (
    <div data-brise="conversation" className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        className="h-full overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          stick.current = atBottom;
          setShowJump(!atBottom);
        }}
      >
        <div className="mx-auto max-w-[820px] px-6 pb-8 pt-6">
          {session.readOnly && !session.guest && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-[0.88em] text-muted">
              <Info className="h-4 w-4" /> Verlauf eines Subagenten – nur lesbar.
            </div>
          )}
          {session.replaying && session.items.length === 0 && <div className="py-10 text-center text-muted">Lade Verlauf …</div>}
          <div className="space-y-4">
            {blocks.map((b, n) => {
              const live = session.running && n === lastIndex;
              if (b.kind === "tools") return <ToolGroup key={b.id} items={b.items} cwd={session.cwd} live={live} />;
              const item = b.item;
              switch (item.type) {
                case "user":
                  return (
                    <div key={item.id} data-brise="user-message" className="flex flex-col items-end gap-1.5 fade-in">
                      {item.author && <span className="text-[0.76em] text-muted">{item.author}</span>}
                      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-user px-4 py-2.5 selectable">{item.text}</div>
                      {item.routed && (
                        <span className="inline-flex items-center gap-1 text-[0.76em] text-muted" title={item.routed.reason}>
                          <Wand2 className="h-3 w-3" /> Auto: {item.routed.model}
                          <span className="opacity-70">· {LEVEL_LABEL[item.routed.level]}</span>
                        </span>
                      )}
                      {item.attachments && item.attachments.length > 0 && (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {item.attachments.map((a) => (
                            <span key={a.path} className="inline-flex items-center gap-1 rounded-md border border-line bg-elev px-2 py-0.5 text-[0.8em] text-fg-2">
                              {a.kind === "image" ? <Image className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
                              {a.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                case "assistant":
                  return (
                    <div key={item.id} data-brise="assistant-message" className="group/msg fade-in">
                      <Markdown text={item.text} />
                      {!live && <MessageActions sessionId={session.id} itemId={item.id} text={item.text} />}
                    </div>
                  );
                case "thought":
                  return <Thought key={item.id} text={item.text} live={live} />;
                case "notice":
                  return (
                    <div
                      key={item.id}
                      className={clsx(
                        "flex items-start gap-2 rounded-lg px-3 py-2 text-[0.9em]",
                        item.tone === "error" && "bg-bad-soft text-bad",
                        item.tone === "warn" && "bg-warn-soft text-warn",
                        item.tone === "info" && "bg-panel text-muted",
                      )}
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="whitespace-pre-wrap selectable">{item.text}</span>
                    </div>
                  );
                case "turn":
                  return <TurnFooter key={item.id} item={item} />;
                default:
                  return null;
              }
            })}
            {session.running && session.pending.length === 0 && <Working since={session.turnStarted} />}
          </div>
        </div>
      </div>
      {showJump && (
        <button
          className="absolute bottom-3 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-elev text-muted shadow-pop hover:text-fg"
          onClick={() => {
            stick.current = true;
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
          }}
          aria-label="Nach unten"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
