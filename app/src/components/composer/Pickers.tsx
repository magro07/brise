import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Brain, ChevronDown, ChevronRight, FilePen, Hand, RotateCcw, Sparkles, Wand2, Zap, type LucideIcon } from "lucide-react";
import type { ConfigOption } from "../../lib/acp";
import { THINKING_LABEL, nearestThinking, useStore, type Session } from "../../lib/store";
import { tokens } from "../../lib/format";
import { useCaps, useSessionBackend } from "../../lib/backends";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Ring, Tip, clsx } from "../ui";
import { modeAllowed, modelAllowed, usePolicy } from "../../lib/policy";

export const MODE_INFO: Record<string, { label: string; description: string; icon: LucideIcon }> = {
  ask: { label: "Alles fragen", description: "Jede Aktion braucht deine Freigabe", icon: Hand },
  "accept-edits": { label: "Edits automatisch", description: "Dateiänderungen ohne Rückfrage, Befehle mit", icon: FilePen },
  "smart-approve": { label: "Smart", description: "Vibe stuft jede Aktion nach Risiko ein", icon: Sparkles },
  "auto-approve": { label: "Alles automatisch", description: "Keine Rückfragen – mit Vorsicht nutzen", icon: Zap },
  // Claude Code
  default: { label: "Alles fragen", description: "Vor jeder Änderung nachfragen", icon: Hand },
  acceptEdits: { label: "Edits automatisch", description: "Dateiänderungen ohne Rückfrage", icon: FilePen },
  plan: { label: "Planen", description: "Erst einen Plan erstellen, nichts ändern", icon: Brain },
  auto: { label: "Claude entscheidet", description: "Claude stuft Freigaben selbst ein", icon: Sparkles },
  bypassPermissions: { label: "Alles automatisch", description: "Keine Rückfragen – mit Vorsicht nutzen", icon: Zap },
};


function PickerButton({ icon: Icon, label, warn }: { icon: LucideIcon; label: string; warn?: boolean }) {
  return (
    <span
      title={label}
      className={clsx(
        "inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[0.86em] text-fg-2 hover:bg-hover hover:text-fg",
        warn && "text-warn",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="hidden max-w-[160px] truncate @[620px]:inline">{label}</span>
      <ChevronDown className="h-3 w-3 shrink-0 text-muted" />
    </span>
  );
}

/** Optionen der aktiven Session, sonst die der zuletzt gesehenen (für den ersten Prompt). */
function useOptions(session?: Session) {
  const template = useStore((s) => s.template);
  const draft = useStore((s) => s.draft);
  const config: ConfigOption[] = session && !session.readOnly && session.config.length ? session.config : (template?.config ?? []);
  const modes = session && session.modes.length ? session.modes : (template?.modes ?? []);
  const value = (id: string) => {
    if (session && !session.readOnly) {
      if (id === "mode") return session.currentMode;
      return session.config.find((o) => o.id === id)?.currentValue as string | undefined;
    }
    return (draft as Record<string, string | undefined>)[id] ?? (config.find((o) => o.id === id)?.currentValue as string | undefined);
  };
  return { config, modes, value };
}

export function ModePicker({ session }: { session?: Session }) {
  const { modes, value } = useOptions(session);
  const setOption = useStore((s) => s.setOption);
  const current = value("mode") ?? "accept-edits";
  const info = MODE_INFO[current];
  const effective = usePolicy((s) => s.effective);
  // Vom Team-Admin gesperrte Modi gar nicht erst anbieten.
  const list: { id: string; name: string; description?: string }[] = (modes.length ? modes : Object.keys(MODE_INFO).map((id) => ({ id, name: MODE_INFO[id].label }))).filter(
    (m) => m.id === current || modeAllowed(m.id, effective),
  );
  return (
    <Menu>
      <MenuTrigger asChild>
        <button aria-label="Freigabe-Modus" data-tour="mode">
          <PickerButton icon={info?.icon ?? Hand} label={info?.label ?? current} warn={current === "auto-approve"} />
        </button>
      </MenuTrigger>
      <MenuContent side="top" className="w-72">
        <MenuLabel>Freigabe-Modus</MenuLabel>
        {list.map((m) => {
          const i = MODE_INFO[m.id];
          const Icon = i?.icon ?? Hand;
          return (
            <MenuItem
              key={m.id}
              icon={<Icon />}
              checked={m.id === current}
              description={i?.description ?? m.description}
              onSelect={() => setOption("mode", m.id, session?.id).catch(() => {})}
            >
              {i?.label ?? m.name}
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

export function ContextMeter({ session }: { session?: Session }) {
  const togglePanel = useStore((s) => s.togglePanel);
  const used = session?.usage.used;
  const size = session?.usage.size;
  if (!used || !size) return null;
  const ratio = used / size;
  return (
    <Tip
      label={
        <span>
          Kontext: {tokens(used)} von {tokens(size)} Tokens ({Math.round(ratio * 100)} %)
          <br />
          Klicken für Details
        </span>
      }
    >
      <button
        className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg px-1.5 text-[0.8em] text-muted hover:bg-hover hover:text-fg"
        onClick={() => togglePanel("context")}
        aria-label="Kontext"
      >
        <Ring value={ratio} />
        <span className="hidden @[520px]:inline">{Math.round(ratio * 100)} %</span>
      </button>
    </Tip>
  );
}

const KNOB = 30;
const TOP_COLOR = "#a05cf6";
const LEVEL_COLOR = "#3b8bf5";
const levelName = (value: string | undefined, fallback?: string) => {
  const label = THINKING_LABEL[value ?? ""] ?? fallback ?? value ?? "";
  return label.charAt(0).toUpperCase() + label.slice(1);
};

/** Dicker Regler: Der Griff gleitet, die Füllung läuft von Blau nach Violett, ganz oben funkelt sie. */
function EffortSlider({ count, index, dimmed, onChange, onTopHover }: { count: number; index: number; dimmed: boolean; onChange: (index: number) => void; onTopHover: (top: boolean) => void }) {
  const max = count - 1;
  const t = max > 0 ? index / max : 0;
  const center = `calc(${KNOB / 2}px + (100% - ${KNOB}px) * ${t})`;
  const top = max > 0 && index === max;
  return (
    <div className={clsx("relative h-[30px] transition-opacity", dimmed && "opacity-60")}>
      <div className="absolute inset-x-0 top-1/2 h-[24px] -translate-y-1/2 overflow-hidden rounded-full bg-active">
        {Array.from({ length: count }, (_, n) => (
          <span key={n} className="absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted/60" style={{ left: `calc(${KNOB / 2}px + (100% - ${KNOB}px) * ${max > 0 ? n / max : 0})` }} />
        ))}
        <div
          className={clsx("effort-fill absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out", top && "effort-top")}
          style={{ width: index > 0 ? center : 0, backgroundSize: `${100 / Math.max(t, 0.01)}% 100%` }}
        />
      </div>
      <div className="pointer-events-none absolute top-0 h-[30px] w-[30px] -translate-x-1/2 rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.3)] transition-[left] duration-300 ease-out" style={{ left: center }} />
      <input
        type="range"
        aria-label="Denkstufe einstellen"
        min={0}
        max={max}
        step={1}
        value={index}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          onTopHover(max > 0 && (e.clientX - box.left) / box.width > 1 - 0.5 / max);
        }}
        onPointerLeave={() => onTopHover(false)}
        className="absolute inset-0 w-full cursor-pointer opacity-0"
      />
    </div>
  );
}

/** Modell und Denkstufe in einem: Regler vorne, Modellliste und Verlauf im selben Popover. */
export function ModelEffortPicker({ session }: { session?: Session }) {
  const { config, value } = useOptions(session);
  const setOption = useStore((s) => s.setOption);
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const autoCapable = useCaps(useSessionBackend(session)).autoModel;
  const effective = usePolicy((s) => s.effective);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"effort" | "models" | "log">("effort");
  const [topHover, setTopHover] = useState(false);
  const model = config.find((o) => o.id === "model");
  const thinking = config.find((o) => o.id === "thinking");
  if (!model?.options?.length && !thinking?.options?.length) return null;

  const autoModel = prefs.autoModel && autoCapable;
  const currentModel = value("model");
  const modelName = model?.options?.find((o) => o.value === currentModel)?.name ?? currentModel ?? "";
  const levels = thinking?.options ?? [];
  const currentLevel = value("thinking");
  const index = Math.max(0, levels.findIndex((l) => l.value === currentLevel));
  const top = levels.length > 1 && index === levels.length - 1;
  const steering = prefs.autoModel && prefs.autoStrategy === "reasoning";
  const autoThinking = steering && (session?.autoThinking ?? true);
  const log = session?.thinkingLog ?? [];
  const color = top ? TOP_COLOR : LEVEL_COLOR;
  const level = levelName(currentLevel, levels[index]?.name);
  const setAutoThinking = (on: boolean) => {
    if (session) useStore.setState((s) => ({ sessions: { ...s.sessions, [session.id]: { ...s.sessions[session.id], autoThinking: on } } }));
  };
  const pickLevel = (n: number) => {
    setAutoThinking(false);
    setOption("thinking", levels[n].value, session?.id).catch(() => {});
  };
  const reset = () => {
    const target = nearestThinking("high", levels.map((l) => l.value));
    if (steering) setAutoThinking(true);
    else if (target) setOption("thinking", target, session?.id).catch(() => {});
  };
  const pickModel = (id: string) => {
    if (autoCapable) setPrefs({ autoModel: false });
    setOption("model", id, session?.id).catch(() => {});
    setPage("effort");
  };
  const firstPage = levels.length ? "effort" : "models";

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setPage(firstPage);
      }}
    >
      <Tip label="Modell und Denkstufe wählen" side="top">
        <Popover.Trigger asChild>
          <button aria-label="Modell" data-tour="model" className="ml-1 inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full bg-hover px-3 text-[0.92em] transition-colors hover:bg-active">
            {open ? (
              <span className="truncate text-muted">Aufwand auswählen</span>
            ) : (
              <>
                {autoModel ? <Wand2 className="h-3.5 w-3.5 shrink-0" /> : <Zap className="h-3.5 w-3.5 shrink-0 fill-current" />}
                <span className="max-w-[170px] truncate">{autoModel ? `Auto · ${modelName}` : modelName}</span>
                {levels.length > 0 && <span className="shrink-0" style={{ color: top ? TOP_COLOR : "var(--muted)" }}>{autoThinking ? "Auto" : level}</span>}
              </>
            )}
            <ChevronDown className="h-3 w-3 shrink-0 text-muted" />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content side="top" align="end" sideOffset={8} data-tour="thinking" className="z-50 w-[300px] rounded-2xl border border-line bg-elev p-3 shadow-pop fade-in">
          {page === "effort" && (
            <>
              <div className="relative flex h-[46px] items-center justify-center text-center">
                {topHover ? (
                  <span key="hint" className="fade-in font-medium" style={{ color: TOP_COLOR }}>Verbraucht Kontingent schneller</span>
                ) : (
                  <>
                    <button className="absolute left-0 top-1 flex h-7 w-7 items-center justify-center rounded-lg hover:bg-hover" style={{ color }} aria-label="Automatisch wählen" title={steering ? "Auto: Das Task-Modell wählt die Stufe" : undefined} onClick={() => steering && setAutoThinking(!autoThinking)}>
                      {autoThinking ? <Wand2 className="h-4 w-4" /> : <Zap className="h-4 w-4 fill-current" />}
                    </button>
                    <div className="min-w-0">
                      <div key={level} className="fade-in text-[1.15em] font-medium leading-6" style={{ color }}>{autoThinking ? `Auto · ${level}` : level}</div>
                      <button className="inline-flex max-w-[200px] items-center gap-0.5 text-[0.92em] text-muted hover:text-fg" onClick={() => setPage("models")}>
                        <span className="truncate">{modelName}</span>
                        <ChevronRight className="h-3 w-3 shrink-0" />
                      </button>
                    </div>
                    <button className="absolute right-0 top-1 flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg" aria-label="Auf Standard zurücksetzen" onClick={reset}>
                      <RotateCcw className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
              <div className="mt-3">
                <EffortSlider count={levels.length} index={index} dimmed={autoThinking} onChange={pickLevel} onTopHover={setTopHover} />
              </div>
              {log.length > 0 && (
                <button className="mt-2 w-full text-center text-[0.84em] text-muted hover:text-fg" onClick={() => setPage("log")}>
                  Verlauf ansehen
                </button>
              )}
            </>
          )}
          {page === "models" && (
            <div className="-m-1 max-h-[340px] overflow-y-auto">
              {autoCapable && (
                <button className={clsx("flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left hover:bg-hover", autoModel && "bg-hover")} onClick={() => { setPrefs({ autoModel: true }); setPage(firstPage); }}>
                  <Wand2 className="h-4 w-4 text-muted" /> Auto
                </button>
              )}
              {(model?.options ?? []).filter((o) => o.value === currentModel || modelAllowed(o.value, effective)).map((o) => (
                <button key={o.value} title={o.description} className={clsx("flex h-9 w-full items-center rounded-lg px-2.5 text-left hover:bg-hover", !autoModel && o.value === currentModel && "bg-hover")} onClick={() => pickModel(o.value)}>
                  <span className="truncate">{o.name}</span>
                </button>
              ))}
            </div>
          )}
          {page === "log" && (
            <div className="max-h-64 overflow-y-auto">
              {[...log].reverse().map((e, n) => (
                <div key={n} className="flex items-start gap-2 py-1 text-[0.82em]">
                  <span className="shrink-0 tabular-nums text-muted">{new Date(e.at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">
                      {THINKING_LABEL[e.from] ?? (e.from || "–")} → {THINKING_LABEL[e.to] ?? e.to}
                    </span>
                    {e.phase === "live" && <span className="ml-1 rounded bg-accent-soft px-1 text-[0.85em] text-accent">während der Arbeit</span>}
                    <span className="block text-muted">{e.reason}</span>
                    {e.probabilities && <ProbabilityBar probs={e.probabilities} chosen={e.to} />}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Wahrscheinlichkeiten eines Decision-Modells als schmale Balken. */
function ProbabilityBar({ probs, chosen }: { probs: Record<string, number>; chosen: string }) {
  const order = ["off", "low", "medium", "high", "max"];
  const entries = Object.entries(probs).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  return (
    <span className="mt-1 flex gap-1" aria-label="Wahrscheinlichkeiten">
      {entries.map(([k, p]) => (
        <span key={k} className="min-w-0 flex-1" title={`${THINKING_LABEL[k] ?? k}: ${Math.round(p * 100)} %`}>
          <span className="block h-1 overflow-hidden rounded bg-hover">
            <span className={clsx("block h-full rounded", k === chosen ? "bg-accent" : "bg-muted/50")} style={{ width: `${Math.max(3, p * 100)}%` }} />
          </span>
          <span className="block truncate text-[0.82em] tabular-nums text-muted">
            {THINKING_LABEL[k] ?? k} {Math.round(p * 100)} %
          </span>
        </span>
      ))}
    </span>
  );
}
