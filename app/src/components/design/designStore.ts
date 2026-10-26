// Zustand des Design-Modus. Die Agent-Session eines Designs lebt im globalen
// Store (dort kommen die Vibe-Events an); hier liegen Designs, Design-Systeme,
// Vorschau-Einstellungen und die Abläufe Senden, Versionen und Übergabe.

import { create } from "zustand";
import { api, type ContentBlock, type SessionSetup } from "../../lib/acp";
import { useStore, type Attachment, type Item, type Session } from "../../lib/store";
import { load, save } from "../../lib/persist";
import {
  MANAGED,
  absPath,
  defaultSystem,
  designApi,
  designRoot,
  entries,
  newId,
  slug,
  systemFromImport,
  tokensCss,
  tokensSummary,
  type DesignFile,
  type DesignMeta,
  type DesignSystem,
  type Device,
  type PickedElement,
} from "../../lib/design";
import { captureEntry } from "./capture";
import { handoffToSession } from "../../lib/handoff";

export type PreviewMode = { kind: "single" } | { kind: "compare" } | { kind: "version"; n: number };

interface DesignState {
  ready: boolean;
  designs: DesignMeta[];
  systems: DesignSystem[];
  activeId: string | null;
  files: DesignFile[];
  /** Zähler: jede Änderung an den Dateien lädt die Vorschau neu. */
  rev: number;
  device: Device;
  theme: "light" | "dark";
  mode: PreviewMode;
  /** Angezeigte Einstiegsdatei (Hauptdesign oder Variante). */
  entry: string | null;
  picking: boolean;
  picked: PickedElement | null;
  tab: "preview" | "system" | "files";
  handoffOpen: boolean;
  previewErrors: string[];
  /** System, dessen Stand der Agent zuletzt gesehen hat (je Design). */
  seenSystem: Record<string, number>;
}

interface DesignActions {
  init(): Promise<void>;
  set(p: Partial<DesignState>): void;
  create(name: string, systemId?: string): Promise<void>;
  open(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  saveMeta(meta: DesignMeta): Promise<void>;
  refreshFiles(): Promise<void>;
  saveSystem(sys: DesignSystem): Promise<void>;
  removeSystem(id: string): Promise<void>;
  applySystem(systemId: string): Promise<void>;
  importSystem(project: string): Promise<DesignSystem>;
  send(text: string, images: Attachment[], variants: number): Promise<void>;
  cancel(): Promise<void>;
  snapshot(label: string): Promise<void>;
  restore(n: number): Promise<void>;
  promote(entry: string): Promise<void>;
  handoff(opts: { project: string; criteria: string[]; notes: string; withVariants: boolean }): Promise<void>;
}

const metaPath = (id: string) => `${id}/design.json`;

export function emptySession(id: string, cwd: string, setup: SessionSetup | null, title: string): Session {
  const modeOption = setup?.configOptions?.find((o) => o.id === "mode");
  return {
    id,
    cwd,
    // Design-Sessions laufen immer über Vibe (Skill design-mode).
    backend: "vibe",
    title,
    items: [],
    pending: [],
    plan: [],
    modes: setup?.modes?.availableModes ?? [],
    currentMode: setup?.modes?.currentModeId ?? (modeOption?.currentValue as string | undefined),
    config: setup?.configOptions ?? [],
    running: false,
    replaying: false,
    usage: {},
    commands: [],
    autoThinking: false,
    thinkingLog: [],
  };
}

const patchSession = (id: string, fn: (s: Session) => Session) =>
  useStore.setState((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } } : {}));

let counter = 0;
const uid = () => `d${Date.now().toString(36)}${++counter}`;
const pushItem = (id: string, item: Item) => patchSession(id, (s) => ({ ...s, items: [...s.items, item] }));

/** Signatur der Arbeitsdateien – ändert sie sich, lohnt eine neue Version. */
const signature = (files: DesignFile[]) =>
  files
    .filter((f) => !MANAGED.includes(f.path.split("/")[0]) && !f.path.startsWith("tokens."))
    .map((f) => `${f.path}:${f.size}:${f.modified}`)
    .join("|");

/** Erklärt dem Agenten Ort, Format und Design-System. Geht mit der ersten Nachricht mit. */
function preamble(meta: DesignMeta, dir: string, sys: DesignSystem) {
  return [
    `[Brise Design-Modus] Nutze den Skill \`design-mode\` und halte dich an sein Ausgabeformat.`,
    `Design: „${meta.name}“. Arbeitsordner (dein cwd): ${dir}`,
    `Schreibe das Hauptdesign nach \`index.html\` (oder \`App.jsx\` für React), Varianten nach \`variants/<a|b|c…>/index.html\`, und halte \`notes.md\` aktuell (Zweck, Aufbau, Komponenten, Zustände, ## Akzeptanzkriterien).`,
    `\`tokens.css\` und \`tokens.json\` verwaltet Brise – nicht ändern. Die Tokens sind in der Vorschau als CSS-Variablen geladen; Hell/Dunkel schaltet Brise über \`data-theme="dark"\` bzw. die Klasse \`dark\` auf <html>.`,
    tokensSummary(sys),
  ].join("\n");
}

function systemNote(sys: DesignSystem) {
  return `[Brise] Das Design-System wurde geändert. Aktueller Stand (tokens.css/tokens.json sind aktualisiert), passe das Design daran an:\n${tokensSummary(sys)}`;
}

function pickedNote(p: PickedElement) {
  return [
    `[Ausgewähltes Element in \`${p.entry}\`]`,
    `Selektor: \`${p.selector}\``,
    p.text ? `Text: „${p.text}“` : "",
    "```html",
    p.html,
    "```",
    `Ändere gezielt dieses Element (und nur, was dafür nötig ist). Der Rest des Designs bleibt unverändert.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function variantsNote(n: number, entry: string | null) {
  const names = "abcdefgh".slice(0, n).split("");
  return `[Brise] Erzeuge ${n} deutlich unterschiedliche Varianten (Layout, Gewichtung, Stil – alle im Design-System) als ${names
    .map((v) => `\`variants/${v}/index.html\``)
    .join(", ")}${entry ? `, ausgehend von \`${entry}\`` : ""}. Lösche alte Varianten-Ordner, die nicht mehr passen. Beschreibe die Unterschiede kurz in deiner Antwort und in \`notes.md\`.`;
}

export const DEFAULT_CRITERIA = [
  "Das Ergebnis entspricht den Screenshots in Layout, Abständen, Typografie und Farben – auf Mobil und Desktop.",
  "Farben, Schriften, Abstände und Radien kommen aus den Design-Tokens bzw. dem Theme des Projekts, nicht hart codiert.",
  "Hell- und Dunkelmodus funktionieren, sofern das Projekt beides unterstützt.",
  "Hover-, Fokus- und Deaktiviert-Zustände sowie Tastaturbedienung sind umgesetzt; Bilder haben Alternativtexte.",
  "Build, Typprüfung und vorhandene Tests laufen fehlerfrei.",
];

/** Liest Akzeptanzkriterien aus `notes.md` (Abschnitt „Akzeptanzkriterien“). */
export function criteriaFromNotes(notes: string): string[] {
  const m = /^#+\s*Akzeptanzkriterien\s*$([\s\S]*?)(?=^#+\s|(?![\s\S]))/im.exec(notes);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s*(?:\[[ x]\]\s*)?/i, "").trim())
    .filter((l) => l.length > 3);
}

export const useDesign = create<DesignState & DesignActions>((set, get) => {
  const active = () => get().designs.find((d) => d.id === get().activeId);
  const systemOf = (meta?: DesignMeta) => get().systems.find((s) => s.id === meta?.systemId) ?? get().systems[0] ?? defaultSystem();

  const writeTokens = async (meta: DesignMeta) => {
    const sys = systemOf(meta);
    await designApi.write(`${meta.id}/tokens.css`, tokensCss(sys));
    await designApi.write(`${meta.id}/tokens.json`, JSON.stringify(sys, null, 2));
  };

  /** Session des Designs bereitstellen: laden, sonst neu anlegen. Gleichzeitige Aufrufe teilen sich eine. */
  const inflight: Record<string, Promise<string>> = {};
  const ensureSession = (meta: DesignMeta): Promise<string> => {
    inflight[meta.id] ??= startSession(meta).finally(() => delete inflight[meta.id]);
    return inflight[meta.id];
  };
  const startSession = async (meta: DesignMeta): Promise<string> => {
    const dir = absPath(meta.id);
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
    // Dateien im eigenen Arbeitsordner ohne Rückfrage schreiben, Befehle weiter mit Freigabe.
    if (session.modes.some((m) => m.id === "accept-edits") && session.currentMode !== "accept-edits") {
      await api.setMode(r.sessionId, "accept-edits").catch(() => {});
      patchSession(r.sessionId, (s) => ({ ...s, currentMode: "accept-edits" }));
    }
    const latest = get().designs.find((d) => d.id === meta.id) ?? meta;
    await get().saveMeta({ ...latest, sessionId: r.sessionId });
    return r.sessionId;
  };

  return {
    ready: false,
    designs: [],
    systems: [],
    activeId: load<string | null>("design.active", null),
    files: [],
    rev: 0,
    device: load<Device>("design.device", "desktop"),
    theme: "light",
    mode: { kind: "single" },
    entry: null,
    picking: false,
    picked: null,
    tab: "preview",
    handoffOpen: false,
    previewErrors: [],
    seenSystem: {},

    set: (p) => set(p),

    async init() {
      if (get().ready) return;
      await designRoot();
      const names = await designApi.dirs("");
      const designs: DesignMeta[] = [];
      for (const n of names.filter((n) => n.startsWith("d-"))) {
        try {
          designs.push({ handoffs: [], versions: [], ...JSON.parse(await designApi.read(metaPath(n))) });
        } catch {
          /* unvollständiger Ordner – überspringen */
        }
      }
      designs.sort((a, b) => b.updated - a.updated);
      const systems: DesignSystem[] = [];
      for (const f of await designApi.list("systems")) {
        try {
          systems.push(JSON.parse(await designApi.read(`systems/${f.path}`)));
        } catch {
          /* defekt – überspringen */
        }
      }
      if (!systems.length) {
        const sys = defaultSystem();
        await designApi.write(`systems/${sys.id}.json`, JSON.stringify(sys, null, 2));
        systems.push(sys);
      }
      set({ designs, systems, ready: true });
      const last = get().activeId;
      if (last && designs.some((d) => d.id === last)) await get().open(last);
      else set({ activeId: null });
    },

    async create(name, systemId) {
      const now = Date.now();
      const meta: DesignMeta = {
        id: newId("d"),
        name: name.trim() || "Neues Design",
        created: now,
        updated: now,
        systemId: systemId ?? get().systems[0]?.id ?? "s-standard",
        versions: [],
        handoffs: [],
      };
      await get().saveMeta(meta);
      await designApi.write(`${meta.id}/notes.md`, `# ${meta.name}\n\nNoch leer – beschreibe im Chat, was entstehen soll.\n`);
      await get().open(meta.id);
    },

    async open(id) {
      const meta = get().designs.find((d) => d.id === id);
      if (!meta) return;
      save("design.active", id);
      set({ activeId: id, files: [], entry: null, mode: { kind: "single" }, picked: null, picking: false, previewErrors: [], tab: "preview" });
      await writeTokens(meta).catch(() => {});
      await get().refreshFiles();
      if (useStore.getState().phase === "ready") ensureSession(meta).catch((e) => useStore.setState({ error: `Design-Session: ${e}` }));
    },

    async rename(id, name) {
      const meta = get().designs.find((d) => d.id === id);
      if (!meta || !name.trim()) return;
      await get().saveMeta({ ...meta, name: name.trim() });
      if (meta.sessionId) patchSession(meta.sessionId, (s) => ({ ...s, title: name.trim() }));
    },

    async remove(id) {
      const meta = get().designs.find((d) => d.id === id);
      await designApi.remove(id);
      if (meta?.sessionId) api.deleteSession(meta.sessionId).catch(() => {});
      set((s) => ({ designs: s.designs.filter((d) => d.id !== id), activeId: s.activeId === id ? null : s.activeId, files: s.activeId === id ? [] : s.files }));
    },

    async saveMeta(meta) {
      const next = { ...meta, updated: Date.now() };
      await designApi.write(metaPath(meta.id), JSON.stringify(next, null, 2));
      set((s) => ({ designs: [next, ...s.designs.filter((d) => d.id !== meta.id)].sort((a, b) => b.updated - a.updated) }));
    },

    async refreshFiles() {
      const id = get().activeId;
      if (!id) return;
      const files = await designApi.list(id).catch(() => [] as DesignFile[]);
      if (get().activeId !== id) return;
      const list = entries(files);
      const entry = list.some((e) => e.entry === get().entry) ? get().entry : (list[0]?.entry ?? null);
      set((s) => ({ files, entry, rev: s.rev + 1, previewErrors: [] }));
    },

    async saveSystem(sys) {
      const next = { ...sys, updated: Date.now() };
      await designApi.write(`systems/${sys.id}.json`, JSON.stringify(next, null, 2));
      set((s) => ({ systems: s.systems.some((x) => x.id === sys.id) ? s.systems.map((x) => (x.id === sys.id ? next : x)) : [...s.systems, next] }));
      const meta = active();
      if (meta?.systemId === sys.id) {
        await writeTokens(meta);
        set((s) => ({ rev: s.rev + 1 }));
      }
    },

    async removeSystem(id) {
      if (get().systems.length <= 1) return;
      await designApi.remove(`systems/${id}.json`);
      const fallback = get().systems.find((s) => s.id !== id)!;
      set((s) => ({ systems: s.systems.filter((x) => x.id !== id) }));
      for (const d of get().designs.filter((d) => d.systemId === id)) await get().saveMeta({ ...d, systemId: fallback.id });
    },

    async applySystem(systemId) {
      const meta = active();
      if (!meta) return;
      await get().saveMeta({ ...meta, systemId });
      await writeTokens({ ...meta, systemId });
      set((s) => ({ rev: s.rev + 1 }));
    },

    async importSystem(project) {
      const imp = await designApi.importTokens(project);
      if (!imp.vars.length && !imp.tailwind.length) throw new Error("Keine CSS-Variablen oder Tailwind-Farben gefunden.");
      const name = project.split(/[\\/]/).filter(Boolean).pop() ?? "Projekt";
      const sys = systemFromImport(defaultSystem(), name, project, imp);
      await get().saveSystem(sys);
      return sys;
    },

    async send(text, images, variants) {
      const meta = active();
      if (!meta) return;
      const dir = absPath(meta.id);
      const sys = systemOf(meta);
      await writeTokens(meta);
      let sid: string;
      try {
        sid = await ensureSession(meta);
      } catch (e) {
        useStore.setState({ error: `Design-Session konnte nicht starten: ${e}` });
        return;
      }
      const session = useStore.getState().sessions[sid];
      const first = !session?.items.some((i) => i.type === "user");
      const { picked, entry } = get();
      const parts: string[] = [];
      if (first) parts.push(preamble(meta, dir, sys));
      else if ((get().seenSystem[meta.id] ?? sys.updated) < sys.updated) parts.push(systemNote(sys));
      if (picked) parts.push(pickedNote(picked));
      if (variants > 1) parts.push(variantsNote(variants, entry));
      else if (entry && entry !== "index.html" && !picked) parts.push(`[Brise] Gerade angezeigt: \`${entry}\`. Beziehe die Bitte darauf, wenn nichts anderes gesagt ist.`);
      parts.push(text);
      set((s) => ({ seenSystem: { ...s.seenSystem, [meta.id]: sys.updated }, picked: null, picking: false }));

      const blocks: ContentBlock[] = [{ type: "text", text: parts.join("\n\n") }];
      for (const a of images) {
        try {
          const [mimeType, data] = await api.readImage(a.path);
          blocks.push({ type: "image", mimeType, data });
        } catch (e) {
          pushItem(sid, { type: "notice", id: uid(), text: String(e), tone: "warn" });
        }
      }
      const shown = [text, picked ? `↳ ${picked.selector}` : "", variants > 1 ? `↳ ${variants} Varianten` : ""].filter(Boolean).join("\n");
      const started = Date.now();
      patchSession(sid, (s) => ({ ...s, running: true, turnStarted: started, items: [...s.items, { type: "user", id: uid(), text: shown, attachments: images }] }));
      try {
        const res = await api.prompt(sid, blocks);
        pushItem(sid, { type: "turn", id: uid(), stopReason: res.stopReason, ms: Date.now() - started, tokens: res.usage?.totalTokens });
      } catch (e) {
        pushItem(sid, { type: "notice", id: uid(), text: String(e), tone: "error" });
      } finally {
        patchSession(sid, (s) => ({ ...s, running: false, turnStarted: undefined }));
      }
      if (get().activeId !== meta.id) return;
      await get().refreshFiles();
      if (variants > 1 && entries(get().files).length > 1) set({ mode: { kind: "compare" } });
      await get().snapshot(text.split("\n")[0].slice(0, 70));
    },

    async cancel() {
      const sid = active()?.sessionId;
      if (sid) await api.cancel(sid);
    },

    async snapshot(label) {
      const meta = active();
      if (!meta) return;
      const files = await designApi.list(meta.id);
      if (!entries(files).length) return;
      const sig = signature(files);
      if (meta.versions[meta.versions.length - 1]?.sig === sig) return;
      const n = (meta.versions[meta.versions.length - 1]?.n ?? 0) + 1;
      await designApi.copy(meta.id, `${meta.id}/.versions/${n}`, MANAGED, true);
      await get().saveMeta({ ...meta, versions: [...meta.versions, { n, label, at: Date.now(), sig }] });
      // Vorschaubild für andere Sessions (MCP-Werkzeug read_design).
      const main = entries(files)[0];
      if (main)
        captureEntry(meta.id, main.entry, tokensCss(systemOf(meta)), "desktop", "light")
          .then((url) => designApi.writeBase64(`${meta.id}/preview.png`, url.split(",")[1]))
          .catch(() => {});
    },

    async restore(n) {
      const meta = active();
      if (!meta) return;
      await designApi.copy(`${meta.id}/.versions/${n}`, meta.id, MANAGED, true);
      await writeTokens(meta);
      set({ mode: { kind: "single" } });
      await get().refreshFiles();
      await get().snapshot(`Version ${n} wiederhergestellt`);
    },

    async promote(entry) {
      const meta = active();
      if (!meta) return;
      const dir = entry.split("/").slice(0, -1).join("/");
      if (!dir) return;
      await designApi.copy(`${meta.id}/${dir}`, meta.id, [], false);
      // Relative Verweise aus dem Variantenordner (../../tokens.css) passen im Hauptordner nicht mehr.
      const file = entry.split("/").pop()!;
      const html = await designApi.read(`${meta.id}/${file}`).catch(() => null);
      if (html != null) await designApi.write(`${meta.id}/${file}`, html.replace(/(["'(])(?:\.\.\/)+/g, "$1"));
      set({ mode: { kind: "single" }, entry: file });
      await get().refreshFiles();
      await get().snapshot(`Variante ${dir.split("/").pop()?.toUpperCase()} übernommen`);
    },

    async handoff({ project, criteria, notes, withVariants }) {
      const meta = active();
      if (!meta) throw new Error("Kein Design geöffnet");
      const sys = systemOf(meta);
      await writeTokens(meta);
      const list = entries(get().files);
      const main = list[0];
      if (!main) throw new Error("Das Design hat noch keine index.html.");

      // Screenshots außerhalb des Bildschirms rendern (Desktop und Mobil, hell).
      const shots: string[] = [];
      for (const device of ["desktop", "mobile"] as Device[]) {
        try {
          const url = await captureEntry(meta.id, main.entry, tokensCss(sys), device, "light");
          await designApi.writeBase64(`${meta.id}/handoff/screenshot-${device}.png`, url.split(",")[1]);
          shots.push(`handoff/screenshot-${device}.png`);
        } catch (e) {
          console.warn("Screenshot fehlgeschlagen", e);
        }
      }
      const designNotes = await designApi.read(`${meta.id}/notes.md`).catch(() => "");
      const target = `.brise/design/${slug(meta.name)}`;
      const files = get()
        .files.map((f) => f.path)
        .filter((p) => !p.startsWith(".") && (withVariants || !p.startsWith("variants/")) && !p.startsWith("handoff/"));
      const refs = files.filter((p) => p.startsWith("refs/"));
      const prompt = [
        `Auftrag: Design „${meta.name}“ umsetzen`,
        `Im Design-Modus von Brise ist ein Design entstanden. Setze es in **diesem Projekt** mit seinem echten Code-Stack um (vorhandenes Framework, Komponenten, Styling-Lösung, Routing). Das HTML ist die visuelle Referenz – nicht 1:1 kopieren, sondern sauber in die bestehende Struktur einbauen.`,
        `## Design-Dateien`,
        `Eine Kopie liegt in \`${target}/\` (per .gitignore vom Repository ausgeschlossen):`,
        files
          .filter((p) => !p.startsWith("refs/"))
          .map((p) => `- \`${target}/${p}\`${p === main.entry ? " – Hauptdesign" : p === "notes.md" ? " – Beschreibung vom Design-Agenten" : p.startsWith("tokens.") ? " – Design-Tokens" : ""}`)
          .join("\n"),
        shots.length ? `Screenshots (hängen auch an dieser Nachricht): ${shots.map((s) => `\`${target}/${s}\``).join(", ")}` : "",
        refs.length ? `Vorlagen/Referenzbilder: ${refs.map((s) => `\`${target}/${s}\``).join(", ")}` : "",
        `## Design-Tokens`,
        tokensSummary(sys),
        `Bilde die Tokens im Theme des Projekts ab (Tailwind-Konfiguration, CSS-Variablen, Theme-Datei …). Gleichwertige vorhandene Tokens wiederverwenden statt doppelt anlegen.`,
        designNotes.trim() ? `## Beschreibung aus dem Design\n${designNotes.trim()}` : "",
        notes.trim() ? `## Hinweise\n${notes.trim()}` : "",
        `## Akzeptanzkriterien`,
        criteria.map((c) => `- [ ] ${c}`).join("\n"),
        `## Vorgehen`,
        [
          `1. Lies die Design-Dateien und sieh dir die Screenshots an.`,
          `2. Finde heraus, wo das Design im Projekt hingehört (bestehende Seiten, Komponenten, Routing), und plane kurz.`,
          `3. Setze es mit echten Komponenten und den Tokens um – responsiv von Mobil bis Desktop.`,
          `4. Prüfe gegen die Akzeptanzkriterien (Build, Lint, Tests ausführen) und berichte, was erledigt ist und was offen bleibt.`,
        ].join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n");
      await designApi.write(`${meta.id}/handoff/AUFTRAG.md`, prompt);
      const exported = await designApi.exportTo(meta.id, project, target, withVariants ? [] : ["variants"]);

      const attachments: Attachment[] = shots.map((s) => ({ kind: "image", path: `${exported}/${s}`, name: s.split("/").pop()! }));
      const record = { project, at: Date.now(), path: exported };
      await get().saveMeta({ ...meta, handoffs: [...meta.handoffs, record] });

      handoffToSession(project, prompt, attachments, (id) => {
        const m = get().designs.find((d) => d.id === meta.id);
        if (m) get().saveMeta({ ...m, handoffs: m.handoffs.map((h) => (h.at === record.at ? { ...h, sessionId: id } : h)) });
      });
      set({ handoffOpen: false });
    },
  };
});

// Live-Vorschau: abgeschlossene Dateiänderungen der Design-Session laden die Vorschau neu.
let editCount = 0;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((st, prev) => {
  const d = useDesign.getState();
  const sid = d.designs.find((x) => x.id === d.activeId)?.sessionId;
  if (!sid || st.sessions[sid] === prev.sessions[sid]) return;
  const items = st.sessions[sid]?.items ?? [];
  const done = items.filter((i) => i.type === "tool" && i.status === "completed" && (i.kind === "edit" || i.kind === "delete" || i.kind === "move" || i.diffs.length > 0)).length;
  if (done === editCount) return;
  editCount = done;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => useDesign.getState().refreshFiles(), 250);
});
