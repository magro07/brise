// Gemeinsame Bausteine für Design- und 3D-Modus, damit sich beide wie der
// Code-Modus anfühlen: Projekt zuordnen (auch aus Team-Workspaces), Anlegen
// mit Projekt und Agent, Tabs der geöffneten Arbeiten und eine Coding-Session
// rechts daneben (Split).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { create } from "zustand";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Bot, Box, ChevronDown, Columns2, Folder, FolderGit2, FolderOpen, FolderX, MessageSquare, Palette, Plus, Users, X } from "lucide-react";
import { api } from "../../lib/acp";
import { basename, draftBackendOf, useStore, type Session } from "../../lib/store";
import { useCollab } from "../../lib/collab";
import { BACKEND_SHORT } from "../../lib/backends";
import { Conversation } from "../chat/Conversation";
import { Composer } from "../composer/Composer";
import { PermissionPrompt } from "../composer/Pinned";
import { BackendBadge } from "../agents/BackendPicker";
import { useDesign } from "../design/designStore";
import { useModel } from "../model3d/modelStore";
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Spinner, clsx } from "../ui";

export interface ProjectChoice {
  path: string;
  /** Name des Teams, wenn das Projekt ein gemeinsames Team-Projekt ist. */
  team?: string;
}

/** Projekte aus dem Code-Modus plus Team-Projekte (lokal geöffnete per Ordnername). */
export function useProjectChoices(): { local: ProjectChoice[]; remote: { name: string; team: string }[] } {
  const projects = useStore((s) => s.projects);
  const teams = useCollab((s) => s.teams);
  return useMemo(() => {
    const local: ProjectChoice[] = projects.map((p) => ({ path: p }));
    const remote: { name: string; team: string }[] = [];
    for (const t of Object.values(teams))
      for (const p of t.projects) {
        const hit = local.find((x) => basename(x.path) === p.name);
        if (hit) hit.team = t.name;
        else remote.push({ name: p.name, team: t.name });
      }
    return { local, remote };
  }, [projects, teams]);
}

async function pickFolder(): Promise<string | null> {
  const p = await openDialog({ directory: true, title: "Projektordner wählen" });
  if (typeof p !== "string") return null;
  // Wie im Code-Modus: der Ordner erscheint danach auch in der Projektliste.
  const st = useStore.getState();
  if (!st.projects.includes(p)) useStore.setState({ projects: [p, ...st.projects] });
  return p;
}

function ProjectItems({ value, onChange }: { value?: string; onChange: (p: string | undefined) => void }) {
  const { local, remote } = useProjectChoices();
  return (
    <>
      <MenuLabel>Projekt zuordnen</MenuLabel>
      {local.length === 0 && <div className="px-3 py-1.5 text-[0.86em] text-muted">Noch keine Projekte im Code-Modus.</div>}
      {local.map((p) => (
        <MenuItem
          key={p.path}
          icon={p.team ? <Users /> : <Folder />}
          checked={p.path === value}
          description={p.team ? `Team ${p.team} · ${p.path}` : p.path}
          onSelect={() => onChange(p.path)}
        >
          {basename(p.path)}
        </MenuItem>
      ))}
      {remote.map((p) => (
        <MenuItem key={`${p.team}/${p.name}`} icon={<FolderGit2 />} description={`Team ${p.team} · noch nicht lokal – erst im Code-Modus öffnen`}>
          <span className="text-muted">{p.name}</span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon={<FolderOpen />} onSelect={async () => onChange((await pickFolder()) ?? value)}>
        Ordner wählen …
      </MenuItem>
      {value && (
        <MenuItem icon={<FolderX />} onSelect={() => onChange(undefined)}>
          Kein Projekt
        </MenuItem>
      )}
    </>
  );
}

/** Knopf mit Menü zum Zuordnen eines Projekts (Kopfzeile von Design/3D). */
export function ProjectMenu({ value, onChange }: { value?: string; onChange: (p: string | undefined) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          data-brise="project-menu"
          title={value ? `Projekt: ${value}` : "Keinem Projekt zugeordnet"}
          className={clsx("inline-flex h-7 max-w-[180px] items-center gap-1 rounded-md px-1.5 text-[0.84em] hover:bg-hover", value ? "text-fg-2" : "text-muted")}
        >
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{value ? basename(value) : "Projekt …"}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted" />
        </button>
      </MenuTrigger>
      <MenuContent className="max-h-[60vh] w-80 overflow-y-auto">
        <ProjectItems value={value} onChange={onChange} />
      </MenuContent>
    </Menu>
  );
}

// ---------- Anlegen ----------

export interface NewWork {
  name: string;
  project?: string;
  backend: string;
}

type Ask = { kind: "design" | "3d"; project?: string; resolve: (v: NewWork | null) => void };
const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

/** Name, Projekt und Agent für ein neues Design bzw. Modell erfragen. */
export function askNewWork(kind: "design" | "3d", project?: string): Promise<NewWork | null> {
  return new Promise((resolve) => useAsk.setState({ ask: { kind, project, resolve } }));
}

export function NewWorkDialog() {
  const ask = useAsk((s) => s.ask);
  const backends = useStore((s) => s.backends).filter((b) => b.installed);
  const [name, setName] = useState("");
  const [project, setProject] = useState<string | undefined>();
  const [backend, setBackend] = useState("vibe");
  useEffect(() => {
    if (!ask) return;
    const st = useStore.getState();
    setName("");
    // Wie im Code-Modus: das zuletzt aktive Projekt und der gewählte Agent sind vorbelegt.
    setProject(ask.project ?? (st.view === "chat" ? (st.activeProject ?? undefined) : undefined));
    setBackend(draftBackendOf(st));
  }, [ask]);
  if (!ask) return null;
  const design = ask.kind === "design";
  const close = (v: NewWork | null) => {
    ask.resolve(v);
    useAsk.setState({ ask: null });
  };
  const ok = () => close({ name: name.trim(), project, backend });
  return (
    <Dialog.Root open onOpenChange={(o) => !o && close(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <Dialog.Content data-brise="new-work" className="fixed left-1/2 top-[20%] z-50 w-[min(460px,92vw)] -translate-x-1/2 rounded-2xl border border-line bg-elev p-5 shadow-pop fade-in">
          <Dialog.Title className="font-semibold">{design ? "Neues Design" : "Neues 3D-Modell"}</Dialog.Title>
          <label className="mt-3 block text-[0.86em] font-medium">Name</label>
          <input
            autoFocus
            value={name}
            placeholder={design ? "z. B. Preisseite" : "z. B. Wandhalterung"}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ok()}
            className="mt-1 h-10 w-full rounded-lg border border-line bg-bg px-3 text-[0.92em] outline-none focus:border-accent"
          />
          <label className="mt-3 block text-[0.86em] font-medium">Projekt</label>
          <Menu>
            <MenuTrigger asChild>
              <button className="mt-1 flex h-10 w-full items-center gap-2 rounded-lg border border-line bg-bg px-3 text-left text-[0.92em]">
                <Folder className="h-4 w-4 shrink-0 text-muted" />
                <span className={clsx("min-w-0 flex-1 truncate", !project && "text-muted")}>{project ? `${basename(project)} – ${project}` : "Kein Projekt"}</span>
                <ChevronDown className="h-3.5 w-3.5 text-muted" />
              </button>
            </MenuTrigger>
            <MenuContent className="max-h-[50vh] w-[420px] overflow-y-auto">
              <ProjectItems value={project} onChange={setProject} />
            </MenuContent>
          </Menu>
          <p className="mt-1 text-[0.8em] text-muted">
            {design ? "Das Design-System des Projekts wird übernommen, die Übergabe geht in dieses Projekt." : "Die Übergabe geht standardmäßig in dieses Projekt."}
          </p>
          {backends.length > 1 && (
            <>
              <label className="mt-3 block text-[0.86em] font-medium">Agent</label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {backends.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => setBackend(b.id)}
                    className={clsx("inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[0.88em]", backend === b.id ? "border-accent bg-accent-soft text-fg" : "border-line text-muted hover:text-fg")}
                  >
                    <Bot className="h-3.5 w-3.5" /> {BACKEND_SHORT[b.id] ?? b.title}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => close(null)}>
              Abbrechen
            </Button>
            <Button variant="primary" onClick={ok}>
              Anlegen
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------- Tabs ----------

export interface WorkTab {
  id: string;
  name: string;
  session?: Session;
}

/** Tab-Leiste der geöffneten Designs bzw. Modelle (Strg+Tab, Strg+W wie im Code-Modus). */
export function WorkTabs({ tabs, active, icon, onOpen, onClose, onNew, newLabel }: { tabs: WorkTab[]; active: string | null; icon: ReactNode; onOpen: (id: string) => void; onClose: (id: string) => void; onNew: () => void; newLabel: string }) {
  if (tabs.length < 2) return null;
  return (
    <div data-brise="work-tabs" className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line px-2">
      {tabs.map((t) => {
        const on = t.id === active;
        const waiting = (t.session?.pending.length ?? 0) > 0;
        return (
          <div
            key={t.id}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(t.id);
              }
            }}
            className={clsx(
              "group relative flex h-8 min-w-[120px] max-w-[220px] shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 pl-2.5 pr-1 text-[0.84em]",
              on ? "border-line bg-bg text-fg" : "border-transparent text-muted hover:bg-hover hover:text-fg",
            )}
          >
            {on && <span className="absolute inset-x-2 top-0 h-[2px] rounded-full bg-accent" />}
            <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => onOpen(t.id)} title={t.name}>
              {waiting ? <span className="h-2 w-2 shrink-0 rounded-full bg-warn pulse-dot" /> : t.session?.running ? <Spinner className="h-3 w-3 shrink-0 text-accent" /> : <span className="shrink-0 text-muted [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}
              <span className="truncate">{t.name}</span>
            </button>
            <button className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 hover:bg-active hover:text-fg group-hover:opacity-100" onClick={() => onClose(t.id)} aria-label="Tab schließen">
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <div className="flex h-8 items-center">
        <IconButton label={newLabel} size="sm" onClick={onNew}>
          <Plus className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

// ---------- Split: Coding-Session daneben ----------

/** Sessions eines Projekts (geladen und aus Vibes Liste), neueste zuerst. */
function useProjectSessions(project?: string) {
  const index = useStore((s) => s.index);
  const sessions = useStore((s) => s.sessions);
  return useMemo(() => {
    if (!project) return [];
    const out = new Map<string, { id: string; title: string; backend: string; at: string }>();
    for (const s of index) if (s.cwd === project && s.title) out.set(s.sessionId, { id: s.sessionId, title: s.title, backend: s.backend ?? "vibe", at: s.updatedAt ?? "" });
    for (const s of Object.values(sessions))
      if (s.cwd === project && !s.readOnly && s.items.length && !out.has(s.id)) out.set(s.id, { id: s.id, title: s.title ?? "Neue Session", backend: s.backend, at: new Date().toISOString() });
    return [...out.values()].sort((a, b) => b.at.localeCompare(a.at));
  }, [project, index, sessions]);
}

/** Knopf „Coding-Session daneben“: Session des Projekts wählen oder neu anlegen. */
export function SplitMenu({ project, current, lastHandoff, onPick }: { project?: string; current: string | null; lastHandoff?: string; onPick: (id: string | null) => void }) {
  const list = useProjectSessions(project);
  const [busy, setBusy] = useState(false);
  const open = async (id: string) => {
    const st = useStore.getState();
    const summary = st.index.find((s) => s.sessionId === id);
    if (!st.sessions[id] && summary) await st.attachSession(id, summary.cwd, summary.backend ?? "vibe", summary.title ?? undefined).catch((e) => useStore.setState({ error: String(e) }));
    onPick(id);
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          aria-label="Coding-Session daneben"
          data-brise="split-menu"
          title="Coding-Session daneben öffnen (Split)"
          className={clsx("flex h-8 w-8 items-center justify-center rounded-md hover:bg-hover", current ? "bg-active text-fg" : "text-muted hover:text-fg")}
        >
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <Columns2 className="h-4 w-4" />}
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="max-h-[60vh] w-80 overflow-y-auto">
        <MenuLabel>Coding-Session daneben</MenuLabel>
        {!project && <div className="px-3 py-1.5 text-[0.86em] text-muted">Erst ein Projekt zuordnen.</div>}
        {project && (
          <MenuItem
            icon={<Plus />}
            description={basename(project)}
            onSelect={async () => {
              setBusy(true);
              try {
                const st = useStore.getState();
                onPick(await st.createSession(project, st.prefs.defaultBackend));
              } catch (e) {
                useStore.setState({ error: `Session konnte nicht gestartet werden: ${e}` });
              } finally {
                setBusy(false);
              }
            }}
          >
            Neue Session im Projekt
          </MenuItem>
        )}
        {list.slice(0, 12).map((s) => (
          <MenuItem key={s.id} icon={<MessageSquare />} checked={s.id === current} hint={s.id === lastHandoff ? "Übergabe" : undefined} onSelect={() => open(s.id)}>
            <span className="flex items-center gap-1.5">
              <span className="truncate">{s.title}</span>
              <BackendBadge backend={s.backend} />
            </span>
          </MenuItem>
        ))}
        {current && (
          <>
            <MenuSeparator />
            <MenuItem icon={<X />} onSelect={() => onPick(null)}>
              Split schließen
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

/** Liegt der Fokus in der Split-Session? Dann gehören Drop und Sprache ihrem Composer. */
export const useSplitFocus = create<{ on: boolean }>(() => ({ on: false }));

/** Rechte Spalte: Verlauf und Code-Composer der gewählten Coding-Session. */
export function SplitSession({ id, onClose }: { id: string; onClose: () => void }) {
  const session = useStore((s) => s.sessions[id]);
  const focused = useSplitFocus((s) => s.on);
  const setFocused = (on: boolean) => useSplitFocus.setState({ on });
  useEffect(() => () => setFocused(false), []);
  if (!session) return null;
  const pending = session.pending[0];
  return (
    <div data-brise="split-session" className="flex min-h-0 w-[min(440px,36vw)] shrink-0 flex-col border-l border-line" onMouseDownCapture={() => setFocused(true)} onFocusCapture={() => setFocused(true)}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <MessageSquare className="h-4 w-4 text-muted" />
        <span className="min-w-0 flex-1 truncate font-medium" title={session.cwd}>
          {session.title ?? "Neue Session"} <span className="text-[0.84em] font-normal text-muted">· {basename(session.cwd)}</span>
        </span>
        <IconButton label="Split schließen" size="sm" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {session.items.length ? <Conversation session={session} /> : <div className="flex-1" />}
      <div className="shrink-0 px-3 pb-3">
        {pending ? (
          <PermissionPrompt session={session} pending={pending} />
        ) : (
          <Composer
            session={session}
            project={session.cwd}
            focused={focused}
            onSend={(t, list, opts) => useStore.getState().send(t, list, { ...opts, sessionId: id })}
            onCancel={() => api.cancel(id)}
          />
        )}
      </div>
    </div>
  );
}

// ---------- Seitenleiste ----------

/** Einträge nach zugeordnetem Projekt gruppieren; ohne Zuordnung zuletzt. Überschriften nur, wenn es Zuordnungen gibt. */
export function ProjectGroups<T extends { id: string; project?: string }>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  const groups = new Map<string, T[]>();
  for (const i of items) groups.set(i.project ?? "", [...(groups.get(i.project ?? "") ?? []), i]);
  if (groups.size === 1 && groups.has("")) return <>{items.map(render)}</>;
  const keys = [...groups.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : basename(a).localeCompare(basename(b))));
  return (
    <>
      {keys.map((k) => (
        <div key={k || "-"} className="mb-1">
          <div className="flex h-7 items-center gap-1.5 px-2 text-[0.8em] text-muted" title={k || undefined}>
            {k ? <Folder className="h-3.5 w-3.5 shrink-0" /> : <FolderX className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{k ? basename(k) : "Ohne Projekt"}</span>
          </div>
          <div className="ml-[13px] border-l border-line pl-1.5">{groups.get(k)!.map(render)}</div>
        </div>
      ))}
    </>
  );
}

/** Designs und Modelle eines Projekts in der Seitenleiste des Code-Modus. */
export function ProjectWork({ project }: { project: string }) {
  const designs = useDesign((s) => s.designs.filter((d) => d.project === project));
  const models = useModel((s) => s.models.filter((m) => m.project === project));
  useEffect(() => {
    useDesign.getState().init().catch(() => {});
    useModel.getState().init().catch(() => {});
  }, []);
  const rows = [
    ...designs.map((d) => ({ id: d.id, name: d.name, kind: "design" as const })),
    ...models.map((m) => ({ id: m.id, name: m.name, kind: "3d" as const })),
  ];
  if (!rows.length) return null;
  return (
    <div data-brise="project-work">
      {rows.map((r) => (
        <button
          key={r.id}
          title={r.kind === "design" ? "Design öffnen" : "3D-Modell öffnen"}
          onClick={() => {
            useStore.getState().setView(r.kind);
            if (r.kind === "design") useDesign.getState().open(r.id);
            else useModel.getState().open(r.id);
          }}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[0.88em] text-fg-2 hover:bg-hover hover:text-fg"
        >
          {r.kind === "design" ? <Palette className="h-3.5 w-3.5 shrink-0 text-muted" /> : <Box className="h-3.5 w-3.5 shrink-0 text-muted" />}
          <span className="truncate">{r.name}</span>
        </button>
      ))}
    </div>
  );
}
