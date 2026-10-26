import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { api, type PermissionRequest } from "./lib/acp";
import { useActiveSession, useStore } from "./lib/store";
import { Button, TooltipProvider, clsx } from "./components/ui";
import { TabBar } from "./components/layout/Tabs";
import { Sidebar } from "./components/layout/Sidebar";
import { Header } from "./components/layout/Header";
import { CommandPalette } from "./components/layout/CommandPalette";
import { Conversation } from "./components/chat/Conversation";
import { Composer } from "./components/composer/Composer";
import { PermissionPrompt, TaskStrip } from "./components/composer/Pinned";
import { SidePanel } from "./components/panels/SidePanel";
import { TerminalPanel } from "./components/tools/Terminal";
import { SettingsView } from "./components/settings/Settings";
import { DraftHero, NoProject, StartScreen } from "./components/screens/Screens";
import { NewProjectDialog } from "./components/screens/NewProject";
import { TextPrompt, Tour } from "./components/screens/Tour";
import { initCollab } from "./lib/collab";
import { ShareDialog } from "./components/collab/ShareDialog";
import { JoinDialog } from "./components/collab/JoinDialog";
import { TeamDialog } from "./components/collab/TeamDialog";
import { GuestPane } from "./components/collab/GuestComposer";

/** Backend-Events abonnieren und einmal mit Vibe verbinden. */
function useBackend() {
  useEffect(() => {
    const s = useStore.getState;
    let disposed = false;
    const unlisten: (() => void)[] = [];
    Promise.all([
      listen<{ sessionId: string; update: unknown }>("acp:update", (e) => s().onUpdate(e.payload.sessionId, e.payload.update)),
      listen<{ key: string; request: PermissionRequest }>("acp:permission", (e) => s().onPermission(e.payload.key, e.payload.request)),
      listen<{ key: string; optionId: string | null }>("acp:permission-closed", (e) => s().onPermissionClosed(e.payload.key, e.payload.optionId)),
      listen<{ url: string }>("acp:login-url", (e) => useStore.setState((st) => ({ login: { ...st.login, url: e.payload.url } }))),
      listen<{ generation: number; backend?: string }>("acp:closed", (e) => s().onClosed(e.payload.generation, e.payload.backend)),
      listen<{ backend: string; status: { kind?: string; label?: string; detail?: string } }>("acp:backend-auth", (e) => s().onBackendAuth(e.payload.backend, e.payload.status)),
      listen<{ method: string; params: unknown }>("acp:notification", (e) => s().onNotification(e.payload.method, e.payload.params)),
      listen<{ stage: string; line: string }>("install:progress", (e) =>
        useStore.setState((st) => ({ install: { ...st.install, lines: [...st.install.lines.slice(-200), e.payload.line] } })),
      ),
      listen<{ settings: Record<string, unknown>; css: string }>("custom:changed", (e) => s().applyCustomization(e.payload)),
      listen<{ cwd: string; done: number; total: number }>("index:progress", (e) =>
        useStore.setState((st) => ({ indexing: { ...st.indexing, [e.payload.cwd]: { done: e.payload.done, total: e.payload.total } } })),
      ),
    ]).then((fns) => {
      if (disposed) fns.forEach((f) => f());
      else unlisten.push(...fns);
    });
    s().connect(true);
    const stopCollab = initCollab();
    api.readCustomization().then((c) => s().applyCustomization({ ...c, settings: { ...c.settings, overrides: undefined } }));
    api.startupProject().then((p) => {
      if (p) s().openProject(p);
    });
    return () => {
      disposed = true;
      unlisten.forEach((f) => f());
      stopCollab();
    };
  }, []);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const st = useStore.getState();
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "k") st.set({ paletteOpen: !st.paletteOpen });
      else if (key === "n") st.newDraft();
      else if (key === ",") st.setView(st.view === "settings" ? "chat" : "settings");
      else if (key === "b") st.set({ sidebarOpen: !st.sidebarOpen });
      else if (key === "j") st.togglePanel();
      else if (key === "`" || key === "ö" || key === "dead") st.set({ terminalOpen: !st.terminalOpen });
      else if (key === "w" && st.activeSessionId) st.closeTab(st.focusedPane, st.activeSessionId);
      else if (key === "\\") st.splitWith(st.activeSessionId);
      else if (key === "tab") {
        const pane = st.panes[st.focusedPane];
        if (!pane?.tabs.length) return;
        const i = pane.active ? pane.tabs.indexOf(pane.active) : -1;
        const next = pane.tabs[(i + (e.shiftKey ? -1 : 1) + pane.tabs.length) % pane.tabs.length];
        st.openTab(next, st.focusedPane);
      }
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Hinweis, wenn Mistral seit dem letzten Start neue Modelle anbietet. */
function NewModelsBanner() {
  const models = useStore((s) => s.newModels);
  const [busy, setBusy] = useState(false);
  if (!models.length) return null;
  const dismiss = () => useStore.setState({ newModels: [] });
  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-[0.88em] fade-in">
      <Sparkles className="h-4 w-4 shrink-0 text-accent" />
      <span className="min-w-0 flex-1">
        <b>{models.length === 1 ? "Neues Modell" : `${models.length} neue Modelle`} bei Mistral:</b> {models.map((m) => m.id).join(", ")}
      </span>
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          for (const m of models) await api.addModel(m.id).catch(() => {});
          dismiss();
          const project = useStore.getState().activeProject;
          if (project) useStore.getState().resetPrepared(project);
        }}
      >
        Hinzufügen
      </Button>
      <button className="text-muted hover:text-fg" onClick={dismiss}>
        Später
      </button>
    </div>
  );
}

function Workspace() {
  const project = useStore((s) => s.activeProject);
  const session = useActiveSession();
  const error = useStore((s) => s.error);
  const set = useStore((s) => s.set);
  const phase = useStore((s) => s.phase);
  const prepare = useStore((s) => s.prepare);
  const panes = useStore((s) => s.panes);

  useEffect(() => {
    if (project && !session && phase === "ready") prepare(project);
  }, [project, session, phase, prepare]);

  // Beim ersten Mal durch die App führen.
  useEffect(() => {
    const st = useStore.getState();
    if (project && phase === "ready" && !st.prefs.tourDone && st.tourStep == null) {
      const t = setTimeout(() => useStore.setState({ tourStep: 0 }), 900);
      return () => clearTimeout(t);
    }
  }, [project, phase]);

  if (!project) return <NoProject />;
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header session={session} />
        {error && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[0.88em] text-bad">
            <span className="flex-1 selectable">{error}</span>
            <button onClick={() => set({ error: undefined })}>×</button>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          {panes.map((_, i) => (
            <PaneView key={i} index={i} project={project} last={i === panes.length - 1} />
          ))}
        </div>
        <TerminalPanel cwd={session?.cwd ?? project} />
      </div>
      <SidePanel session={session} />
    </div>
  );
}

/** Ein Bereich: Tabs, Konversation (oder Startseite) und eigener Composer. */
function PaneView({ index, project, last }: { index: number; project: string; last: boolean }) {
  const pane = useStore((s) => s.panes[index]);
  const multiple = useStore((s) => s.panes.length > 1);
  const session = useStore((s) => (pane?.active ? s.sessions[pane.active] : undefined));
  const focusPane = useStore((s) => s.focusPane);
  const focused = useStore((s) => s.focusedPane === index);
  const pending = session?.pending[0];
  const showTabs = multiple || (pane?.tabs.length ?? 0) > 0;
  return (
    <div className={clsx("flex min-w-0 flex-1 flex-col", !last && "border-r border-line")} onMouseDownCapture={() => focusPane(index)} onFocusCapture={() => focusPane(index)}>
      {showTabs && <TabBar index={index} />}
      {session ? <Conversation session={session} /> : <DraftHero project={project} />}
      <div className="mx-auto w-full max-w-[820px] px-6 pb-5">
        {index === 0 && <NewModelsBanner />}
        {session && <TaskStrip session={session} />}
        {session?.guest ? <GuestPane session={session} /> : session && pending ? <PermissionPrompt session={session} pending={pending} /> : <Composer session={session} project={session?.cwd ?? project} focused={focused} />}
      </div>
    </div>
  );
}

export default function App() {
  const phase = useStore((s) => s.phase);
  const view = useStore((s) => s.view);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  useBackend();
  useShortcuts();

  return (
    <TooltipProvider>
      {phase !== "ready" ? (
        <StartScreen />
      ) : (
        <div className="flex h-full">
          {sidebarOpen && <Sidebar />}
          {view === "settings" ? <SettingsView /> : <Workspace />}
        </div>
      )}
      <CommandPalette />
      <NewProjectDialog />
      <TextPrompt />
      <ShareDialog />
      <JoinDialog />
      <TeamDialog />
      <Tour />
    </TooltipProvider>
  );
}
