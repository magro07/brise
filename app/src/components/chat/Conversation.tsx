import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, Brain, Check, Wand2, CheckCircle2, ChevronRight, CircleSlash, Copy, FileText, Image, Info, Network, Scale, Square, Volume2 } from "lucide-react";
import { useStore } from "../../lib/store";
import { agentName, useVoiceAvailable } from "../../lib/backends";
import type { Item, Session } from "../../lib/store";
import { duration, latency, tokens } from "../../lib/format";
import { Spinner, Tip, clsx } from "../ui";
import { Markdown } from "./Markdown";
import { ToolGroup } from "./ToolCall";
import { CouncilItemCard } from "./Council";
import { askAgentForCouncil } from "../../lib/council";
import { NOTE_AUTHOR } from "../../lib/orchestra";
import { OpenCards, OrchCard } from "../orchestra/Orchestra";

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

function Working({ since, backend }: { since?: number; backend?: string }) {
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
      <span className="shimmer-text">{agentName(backend)} arbeitet</span>
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
      {item.ttftMs != null && (
        <>
          <span>·</span>
          <span title="Zeit vom Senden bis zum ersten Token">erstes Token nach {latency(item.ttftMs)}</span>
        </>
      )}
      {item.tps != null && (
        <>
          <span>·</span>
          <span title="Output-Tokens je Sekunde Generierungszeit (ohne Werkzeuge)">{item.tps.toLocaleString("de-DE", { maximumFractionDigits: 0 })} t/s</span>
        </>
      )}
    </div>
  );
}

const LEVEL_LABEL = { simple: "einfach", standard: "normal", complex: "komplex" } as const;

function MessageActions({ sessionId, itemId, text }: { sessionId: string; itemId: string; text: string }) {
  const narration = useStore((s) => s.narration);
  const { narrate, stopNarration } = useStore.getState();
  const voice = useVoiceAvailable();
  const [copied, setCopied] = useState(false);
  const active = narration.itemId === itemId && narration.state !== "idle";
  const councilOn = useStore((s) => s.prefs.council.mode !== "off");
  const busy = useStore((s) => !!s.sessions[sessionId]?.running || !!s.sessions[sessionId]?.readOnly);
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
      {voice && <Tip label={active ? "Vorlesen stoppen" : "Vorlesen (Voxtral, als kurze Zusammenfassung)"}>
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
      </Tip>}
      {councilOn && (
        <Tip label="Mit Council prüfen: andere Modelle sehen sich die Änderungen an">
          <button
            className="flex h-7 items-center gap-1.5 rounded-md px-1.5 hover:bg-hover hover:text-fg disabled:opacity-40"
            disabled={busy}
            onClick={() => askAgentForCouncil(sessionId)}
            aria-label="Mit Council prüfen"
          >
            <Scale className="h-3.5 w-3.5" />
            <span className="text-[0.8em]">Mit Council prüfen</span>
          </button>
        </Tip>
      )}
    </div>
  );
}

/** Ein Block des Verlaufs. Beim Streaming ändert sich nur der letzte Block – die übrigen rendern nicht neu. */
const BlockView = memo(function BlockView({ block: b, live, sessionId, cwd }: { block: Block; live: boolean; sessionId: string; cwd: string }) {
  if (b.kind === "tools") return <ToolGroup items={b.items} cwd={cwd} live={live} />;
  const item = b.item;
  switch (item.type) {
    case "user":
      if (item.author === NOTE_AUTHOR)
        return (
          <div data-brise="orch-note" className="rounded-xl border border-dashed border-line-strong bg-panel px-3.5 py-2.5 text-[0.88em] fade-in">
            <div className="mb-1 flex items-center gap-1.5 text-[0.85em] font-medium text-muted">
              <Network className="h-3.5 w-3.5 text-accent" /> {NOTE_AUTHOR}
            </div>
            <div className="whitespace-pre-wrap text-fg-2 selectable">{item.text}</div>
          </div>
        );
      return (
        <div data-brise="user-message" className="flex flex-col items-end gap-1.5 fade-in">
          {item.author && <span className="text-[0.76em] text-muted">{item.author}</span>}
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-user px-4 py-2.5 selectable">{item.text}</div>
          {(item.routed || item.zdr) && (
            <span className="inline-flex items-center gap-1 text-[0.76em] text-muted" title={item.routed?.reason}>
              {item.routed && (
                <>
                  <Wand2 className="h-3 w-3" /> Auto: {item.routed.model}
                  <span className="opacity-70">· {LEVEL_LABEL[item.routed.level]}</span>
                  {item.routed.probabilities?.[item.routed.level] != null && (
                    <span className="opacity-70">{Math.round(item.routed.probabilities[item.routed.level] * 100)} %</span>
                  )}
                </>
              )}
              {item.zdr && (
                <span className="rounded bg-ok-soft px-1 font-medium text-ok" title="Ging an ein Cortecs-Modell ohne Datenspeicherung (Zero Data Retention)">
                  ZDR
                </span>
              )}
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
        <div data-brise="assistant-message" className="group/msg fade-in">
          <Markdown text={item.text} />
          {!live && <MessageActions sessionId={sessionId} itemId={item.id} text={item.text} />}
        </div>
      );
    case "thought":
      return <Thought text={item.text} live={live} />;
    case "notice":
      return (
        <div
         
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
      return <TurnFooter item={item} />;
    case "council":
      return <CouncilItemCard item={item} sessionId={sessionId} />;
    case "orch":
      return <OrchCard kind={item.kind} refId={item.ref} />;
    default:
      return null;
  }
}, sameBlock);

function sameBlock(a: { block: Block; live: boolean; sessionId: string; cwd: string }, b: { block: Block; live: boolean; sessionId: string; cwd: string }) {
  if (a.live !== b.live || a.sessionId !== b.sessionId || a.cwd !== b.cwd || a.block.kind !== b.block.kind) return false;
  if (a.block.kind === "item") return a.block.item === (b.block as typeof a.block).item;
  const x = a.block.items;
  const y = (b.block as typeof a.block).items;
  return x.length === y.length && x.every((item, i) => item === y[i]);
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
            {blocks.map((b, n) => (
              <BlockView key={b.kind === "tools" ? b.id : b.item.id} block={b} live={session.running && n === lastIndex} sessionId={session.id} cwd={session.cwd} />
            ))}
            <OpenCards session={session} />
            {session.running && session.pending.length === 0 && <Working since={session.turnStarted} backend={session.backend} />}
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
