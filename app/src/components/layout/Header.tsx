import { ChevronRight, MoreHorizontal, PanelLeftOpen, PanelRight, Share2, SquarePlus, SquareTerminal, Trash2 } from "lucide-react";
import { shortcut } from "../../lib/platform";
import { basename, useStore, type Session } from "../../lib/store";
import { IconButton, Menu, MenuContent, MenuItem, MenuTrigger } from "../ui";
import { PANEL_TABS, changedFiles, subagents } from "../panels/SidePanel";
import { subagentLook, workingSubagents } from "../chat/ToolCall";
import { confirmAction } from "../../lib/dialogs";
import { AccountBadge } from "./AccountBadge";
import { useCollab } from "../../lib/collab";
import { CollabBadge } from "../collab/CollabBadge";

export function Header({ session }: { session?: Session }) {
  const project = useStore((s) => s.activeProject);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const terminalOpen = useStore((s) => s.terminalOpen);
  const panel = useStore((s) => s.panel);
  const { set, togglePanel, deleteSession, newDraft } = useStore.getState();
  const changes = changedFiles(session).length;
  const agents = subagents(session).length;
  const working = workingSubagents(session);
  const badge: Record<string, number> = { changes, agents, tasks: session?.plan.length ?? 0 };

  return (
    <header data-brise="header" className="relative flex h-[46px] shrink-0 items-center gap-2 px-3" data-tauri-drag-region>
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
        {session && !session.readOnly && (
          <Menu>
            <MenuTrigger asChild>
              <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" aria-label="Sessionmenü">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon={<SquareTerminal />} onSelect={() => set({ terminalOpen: !terminalOpen })}>
                Terminal
              </MenuItem>
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
        <IconButton label={`Detailpanel (${shortcut("J")})`} active={!!panel} onClick={() => togglePanel()}>
          <PanelRight className="h-4 w-4" />
        </IconButton>
        <IconButton label={`Neue Session (${shortcut("N")})`} onClick={() => newDraft(project ?? undefined)}>
          <SquarePlus className="h-4 w-4" />
        </IconButton>
      </div>
      {session && !panel && (
        <div className="absolute right-3 top-full z-20 hidden w-[220px] min-[1400px]:block rounded-2xl border border-line bg-elev p-2 shadow-soft fade-in">
          <div className="truncate px-2 pb-1 text-[0.9em] text-muted">{basename(session.cwd)}</div>
          {PANEL_TABS.filter((t) => t.id === "changes" || (badge[t.id] > 0 && (t.id !== "agents" || !working.length))).map((t) => (
            <button key={t.id} onClick={() => togglePanel(t.id)} className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-hover">
              <t.icon className="h-4 w-4 text-fg-2" />
              <span className="flex-1 truncate">{t.label}</span>
              {badge[t.id] > 0 && <span className="tabular-nums text-muted">{badge[t.id]}</span>}
            </button>
          ))}
          {working.length > 0 && (
            <>
              <div className="truncate px-2 pb-1 pt-2 text-[0.9em] text-muted">Subagenten</div>
              <button onClick={() => togglePanel("agents")} className="flex h-8 w-full items-center gap-1 rounded-lg bg-hover px-2 text-left">
                {working.slice(0, 3).map((t) => {
                  const { Icon, color } = subagentLook(t);
                  return <Icon key={t.id} className={`h-3.5 w-3.5 shrink-0 ${color}`} />;
                })}
                <span className="ml-1 truncate">{working.length === 1 ? "1 arbeitet" : `${working.length} arbeiten`}</span>
              </button>
            </>
          )}
        </div>
      )}
    </header>
  );
}
