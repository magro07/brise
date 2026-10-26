import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Maximize2 } from "lucide-react";
import { DEVICE_HEIGHT, DEVICE_WIDTH, buildPreview, entries, type Device } from "../../lib/design";
import { Button, Spinner, clsx } from "../ui";
import { useDesign } from "./designStore";

/** Ein isoliertes iframe mit dem zusammengesetzten Design, auf die verfügbare Breite skaliert. */
export function PreviewFrame({
  base,
  entry,
  device,
  css,
  compact,
  pickable = true,
}: {
  /** Ordner relativ zum Design-Root, z. B. `d-…` oder `d-…/.versions/3`. */
  base: string;
  entry: string;
  device: Device;
  css: string;
  compact?: boolean;
  pickable?: boolean;
}) {
  const rev = useDesign((s) => s.rev);
  const theme = useDesign((s) => s.theme);
  const picking = useDesign((s) => s.picking && pickable);
  const picked = useDesign((s) => s.picked);
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    let stale = false;
    buildPreview(base, entry, css, themeRef.current)
      .then((h) => !stale && (setHtml(h), setError(null)))
      .catch((e) => !stale && setError(String(e)));
    return () => {
      stale = true;
    };
  }, [base, entry, css, rev]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const post = (m: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ __brise: 1, ...m }, "*");
  useEffect(() => post({ type: "theme", theme }), [theme]);
  useEffect(() => post({ type: "pick", on: picking }), [picking]);
  useEffect(() => {
    if (!picked) post({ type: "clear" });
  }, [picked]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data?.__brise) return;
      const d = e.data;
      if (d.type === "ready") {
        post({ type: "theme", theme: themeRef.current });
        post({ type: "pick", on: useDesign.getState().picking && pickable });
      } else if (d.type === "pick") {
        useDesign.setState({ picked: { entry, selector: d.selector, tag: d.tag, text: d.text, html: d.html }, picking: false });
      } else if (d.type === "error") {
        useDesign.setState((s) => ({ previewErrors: [...s.previewErrors.slice(-4), String(d.message)] }));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [entry, pickable]);

  const pad = compact ? 0 : 24;
  const fill = device === "desktop";
  const width = fill ? Math.max(size.w - pad * 2, compact ? 1280 : 1024) : DEVICE_WIDTH[device];
  const scale = Math.min(1, (size.w - pad * 2) / width);
  const height = fill || compact ? (size.h - pad * 2) / scale : Math.min(DEVICE_HEIGHT[device], (size.h - pad * 2) / scale);

  return (
    <div ref={box} className={clsx("relative min-h-0 flex-1 overflow-hidden", !compact && "bg-[repeating-conic-gradient(var(--hover)_0%_25%,transparent_0%_50%)] [background-size:18px_18px]")}>
      {error ? (
        <div className="m-6 flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[0.88em] text-bad">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="selectable">{error}</span>
        </div>
      ) : html == null ? (
        <div className="flex h-full items-center justify-center text-muted">
          <Spinner />
        </div>
      ) : (
        <div
          className={clsx("absolute left-1/2 origin-top overflow-hidden bg-white", !fill && !compact && "rounded-[22px] border border-line-strong shadow-pop", fill && !compact && "rounded-lg border border-line shadow-soft")}
          style={{ width, height, top: pad, transform: `translateX(-50%) scale(${scale})`, transformOrigin: "top center" }}
        >
          <iframe
            ref={frame}
            title={entry}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            srcDoc={html}
            className="h-full w-full border-0"
            onLoad={() => post({ type: "theme", theme: themeRef.current })}
          />
        </div>
      )}
    </div>
  );
}

/** Varianten (und Hauptdesign) nebeneinander vergleichen. */
export function CompareGrid({ css }: { css: string }) {
  const files = useDesign((s) => s.files);
  const activeId = useDesign((s) => s.activeId)!;
  const device = useDesign((s) => s.device);
  const current = useDesign((s) => s.entry);
  const { promote, set } = useDesign.getState();
  const list = entries(files);
  if (list.length < 2)
    return <div className="flex flex-1 items-center justify-center text-muted">Noch keine Varianten – wähle im Chat „Varianten: 3“ und beschreibe, was entstehen soll.</div>;
  return (
    <div className="grid min-h-0 flex-1 gap-3 overflow-auto p-3" style={{ gridTemplateColumns: `repeat(${Math.min(list.length, 3)}, minmax(260px, 1fr))` }}>
      {list.map((e) => (
        <div key={e.entry} className={clsx("flex min-h-[420px] flex-col overflow-hidden rounded-xl border bg-elev", e.entry === current ? "border-accent" : "border-line")}>
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
            <span className="font-medium">{e.name}</span>
            <span className="truncate font-mono text-[0.76em] text-muted">{e.entry}</span>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => set({ entry: e.entry, mode: { kind: "single" } })} title="Groß anzeigen">
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
            {e.entry.startsWith("variants/") && (
              <Button size="sm" onClick={() => promote(e.entry)} title="Diese Variante wird zum Hauptdesign">
                <Check className="h-3.5 w-3.5" /> Übernehmen
              </Button>
            )}
          </div>
          <PreviewFrame base={activeId} entry={e.entry} device={device} css={css} compact pickable={false} />
        </div>
      ))}
    </div>
  );
}
