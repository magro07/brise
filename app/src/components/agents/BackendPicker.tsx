import { Bot, ChevronDown, Settings2 } from "lucide-react";
import { BACKEND_SHORT, BACKEND_TONE, useMultiBackend } from "../../lib/backends";
import { draftBackendOf, useStore, type Session } from "../../lib/store";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, clsx } from "../ui";

/** Kleines Kennzeichen, zu welchem Agenten eine Session gehört. */
export function BackendBadge({ backend, always, className }: { backend: string; always?: boolean; className?: string }) {
  const multi = useMultiBackend();
  if (!multi && !always) return null;
  return (
    <span
      title={`Agent: ${BACKEND_SHORT[backend] ?? backend}`}
      className={clsx("inline-flex h-4 shrink-0 items-center rounded px-1 text-[0.68em] font-medium leading-none", BACKEND_TONE[backend] ?? "bg-hover text-fg-2", className)}
    >
      {BACKEND_SHORT[backend] ?? backend}
    </span>
  );
}

/**
 * Agent für die nächste neue Session (Composer ohne Session). Läuft schon eine
 * Session, zeigt der Picker nur ihr Backend an – wechseln geht nicht mitten drin.
 */
export function BackendPicker({ session }: { session?: Session }) {
  const backends = useStore((s) => s.backends);
  const agents = useStore((s) => s.agents);
  const current = useStore((s) => session?.backend ?? draftBackendOf(s));
  const defaultBackend = useStore((s) => s.prefs.defaultBackend);
  const { setDraftBackend, setView } = useStore.getState();
  const installed = backends.filter((b) => b.installed);
  if (session) return <BackendBadge backend={session.backend} className="mx-1" />;
  if (installed.length < 2) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button aria-label="Agent" data-brise="backend-picker" className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[0.86em] text-fg-2 hover:bg-hover hover:text-fg">
          <Bot className="h-3.5 w-3.5 shrink-0" />
          <span className="max-w-[120px] truncate">{BACKEND_SHORT[current] ?? current}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted" />
        </button>
      </MenuTrigger>
      <MenuContent side="top" className="w-72">
        <MenuLabel>Agent für die neue Session</MenuLabel>
        {installed.map((b) => {
          const auth = agents[b.id]?.auth;
          const status = !agents[b.id] ? "startet bei Bedarf" : auth?.authenticated ? (auth.label ?? "angemeldet") : "nicht angemeldet";
          return (
            <MenuItem
              key={b.id}
              checked={b.id === current}
              hint={b.id === defaultBackend ? "Standard" : undefined}
              description={status}
              onSelect={() => setDraftBackend(b.id === defaultBackend ? null : b.id)}
            >
              {b.title}
            </MenuItem>
          );
        })}
        <MenuSeparator />
        <MenuItem icon={<Settings2 />} onSelect={() => setView("settings", "agents")}>
          Agenten verwalten …
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
