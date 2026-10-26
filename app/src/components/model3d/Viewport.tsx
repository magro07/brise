import { useEffect, useRef, useState } from "react";
import { Box } from "lucide-react";
import { useStore } from "../../lib/store";
import { formatMm, type ModelInfo, type PickedPart } from "../../lib/model3d";
import { Viewer, parseModel, webglAvailable } from "./viewer3d";

export interface ViewportHandle {
  screenshot(width?: number, height?: number): string;
  view(dir: "front" | "top" | "right" | "iso"): void;
  frame(): void;
}

interface Props {
  /** Einstiegsdatei (für Auswahl und Kamera). */
  entry: string;
  bytes: ArrayBuffer | null;
  ext: string;
  /** Ändert sich der Zähler, lädt der Viewer neu und behält die Kamera. */
  n: number;
  wireframe: boolean;
  bbox: boolean;
  grid: boolean;
  zUp: boolean;
  picking?: boolean;
  compact?: boolean;
  onPick?: (p: PickedPart | null) => void;
  /** Nach dem Laden: Maße und Screenshot (für preview.png). */
  onLoaded?: (info: ModelInfo | null, shot: () => string) => void;
  handle?: (h: ViewportHandle | null) => void;
}

const dark = () => document.documentElement.dataset.theme === "dark";

/** Eingebetteter three.js-Viewer für eine Modelldatei. */
export function Viewport(p: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const theme = useStore((s) => s.prefs.theme);
  const latest = useRef(p);
  latest.current = p;

  useEffect(() => {
    if (!host.current) return;
    if (!webglAvailable()) {
      setError("WebGL ist in dieser Umgebung nicht verfügbar – die Vorschau fehlt, Dateien und Export funktionieren weiter.");
      return;
    }
    try {
      const v = new Viewer(host.current);
      viewer.current = v;
      v.onPick = (x) => latest.current.onPick?.(x);
      p.handle?.({ screenshot: (w, h) => v.screenshot(w, h), view: (d) => v.view(d), frame: () => v.frame() });
    } catch (e) {
      setError(`3D-Vorschau konnte nicht starten: ${e}`);
    }
    return () => {
      p.handle?.(null);
      viewer.current?.dispose();
      viewer.current = null;
    };
  }, []);

  const loaded = useRef<{ entry: string; n: number } | null>(null);
  useEffect(() => {
    const v = viewer.current;
    if (!v || !p.bytes) return;
    let cancelled = false;
    const keep = loaded.current?.entry === p.entry;
    // Bytes kopieren: der Loader darf den Puffer im Store nicht verändern.
    parseModel(p.bytes.slice(0), p.ext)
      .then((obj) => {
        if (cancelled) return;
        v.entry = p.entry;
        v.show(obj, keep);
        loaded.current = { entry: p.entry, n: p.n };
        setError(null);
        const i = v.info();
        setInfo(i);
        latest.current.onLoaded?.(i, () => v.screenshot(960, 720));
      })
      .catch((e) => !cancelled && setError(`${p.entry}: ${e instanceof Error ? e.message : e}`));
    return () => {
      cancelled = true;
    };
  }, [p.bytes, p.n, p.entry]);

  useEffect(() => {
    viewer.current?.setOptions({ wireframe: p.wireframe, bbox: p.bbox, grid: p.grid, zUp: p.zUp, dark: dark() });
    const v = viewer.current;
    if (v && v.bounds() && p.bytes) setInfo(v.info());
  }, [p.wireframe, p.bbox, p.grid, p.zUp, theme]);

  useEffect(() => {
    if (viewer.current) {
      viewer.current.picking = !!p.picking;
      if (!p.picking) viewer.current.setHighlight(null);
    }
  }, [p.picking]);

  return (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-[radial-gradient(ellipse_at_center,var(--panel),var(--bg))]" data-brise="model-viewport">
      <div ref={host} className={p.picking ? "absolute inset-0 cursor-crosshair" : "absolute inset-0"} />
      {!p.bytes && !error && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted">
          <Box className="h-8 w-8" />
          <span className="text-[0.9em]">Noch nichts zu sehen.</span>
        </div>
      )}
      {error && <div className="absolute inset-x-3 top-3 rounded-lg bg-bad-soft px-3 py-2 text-[0.84em] text-bad selectable">{error}</div>}
      {info && p.bbox && !p.compact && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-elev/90 px-2 py-1 font-mono text-[0.78em] text-fg-2 shadow-soft">
          {info.size.map(formatMm).join(" × ")} mm · {info.triangles.toLocaleString("de-DE")} Dreiecke · {info.parts.length} {info.parts.length === 1 ? "Teil" : "Teile"}
        </div>
      )}
    </div>
  );
}
