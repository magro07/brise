import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import { FolderOpen, Folder, MessageSquare, Moon, PanelRight, Settings, SquarePen, Sun } from "lucide-react";
import { basename, useStore } from "../../lib/store";
import { relativeTime } from "../../lib/format";
import { pickProject } from "./Sidebar";
import { PANEL_TABS } from "../panels/SidePanel";

function Item({ children, onSelect, icon, hint, value }: { children: React.ReactNode; onSelect: () => void; icon: React.ReactNode; hint?: string; value?: string }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[0.93em] data-[selected=true]:bg-hover"
    >
      <span className="text-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-[0.8em] text-muted">{hint}</span>}
    </Command.Item>
  );
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const index = useStore((s) => s.index);
  const projects = useStore((s) => s.projects);
  const prefs = useStore((s) => s.prefs);
  const { set, newDraft, selectSession, setView, togglePanel, setPrefs, openProject } = useStore.getState();
  const close = () => set({ paletteOpen: false });
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => set({ paletteOpen: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 fade-in" />
        <Dialog.Content className="fixed left-1/2 top-[14%] z-50 w-[min(640px,92vw)] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-elev shadow-pop fade-in">
          <Dialog.Title className="sr-only">Suchen und Befehle</Dialog.Title>
          <Command loop>
            <Command.Input
              autoFocus
              placeholder="Sessions, Projekte oder Befehle suchen …"
              className="h-12 w-full border-b border-line bg-transparent px-4 outline-none placeholder:text-muted"
            />
            <Command.List className="max-h-[420px] overflow-y-auto p-1.5">
              <Command.Empty className="px-4 py-8 text-center text-muted">Nichts gefunden.</Command.Empty>
              <Command.Group heading="Aktionen" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[0.75em] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted">
                <Item icon={<SquarePen />} hint="Strg+N" onSelect={run(() => newDraft())}>
                  Neue Session
                </Item>
                <Item icon={<FolderOpen />} onSelect={run(pickProject)}>
                  Projektordner öffnen …
                </Item>
                <Item icon={<Settings />} hint="Strg+," onSelect={run(() => setView("settings"))}>
                  Einstellungen
                </Item>
                {PANEL_TABS.map((t) => (
                  <Item key={t.id} icon={<PanelRight />} onSelect={run(() => togglePanel(t.id))}>
                    Panel: {t.label}
                  </Item>
                ))}
                <Item
                  icon={prefs.theme === "dark" ? <Sun /> : <Moon />}
                  onSelect={run(() => setPrefs({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" }))}
                >
                  Hell/Dunkel umschalten
                </Item>
              </Command.Group>
              {projects.length > 0 && (
                <Command.Group heading="Projekte" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[0.75em] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted">
                  {projects.map((p) => (
                    <Item key={p} value={`projekt ${p}`} icon={<Folder />} hint={p} onSelect={run(() => openProject(p))}>
                      {basename(p)}
                    </Item>
                  ))}
                </Command.Group>
              )}
              {index.length > 0 && (
                <Command.Group heading="Sessions" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[0.75em] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted">
                  {index.slice(0, 200).map((s) => (
                    <Item
                      key={s.sessionId}
                      value={`${s.title ?? ""} ${basename(s.cwd)} ${s.sessionId}`}
                      icon={<MessageSquare />}
                      hint={`${basename(s.cwd)} · ${relativeTime(s.updatedAt)}`}
                      onSelect={run(() => selectSession(s.sessionId))}
                    >
                      {s.title ?? "Unbenannte Session"}
                    </Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
