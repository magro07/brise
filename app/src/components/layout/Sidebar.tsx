import { useMemo, useState } from "react";
import { shortcut } from "../../lib/platform";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Columns2,
  EyeOff,
  Folder,
  FolderOpen,
  FolderPlus,
  LogIn,
  Users,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
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
  Pencil,
} from "lucide-react";
import { basename, byRecency, useStore, type Session } from "../../lib/store";
import { BackendBadge } from "../agents/BackendPicker";
import { IconButton, Kbd, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Spinner, clsx } from "../ui";
import { askText, confirmAction } from "../../lib/dialogs";
import { useCollab } from "../../lib/collab";
import { isDesignPath } from "../../lib/design";
import { isModelPath } from "../../lib/model3d";
import { isBenchPath } from "../../lib/bench";
import { TeamPanel } from "../collab/TeamPanel";
import { DesignList } from "../design/Sidebar";
import { newDesign } from "../design/DesignView";
import { ModelList, newModel } from "../model3d/Sidebar";
import { ProjectWork } from "../workbench/parts";
import { startCurator, useOrchestra } from "../../lib/orchestra";
import { SubRows } from "../orchestra/Orchestra";
import { useProfile } from "../../lib/profile";
import { useProviders } from "../../lib/providers";
import { Avatar } from "../profile/ProfileDialog";

const SHOWN_PROJECTS = 5;
const SHOWN_RECENT = 30;
const SHOWN_IN_PROJECT = 6;

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
  const { newDraft, selectSession, removeProject, deleteSession, set } = useStore.getState();
  const [moreProjects, setMoreProjects] = useState(false);
  const [allInProject, setAllInProject] = useState(false);
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
      if (!s.items.some((i) => i.type !== "notice") && !summary?.title) continue;
      // Design, 3D und Benchmarks haben eigene Listen.
      if (isDesignPath(s.cwd) || isModelPath(s.cwd) || isBenchPath(s.cwd)) continue;
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
    for (const list of map.values()) list.sort(byRecency);
    return map;
  }, [index, sessions, subs]);

  const recent = useMemo(() => [...byProject.values()].flat().sort(byRecency), [byProject]);
  // Das aktive Projekt bleibt sichtbar, auch wenn es hinter „Mehr anzeigen“ läge.
  const shownProjects = moreProjects ? projects : [...new Set([...projects.slice(0, SHOWN_PROJECTS), ...(activeProject && projects.includes(activeProject) ? [activeProject] : [])])];
  const row = (s: { id: string; title: string; backend?: string }) => (
    <div key={s.id}>
      <SessionRow
        id={s.id}
        title={s.title}
        backend={s.backend}
        active={s.id === activeSessionId && view === "chat"}
        live={sessions[s.id]}
        onClick={() => selectSession(s.id)}
        onSplit={() => useStore.getState().splitWith(s.id)}
        onRename={async () => {
          const name = await askText("Neuer Name", s.title);
          if (name?.trim()) useStore.getState().renameSession(s.id, name.trim());
        }}
        onDelete={async () => {
          if (await confirmAction(`Session „${s.title}“ endgültig löschen?`, true)) deleteSession(s.id);
        }}
      />
      <SubRows master={s.id} activeId={view === "chat" ? activeSessionId : null} />
    </div>
  );

  return (
    <aside data-brise="sidebar" className="flex h-full w-[288px] shrink-0 flex-col overflow-hidden rounded-xl bg-bg shadow-soft">
      <div className="flex h-12 items-center gap-1 px-4" data-tauri-drag-region>
        <span className="flex-1 text-[1.1em] font-semibold tracking-tight">Brise</span>
        <IconButton label={`Seitenleiste ausblenden (${shortcut("B")})`} onClick={() => set({ sidebarOpen: false })}>
          <PanelLeftClose className="h-4 w-4" />
        </IconButton>
      </div>

      <div className="px-2">
        <SideButton icon={<SquarePen className="h-4 w-4" />} onClick={() => newDraft()} hint={shortcut("N")}>
          Neue Session
        </SideButton>
      </div>

      {view === "design" ? <DesignList /> : view === "3d" ? <ModelList /> : <>
      <TeamPanel />

      <nav className="mt-2 flex-1 overflow-y-auto px-2 pb-2">
        <div className="flex h-8 items-center pl-2.5 pr-1 text-muted">
          <span className="flex-1">Projekte</span>
          <Menu>
            <MenuTrigger asChild>
              <button className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-fg" aria-label="Projekt hinzufügen" data-tour="add-project">
                <Plus className="h-3.5 w-3.5" />
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
        {projects.length === 0 && (
          <button onClick={pickProject} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-muted hover:bg-hover hover:text-fg">
            <FolderOpen className="h-4 w-4" /> Ersten Projektordner öffnen
          </button>
        )}
        {shownProjects.map((project) => (
          <div key={project}>
            <div className={clsx("group flex h-8 items-center rounded-lg pr-1 text-fg-2 hover:bg-hover", project === activeProject && !activeSessionId && "bg-active text-fg")} title={project}>
              <button className="flex h-full min-w-0 flex-1 items-center gap-2.5 pl-2.5 text-left" onClick={() => newDraft(project)}>
                <Folder className="h-4 w-4 shrink-0 text-muted" />
                <span className="truncate">{basename(project)}</span>
              </button>
              <Menu>
                <MenuTrigger asChild>
                  <button className="hidden h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-active hover:text-fg group-hover:flex" aria-label="Projektmenü">
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
            {project === activeProject && <ProjectWork project={project} />}
            {project === activeProject && (
              <div className="ml-[17px] border-l border-line pl-1.5" data-brise="project-sessions">
                {(byProject.get(project) ?? []).slice(0, allInProject ? undefined : SHOWN_IN_PROJECT).map(row)}
                {(byProject.get(project)?.length ?? 0) > SHOWN_IN_PROJECT && (
                  <button className="h-8 w-full rounded-lg px-2.5 text-left text-muted hover:bg-hover hover:text-fg" onClick={() => setAllInProject(!allInProject)}>
                    {allInProject ? "Weniger anzeigen" : `Alle ${byProject.get(project)!.length} anzeigen`}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {projects.length > SHOWN_PROJECTS && (
          <button className="h-8 w-full rounded-lg px-2.5 text-left text-muted hover:bg-hover hover:text-fg" onClick={() => setMoreProjects(!moreProjects)}>
            {moreProjects ? "Weniger anzeigen" : "Mehr anzeigen"}
          </button>
        )}

        {recent.length > 0 && <div className="mt-3 flex h-8 items-center pl-2.5 text-muted">Letzte</div>}
        {recent.slice(0, SHOWN_RECENT).map(row)}
      </nav>
      </>}
    </aside>
  );
}

/** Kurzname eines verbundenen Agenten samt Abo, z. B. „Claude Max“. */
function agentLabel(id: string, title: string, label?: string | null) {
  if (id === "claude" && label && /max|pro|team/i.test(label)) return label.replace(/^Claude\s*/i, "Claude ");
  return { vibe: "Vibe", claude: "Claude Code", codex: "Codex", gemini: "Gemini" }[id] ?? title;
}

/** Unten in der Leiste: Brise-Konto, verbundene Agenten und Anbieter, Menü. */
export function AccountMenu() {
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
        <button className="mt-1 flex h-9 w-9 items-center justify-center rounded-lg hover:bg-hover" title={`${profile?.name ?? "Konto anlegen"} · ${summary}${keys ? ` · ${keys} Schlüssel` : ""}`} data-testid="account-footer">
          <span className="relative">
            <Avatar name={profile?.name ?? "?"} color={profile?.color} avatar={profile?.avatar} size={26} className={profile ? "" : "!bg-hover !text-muted"} />
            <span className={clsx("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--shell)]", connected.length ? "bg-ok" : "bg-muted")} />
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
  active,
  live,
  onClick,
  onDelete,
  onSplit,
  onRename,
}: {
  id: string;
  title: string;
  backend?: string;
  active: boolean;
  live?: Session;
  onClick: () => void;
  onDelete: () => void;
  onSplit: () => void;
  onRename: () => void;
}) {
  const waiting = (live?.pending.length ?? 0) > 0;
  return (
    <div
      className={clsx(
        "group flex h-8 items-center gap-2 rounded-lg pl-2.5 pr-1 text-fg-2 hover:bg-hover",
        active && "bg-active text-fg",
      )}
    >
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onClick}>
        <span className="truncate">{title}</span>
        {backend && <BackendBadge backend={backend} />}
        <span className="flex-1" />
        {live?.running && !waiting && <Spinner className="shrink-0 text-muted" />}
        {waiting && <span className="h-2 w-2 shrink-0 rounded-full bg-warn pulse-dot" title="Wartet auf Freigabe" />}
      </button>
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
          <MenuItem icon={<Pencil />} onSelect={onRename}>
            Umbenennen
          </MenuItem>
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
