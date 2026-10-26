import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type PermissionRequest } from "./lib/acp";
import { useActiveSession, useStore } from "./lib/store";
import { TooltipProvider } from "./components/ui";
import { Sidebar } from "./components/layout/Sidebar";
import { Header } from "./components/layout/Header";
import { CommandPalette } from "./components/layout/CommandPalette";
import { Conversation } from "./components/chat/Conversation";
import { Composer } from "./components/composer/Composer";
import { PermissionPrompt, TaskStrip } from "./components/composer/Pinned";
import { SidePanel } from "./components/panels/SidePanel";
import { SettingsView } from "./components/settings/Settings";
import { DraftHero, NoProject, StartScreen } from "./components/screens/Screens";

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
      listen<{ generation: number }>("acp:closed", (e) => s().onClosed(e.payload.generation)),
    ]).then((fns) => {
      if (disposed) fns.forEach((f) => f());
      else unlisten.push(...fns);
    });
    s().connect(true);
    api.startupProject().then((p) => {
      if (p) s().openProject(p);
    });
    return () => {
      disposed = true;
      unlisten.forEach((f) => f());
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
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function Workspace() {
  const project = useStore((s) => s.activeProject);
  const session = useActiveSession();
  const error = useStore((s) => s.error);
  const set = useStore((s) => s.set);
  const phase = useStore((s) => s.phase);
  const prepare = useStore((s) => s.prepare);

  useEffect(() => {
    if (project && !session && phase === "ready") prepare(project);
  }, [project, session, phase, prepare]);

  if (!project) return <NoProject />;
  const pending = session?.pending[0];
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header session={session} />
        {session ? <Conversation session={session} /> : <DraftHero project={project} />}
        <div className="mx-auto w-full max-w-[820px] px-6 pb-5">
          {error && (
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[0.88em] text-bad">
              <span className="flex-1 selectable">{error}</span>
              <button onClick={() => set({ error: undefined })}>×</button>
            </div>
          )}
          {session && <TaskStrip session={session} />}
          {session && pending ? <PermissionPrompt session={session} pending={pending} /> : <Composer session={session} project={session?.cwd ?? project} />}
        </div>
      </div>
      <SidePanel session={session} />
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
    </TooltipProvider>
  );
}
