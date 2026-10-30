import { Box, House, Palette, Search, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { shortcut } from "../../lib/platform";
import { useStore } from "../../lib/store";
import { Tip, clsx } from "../ui";
import { AccountMenu } from "./Sidebar";

function RailButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tip label={label} side="right">
      <button
        aria-label={label}
        onClick={onClick}
        className={clsx("flex h-9 w-9 items-center justify-center rounded-lg transition-colors", active ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg")}
      >
        {children}
      </button>
    </Tip>
  );
}

/** Schmale Leiste ganz links: Bereiche, Suche, Einstellungen, Konto. */
export function Rail() {
  const view = useStore((s) => s.view);
  const simple = useStore((s) => s.prefs.simpleMode);
  const { setView, set } = useStore.getState();
  return (
    <nav data-brise="rail" className="flex w-12 shrink-0 flex-col items-center gap-1 py-2" data-tauri-drag-region>
      <RailButton label="Code" active={view === "chat"} onClick={() => setView("chat")}>
        <House className="h-[18px] w-[18px]" />
      </RailButton>
      {!simple && (
        <>
          <RailButton label="Design" active={view === "design"} onClick={() => setView("design")}>
            <Palette className="h-[18px] w-[18px]" />
          </RailButton>
          <RailButton label="3D" active={view === "3d"} onClick={() => setView("3d")}>
            <Box className="h-[18px] w-[18px]" />
          </RailButton>
        </>
      )}
      <RailButton label={`Suchen und Befehle (${shortcut("K")})`} onClick={() => set({ paletteOpen: true })}>
        <Search className="h-[18px] w-[18px]" />
      </RailButton>
      <div className="flex-1" data-tauri-drag-region />
      <div data-tour="settings">
        <RailButton label={`Einstellungen (${shortcut(",")})`} active={view === "settings"} onClick={() => setView(view === "settings" ? "chat" : "settings")}>
          <Settings className="h-[18px] w-[18px]" />
        </RailButton>
      </div>
      <AccountMenu />
    </nav>
  );
}
