import { useMemo } from "react";

type Line = { kind: "same" | "add" | "del"; text: string };

const MAX_LINES = 400;

/** Zeilen-Diff per LCS – reicht für die Änderungen eines einzelnen Edits. */
function diffLines(oldText: string, newText: string): Line[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return b.map((text) => ({ kind: "add", text }));
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i++] });
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** Zeigt nur geänderte Zeilen plus etwas Kontext. */
function withContext(lines: Line[], context = 3): (Line | null)[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, n) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, n - context); k <= Math.min(lines.length - 1, n + context); k++) keep[k] = true;
  });
  const out: (Line | null)[] = [];
  lines.forEach((l, n) => {
    if (keep[n]) out.push(l);
    else if (out[out.length - 1] !== null) out.push(null);
  });
  return out;
}

export function Diff({ path, oldText, newText }: { path: string; oldText: string | null; newText: string }) {
  const lines = useMemo(() => withContext(diffLines(oldText ?? "", newText)), [oldText, newText]);
  const added = lines.filter((l) => l?.kind === "add").length;
  const removed = lines.filter((l) => l?.kind === "del").length;
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-path">{path}</span>
        <span className="diff-stat">
          <span className="add">+{added}</span> <span className="del">−{removed}</span>
        </span>
      </div>
      <pre className="diff-body">
        {lines.map((l, n) =>
          l === null ? (
            <div key={n} className="diff-gap">⋯</div>
          ) : (
            <div key={n} className={`diff-line ${l.kind}`}>
              <span className="diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
              {l.text || " "}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}
