import { useEffect } from "react";
import { Box, Pencil, Sparkles, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { relativeTime } from "../../lib/format";
import { askText, confirmAction } from "../../lib/dialogs";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, clsx } from "../ui";
import { useModel } from "./modelStore";
import { ProjectGroups, askNewWork } from "../workbench/parts";

/** Liste der 3D-Modelle für die Seitenleiste im 3D-Modus. */
export function ModelList() {
  const models = useModel((s) => s.models);
  const activeId = useModel((s) => s.activeId);
  const ready = useModel((s) => s.ready);
  const sessions = useStore((s) => s.sessions);
  useEffect(() => {
    useModel.getState().init().catch(() => {});
  }, []);
  return (
    <>
      <div className="mt-3 flex items-center px-4 pb-1 text-[0.78em] font-medium uppercase tracking-wide text-muted">
        <span className="flex-1">3D-Modelle</span>
        <button className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" aria-label="Neues Modell" onClick={() => newModel()}>
          <Sparkles className="h-3.5 w-3.5" />
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {ready && models.length === 0 && (
          <button
            onClick={() => newModel()}
            className="mt-2 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-muted hover:border-accent hover:text-fg"
          >
            <Box className="h-5 w-5" />
            <span className="text-[0.9em]">Erstes Modell anlegen</span>
          </button>
        )}
        <ProjectGroups items={models} render={(m) => {
          const live = m.sessionId ? sessions[m.sessionId] : undefined;
          const running = !!live?.running;
          const waiting = (live?.pending.length ?? 0) > 0;
          return (
            <div key={m.id} className={clsx("group flex h-8 items-center gap-2 rounded-lg pl-2 pr-1 text-[0.92em] text-fg-2 hover:bg-hover", m.id === activeId && "bg-active text-fg")}>
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => useModel.getState().open(m.id)}>
                {running && !waiting ? (
                  <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
                ) : waiting ? (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-warn pulse-dot" title="Wartet auf Freigabe" />
                ) : (
                  <Box className="h-3.5 w-3.5 shrink-0 text-muted" />
                )}
                <span className="truncate">{m.name}</span>
              </button>
              <span className="text-[0.78em] text-muted group-hover:hidden">{relativeTime(new Date(m.updated).toISOString())}</span>
              <Menu>
                <MenuTrigger asChild>
                  <button className="hidden h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-active hover:text-fg group-hover:flex" aria-label="Modellmenü">
                    <Pencil className="h-3 w-3" />
                  </button>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem
                    icon={<Pencil />}
                    onSelect={async () => {
                      const n = await askText("Neuer Name", m.name);
                      if (n) useModel.getState().rename(m.id, n);
                    }}
                  >
                    Umbenennen
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    icon={<X />}
                    danger
                    onSelect={async () => {
                      if (await confirmAction(`Modell „${m.name}“ mit allen Versionen löschen?`, true)) useModel.getState().remove(m.id);
                    }}
                  >
                    Löschen
                  </MenuItem>
                </MenuContent>
              </Menu>
            </div>
          );
        }} />
      </nav>
    </>
  );
}

export async function newModel(prompt?: string, project?: string) {
  const answer = await askNewWork("3d", project);
  if (!answer) return;
  await useModel.getState().init();
  const meta = await useModel.getState().create(answer.name || "Neues Modell", { project: answer.project, backend: answer.backend });
  useStore.getState().setView("3d");
  await useModel.getState().open(meta.id);
  if (prompt) setTimeout(() => useModel.getState().send(prompt, [], 1), 300);
}
