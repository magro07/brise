import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

// ---------- Definition (wie bench.rs, Datei <Datenordner>/benchmarks/<id>.json) ----------

export type Check =
  | { type: "contains"; value: string; ignoreCase?: boolean }
  | { type: "regex"; pattern: string }
  | { type: "command"; run: string; timeoutSec?: number }
  | { type: "file"; path: string; pattern?: string }
  | { type: "judge"; criteria: string; model?: string; threshold?: number };

export interface BenchTask {
  id: string;
  name: string;
  prompt: string;
  project?: string;
  ref?: string;
  files?: Record<string, string>;
  setup?: string;
  checks: Check[];
  timeoutSec?: number;
}

export interface BenchTarget {
  backend: string;
  model?: string;
  options?: Record<string, unknown>;
  label?: string;
}

export interface Benchmark {
  id?: string;
  name: string;
  description?: string;
  judgeModel?: string;
  tasks: BenchTask[];
  targets: BenchTarget[];
}

export interface BenchSummary {
  id: string;
  name: string;
  description: string;
  tasks: number;
  targets: number;
  runs: number;
  lastRun: { id: string; started: number; status: string; passed: number; total: number } | null;
  error: string | null;
}

// ---------- Läufe ----------

export interface CheckResult {
  kind: string;
  label: string;
  passed: boolean;
  score: number;
  detail: string;
}

export interface TaskResult {
  task: string;
  target: string;
  passed: boolean;
  score: number;
  checks: CheckResult[];
  error: string | null;
  stopReason: string | null;
  model: string | null;
  durationMs: number;
  ttftMs: number | null;
  outputTps: number | null;
  input: number;
  cached: number;
  output: number;
  toolCalls: number;
  costEur: number | null;
  answer: string;
  /** Hinweise des Agenten außerhalb der Antwort (z. B. MCP-Warnungen). */
  notices?: string[];
  workdir: string | null;
}

export interface BenchRun {
  id: string;
  benchId: string;
  benchName: string;
  started: number;
  finished: number | null;
  status: "running" | "done" | "cancelled" | "failed";
  total: number;
  targets: { key: string; label: string; backend: string; model: string | null }[];
  tasks: { id: string; name: string }[];
  results: TaskResult[];
  current?: string;
}

export const benchApi = {
  list: () => invoke<BenchSummary[]>("bench_list"),
  get: (id: string) => invoke<Benchmark>("bench_get", { id }),
  save: (bench: Benchmark) => invoke<string>("bench_save", { bench }),
  remove: (id: string, runs: boolean) => invoke<void>("bench_delete", { id, runs }),
  dir: () => invoke<string>("bench_dir"),
  runs: (id: string) => invoke<BenchRun[]>("bench_runs", { id }),
  removeRun: (id: string, run: string) => invoke<void>("bench_delete_run", { id, run }),
  status: () => invoke<BenchRun | null>("bench_status"),
  run: (id: string, tasks?: string[], targets?: string[]) => invoke<BenchRun>("bench_run", { id, tasks, targets }),
  cancel: () => invoke<void>("bench_cancel"),
};

/** Gleiche Kennung wie `Target::key` in bench.rs. */
export function targetKey(t: BenchTarget): string {
  let k = `${t.backend}:${t.model || "standard"}`;
  for (const [o, v] of Object.entries(t.options ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) k += `:${o}=${typeof v === "string" ? v : JSON.stringify(v)}`;
  return k;
}

// ---------- Laufender Lauf (Event bench:progress) ----------

export const useBenchRun = create<{ run: BenchRun | null; seq: number }>(() => ({ run: null, seq: 0 }));

let listening = false;
export function watchBench() {
  if (listening) return;
  listening = true;
  benchApi.status().then((run) => run && useBenchRun.setState((s) => ({ run, seq: s.seq + 1 }))).catch(() => {});
  listen<BenchRun>("bench:progress", (e) => useBenchRun.setState((s) => ({ run: e.payload, seq: s.seq + 1 })));
}

/** Arbeitsordner eines Benchmark-Laufs (`<Datenordner>/benchmarks/work/…`) – nicht in der Seitenleiste zeigen. */
export function isBenchPath(p: string | undefined): boolean {
  return !!p && /[\\/]benchmarks[\\/]work[\\/]/.test(p);
}

/** Median einer Zahlenliste (ohne leere Werte). */
export function median(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
