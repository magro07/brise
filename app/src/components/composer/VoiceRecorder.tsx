import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, X } from "lucide-react";
import { useStore } from "../../lib/store";

const BARS = 56;

/** Laufende Pegelbalken: echte Lautstärke vom Mikrofon, sonst sanftes Atmen. */
function Wave() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const levels: number[] = new Array(BARS).fill(0);
    let target = 0;
    let current = 0;
    let real = false;
    let raf = 0;
    let unlisten: (() => void) | undefined;
    listen<{ level: number }>("voice:level", (e) => {
      real = true;
      target = e.payload.level;
    }).then((f) => (unlisten = f));

    let tick = 0;
    const draw = () => {
      const el = canvas.current;
      if (!el) return;
      const ctx = el.getContext("2d")!;
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== w * dpr) {
        el.width = w * dpr;
        el.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      tick++;
      // Weich nachziehen; ohne echtes Signal leicht „atmen“.
      const goal = real ? target : 0.12 + Math.sin(tick / 18) * 0.06;
      current += (goal - current) * 0.35;
      if (tick % 2 === 0) {
        levels.shift();
        levels.push(Math.max(0.04, Math.min(1, current * (0.75 + Math.random() * 0.5))));
      }
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3d6ef0";
      const gap = 3;
      const bw = Math.max(2, (w - gap * (BARS - 1)) / BARS);
      levels.forEach((lv, i) => {
        const bh = Math.max(3, lv * h);
        const x = i * (bw + gap);
        ctx.globalAlpha = 0.25 + 0.75 * (i / BARS);
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.roundRect(x, (h - bh) / 2, bw, bh, bw / 2);
        ctx.fill();
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      unlisten?.();
    };
  }, []);
  return <canvas ref={canvas} className="h-10 w-full" />;
}

/** Transkript, bei dem neue Wörter weich einblenden. */
function LiveText({ text }: { text: string }) {
  const words = text.split(/(\s+)/);
  const seen = useRef(0);
  const start = seen.current;
  useEffect(() => {
    seen.current = words.length;
  });
  if (!text.trim()) return <span className="shimmer-text">Ich höre zu … sprich einfach los.</span>;
  return (
    <span>
      {words.map((w, i) => (
        <span key={i} className={i >= start ? "word-in" : undefined}>
          {w}
        </span>
      ))}
      <span className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] animate-pulse bg-accent" />
    </span>
  );
}

export function VoiceRecorder({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const transcript = useStore((s) => s.transcript);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const mm = String(Math.floor(seconds / 60)).padStart(1, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return (
    <div className="px-4 pb-1 pt-3 fade-in">
      <div className="flex items-center gap-3">
        <span className="relative flex h-3 w-3 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bad opacity-60" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-bad" />
        </span>
        <span className="w-10 shrink-0 font-mono text-[0.82em] tabular-nums text-muted">
          {mm}:{ss}
        </span>
        <div className="min-w-0 flex-1">
          <Wave />
        </div>
        <button onClick={onCancel} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg" title="Verwerfen (Esc)">
          <X className="h-4 w-4" />
        </button>
        <button onClick={onDone} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg hover:brightness-110" title="Übernehmen">
          <Check className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-2 min-h-[1.6em] text-[1.02em] leading-relaxed selectable">
        <LiveText text={transcript} />
      </div>
    </div>
  );
}
