import { useMemo, useState } from "react";
import { shortcut } from "../../lib/platform";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Columns2,
  ChevronRight,
  EyeOff,
  Folder,
  FolderOpen,
  FolderPlus,
  LogIn,
  Users,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  SquarePen,
  Trash2,
  Crown,
  Bot,
  ChartColumn,
  KeyRound,
  LogOut,
  UserRound,
  Palette,
  Box,
} from "lucide-react";
import { basename, useStore, type Session } from "../../lib/store";
import { BackendBadge } from "../agents/BackendPicker";
import { relativeTime } from "../../lib/format";
import { IconButton, Kbd, Logo, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Spinner, clsx } from "../ui";
import { confirmAction } from "../../lib/dialogs";
import { useCollab } from "../../lib/collab";
import { TeamPanel } from "../collab/TeamPanel";
import { DesignList, ModeSwitch } from "../design/Sidebar";
import { newDesign } from "../design/DesignView";
import { ModelList, newModel } from "../model3d/Sidebar";
import { ProjectWork } from "../workbench/parts";
import { startCurator, useOrchestra } from "../../lib/orchestra";
import { SubRows } from "../orchestra/Orchestra";
import { useProfile } from "../../lib/profile";
import { useProviders } from "../../lib/providers";
import { Avatar } from "../profile/ProfileDialog";

const SHOWN_PER_PROJECT = 6;

export async function pickProject() {
  const picked = await openDialog({ directory: true, title: "Projektordner wählen" });
  if (typeof picked === "string") useStore.getState().openProject(picked);
}

export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const index = useStore((s) => s.index);
  const sessions = useStore((s) => s.sessions);
  const activeProject = useStore((s) => s.activeProject);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const view = useStore((s) => s.view);
  const { newDraft, selectSession, removeProject, deleteSession, setView, set } = useStore.getState();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Untersessions stehen unter ihrer Master-Session, nicht im Projekt.
  const subs = useOrchestra((s) => s.book.subs);

  // Sessions je Projekt: Vibes Liste plus gerade erst angelegte, noch nicht gelistete.
  const byProject = useMemo(() => {
    const map = new Map<string, { id: string; title: string; updatedAt?: string | null; backend?: string }[]>();
    const seen = new Set<string>(subs.map((s) => s.id));
    for (const s of Object.values(sessions)) {
      if (s.readOnly || seen.has(s.id)) continue;
      const summary = index.find((x) => x.sessionId === s.id);
      // Vorbereitete, noch leere Sessions nicht anzeigen.
      if (s.items.length === 0 && !summary?.title) continue;
      seen.add(s.id);
      const list = map.get(s.cwd) ?? [];
      list.push({ id: s.id, title: s.title ?? summary?.title ?? "Neue Session", updatedAt: summary?.updatedAt ?? new Date().toISOString(), backend: s.backend });
      map.set(s.cwd, list);
    }
    for (const s of index) {
      // Ohne Titel = nie benutzt (z. B. eine vorbereitete Session).
      if (seen.has(s.sessionId) || !s.title) continue;
      const list = map.get(s.cwd) ?? [];
      list.push({ id: s.sessionId, title: s.title ?? "Unbenannte Session", updatedAt: s.updatedAt, backend: s.backend });
      map.set(s.cwd, list);
    }
    for (const list of map.values()) list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return map;
  }, [index, sessions, subs]);

  const q = query.trim().toLowerCase();

  return (
    <aside data-brise="sidebar" className="flex h-full w-[272px] shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex h-12 items-center gap-2 px-3" data-tauri-drag-region>
        <Logo size={22} />
        <span className="font-semibold tracking-tight">Brise</span>
        <div className="flex-1" />
        <IconButton label={`Seitenleiste ausblenden (${shortcut("B")})`} onClick={() => set({ sidebarOpen: false })}>
          <PanelLeftClose className="h-4 w-4" />
        </IconButton>
      </div>

      <div className="space-y-0.5 px-2">
        <SideButton icon={<SquarePen className="h-4 w-4" />} onClick={() => newDraft()} hint={shortcut("N")}>
          Neue Session
        </SideButton>
        <SideButton icon={<Search className="h-4 w-4" />} onClick={() => set({ paletteOpen: true })} hint={shortcut("K")}>
          Suchen und Befehle
        </SideButton>
      </div>

      <ModeSwitch />

      {view === "design" ? <DesignList /> : view === "3d" ? <ModelList /> : <>
      <TeamPanel />

      <div className="mt-3 flex items-center px-4 pb-1 text-[0.78em] font-medium uppercase tracking-wide text-muted">
        <span className="flex-1">Projekte</span>
        <Menu>
          <MenuTrigger asChild>
            <button className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" aria-label="Projekt hinzufügen" data-tour="add-project">
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<FolderPlus />} onSelect={() => set({ newProjectOpen: true })}>
              Neues Projekt anlegen …
            </MenuItem>
            <MenuItem icon={<FolderOpen />} onSelect={pickProject}>
              Vorhandenen Ordner öffnen …
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<LogIn />} onSelect={() => useCollab.setState({ joinOpen: true })}>
              Einer Session beitreten …
            </MenuItem>
            <MenuItem icon={<Users />} onSelect={() => useCollab.setState({ teamOpen: true })}>
              Team anlegen oder beitreten …
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      {projects.length > 4 && (
        <div className="px-3 pb-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Sessions filtern …"
            className="h-7 w-full rounded-md border border-line bg-bg px-2 text-[0.86em] outline-none placeholder:text-muted focus:border-accent"
          />
        </div>
      )}

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {projects.length === 0 && (
          <button
            onClick={pickProject}
            className="mt-2 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-muted hover:border-accent hover:text-fg"
          >
            <FolderOpen className="h-5 w-5" />
            <span className="text-[0.9em]">Ersten Projektordner öffnen</span>
          </button>
        )}
        {projects.map((project) => {
          const all = byProject.get(project) ?? [];
          const list = q ? all.filter((s) => s.title.toLowerCase().includes(q)) : all;
          if (q && list.length === 0 && !basename(project).toLowerCase().includes(q)) return null;
          const isCollapsed = collapsed[project] && !q;
          const shown = expanded[project] || q ? list : list.slice(0, SHOWN_PER_PROJECT);
          const isActiveProject = project === activeProject && !activeSessionId && view === "chat";
          return (
            <div key={project} className="mb-1">
              <div
                className={clsx(
                  "group flex h-8 items-center gap-1 rounded-lg pl-1 pr-1 text-fg-2 hover:bg-hover",
                  isActiveProject && "bg-active text-fg",
                )}
                title={project}
              >
                <button
                  className="flex h-6 w-5 items-center justify-center text-muted"
                  onClick={() => setCollapsed((c) => ({ ...c, [project]: !c[project] }))}
                  aria-label={isCollapsed ? "Aufklappen" : "Zuklappen"}
                >
                  <ChevronRight className={clsx("h-3.5 w-3.5 transition-transform", !isCollapsed && "rotate-90")} />
                </button>
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => newDraft(project)}>
                  <Folder className="h-4 w-4 shrink-0 text-muted" />
                  <span className="truncate font-medium">{basename(project)}</span>
                </button>
                <div className="hidden items-center group-hover:flex">
                  <IconButton label={`Neue Session in ${basename(project)}`} size="sm" onClick={() => newDraft(project)}>
                    <Plus className="h-3.5 w-3.5" />
                  </IconButton>
                  <Menu>
                    <MenuTrigger asChild>
                      <button className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-active hover:text-fg" aria-label="Projektmenü">
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem icon={<Plus />} onSelect={() => newDraft(project)}>
                        Neue Session
                      </MenuItem>
                      <MenuItem icon={<Crown />} onSelect={() => startCurator(project)}>
                        Neue Kurator-Session
                      </MenuItem>
                      <MenuItem icon={<Palette />} onSelect={() => newDesign(undefined, project)}>
                        Neues Design im Projekt
                      </MenuItem>
                      <MenuItem icon={<Box />} onSelect={() => newModel(undefined, project)}>
                        Neues 3D-Modell im Projekt
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem icon={<EyeOff />} onSelect={() => removeProject(project)}>
                        Aus der Liste entfernen
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
              </div>
              {!isCollapsed && (
                <div className="ml-[18px] border-l border-line pl-1.5">
                  {shown.map((s) => (
                    <div key={s.id}>
                    <SessionRow
                      key={s.id}
                      id={s.id}
                      title={s.title}
                      backend={s.backend}
                      time={relativeTime(s.updatedAt)}
                      active={s.id === activeSessionId && view === "chat"}
                      live={sessions[s.id]}
                      onClick={() => selectSession(s.id)}
                      onSplit={() => useStore.getState().splitWith(s.id)}
                      onDelete={async () => {
                        if (await confirmAction(`Session „${s.title}“ endgültig löschen?`, true)) deleteSession(s.id);
                      }}
                    />
                    <SubRows master={s.id} activeId={view === "chat" ? activeSessionId : null} />
                    </div>
                  ))}
                  {!q && list.length > SHOWN_PER_PROJECT && (
                    <button
                      className="h-7 w-full rounded-md px-2 text-left text-[0.84em] text-muted hover:bg-hover hover:text-fg"
                      onClick={() => setExpanded((e) => ({ ...e, [project]: !e[project] }))}
                    >
                      {expanded[project] ? "Weniger anzeigen" : `${list.length - SHOWN_PER_PROJECT} weitere anzeigen`}
                    </button>
                  )}
                  {list.length === 0 && !q && <div className="px-2 py-1 text-[0.84em] text-muted">Noch keine Sessions</div>}
                  {!q && <ProjectWork project={project} />}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      </>}

      <div className="border-t border-line p-2" data-tour="settings">
        <SideButton
          icon={<Settings className="h-4 w-4" />}
          onClick={() => setView(view === "settings" ? "chat" : "settings")}
          active={view === "settings"}
          hint={shortcut(",")}
        >
          Einstellungen
        </SideButton>
        <AccountFooter />
      </div>
    </aside>
  );
}

/** Kurzname eines verbundenen Agenten samt Abo, z. B. „Claude Max“. */
function agentLabel(id: string, title: string, label?: string | null) {
  if (id === "claude" && label && /max|pro|team/i.test(label)) return label.replace(/^Claude\s*/i, "Claude ");
  return { vibe: "Vibe", claude: "Claude Code", codex: "Codex", gemini: "Gemini" }[id] ?? title;
}

/** Unten links: Brise-Konto, verbundene Agenten und Anbieter, Menü. */
function AccountFooter() {
  const profile = useProfile((s) => s.profile);
  const agents = useStore((s) => s.agents);
  const auth = useStore((s) => s.auth);
  const providers = useProviders((s) => s.list);
  const { setView, signOut } = useStore.getState();
  const connected = Object.entries(agents)
    .filter(([id, a]) => (id === "vibe" ? auth?.authenticated : a.auth?.authenticated))
    .map(([id, a]) => agentLabel(id, a.title, a.auth?.label));
  const keys = providers.filter((p) => p.hasKey && p.id !== "mistral").length;
  const summary = connected.length === 0 ? "Kein Agent verbunden" : connected.length <= 3 ? connected.join(" · ") : `${connected.length} Agenten verbunden`;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-hover" data-testid="account-footer">
          <span className="relative">
            <Avatar name={profile?.name ?? "?"} color={profile?.color} avatar={profile?.avatar} size={28} className={profile ? "" : "!bg-hover !text-muted"} />
            <span className={clsx("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-sidebar", connected.length ? "bg-ok" : "bg-muted")} />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[0.9em]">{profile?.name ?? "Konto anlegen"}</span>
            <span className="block truncate text-[0.78em] text-muted">
              {summary}
              {keys ? ` · ${keys} Schlüssel` : ""}
            </span>
          </span>
        </button>
      </MenuTrigger>
      <MenuContent side="top" className="w-72">
        <MenuItem icon={<UserRound />} onSelect={() => useProfile.setState({ dialog: profile ? "edit" : "create" })}>
          {profile ? "Konto bearbeiten" : "Konto anlegen"}
        </MenuItem>
        <MenuItem icon={<KeyRound />} onSelect={() => setView("settings", "providers")}>
          Anbieter & Schlüssel
        </MenuItem>
        <MenuItem icon={<Bot />} onSelect={() => setView("settings", "agents")} description={connected.length ? connected.join(", ") : undefined}>
          Agenten
        </MenuItem>
        <MenuItem icon={<ChartColumn />} onSelect={() => setView("settings", "usage")}>
          Nutzung
        </MenuItem>
        <MenuSeparator />
        {auth?.authenticated && auth.signOutAvailable && (
          <MenuItem icon={<LogOut />} danger onSelect={async () => (await confirmAction("Von Vibe abmelden? Der gespeicherte Mistral-Schlüssel wird entfernt.", true)) && signOut()}>
            Von Vibe abmelden
          </MenuItem>
        )}
        {Object.entries(agents)
          .filter(([id, a]) => id !== "vibe" && a.auth?.authenticated)
          .map(([id, a]) => (
            <MenuItem key={id} icon={<LogOut />} onSelect={() => setView("settings", "agents")} description="Abmelden bzw. anders anmelden unter Agenten">
              {a.title}: Anmeldung verwalten
            </MenuItem>
          ))}
      </MenuContent>
    </Menu>
  );
}

function SideButton({
  icon,
  children,
  onClick,
  hint,
  active,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  hint?: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "group flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-fg-2 hover:bg-hover hover:text-fg",
        active && "bg-active text-fg",
      )}
    >
      <span className="text-muted group-hover:text-fg">{icon}</span>
      <span className="flex-1">{children}</span>
      {hint && (
        <span className="hidden group-hover:inline">
          <Kbd>{hint}</Kbd>
        </span>
      )}
    </button>
  );
}

function SessionRow({
  title,
  backend,
  time,
  active,
  live,
  onClick,
  onDelete,
  onSplit,
}: {
  id: string;
  title: string;
  backend?: string;
  time: string;
  active: boolean;
  live?: Session;
  onClick: () => void;
  onDelete: () => void;
  onSplit: () => void;
}) {
  const waiting = (live?.pending.length ?? 0) > 0;
  return (
    <div
      className={clsx(
        "group flex h-8 items-center gap-2 rounded-lg pl-2 pr-1 text-[0.92em] text-fg-2 hover:bg-hover",
        active && "bg-active text-fg",
      )}
    >
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onClick}>
        {live?.running && !waiting && <Spinner className="text-accent" />}
        {waiting && <span className="h-2 w-2 shrink-0 rounded-full bg-warn pulse-dot" title="Wartet auf Freigabe" />}
        <span className="truncate">{title}</span>
        {backend && <BackendBadge backend={backend} />}
      </button>
      <span className="text-[0.78em] text-muted group-hover:hidden">{time}</span>
      <Menu>
        <MenuTrigger asChild>
          <button
            className="hidden h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-active hover:text-fg group-hover:flex"
            aria-label="Sessionmenü"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<Columns2 />} onSelect={onSplit}>
            Rechts daneben öffnen
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 />} danger onSelect={onDelete}>
            Session löschen
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
