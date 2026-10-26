import { useEffect, useRef, useState } from "react";
import { shortcut } from "../../lib/platform";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { Plus, SquareTerminal, X } from "lucide-react";
import { api } from "../../lib/acp";
import { basename, useStore } from "../../lib/store";
import { IconButton, clsx } from "../ui";

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function theme() {
  const dark = document.documentElement.dataset.theme === "dark";
  return {
    background: cssVar("--panel"),
    foreground: cssVar("--fg"),
    cursor: cssVar("--accent"),
    selectionBackground: dark ? "#3a4a6a" : "#cddcfb",
    black: dark ? "#2a2a28" : "#1d1c1a",
    brightBlack: "#85827b",
  };
}

/** Ein Terminal-Tab: xterm.js an ein PTY im Backend gekoppelt. */
function TermView({ cwd, visible, onExit, onTitle }: { cwd: string; visible: boolean; onExit: () => void; onTitle: (t: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const term = useRef<XTerm | null>(null);
  const id = useRef<number | null>(null);

  useEffect(() => {
    const xterm = new XTerm({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: theme(),
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new WebLinksAddon((_, uri) => openUrl(uri)));
    xterm.open(box.current!);
    fitAddon.fit();
    term.current = xterm;
    fit.current = fitAddon;

    let disposed = false;
    const unlisten: (() => void)[] = [];
    (async () => {
      const termId = await api.termOpen(cwd, xterm.cols, xterm.rows);
      if (disposed) return api.termClose(termId);
      id.current = termId;
      unlisten.push(await listen<{ id: number; data: string }>("term:data", (e) => e.payload.id === termId && xterm.write(e.payload.data)));
      unlisten.push(await listen<{ id: number }>("term:exit", (e) => e.payload.id === termId && onExit()));
    })();
    const input = xterm.onData((d) => id.current && api.termWrite(id.current, d));
    const title = xterm.onTitleChange(onTitle);
    const resize = xterm.onResize(({ cols, rows }) => id.current && api.termResize(id.current, cols, rows));
    // Farben mitziehen, wenn das Theme wechselt.
    const observer = new MutationObserver(() => (xterm.options.theme = theme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      title.dispose();
      resize.dispose();
      unlisten.forEach((f) => f());
      if (id.current) api.termClose(id.current);
      xterm.dispose();
    };
  }, [cwd]);

  useEffect(() => {
    if (!visible) return;
    const el = box.current!;
    const ro = new ResizeObserver(() => {
      try {
        fit.current?.fit();
      } catch {
        /* während des Ausblendens */
      }
    });
    ro.observe(el);
    term.current?.focus();
    return () => ro.disconnect();
  }, [visible]);

  return <div ref={box} className={clsx("h-full w-full px-2 pt-1", !visible && "hidden")} />;
}

interface Tab {
  key: number;
  title: string;
}

let tabCounter = 0;

/** Terminal-Bereich unter dem Chat (Strg+ö / Strg+`). */
export function TerminalPanel({ cwd }: { cwd: string }) {
  const open = useStore((s) => s.terminalOpen);
  const set = useStore((s) => s.set);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [height, setHeight] = useState(280);

  const add = () => {
    const key = ++tabCounter;
    setTabs((t) => [...t, { key, title: basename(cwd) }]);
    setActive(key);
  };
  const close = (key: number) => {
    setTabs((t) => {
      const rest = t.filter((x) => x.key !== key);
      if (active === key) setActive(rest[rest.length - 1]?.key ?? null);
      if (!rest.length) set({ terminalOpen: false });
      return rest;
    });
  };

  useEffect(() => {
    if (open && tabs.length === 0) add();
  }, [open]);

  if (!tabs.length) return null;
  return (
    <div data-brise="terminal" className={clsx("flex shrink-0 flex-col border-t border-line bg-panel", !open && "hidden")} style={{ height }}>
      <div
        className="h-1 cursor-row-resize hover:bg-accent/40"
        onMouseDown={(e) => {
          const startY = e.clientY;
          const startH = height;
          const move = (ev: MouseEvent) => setHeight(Math.min(700, Math.max(120, startH + startY - ev.clientY)));
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }}
      />
      <div className="flex h-8 items-center gap-1 px-2">
        <SquareTerminal className="mx-1 h-3.5 w-3.5 text-muted" />
        {tabs.map((t) => (
          <div
            key={t.key}
            className={clsx("group flex h-6 items-center gap-1 rounded-md pl-2 pr-1 text-[0.82em]", active === t.key ? "bg-active text-fg" : "text-muted hover:bg-hover")}
          >
            <button onClick={() => setActive(t.key)} className="max-w-[160px] truncate">
              {t.title}
            </button>
            <button className="opacity-0 hover:text-fg group-hover:opacity-100" onClick={() => close(t.key)} aria-label="Terminal schließen">
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <IconButton label="Neues Terminal" size="sm" onClick={add}>
          <Plus className="h-3.5 w-3.5" />
        </IconButton>
        <div className="flex-1" />
        <IconButton label={`Ausblenden (${shortcut("`")})`} size="sm" onClick={() => set({ terminalOpen: false })}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">
        {tabs.map((t) => (
          <TermView
            key={t.key}
            cwd={cwd}
            visible={open && active === t.key}
            onExit={() => close(t.key)}
            onTitle={(title) => setTabs((all) => all.map((x) => (x.key === t.key ? { ...x, title: title || x.title } : x)))}
          />
        ))}
      </div>
    </div>
  );
}
