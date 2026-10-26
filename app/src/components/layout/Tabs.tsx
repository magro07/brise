import { Columns2, MoreHorizontal, Plus, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { BackendBadge } from "../agents/BackendPicker";
import { IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Spinner, clsx } from "../ui";

/** Tab-Leiste eines Bereichs: offene Sessions mit Status. */
export function TabBar({ index }: { index: number }) {
  const pane = useStore((s) => s.panes[index]);
  const panes = useStore((s) => s.panes.length);
  const focused = useStore((s) => s.focusedPane === index);
  const sessions = useStore((s) => s.sessions);
  const { openTab, closeTab, splitWith, newDraft, focusPane } = useStore.getState();
  if (!pane) return null;

  return (
    <div className={clsx("flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line px-2", focused && panes > 1 && "bg-accent-soft/40")}>
      {pane.tabs.map((id) => {
        const s = sessions[id];
        const active = pane.active === id;
        const waiting = (s?.pending.length ?? 0) > 0;
        return (
          <div
            key={id}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(index, id);
              }
            }}
            className={clsx(
              "group relative flex h-8 min-w-[120px] max-w-[220px] shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 pl-2.5 pr-1 text-[0.84em]",
              active ? "border-line bg-bg text-fg" : "border-transparent text-muted hover:bg-hover hover:text-fg",
            )}
          >
            {active && focused && <span className="absolute inset-x-2 top-0 h-[2px] rounded-full bg-accent" />}
            <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => openTab(id, index)} title={s?.title}>
              {waiting ? (
                <span className="h-2 w-2 shrink-0 rounded-full bg-warn pulse-dot" title="Wartet auf Freigabe" />
              ) : s?.running ? (
                <Spinner className="h-3 w-3 shrink-0 text-accent" />
              ) : null}
              <span className="truncate">{s?.title ?? "Session"}</span>
              {s && <BackendBadge backend={s.backend} />}
            </button>
            <Menu>
              <MenuTrigger asChild>
                <button className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-active hover:text-fg group-hover:flex" aria-label="Tab-Menü">
                  <MoreHorizontal className="h-3 w-3" />
                </button>
              </MenuTrigger>
              <MenuContent align="end">
                {panes < 3 && (
                  <MenuItem
                    icon={<Columns2 />}
                    onSelect={() => {
                      closeTab(index, id);
                      splitWith(id);
                    }}
                  >
                    Rechts daneben öffnen
                  </MenuItem>
                )}
                {panes > 1 &&
                  Array.from({ length: panes }, (_, n) => n)
                    .filter((n) => n !== index)
                    .map((n) => (
                      <MenuItem
                        key={n}
                        onSelect={() => {
                          closeTab(index, id);
                          openTab(id, n > index && panes > useStore.getState().panes.length ? n - 1 : n);
                        }}
                      >
                        In Bereich {n + 1} verschieben
                      </MenuItem>
                    ))}
                <MenuSeparator />
                <MenuItem
                  onSelect={() => {
                    for (const other of pane.tabs) if (other !== id) closeTab(index, other);
                  }}
                >
                  Andere Tabs schließen
                </MenuItem>
              </MenuContent>
            </Menu>
            <button className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 hover:bg-active hover:text-fg group-hover:opacity-100" onClick={() => closeTab(index, id)} aria-label="Tab schließen">
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <div className="flex h-8 items-center">
        <IconButton
          label="Neue Session in diesem Bereich"
          size="sm"
          onClick={() => {
            focusPane(index);
            newDraft();
            useStore.setState((s) => ({ panes: s.panes.map((p, n) => (n === index ? { ...p, active: null } : p)) }));
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </IconButton>
        {panes < 3 && (
          <IconButton label="Neuen Bereich rechts öffnen" size="sm" onClick={() => splitWith(null)}>
            <Columns2 className="h-3.5 w-3.5" />
          </IconButton>
        )}
        {panes > 1 && (
          <IconButton
            label="Bereich schließen"
            size="sm"
            onClick={() => {
              for (const t of [...pane.tabs]) closeTab(index, t);
              if (useStore.getState().panes.length > 1 && useStore.getState().panes[index]?.tabs.length === 0) {
                useStore.setState((s) => {
                  const p = s.panes.filter((_, n) => n !== index);
                  return { panes: p, focusedPane: Math.min(s.focusedPane, p.length - 1) };
                });
              }
            }}
          >
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
    </div>
  );
}
