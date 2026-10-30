import { ChevronRight, MoreHorizontal, PanelLeftOpen, PanelRight, Share2, SquareTerminal, Trash2 } from "lucide-react";
import { shortcut } from "../../lib/platform";
import { basename, useStore, type Session } from "../../lib/store";
import { IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Tip, clsx } from "../ui";
import { PANEL_TABS, changedFiles, subagents } from "../panels/SidePanel";
import { confirmAction } from "../../lib/dialogs";
import { HeaderMeter } from "../usage/HeaderMeter";
import { AccountBadge } from "./AccountBadge";
import { useCollab } from "../../lib/collab";
import { CollabBadge } from "../collab/CollabBadge";

export function Header({ session }: { session?: Session }) {
  const project = useStore((s) => s.activeProject);
  const simple = useStore((s) => s.prefs.simpleMode);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const terminalOpen = useStore((s) => s.terminalOpen);
  const panel = useStore((s) => s.panel);
  const { set, togglePanel, deleteSession, newDraft } = useStore.getState();
  const changes = changedFiles(session).length;
  const agents = subagents(session).length;
  const badge: Record<string, number> = { changes, agents, tasks: session?.plan.length ?? 0 };

  return (
    <header data-brise="header" className="flex h-[46px] shrink-0 items-center gap-2 px-3" data-tauri-drag-region>
      {!sidebarOpen && (
        <IconButton label={`Seitenleiste einblenden (${shortcut("B")})`} onClick={() => set({ sidebarOpen: true })}>
          <PanelLeftOpen className="h-4 w-4" />
        </IconButton>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[0.95em]" data-tauri-drag-region>
        {project && (
          <button className="shrink-0 rounded-md px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg" onClick={() => newDraft(project)} title={project}>
            {basename(project)}
          </button>
        )}
        {project && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />}
        <span className="truncate font-medium">{session ? (session.title ?? "Neue Session") : "Neue Session"}</span>
        {session?.readOnly && !session.guest && <span className="rounded bg-hover px-1.5 text-[0.75em] text-muted">Subagent</span>}
        {session?.guest && <CollabBadge session={session} />}
        {!session?.readOnly && !session?.guest && (session?.backend ?? "vibe") === "vibe" && <AccountBadge sessionId={session?.id} />}
      </div>

      <div className="flex items-center gap-0.5">
        {!session?.guest && <CollabBadge session={session} />}
        {!simple && <HeaderMeter />}
        {!panel && PANEL_TABS.filter((t) => badge[t.id] > 0).map((t) => (
          <Tip key={t.id} label={t.label}>
            <button
              onClick={() => togglePanel(t.id)}
              className={clsx(
                "relative flex h-8 items-center gap-1.5 rounded-md px-2 text-[0.85em]",
                panel === t.id ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
              )}
              aria-label={t.label}
            >
              <t.icon className="h-4 w-4" />
              {badge[t.id] > 0 && <span className="tabular-nums">{badge[t.id]}</span>}
            </button>
          </Tip>
        ))}
        <IconButton label={`Terminal (${shortcut("ö")})`} active={terminalOpen} onClick={() => set({ terminalOpen: !terminalOpen })}>
          <SquareTerminal className="h-4 w-4" />
        </IconButton>
        <IconButton label={`Detailpanel (${shortcut("J")})`} active={!!panel} onClick={() => togglePanel()}>
          <PanelRight className="h-4 w-4" />
        </IconButton>
        {session && !session.readOnly && (
          <Menu>
            <MenuTrigger asChild>
              <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" aria-label="Sessionmenü">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon={<Share2 />} onSelect={() => useCollab.setState({ shareFor: session.id })}>
                Session teilen …
              </MenuItem>
              <MenuItem
                icon={<Trash2 />}
                danger
                onSelect={async () => (await confirmAction("Diese Session endgültig löschen?", true)) && deleteSession(session.id)}
              >
                Session löschen
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
    </header>
  );
}
