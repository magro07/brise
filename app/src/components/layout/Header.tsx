import { ChevronRight, MoreHorizontal, PanelLeftOpen, PanelRight, Trash2 } from "lucide-react";
import { basename, useStore, type Session } from "../../lib/store";
import { IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Tip, clsx } from "../ui";
import { PANEL_TABS, changedFiles, subagents } from "../panels/SidePanel";

export function Header({ session }: { session?: Session }) {
  const project = useStore((s) => s.activeProject);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const panel = useStore((s) => s.panel);
  const { set, togglePanel, deleteSession, newDraft } = useStore.getState();
  const changes = changedFiles(session).length;
  const agents = subagents(session).length;
  const badge: Record<string, number> = { changes, agents, tasks: session?.plan.length ?? 0 };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3" data-tauri-drag-region>
      {!sidebarOpen && (
        <IconButton label="Seitenleiste einblenden (Strg+B)" onClick={() => set({ sidebarOpen: true })}>
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
        {session?.readOnly && <span className="rounded bg-hover px-1.5 text-[0.75em] text-muted">Subagent</span>}
      </div>

      <div className="flex items-center gap-0.5">
        {PANEL_TABS.map((t) => (
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
        <IconButton label="Detailpanel (Strg+J)" active={!!panel} onClick={() => togglePanel()}>
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
              <MenuItem
                icon={<Trash2 />}
                danger
                onSelect={() => window.confirm("Diese Session endgültig löschen?") && deleteSession(session.id)}
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
