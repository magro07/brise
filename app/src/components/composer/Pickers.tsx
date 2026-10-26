import { Brain, ChevronDown, Cpu, FilePen, Hand, Sparkles, Wand2, Zap, type LucideIcon } from "lucide-react";
import type { ConfigOption } from "../../lib/acp";
import { useStore, type Session } from "../../lib/store";
import { tokens } from "../../lib/format";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Ring, Tip, clsx } from "../ui";

export const MODE_INFO: Record<string, { label: string; description: string; icon: LucideIcon }> = {
  ask: { label: "Alles fragen", description: "Jede Aktion braucht deine Freigabe", icon: Hand },
  "accept-edits": { label: "Edits automatisch", description: "Dateiänderungen ohne Rückfrage, Befehle mit", icon: FilePen },
  "smart-approve": { label: "Smart", description: "Vibe stuft jede Aktion nach Risiko ein", icon: Sparkles },
  "auto-approve": { label: "Alles automatisch", description: "Keine Rückfragen – mit Vorsicht nutzen", icon: Zap },
};

const THINKING_LABEL: Record<string, string> = { off: "Aus", low: "Niedrig", medium: "Mittel", high: "Hoch", max: "Maximal" };

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
  const list: { id: string; name: string; description?: string }[] = modes.length
    ? modes
    : Object.keys(MODE_INFO).map((id) => ({ id, name: MODE_INFO[id].label }));
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
              onSelect={() => setOption("mode", m.id)}
            >
              {i?.label ?? m.name}
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

export function OptionPicker({ session, id }: { session?: Session; id: "model" | "thinking" }) {
  const { config, value } = useOptions(session);
  const setOption = useStore((s) => s.setOption);
  const auto = useStore((s) => s.prefs.autoModel);
  const setPrefs = useStore((s) => s.setPrefs);
  const option = config.find((o) => o.id === id);
  if (!option?.options?.length) return null;
  const current = value(id);
  if (id === "model") {
    const name = (v?: string) => option.options?.find((o) => o.value === v)?.name ?? v ?? "";
    return (
      <Menu>
        <MenuTrigger asChild>
          <button aria-label="Modell" data-tour="model">
            <PickerButton icon={auto ? Wand2 : Cpu} label={auto ? `Auto · ${name(current)}` : name(current)} />
          </button>
        </MenuTrigger>
        <MenuContent side="top" className="w-72">
          <MenuLabel>Modell</MenuLabel>
          <MenuItem
            icon={<Wand2 />}
            checked={auto}
            description="Brise stuft jede Aufgabe ein und wählt das passende Modell"
            onSelect={() => setPrefs({ autoModel: true })}
          >
            Auto
          </MenuItem>
          <MenuSeparator />
          {option.options.map((o) => (
            <MenuItem
              key={o.value}
              checked={!auto && o.value === current}
              description={o.description}
              onSelect={() => {
                setPrefs({ autoModel: false });
                setOption("model", o.value);
              }}
            >
              {o.name}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    );
  }
  const label = (v?: string) =>
    id === "thinking" ? (THINKING_LABEL[v ?? ""] ?? v ?? "") : (option.options?.find((o) => o.value === v)?.name ?? v ?? "");
  return (
    <Menu>
      <MenuTrigger asChild>
        <button aria-label={(id as string) === "model" ? "Modell" : "Denkstufe"}>
          <PickerButton icon={(id as string) === "model" ? Cpu : Brain} label={id === "thinking" ? `Denken: ${label(current)}` : label(current)} />
        </button>
      </MenuTrigger>
      <MenuContent side="top" className="w-64">
        <MenuLabel>{(id as string) === "model" ? "Modell" : "Denkstufe"}</MenuLabel>
        {option.options.map((o) => (
          <MenuItem
            key={o.value}
            checked={o.value === current}
            description={(id as string) === "model" ? o.description : undefined}
            onSelect={() => setOption(id, o.value)}
          >
            {label(o.value)}
          </MenuItem>
        ))}
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
