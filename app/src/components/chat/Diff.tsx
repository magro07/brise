import { useMemo, useState } from "react";
import { ChevronRight, FileDiff } from "lucide-react";
import { clsx } from "../ui";

type Line = { kind: "same" | "add" | "del"; text: string; a?: number; b?: number };

const MAX_LINES = 600;

/** Zeilen-Diff per LCS – reicht für die Änderungen eines Edits. */
export function diffLines(oldText: string, newText: string): Line[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map((text, i) => ({ kind: "del" as const, text, a: i + 1 })), ...b.map((text, i) => ({ kind: "add" as const, text, b: i + 1 }))];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push({ kind: "same", text: a[i], a: ++i, b: ++j });
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: "del", text: a[i], a: ++i });
    else out.push({ kind: "add", text: b[j], b: ++j });
  }
  while (i < a.length) out.push({ kind: "del", text: a[i], a: ++i });
  while (j < b.length) out.push({ kind: "add", text: b[j], b: ++j });
  return out;
}

function withContext(lines: Line[], context = 3): (Line | null)[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, n) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, n - context); k <= Math.min(lines.length - 1, n + context); k++) keep[k] = true;
  });
  const out: (Line | null)[] = [];
  lines.forEach((l, n) => {
    if (keep[n]) out.push(l);
    else if (out.length && out[out.length - 1] !== null) out.push(null);
  });
  return out;
}

export function diffStats(oldText: string | null, newText: string) {
  const lines = diffLines(oldText ?? "", newText);
  return { added: lines.filter((l) => l.kind === "add").length, removed: lines.filter((l) => l.kind === "del").length };
}

export function Diff({
  path,
  oldText,
  newText,
  cwd,
  defaultOpen = true,
}: {
  path: string;
  oldText: string | null;
  newText: string;
  cwd?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const lines = useMemo(() => withContext(diffLines(oldText ?? "", newText)), [oldText, newText]);
  const added = lines.filter((l) => l?.kind === "add").length;
  const removed = lines.filter((l) => l?.kind === "del").length;
  const shown = cwd && path.startsWith(cwd) ? path.slice(cwd.length).replace(/^[\\/]/, "") : path;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-elev">
      <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-hover" onClick={() => setOpen(!open)}>
        <ChevronRight className={clsx("h-3.5 w-3.5 text-muted transition-transform", open && "rotate-90")} />
        <FileDiff className="h-4 w-4 text-muted" />
        <span className="min-w-0 flex-1 truncate font-mono text-[0.84em]">{shown}</span>
        {oldText === null && <span className="rounded bg-ok-soft px-1.5 text-[0.75em] text-ok">neu</span>}
        <span className="font-mono text-[0.8em] text-ok">+{added}</span>
        <span className="font-mono text-[0.8em] text-bad">−{removed}</span>
      </button>
      {open && (
        <div className="max-h-[420px] overflow-auto border-t border-line font-mono text-[0.8em] leading-[1.6] selectable">
          {lines.map((l, n) =>
            l === null ? (
              <div key={n} className="bg-panel px-3 text-muted">
                ⋯
              </div>
            ) : (
              <div
                key={n}
                className={clsx(
                  "flex whitespace-pre",
                  l.kind === "add" && "bg-ok-soft",
                  l.kind === "del" && "bg-bad-soft",
                )}
              >
                <span className="w-10 shrink-0 select-none pr-2 text-right text-muted/70">{l.kind === "add" ? l.b : l.a}</span>
                <span className={clsx("w-4 shrink-0 select-none", l.kind === "add" ? "text-ok" : l.kind === "del" ? "text-bad" : "text-muted")}>
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                </span>
                <span className="pr-4">{l.text || " "}</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
