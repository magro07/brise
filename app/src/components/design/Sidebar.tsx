import { useEffect } from "react";
import { Box, Code2, Palette, Pencil, Sparkles, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { relativeTime } from "../../lib/format";
import { askText, confirmAction } from "../../lib/dialogs";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, clsx } from "../ui";
import { useDesign } from "./designStore";
import { newDesign } from "./DesignView";
import { ProjectGroups } from "../workbench/parts";

/** Umschalter zwischen Coding-Sessions, Design- und 3D-Modus. */
export function ModeSwitch() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const current = view === "design" || view === "3d" ? view : "chat";
  return (
    <div className="mx-2 mt-3 flex h-8 items-center rounded-lg bg-hover p-0.5" data-tour="mode-switch">
      {(
        [
          { id: "chat", label: "Code", icon: Code2 },
          { id: "design", label: "Design", icon: Palette },
          { id: "3d", label: "3D", icon: Box },
        ] as const
      ).map((m) => (
        <button
          key={m.id}
          onClick={() => setView(m.id)}
          className={clsx(
            "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[0.9em]",
            current === m.id ? "bg-elev font-medium text-fg shadow-soft" : "text-muted hover:text-fg",
          )}
        >
          <m.icon className="h-3.5 w-3.5" /> {m.label}
        </button>
      ))}
    </div>
  );
}

/** Liste der Designs für die Seitenleiste im Design-Modus. */
export function DesignList() {
  const designs = useDesign((s) => s.designs);
  const activeId = useDesign((s) => s.activeId);
  const ready = useDesign((s) => s.ready);
  const sessions = useStore((s) => s.sessions);
  useEffect(() => {
    useDesign.getState().init().catch(() => {});
  }, []);
  return (
    <>
      <div className="mt-3 flex items-center px-4 pb-1 text-[0.78em] font-medium uppercase tracking-wide text-muted">
        <span className="flex-1">Designs</span>
        <button className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" aria-label="Neues Design" onClick={() => newDesign()}>
          <Sparkles className="h-3.5 w-3.5" />
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {ready && designs.length === 0 && (
          <button
            onClick={() => newDesign()}
            className="mt-2 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-muted hover:border-accent hover:text-fg"
          >
            <Palette className="h-5 w-5" />
            <span className="text-[0.9em]">Erstes Design anlegen</span>
          </button>
        )}
        <ProjectGroups
          items={designs}
          render={(d) => {
            const live = d.sessionId ? sessions[d.sessionId] : undefined;
            return <DesignRow key={d.id} id={d.id} name={d.name} active={d.id === activeId} running={!!live?.running} waiting={(live?.pending.length ?? 0) > 0} updated={d.updated} />;
          }}
        />
      </nav>
    </>
  );
}

function DesignRow({ id, name, active, running, waiting, updated }: { id: string; name: string; active: boolean; running: boolean; waiting: boolean; updated: number }) {
  return (
    <div className={clsx("group flex h-8 items-center gap-2 rounded-lg pl-2 pr-1 text-[0.92em] text-fg-2 hover:bg-hover", active && "bg-active text-fg")}>
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => useDesign.getState().open(id)}>
        {running && !waiting ? (
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
        ) : waiting ? (
          <span className="h-2 w-2 shrink-0 rounded-full bg-warn pulse-dot" title="Wartet auf Freigabe" />
        ) : (
          <Palette className="h-3.5 w-3.5 shrink-0 text-muted" />
        )}
        <span className="truncate">{name}</span>
      </button>
      <span className="text-[0.78em] text-muted group-hover:hidden">{relativeTime(new Date(updated).toISOString())}</span>
      <Menu>
        <MenuTrigger asChild>
          <button className="hidden h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-active hover:text-fg group-hover:flex" aria-label="Designmenü">
            <Pencil className="h-3 w-3" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem
            icon={<Pencil />}
            onSelect={async () => {
              const n = await askText("Neuer Name", name);
              if (n) useDesign.getState().rename(id, n);
            }}
          >
            Umbenennen
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<X />}
            danger
            onSelect={async () => {
              if (await confirmAction(`Design „${name}“ mit allen Versionen löschen?`, true)) useDesign.getState().remove(id);
            }}
          >
            Löschen
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
