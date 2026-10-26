// Zustand des 3D-Modus (ADR 0007). Wie beim Design-Modus lebt die
// Agent-Session im globalen Store; hier liegen Modelle, Bau-Ergebnisse
// (`model.js` → GLB/STL, `model.scad` → STL), Regler, Auswahl, Versionen und
// Übergabe.

import { create } from "zustand";
import { api, type ContentBlock } from "../../lib/acp";
import { useStore, type Attachment, type Item, type Session } from "../../lib/store";
import { load, save } from "../../lib/persist";
import type { DesignFile } from "../../lib/design";
import { fileSlug, handoffToSession } from "../../lib/handoff";
import {
  MODEL_MANAGED,
  modelAbs,
  modelApi,
  modelEntries,
  modelRoot,
  newModelId,
  outputOf,
  type ModelEntry,
  type ModelInfo,
  type ModelMeta,
  type PickedPart,
} from "../../lib/model3d";
import { emptySession } from "../design/designStore";
import type { ParamSpec } from "./modelCode";

export type ModelMode = { kind: "single" } | { kind: "compare" } | { kind: "version"; n: number };

/** Was der Viewer für eine Einstiegsdatei anzeigt. */
export interface Shown {
  bytes: ArrayBuffer;
  ext: string;
  /** Signatur der Quelle – ändert sie sich, wird neu gebaut. */
  sig: string;
  /** Zähler, damit der Viewer neu lädt. */
  n: number;
}

export interface BuildState {
  status: "idle" | "building" | "error";
  error?: string;
  logs?: string[];
}

interface ModelState {
  ready: boolean;
  models: ModelMeta[];
  activeId: string | null;
  files: DesignFile[];
  rev: number;
  entry: string | null;
  mode: ModelMode;
  tab: "view" | "code" | "files";
  picking: boolean;
  picked: PickedPart | null;
  handoffOpen: boolean;
  tools: { openscad: string | null; blender: string | null };
  shown: Record<string, Shown>;
  build: Record<string, BuildState>;
  params: Record<string, ParamSpec[]>;
  /** Anzeige: Drahtgitter, Bounding Box, Raster; Z-oben je Einstiegsdatei. */
  wireframe: boolean;
  bbox: boolean;
  grid: boolean;
  zUp: Record<string, boolean>;
  info: ModelInfo | null;
}

interface ModelActions {
  init(): Promise<void>;
  set(p: Partial<ModelState>): void;
  create(name: string): Promise<ModelMeta>;
  open(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  saveMeta(meta: ModelMeta): Promise<void>;
  refreshFiles(): Promise<void>;
  rebuild(entry: string, force?: boolean): Promise<void>;
  setParam(entry: string, name: string, value: number | boolean | string): void;
  resetParams(entry: string): void;
  send(text: string, images: Attachment[], variants: number): Promise<void>;
  /**
   * Neues Modell mit Auftrag anlegen und die Session starten (Delegation aus einer
   * anderen Session, ADR 0007). `onSession` läuft, bevor der erste Turn beginnt.
   */
  delegate(name: string, task: string, opts?: { author?: string; onSession?: (sessionId: string, modelId: string) => Promise<void> }): Promise<{ sessionId: string; modelId: string }>;
  /** Weitere Nachricht einer anderen Session an ein delegiertes Modell. */
  message(modelId: string, text: string, author?: string): Promise<void>;
  ensureSession(meta: ModelMeta): Promise<string>;
  cancel(): Promise<void>;
  snapshot(label: string): Promise<void>;
  restore(n: number): Promise<void>;
  promote(entry: string): Promise<void>;
  /** Vom Viewer: Screenshot und Maße des Hauptmodells für andere Sessions ablegen. */
  savePreview(entry: string, png: string, info: ModelInfo | null): Promise<void>;
  handoff(opts: { project: string; format: "glb" | "stl"; target: string; notes: string; criteria: string[] }): Promise<void>;
}

const metaPath = (id: string) => `${id}/model.json`;

const patchSession = (id: string, fn: (s: Session) => Session) =>
  useStore.setState((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } } : {}));

let counter = 0;
const uid = () => `m${Date.now().toString(36)}${++counter}`;
const pushItem = (id: string, item: Item) => patchSession(id, (s) => ({ ...s, items: [...s.items, item] }));

/** Signatur der Arbeitsdateien – ändert sie sich, lohnt eine neue Version. */
const signature = (files: DesignFile[]) =>
  files
    .filter((f) => !MODEL_MANAGED.includes(f.path.split("/")[0]))
    .map((f) => `${f.path}:${f.size}:${f.modified}`)
    .join("|");

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const ext = (p: string) => p.split(".").pop()!.toLowerCase();

function preamble(meta: ModelMeta, dir: string, tools: ModelState["tools"]) {
  return [
    `[Brise 3D-Modus] Nutze den Skill \`3d-mode\` und halte dich an sein Ausgabeformat.`,
    `Modell: „${meta.name}“. Arbeitsordner (dein cwd): ${dir}`,
    `Standardweg: Schreibe \`model.js\` (ES-Modul, \`export default function build({ THREE, params, csg })\` gibt ein THREE.Object3D zurück; optional \`export const params = { … }\` als Regler). Brise baut es nach jeder Änderung selbst zu \`out/model.glb\` und \`out/model.stl\` und zeigt es an – kein Befehl nötig.`,
    `Einheiten: 1 = 1 mm, Y zeigt nach oben. Benenne Teile (\`mesh.name\`). Varianten nach \`variants/<a|b|c…>/model.js\`. Halte \`notes.md\` aktuell (Zweck, Maße, Teile, ## Akzeptanzkriterien).`,
    tools.openscad
      ? `OpenSCAD ist installiert (${tools.openscad}): Für technische Teile und 3D-Druck darfst du statt \`model.js\` auch \`model.scad\` schreiben (Z oben); Brise rendert sie zu \`out/model.stl\`.`
      : `OpenSCAD ist nicht installiert – nutze \`model.js\`.`,
    tools.blender
      ? `Blender ist installiert (${tools.blender}): Für Modifikatoren, Rundungen oder Renderings darfst du \`blender --background --python model.py\` ausführen und das Ergebnis selbst nach \`out/model.glb\` exportieren (dann ohne \`model.js\`).`
      : "",
    `\`model.json\`, \`.versions/\`, \`preview.png\` und \`refs/\` verwaltet Brise – nicht ändern.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function pickedNote(p: PickedPart) {
  return [
    `[Ausgewähltes Teil in \`${p.entry}\`]`,
    `Teil: ${p.path}${p.material ? ` · Material ${p.material}` : ""}`,
    `Mittelpunkt (mm): ${p.center.join(", ")} · Größe (mm): ${p.size.join(" × ")} · ${p.triangles} Dreiecke`,
    `Ändere gezielt dieses Teil (und nur, was dafür nötig ist). Der Rest des Modells bleibt unverändert.`,
  ].join("\n");
}

function variantsNote(n: number, entry: string | null) {
  const names = "abcdefgh".slice(0, n).split("");
  return `[Brise] Erzeuge ${n} deutlich unterschiedliche Varianten (Form, Proportionen, Aufbau) als ${names
    .map((v) => `\`variants/${v}/model.js\``)
    .join(", ")}${entry ? `, ausgehend von \`${entry}\`` : ""}. Lösche alte Varianten-Ordner, die nicht mehr passen. Beschreibe die Unterschiede kurz in deiner Antwort und in \`notes.md\`.`;
}

export const DEFAULT_CRITERIA_3D = [
  "Das Modell wird im Projekt korrekt geladen und angezeigt (Maßstab, Ausrichtung, Materialien).",
  "Die Einbindung nutzt die vorhandene 3D-Lösung des Projekts bzw. eine leichte, passende Bibliothek.",
  "Ladezustand und Fehlerfall (Datei fehlt, WebGL nicht verfügbar) sind behandelt.",
  "Build, Typprüfung und vorhandene Tests laufen fehlerfrei.",
];

/** Hintergrund-Bau für nicht geöffnete Modelle (Delegation). */
let bgBuild: (id: string) => Promise<void> = async () => {};

export const useModel = create<ModelState & ModelActions>((set, get) => {
  const active = () => get().models.find((m) => m.id === get().activeId);

  const inflight: Record<string, Promise<string>> = {};
  const startSession = async (given: ModelMeta): Promise<string> => {
    // Immer den aktuellen Stand nehmen: der Aufrufer kann ein Meta ohne sessionId halten.
    const meta = get().models.find((m) => m.id === given.id) ?? given;
    const dir = modelAbs(meta.id);
    const sessions = useStore.getState().sessions;
    if (meta.sessionId && sessions[meta.sessionId]) return meta.sessionId;
    if (meta.sessionId) {
      const sid = meta.sessionId;
      useStore.setState((st) => ({ sessions: { ...st.sessions, [sid]: { ...emptySession(sid, dir, null, meta.name), replaying: true } } }));
      try {
        const r = await api.loadSession(dir, sid, false, false, "vibe");
        patchSession(sid, (s) => ({ ...emptySession(sid, dir, r, meta.name), items: s.items }));
        return sid;
      } catch {
        // Vibe speichert Sessions erst nach dem ersten Turn – dann neu anlegen.
        useStore.setState((st) => {
          const next = { ...st.sessions };
          delete next[sid];
          return { sessions: next };
        });
      }
    }
    const r = await api.newSession(dir, false, false, "vibe");
    const session = emptySession(r.sessionId, dir, r, meta.name);
    useStore.setState((st) => ({ sessions: { ...st.sessions, [r.sessionId]: session } }));
    if (session.modes.some((m) => m.id === "accept-edits") && session.currentMode !== "accept-edits") {
      await api.setMode(r.sessionId, "accept-edits").catch(() => {});
      patchSession(r.sessionId, (s) => ({ ...s, currentMode: "accept-edits" }));
    }
    const latest = get().models.find((m) => m.id === meta.id) ?? meta;
    await get().saveMeta({ ...latest, sessionId: r.sessionId });
    return r.sessionId;
  };

  /** Einen Turn an die Session des Modells schicken (auch für Delegation im Hintergrund). */
  const prompt = async (meta: ModelMeta, text: string, shown: string, images: Attachment[], author?: string, beforeEnd?: () => Promise<void>) => {
    const sid = await get().ensureSession(meta);
    const blocks: ContentBlock[] = [{ type: "text", text }];
    for (const a of images) {
      try {
        const [mimeType, data] = await api.readImage(a.path);
        blocks.push({ type: "image", mimeType, data });
      } catch (e) {
        pushItem(sid, { type: "notice", id: uid(), text: String(e), tone: "warn" });
      }
    }
    const started = Date.now();
    patchSession(sid, (s) => ({ ...s, running: true, turnStarted: started, items: [...s.items, { type: "user", id: uid(), text: shown, attachments: images, ...(author ? { author } : {}) }] }));
    try {
      const res = await api.prompt(sid, blocks);
      pushItem(sid, { type: "turn", id: uid(), stopReason: res.stopReason, ms: Date.now() - started, tokens: res.usage?.totalTokens });
    } catch (e) {
      pushItem(sid, { type: "notice", id: uid(), text: String(e), tone: "error" });
    } finally {
      // Delegation: Ergebnis bauen, bevor das Turn-Ende die Rückmeldung auslöst.
      await beforeEnd?.().catch(() => {});
      patchSession(sid, (s) => ({ ...s, running: false, turnStarted: undefined }));
    }
    return sid;
  };

  /** Nach einem Turn: Dateien neu lesen, bauen, Version anlegen – auch wenn das Modell nicht geöffnet ist. */
  const afterTurn = async (meta: ModelMeta, label: string) => {
    if (get().activeId === meta.id) {
      await get().refreshFiles();
      await get().snapshot(label);
      return;
    }
    await buildInBackground(meta.id);
    await snapshotOf(meta.id, label);
  };

  /**
   * Hauptmodell eines nicht geöffneten Modells bauen (Delegation), damit out/,
   * Maße und Vorschaubild für andere Sessions bereitliegen.
   */
  const buildInBackground = async (id: string) => {
    const files = await modelApi.list(id).catch(() => [] as DesignFile[]);
    const main = modelEntries(files)[0];
    if (!main) return;
    try {
      const r = await produce(id, main, get().models.find((m) => m.id === id)?.params?.[main.entry] ?? {});
      const { renderOffscreen, webglAvailable } = await import("./viewer3d");
      if (!webglAvailable()) return;
      const { png, info } = await renderOffscreen(r.bytes, r.ext, main.kind === "scad" || r.ext === "3mf");
      if (info) await modelApi.write(`${id}/out/info.json`, JSON.stringify(info));
      await modelApi.writeBase64(`${id}/preview.png`, png.split(",")[1]);
    } catch (e) {
      console.warn("3D-Modell im Hintergrund bauen", e);
    }
  };

  /**
   * Quelle bauen und Ausgaben schreiben; liefert Bytes für den Viewer. Baufehler
   * landen in `out/error.txt`, damit der Agent sie während seines Turns sieht.
   */
  const produce = async (id: string, e: ModelEntry, values: Record<string, unknown>) => {
    const base = `${id}/${e.dir ? `${e.dir}/` : ""}`;
    try {
      const r = await produceRaw(id, e, values, base);
      await modelApi.remove(`${base}out/error.txt`).catch(() => {});
      return r;
    } catch (err) {
      const logs = (err as { logs?: string[] })?.logs ?? [];
      await modelApi.write(`${base}out/error.txt`, `${err instanceof Error ? err.message : err}${logs.length ? `\n\nAusgaben:\n${logs.join("\n")}` : ""}\n`).catch(() => {});
      throw err;
    }
  };

  const produceRaw = async (id: string, e: ModelEntry, values: Record<string, unknown>, base: string): Promise<{ bytes: ArrayBuffer; ext: string; params: ParamSpec[]; logs: string[] }> => {
    if (e.kind === "js") {
      const code = await modelApi.read(`${id}/${e.entry}`);
      const { buildModel } = await import("./sandbox");
      const r = await buildModel(code, values);
      if (!r.out.glb) throw new Error("model.js hat nichts erzeugt");
      await modelApi.writeBase64(`${base}out/model.glb`, toBase64(r.out.glb));
      if (r.out.stl) await modelApi.writeBase64(`${base}out/model.stl`, toBase64(r.out.stl));
      return { bytes: r.out.glb, ext: "glb", params: r.params, logs: r.logs };
    }
    if (e.kind === "scad") {
      const log = await modelApi.openscad(id + (e.dir ? `/${e.dir}` : ""), "model.scad", "out/model.stl");
      return { bytes: await modelApi.bytes(`${base}out/model.stl`), ext: "stl", params: [], logs: log ? [log] : [] };
    }
    return { bytes: await modelApi.bytes(`${id}/${e.entry}`), ext: ext(e.entry), params: [], logs: [] };
  };

  const snapshotOf = async (id: string, label: string) => {
    const meta = get().models.find((m) => m.id === id);
    if (!meta) return;
    const files = await modelApi.list(id);
    if (!modelEntries(files).length) return;
    const sig = signature(files.filter((f) => !f.path.startsWith("out/") && !f.path.includes("/out/")));
    if (meta.versions[meta.versions.length - 1]?.sig === sig) return;
    const n = (meta.versions[meta.versions.length - 1]?.n ?? 0) + 1;
    await modelApi.copy(id, `${id}/.versions/${n}`, MODEL_MANAGED, true);
    const latest = get().models.find((m) => m.id === id) ?? meta;
    await get().saveMeta({ ...latest, versions: [...latest.versions, { n, label, at: Date.now(), sig }] });
  };

  bgBuild = buildInBackground;

  return {
    ready: false,
    models: [],
    activeId: load<string | null>("model.active", null),
    files: [],
    rev: 0,
    entry: null,
    mode: { kind: "single" },
    tab: "view",
    picking: false,
    picked: null,
    handoffOpen: false,
    tools: { openscad: null, blender: null },
    shown: {},
    build: {},
    params: {},
    wireframe: false,
    bbox: true,
    grid: true,
    zUp: {},
    info: null,

    set: (p) => set(p),

    async init() {
      if (get().ready) return;
      await modelRoot();
      const models: ModelMeta[] = [];
      for (const n of await modelApi.dirs()) {
        try {
          models.push({ handoffs: [], versions: [], ...JSON.parse(await modelApi.read(metaPath(n))) });
        } catch {
          /* unvollständiger Ordner – überspringen */
        }
      }
      models.sort((a, b) => b.updated - a.updated);
      const tools = await modelApi.tools().catch(() => ({ openscad: null, blender: null }));
      set({ models, tools, ready: true });
      const last = get().activeId;
      if (last && models.some((m) => m.id === last)) await get().open(last);
      else set({ activeId: null });
    },

    async create(name) {
      const now = Date.now();
      const meta: ModelMeta = { id: newModelId(), name: name.trim() || "Neues Modell", created: now, updated: now, versions: [], handoffs: [] };
      await get().saveMeta(meta);
      await modelApi.write(`${meta.id}/notes.md`, `# ${meta.name}\n\nNoch leer – beschreibe im Chat, was entstehen soll.\n`);
      return meta;
    },

    async open(id) {
      const meta = get().models.find((m) => m.id === id);
      if (!meta) return;
      save("model.active", id);
      set({ activeId: id, files: [], entry: null, mode: { kind: "single" }, picked: null, picking: false, tab: "view", shown: {}, build: {}, params: {}, info: null });
      await get().refreshFiles();
      if (useStore.getState().phase === "ready") get().ensureSession(meta).catch((e) => useStore.setState({ error: `3D-Session: ${e}` }));
    },

    async rename(id, name) {
      const meta = get().models.find((m) => m.id === id);
      if (!meta || !name.trim()) return;
      await get().saveMeta({ ...meta, name: name.trim() });
      if (meta.sessionId) patchSession(meta.sessionId, (s) => ({ ...s, title: name.trim() }));
    },

    async remove(id) {
      const meta = get().models.find((m) => m.id === id);
      await modelApi.remove(id);
      if (meta?.sessionId) api.deleteSession(meta.sessionId).catch(() => {});
      set((s) => ({ models: s.models.filter((m) => m.id !== id), activeId: s.activeId === id ? null : s.activeId }));
    },

    async saveMeta(meta) {
      const next = { ...meta, updated: Date.now() };
      await modelApi.write(metaPath(meta.id), JSON.stringify(next, null, 2));
      set((s) => ({ models: [next, ...s.models.filter((m) => m.id !== meta.id)].sort((a, b) => b.updated - a.updated) }));
    },

    async refreshFiles() {
      const id = get().activeId;
      if (!id) return;
      const files = await modelApi.list(id).catch(() => [] as DesignFile[]);
      if (get().activeId !== id) return;
      const list = modelEntries(files);
      const entry = list.some((e) => e.entry === get().entry) ? get().entry : (list[0]?.entry ?? null);
      set((s) => ({ files, entry, rev: s.rev + 1 }));
      for (const e of list) await get().rebuild(e.entry);
      // Ausgaben (out/) in der Dateiliste nachziehen.
      const after = await modelApi.list(id).catch(() => files);
      if (get().activeId === id) set({ files: after });
    },

    async rebuild(entryPath, force = false) {
      const id = get().activeId;
      const meta = active();
      const e = modelEntries(get().files).find((x) => x.entry === entryPath);
      if (!id || !meta || !e) return;
      const src = get().files.find((f) => f.path === e.entry);
      const values = meta.params?.[e.entry] ?? {};
      const sig = `${src?.size}:${src?.modified}:${JSON.stringify(values)}`;
      if (!force && get().shown[e.entry]?.sig === sig) return;
      set((s) => ({ build: { ...s.build, [e.entry]: { status: "building" } } }));
      try {
        const r = await produce(id, e, values);
        if (get().activeId !== id) return;
        set((s) => ({
          shown: { ...s.shown, [e.entry]: { bytes: r.bytes, ext: r.ext, sig, n: (s.shown[e.entry]?.n ?? 0) + 1 } },
          build: { ...s.build, [e.entry]: { status: "idle", logs: r.logs } },
          params: { ...s.params, [e.entry]: r.params },
          zUp: e.entry in s.zUp ? s.zUp : { ...s.zUp, [e.entry]: e.kind === "scad" || r.ext === "3mf" },
        }));
      } catch (err) {
        if (get().activeId !== id) return;
        const error = err instanceof Error ? err.message : String(err);
        set((s) => ({ build: { ...s.build, [e.entry]: { status: "error", error, logs: (err as { logs?: string[] })?.logs } } }));
      }
    },

    setParam(entry, name, value) {
      const meta = active();
      if (!meta) return;
      const params = { ...(meta.params ?? {}), [entry]: { ...(meta.params?.[entry] ?? {}), [name]: value } };
      set((s) => ({ models: s.models.map((m) => (m.id === meta.id ? { ...m, params } : m)) }));
      clearTimeout(paramTimer);
      paramTimer = setTimeout(async () => {
        const latest = active();
        if (latest) await get().saveMeta(latest);
        await get().rebuild(entry);
      }, 250);
    },

    resetParams(entry) {
      const meta = active();
      if (!meta?.params?.[entry]) return;
      const params = { ...meta.params };
      delete params[entry];
      get()
        .saveMeta({ ...meta, params })
        .then(() => get().rebuild(entry));
    },

    async ensureSession(meta) {
      inflight[meta.id] ??= startSession(meta).finally(() => delete inflight[meta.id]);
      return inflight[meta.id];
    },

    async send(text, images, variants) {
      const meta = active();
      if (!meta) return;
      const dir = modelAbs(meta.id);
      let sid: string;
      try {
        sid = await get().ensureSession(meta);
      } catch (e) {
        useStore.setState({ error: `3D-Session konnte nicht starten: ${e}` });
        return;
      }
      const session = useStore.getState().sessions[sid];
      const first = !session?.items.some((i) => i.type === "user");
      const { picked, entry } = get();
      const parts: string[] = [];
      if (first) parts.push(preamble(meta, dir, get().tools));
      if (picked) parts.push(pickedNote(picked));
      if (variants > 1) parts.push(variantsNote(variants, entry));
      else if (entry && !entry.startsWith("model.") && !picked) parts.push(`[Brise] Gerade angezeigt: \`${entry}\`. Beziehe die Bitte darauf, wenn nichts anderes gesagt ist.`);
      const values = entry ? meta.params?.[entry] : undefined;
      if (values && Object.keys(values).length)
        parts.push(
          `[Brise] Die Nutzer:in hat die Regler in \`${entry}\` eingestellt: ${Object.entries(values)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}. Übernimm diese Werte als neue Standardwerte in \`export const params\`, sofern die Bitte nichts anderes sagt.`,
        );
      const build = entry ? get().build[entry] : undefined;
      if (build?.status === "error") parts.push(`[Brise] Der letzte Bau von \`${entry}\` ist fehlgeschlagen:\n${build.error}`);
      parts.push(text);
      set({ picked: null, picking: false });
      const shown = [text, picked ? `↳ ${picked.path}` : "", variants > 1 ? `↳ ${variants} Varianten` : ""].filter(Boolean).join("\n");
      await prompt(meta, parts.join("\n\n"), shown, images);
      if (values && Object.keys(values).length && entry) {
        // Die Werte stehen jetzt im Code.
        const latest = get().models.find((m) => m.id === meta.id);
        if (latest?.params?.[entry]) {
          const params = { ...latest.params };
          delete params[entry];
          await get().saveMeta({ ...latest, params });
        }
      }
      await afterTurn(meta, text.split("\n")[0].slice(0, 70));
      if (get().activeId === meta.id && variants > 1 && modelEntries(get().files).length > 1) set({ mode: { kind: "compare" } });
    },

    async delegate(name, task, opts) {
      if (!get().ready) await get().init();
      const meta = await get().create(name);
      const sid = await get().ensureSession(meta);
      await opts?.onSession?.(sid, meta.id);
      const text = `${preamble(meta, modelAbs(meta.id), get().tools)}\n\n${task}`;
      const label = name.slice(0, 70);
      // Nicht geöffnet: vor dem Turn-Ende bauen und eine Version anlegen, damit die Rückmeldung ein fertiges Ergebnis meldet.
      const finish = async () => {
        if (get().activeId === meta.id) return;
        await buildInBackground(meta.id);
        await snapshotOf(meta.id, label);
      };
      void prompt(meta, text, task, [], opts?.author, finish).then(async () => {
        if (get().activeId === meta.id) await afterTurn(meta, label);
      });
      return { sessionId: sid, modelId: meta.id };
    },

    async message(modelId, text, author) {
      if (!get().ready) await get().init();
      const meta = get().models.find((m) => m.id === modelId);
      if (!meta) throw new Error(`Modell ${modelId} nicht gefunden`);
      const label = text.split("\n")[0].slice(0, 70);
      await prompt(meta, text, text, [], author, async () => {
        if (get().activeId === meta.id) return;
        await buildInBackground(meta.id);
        await snapshotOf(meta.id, label);
      });
      if (get().activeId === meta.id) await afterTurn(meta, label);
    },

    async cancel() {
      const sid = active()?.sessionId;
      if (sid) await api.cancel(sid);
    },

    async snapshot(label) {
      const meta = active();
      if (meta) await snapshotOf(meta.id, label);
    },

    async restore(n) {
      const meta = active();
      if (!meta) return;
      await modelApi.copy(`${meta.id}/.versions/${n}`, meta.id, MODEL_MANAGED, true);
      set({ mode: { kind: "single" } });
      await get().refreshFiles();
      await get().snapshot(`Version ${n} wiederhergestellt`);
    },

    async promote(entry) {
      const meta = active();
      const e = modelEntries(get().files).find((x) => x.entry === entry);
      if (!meta || !e?.dir) return;
      // Hauptquelle ersetzen: alte Quellen entfernen, Variante kopieren.
      for (const f of ["model.js", "model.scad"]) await modelApi.remove(`${meta.id}/${f}`);
      await modelApi.copy(`${meta.id}/${e.dir}`, meta.id, [], false);
      set({ mode: { kind: "single" }, entry: e.entry.split("/").pop()! });
      await get().refreshFiles();
      await get().snapshot(`Variante ${e.dir.split("/").pop()?.toUpperCase()} übernommen`);
    },

    async savePreview(entry, png, info) {
      const meta = active();
      const e = modelEntries(get().files).find((x) => x.entry === entry);
      if (!meta || !e) return;
      set({ info });
      if (info) await modelApi.write(`${meta.id}/${e.dir ? `${e.dir}/` : ""}out/info.json`, JSON.stringify(info));
      if (!e.dir) await modelApi.writeBase64(`${meta.id}/preview.png`, png.split(",")[1]);
    },

    async handoff({ project, format, target, notes, criteria }) {
      const meta = active();
      if (!meta) throw new Error("Kein Modell geöffnet");
      const main = modelEntries(get().files)[0];
      if (!main) throw new Error("Das Modell hat noch keine Datei.");
      const output = format === "stl" ? `${main.dir ? `${main.dir}/` : ""}out/model.stl` : outputOf(main);
      if (!get().files.some((f) => f.path === output)) throw new Error(`${output} fehlt – erst bauen lassen.`);
      const exported = await modelApi.exportTo(`${meta.id}/${output}`, project, target);
      const sourceDir = `.brise/3d/${fileSlug(meta.name)}`;
      const source = await modelApi.exportTo(meta.id, project, sourceDir);
      const modelNotes = await modelApi.read(`${meta.id}/notes.md`).catch(() => "");
      const info = get().info;
      const hasPreview = get().files.some((f) => f.path === "preview.png");
      const promptText = [
        `Auftrag: 3D-Modell „${meta.name}“ einbinden`,
        `Im 3D-Modus von Brise ist ein 3D-Modell entstanden. Binde es in **diesem Projekt** ein, passend zu seinem Stack.`,
        `## Dateien`,
        `- \`${target}\` – das Modell (${format.toUpperCase()})`,
        `- \`${sourceDir}/\` – Quellcode (${main.kind === "js" ? "model.js, three.js" : main.kind === "scad" ? "model.scad, OpenSCAD" : "fertige Datei"}), \`notes.md\` und Vorschaubild (per .gitignore vom Repository ausgeschlossen)`,
        info
          ? `## Maße\nBounding Box ${info.size.join(" × ")} mm (x × y × z), ${info.triangles} Dreiecke, ${info.parts.length} Teile: ${info.parts
              .slice(0, 12)
              .map((p) => p.name)
              .join(", ")}`
          : "",
        `Einheiten im Modell: **1 = 1 mm**, ${get().zUp[main.entry] ? "Z" : "Y"} zeigt nach oben. Arbeitet die Szene des Projekts in Metern (three.js-Standard), skaliere mit 0,001.`,
        `## Vorgehen`,
        [
          `1. Finde heraus, wie das Projekt 3D darstellt (three.js, react-three-fiber/drei mit \`useGLTF\`, Babylon.js, \`<model-viewer>\`, eine Game-Engine …). Gibt es noch nichts, wähle die leichteste passende Lösung und begründe sie kurz.`,
          `2. Lade das Modell von \`${target}\` (ggf. Pfad an das Asset-System anpassen), richte Kamera, Licht und Maßstab ein.`,
          `3. Baue es dort ein, wo es hingehört (Seite, Komponente, Szene), mit Ladezustand und Fehlerfall.`,
          `4. Prüfe gegen die Akzeptanzkriterien und berichte, was erledigt ist und was offen bleibt.`,
        ].join("\n"),
        modelNotes.trim() ? `## Beschreibung aus dem 3D-Modus\n${modelNotes.trim()}` : "",
        notes.trim() ? `## Hinweise\n${notes.trim()}` : "",
        `## Akzeptanzkriterien`,
        criteria.map((c) => `- [ ] ${c}`).join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n");
      await modelApi.write(`${meta.id}/handoff/AUFTRAG.md`, promptText);
      const attachments: Attachment[] = hasPreview ? [{ kind: "image", path: `${source}/preview.png`, name: "preview.png" }] : [];
      const record = { project, at: Date.now(), path: exported };
      await get().saveMeta({ ...meta, handoffs: [...meta.handoffs, record] });
      handoffToSession(project, promptText, attachments, (id) => {
        const m = get().models.find((x) => x.id === meta.id);
        if (m) get().saveMeta({ ...m, handoffs: m.handoffs.map((h) => (h.at === record.at ? { ...h, sessionId: id } : h)) });
      });
      set({ handoffOpen: false });
    },
  };
});

let paramTimer: ReturnType<typeof setTimeout> | undefined;

// Live-Vorschau: abgeschlossene Dateiänderungen der 3D-Session bauen und laden neu.
// Nicht geöffnete Modelle (z. B. delegierte) baut Brise im Hintergrund, damit der
// Agent schon während seines Turns out/info.json bzw. out/error.txt lesen kann.
const editCounts: Record<string, number> = {};
const timers: Record<string, ReturnType<typeof setTimeout>> = {};
useStore.subscribe((st, prev) => {
  if (st.sessions === prev.sessions) return;
  const m = useModel.getState();
  for (const model of m.models) {
    const sid = model.sessionId;
    if (!sid || st.sessions[sid] === prev.sessions[sid]) continue;
    const items = st.sessions[sid]?.items ?? [];
    const done = items.filter((i) => i.type === "tool" && i.status === "completed" && (i.kind === "edit" || i.kind === "delete" || i.kind === "move" || i.kind === "execute" || i.diffs.length > 0)).length;
    if (done === (editCounts[sid] ?? done - 1) || done === 0) {
      editCounts[sid] = done;
      continue;
    }
    editCounts[sid] = done;
    clearTimeout(timers[sid]);
    const active = model.id === m.activeId;
    timers[sid] = setTimeout(() => (active ? useModel.getState().refreshFiles() : bgBuild(model.id)), 300);
  }
});
