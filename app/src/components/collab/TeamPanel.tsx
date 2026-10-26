import { useState } from "react";
import { ChevronRight, Copy, FolderGit2, LogOut, MoreHorizontal, Plus, Radio, UserPlus, Users, X } from "lucide-react";
import { basename, useStore } from "../../lib/store";
import {
  BACKEND_LABEL,
  joinTeamSession,
  leaveTeam,
  planLabel,
  setTeamProjects,
  useCollab,
  type Member,
  type TeamProject,
  type TeamView,
} from "../../lib/collab";
import { confirmAction } from "../../lib/dialogs";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tip, clsx } from "../ui";

function Dot({ on }: { on: boolean }) {
  return <span className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", on ? "bg-ok" : "bg-line-strong")} />;
}

function plans(m: Member) {
  return m.backends.filter((b) => b.active !== false && b.plan).map((b) => `${b.label ?? BACKEND_LABEL[b.id] ?? b.id}: ${b.plan}`);
}

function MemberRow({ member }: { member: Member }) {
  const guests = useCollab((s) => s.guests);
  const list = plans(member);
  return (
    <div data-collab="member">
      <div className="flex h-7 items-center gap-2 rounded-md px-2 text-[0.88em]" title={list.join("\n") || "kein Abo – arbeitet in Sessions anderer mit"}>
        <Dot on={member.online} />
        <span className="min-w-0 flex-1 truncate">{member.name}</span>
        <span className="shrink-0 text-[0.8em] text-muted">{list.length ? (member.backends.length > 1 ? `${list.length} Abos` : "Abo") : "ohne Abo"}</span>
      </div>
      {member.sessions.map((s) => {
        const room = /^brise:\/\/join\/([^?#]+)/.exec(s.link)?.[1];
        const joined = !!(room && guests[room]);
        return (
          <button
            key={s.sessionId}
            onClick={() => joinTeamSession(s).catch((e) => useStore.setState({ error: String(e) }))}
            className="ml-3.5 flex w-[calc(100%-0.875rem)] items-center gap-1.5 rounded-md px-2 py-1 text-left text-[0.84em] text-fg-2 hover:bg-hover hover:text-fg"
            title={`${BACKEND_LABEL[s.backend] ?? s.backend} auf dem Abo von ${s.billedTo?.name}${s.policy?.guestPrompts ? "" : " · nur zusehen"}`}
            data-collab="team-session"
          >
            <Radio className={clsx("h-3 w-3 shrink-0", s.running ? "text-accent" : "text-muted")} />
            <span className="min-w-0 flex-1 truncate">{s.title || "Neue Session"}</span>
            {s.project && <span className="max-w-[70px] shrink-0 truncate text-[0.9em] text-muted">{s.project}</span>}
            {joined ? <span className="text-[0.85em] text-accent">offen</span> : <ChevronRight className="h-3 w-3 shrink-0 text-muted" />}
          </button>
        );
      })}
    </div>
  );
}

function Projects({ team }: { team: TeamView }) {
  const projects = useStore((s) => s.projects);
  const { openProject } = useStore.getState();
  const add = async () => {
    const value = await new Promise<string | null>((resolve) =>
      useStore.setState({ textPrompt: { title: "Projekt für das Team", placeholder: "Name oder Git-URL (https://… oder git@…)", resolve } }),
    );
    const text = value?.trim();
    if (!text) return;
    const isRepo = /^(https?:\/\/|git@|ssh:\/\/)/.test(text);
    const name = isRepo ? basename(text).replace(/\.git$/, "") : text;
    const me = useCollab.getState().prefs.name.trim() || undefined;
    const item: TeamProject = { id: crypto.randomUUID(), name, repo: isRepo ? text : undefined, addedBy: me };
    await setTeamProjects(team.id, [...team.projects, item]);
  };
  const remove = (id: string) => setTeamProjects(team.id, team.projects.filter((p) => p.id !== id));
  return (
    <>
      <div className="mt-1 flex items-center px-2 text-[0.74em] uppercase tracking-wide text-muted">
        <span className="flex-1">Gemeinsame Projekte</span>
        <Tip label="Projekt hinzufügen">
          <button className="flex h-5 w-5 items-center justify-center rounded hover:bg-hover hover:text-fg" onClick={add} aria-label="Projekt hinzufügen">
            <Plus className="h-3 w-3" />
          </button>
        </Tip>
      </div>
      {team.projects.length === 0 && <div className="px-2 py-1 text-[0.82em] text-muted">Noch keine.</div>}
      {team.projects.map((p) => {
        const local = projects.find((x) => basename(x) === p.name);
        return (
          <div key={p.id} className="group flex h-7 items-center gap-2 rounded-md px-2 text-[0.86em] hover:bg-hover">
            <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted" />
            <button
              className="min-w-0 flex-1 truncate text-left"
              title={local ? `Öffnen: ${local}` : p.repo ? `Git-URL kopieren: ${p.repo}` : p.name}
              onClick={() => (local ? openProject(local) : p.repo && navigator.clipboard.writeText(p.repo).catch(() => {}))}
            >
              {p.name}
              {!local && p.repo && <span className="ml-1 text-[0.85em] text-muted">klonen</span>}
            </button>
            <button className="hidden h-5 w-5 items-center justify-center rounded text-muted hover:text-bad group-hover:flex" onClick={() => remove(p.id)} aria-label="Entfernen">
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </>
  );
}

function TeamBlock({ team }: { team: TeamView }) {
  const [open, setOpen] = useState(true);
  const name = useCollab((s) => s.prefs.name);
  const auth = useStore((s) => s.auth);
  const online = team.members.filter((m) => m.online).length + 1;
  return (
    <div className="mb-1" data-collab="team">
      <div className="group flex h-7 items-center gap-1.5 rounded-md px-2 text-[0.9em] hover:bg-hover">
        <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpen(!open)}>
          <ChevronRight className={clsx("h-3.5 w-3.5 shrink-0 text-muted transition-transform", open && "rotate-90")} />
          <Users className="h-3.5 w-3.5 shrink-0 text-muted" />
          <span className="truncate font-medium">{team.name}</span>
          <span className="text-[0.8em] text-muted">{online} online</span>
          {!team.connected && <span className="text-[0.8em] text-warn" title={team.error ?? ""}>getrennt</span>}
        </button>
        <Menu>
          <MenuTrigger asChild>
            <button className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-active hover:text-fg" aria-label="Teammenü">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<UserPlus />} onSelect={() => useCollab.setState({ teamOpen: true })}>
              Einladen …
            </MenuItem>
            <MenuItem icon={<Copy />} onSelect={() => navigator.clipboard.writeText(team.link).catch(() => {})}>
              Einladungslink kopieren
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<LogOut />} danger onSelect={async () => (await confirmAction(`Team „${team.name}“ verlassen?`, true)) && leaveTeam(team.id)}>
              Team verlassen
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {open && (
        <div className="pl-2">
          <div className="flex h-7 items-center gap-2 px-2 text-[0.88em]" title={auth?.authenticated ? planLabel() : "kein Abo angemeldet"}>
            <Dot on />
            <span className="min-w-0 flex-1 truncate">{name.trim() || "Du"} <span className="text-muted">(du)</span></span>
            <span className="shrink-0 text-[0.8em] text-muted">{auth?.authenticated ? "Abo" : "ohne Abo"}</span>
          </div>
          {team.members.map((m) => (
            <MemberRow key={m.id} member={m} />
          ))}
          <Projects team={team} />
        </div>
      )}
    </div>
  );
}

/** Sidebar: Teams mit Präsenz, Sessions der anderen und gemeinsamen Projekten. */
export function TeamPanel() {
  const teams = Object.values(useCollab((s) => s.teams));
  if (!teams.length) return null;
  return (
    <div className="mt-3 px-2" data-brise="teams">
      <div className="flex items-center px-2 pb-1 text-[0.78em] font-medium uppercase tracking-wide text-muted">Team</div>
      {teams.map((t) => (
        <TeamBlock key={t.id} team={t} />
      ))}
    </div>
  );
}
