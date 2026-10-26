import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderPlus } from "lucide-react";
import { api } from "../../lib/acp";
import { useStore } from "../../lib/store";
import { Button, Switch } from "../ui";

/** Neuen Projektordner anlegen – ohne Dateimanager. */
export function NewProjectDialog() {
  const open = useStore((s) => s.newProjectOpen);
  const set = useStore((s) => s.set);
  const openProject = useStore((s) => s.openProject);
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  const [git, setGit] = useState(true);
  const [readme, setReadme] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && !parent) api.defaultProjectsDir().then(setParent);
    if (open) {
      setName("");
      setError(null);
    }
  }, [open]);

  const sep = parent.includes("\\") ? "\\" : "/";
  const create = async () => {
    try {
      const path = await api.createProject(parent, name.trim(), git, readme);
      set({ newProjectOpen: false });
      openProject(path);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => set({ newProjectOpen: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 fade-in" />
        <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(520px,92vw)] -translate-x-1/2 rounded-2xl border border-line bg-elev p-6 shadow-pop fade-in">
          <Dialog.Title className="flex items-center gap-2 text-[1.15em] font-semibold">
            <FolderPlus className="h-5 w-5 text-accent" /> Neues Projekt
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[0.9em] text-muted">Legt einen Ordner an und öffnet ihn direkt in Brise.</Dialog.Description>

          <label className="mt-5 block text-[0.86em] font-medium">Name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => (setName(e.target.value), setError(null))}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && create()}
            placeholder="mein-projekt"
            className="mt-1 h-10 w-full rounded-lg border border-line bg-bg px-3 outline-none focus:border-accent"
          />

          <label className="mt-4 block text-[0.86em] font-medium">Speicherort</label>
          <div className="mt-1 flex gap-2">
            <div className="flex h-10 min-w-0 flex-1 items-center truncate rounded-lg border border-line bg-panel px-3 font-mono text-[0.84em] text-fg-2" title={parent}>
              {parent}
              {name.trim() && <span className="text-accent">{sep + name.trim()}</span>}
            </div>
            <Button
              onClick={async () => {
                const p = await openDialog({ directory: true, defaultPath: parent, title: "Speicherort wählen" });
                if (typeof p === "string") setParent(p);
              }}
            >
              Ändern
            </Button>
          </div>

          <div className="mt-4 space-y-2.5">
            <label className="flex items-center justify-between gap-4 text-[0.92em]">
              <span>
                Git-Repository anlegen
                <span className="block text-[0.86em] text-muted">Damit lässt sich jede Änderung des Agenten nachvollziehen und rückgängig machen.</span>
              </span>
              <Switch checked={git} onChange={setGit} />
            </label>
            <label className="flex items-center justify-between gap-4 text-[0.92em]">
              <span>README.md anlegen</span>
              <Switch checked={readme} onChange={setReadme} />
            </label>
          </div>

          {error && <div className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-[0.86em] text-bad">{error}</div>}

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => set({ newProjectOpen: false })}>
              Abbrechen
            </Button>
            <Button variant="primary" disabled={!name.trim() || !parent} onClick={create}>
              Anlegen und öffnen
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
