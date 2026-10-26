// 3D-Modus (docs/adr/0007-3d-modus.md): Typen, Rust-Aufrufe (src-tauri/src/model3d.rs)
// und die Einstiegsdateien eines Modells.

import { invoke } from "@tauri-apps/api/core";
import type { DesignFile, HandoffRecord } from "./design";

export interface ModelVersion {
  n: number;
  label: string;
  at: number;
  sig: string;
}

export interface ModelMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
  sessionId?: string;
  versions: ModelVersion[];
  handoffs: HandoffRecord[];
  /** Vom Nutzer eingestellte Reglerwerte (je Einstiegsdatei). */
  params?: Record<string, Record<string, number | boolean | string>>;
}

/** Ausgewähltes Teil im Viewer; geht mit der nächsten Nachricht mit. */
export interface PickedPart {
  entry: string;
  name: string;
  path: string;
  /** Mittelpunkt und Größe in mm. */
  center: [number, number, number];
  size: [number, number, number];
  triangles: number;
  material?: string;
}

export interface ModelInfo {
  /** Bounding Box in mm (x, y, z). */
  size: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  triangles: number;
  parts: { name: string; triangles: number; size: [number, number, number] }[];
}

export const modelApi = {
  root: () => invoke<string>("model_root"),
  read: (path: string) => invoke<string>("model_read", { path }),
  bytes: (path: string) => invoke<ArrayBuffer>("model_bytes", { path }),
  write: (path: string, content: string) => invoke<void>("model_write", { path, content }),
  writeBase64: (path: string, data: string) => invoke<string>("model_write_base64", { path, data }),
  list: (path: string) => invoke<DesignFile[]>("model_list", { path }),
  dirs: () => invoke<string[]>("model_dirs"),
  copy: (from: string, to: string, skip: string[], replace: boolean) => invoke<void>("model_copy", { from, to, skip, replace }),
  remove: (path: string) => invoke<void>("model_remove", { path }),
  exportTo: (path: string, project: string, target: string) => invoke<string>("model_export", { path, project, target }),
  tools: () => invoke<{ openscad: string | null; blender: string | null }>("model_tools"),
  openscad: (dir: string, src: string, out: string) => invoke<string>("model_openscad", { dir, src, out }),
};

let root: string | null = null;

export async function modelRoot(): Promise<string> {
  if (!root) root = await modelApi.root();
  return root;
}

/** Gehört der Ordner zum 3D-Modus? Solche Sessions erscheinen nicht bei den Projekten. */
export function isModelPath(p: string): boolean {
  if (root && (p === root || p.startsWith(root + "/") || p.startsWith(root + "\\"))) return true;
  return /[\\/]3d[\\/]m-[\w-]+[\\/]?$/.test(p);
}

export const modelAbs = (rel: string) => `${root ?? ""}/${rel}`.replace(/\\/g, "/");

/** Von Brise verwaltete Einträge eines Modellordners. */
export const MODEL_MANAGED = [".versions", "model.json", "refs", "handoff", "preview.png"];

export const MODEL_EXT = /\.(glb|gltf|stl|obj|3mf)$/i;

export type EntryKind = "js" | "scad" | "file";

export interface ModelEntry {
  name: string;
  /** Einstiegsdatei relativ zum Modell (Quelle oder fertige Datei). */
  entry: string;
  kind: EntryKind;
  /** Ordner der Variante ("" = Hauptmodell). */
  dir: string;
}

/** Fertige Datei, die zu einer Quelle gehört (bzw. die Datei selbst). */
export function outputOf(e: ModelEntry): string {
  if (e.kind === "file") return e.entry;
  return `${e.dir ? `${e.dir}/` : ""}out/model.${e.kind === "scad" ? "stl" : "glb"}`;
}

/** Einstiegsdateien: Hauptmodell und Varianten (`variants/<name>/`). Quellen haben Vorrang vor fertigen Dateien. */
export function modelEntries(files: DesignFile[]): ModelEntry[] {
  const pick = (dir: string): ModelEntry | null => {
    const prefix = dir ? `${dir}/` : "";
    const has = (p: string) => files.some((f) => f.path === prefix + p);
    if (has("model.js")) return { name: "", entry: `${prefix}model.js`, kind: "js", dir };
    if (has("model.scad")) return { name: "", entry: `${prefix}model.scad`, kind: "scad", dir };
    const own = files
      .map((f) => f.path)
      .filter((p) => p.startsWith(prefix) && MODEL_EXT.test(p) && !p.slice(prefix.length).startsWith("variants/") && !p.slice(prefix.length).startsWith("refs/"))
      .sort((a, b) => rank(a) - rank(b) || a.length - b.length);
    return own[0] ? { name: "", entry: own[0], kind: "file", dir } : null;
  };
  const out: ModelEntry[] = [];
  const main = pick("");
  if (main) out.push({ ...main, name: "Hauptmodell" });
  const variants = [...new Set(files.map((f) => /^variants\/([^/]+)\//.exec(f.path)?.[1]).filter((v): v is string => !!v))].sort();
  for (const v of variants) {
    const e = pick(`variants/${v}`);
    if (e) out.push({ ...e, name: `Variante ${v.toUpperCase()}` });
  }
  return out;
}

const rank = (p: string) => ["glb", "gltf", "3mf", "obj", "stl"].indexOf(p.split(".").pop()!.toLowerCase());

export const newModelId = () => `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function formatMm(v: number): string {
  return `${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "")}`;
}
