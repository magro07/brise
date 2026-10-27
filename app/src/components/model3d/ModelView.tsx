import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Axis3d,
  Box,
  Boxes,
  Camera,
  Cog,
  Columns3,
  FileCode2,
  Grid3x3,
  History,
  MousePointerClick,
  Pencil,
  Printer,
  RefreshCw,
  RotateCcw,
  Ruler,
  Send,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { basename, useStore } from "../../lib/store";
import { relativeTime } from "../../lib/format";
import { askText } from "../../lib/dialogs";
import { fileSlug } from "../../lib/handoff";
import { modelAbs, modelApi, modelEntries, outputOf } from "../../lib/model3d";
import { criteriaFromNotes } from "../design/designStore";
import { Conversation } from "../chat/Conversation";
import { PermissionPrompt } from "../composer/Pinned";
import { Composer } from "../composer/Composer";
import { SidePanel } from "../panels/SidePanel";
import { TerminalPanel } from "../tools/Terminal";
import { ProjectMenu, SplitMenu, SplitSession, WorkTabs, useSplitFocus } from "../workbench/parts";
import { Button, IconButton, Logo, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Spinner, clsx } from "../ui";
import { DEFAULT_CRITERIA_3D, ext, useModel } from "./modelStore";
import { Viewport, type ViewportHandle } from "./Viewport";
import { newModel } from "./Sidebar";

const STARTERS = [
  { icon: Cog, title: "Technisches Teil", prompt: "Modelliere eine Wandhalterung für ein Smartphone (75 × 155 × 9 mm) mit zwei Schraublöchern (4 mm), 2,5 mm Wandstärke, druckbar ohne Stützen. Parameter für Gerätemaße als Regler." },
  { icon: Boxes, title: "Web-Asset", prompt: "Modelliere eine stilisierte Low-Poly-Kaffeetasse mit Untertasse für eine Landingpage: weiche Farben, benannte Teile, etwa 90 mm hoch." },
  { icon: Box, title: "Gehäuse", prompt: "Modelliere ein zweiteiliges Gehäuse für einen Raspberry Pi 5 mit Lüftungsschlitzen, Aussparungen für USB-C, 2× Micro-HDMI, USB und Ethernet. Deckel und Boden als getrennte Teile." },
  { icon: Printer, title: "3D-Druck", prompt: "Modelliere einen parametrischen Kabelhalter für die Tischkante (Tischstärke 18–40 mm als Regler), drei Kabelschlitze, druckbar flach auf dem Bett." },
];

/** Der 3D-Modus: links der Chat mit dem Agenten, rechts Viewer, Code und Dateien. */
export function ModelView() {
  const ready = useModel((s) => s.ready);
  const activeId = useModel((s) => s.activeId);
  const phase = useStore((s) => s.phase);

  useEffect(() => {
    useModel.getState().init().catch((e) => useStore.setState({ error: `3D-Modus: ${e}` }));
  }, []);
  useEffect(() => {
    const id = useModel.getState().activeId;
    if (phase === "ready" && id && ready) useModel.getState().open(id);
  }, [phase === "ready", ready]);

  const activeSession = useActiveModelSession();
  if (!ready) return <div className="flex flex-1 items-center justify-center text-muted">Lade Modelle …</div>;
  return (
    <div data-brise="model3d" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ModelTabs />
      <div className="flex min-h-0 min-w-0 flex-1">
        {activeId ? <Workbench key={activeId} /> : <ModelHome />}
        <SidePanel session={activeSession} />
      </div>
      <WorkTerminal />
      <HandoffDialog3D />
    </div>
  );
}

function useActiveModelSession() {
  const sid = useModel((s) => s.models.find((m) => m.id === s.activeId)?.sessionId);
  return useStore((s) => (sid ? s.sessions[sid] : undefined));
}

function ModelTabs() {
  const tabs = useModel((s) => s.tabs);
  const models = useModel((s) => s.models);
  const activeId = useModel((s) => s.activeId);
  const sessions = useStore((s) => s.sessions);
  const list = tabs.flatMap((id) => {
    const m = models.find((x) => x.id === id);
    return m ? [{ id, name: m.name, session: m.sessionId ? sessions[m.sessionId] : undefined }] : [];
  });
  const { open, closeTab } = useModel.getState();
  return <WorkTabs tabs={list} active={activeId} icon={<Box />} onOpen={open} onClose={closeTab} onNew={() => newModel()} newLabel="Neues Modell" />;
}

function ModelHome() {
  const models = useModel((s) => s.models);
  const tools = useModel((s) => s.tools);
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-14" data-tauri-drag-region>
      <Logo size={44} />
      <h1 className="mt-4 text-[1.6em] font-semibold tracking-tight">Was modellieren wir?</h1>
      <p className="mt-1 max-w-[580px] text-center text-muted">
        Bauteile, Gehäuse und Assets als Code modellieren, live im Viewer drehen, Teile anklicken und ändern lassen, Varianten vergleichen und das Modell als glTF oder STL an
        eine Coding-Session übergeben.
      </p>
      <div className="mt-3 flex flex-wrap justify-center gap-1.5 text-[0.8em]">
        <ToolBadge label="three.js" ok title="Standard: model.js, läuft in Brise" />
        <ToolBadge label="OpenSCAD" ok={!!tools.openscad} title={tools.openscad ?? "Nicht gefunden – optional (openscad.org)"} />
        <ToolBadge label="Blender" ok={!!tools.blender} title={tools.blender ?? "Nicht gefunden – optional (blender.org)"} />
      </div>
      <div className="mt-8 grid w-full max-w-[720px] grid-cols-2 gap-2.5">
        {STARTERS.map((s) => (
          <button
            key={s.title}
            onClick={() => newModel(s.prompt)}
            title={s.prompt}
            className="flex items-start gap-3 rounded-xl border border-line bg-elev px-4 py-3 text-left transition hover:border-line-strong hover:shadow-soft"
          >
            <s.icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <div className="min-w-0">
              <div className="font-medium">{s.title}</div>
              <div className="line-clamp-2 text-[0.86em] text-muted">{s.prompt}</div>
            </div>
          </button>
        ))}
      </div>
      <Button variant="primary" size="lg" className="mt-5" onClick={() => newModel()}>
        <Sparkles className="h-4 w-4" /> Leeres Modell
      </Button>
      {models.length > 0 && (
        <div className="mt-10 w-full max-w-[720px]">
          <div className="mb-1.5 text-[0.78em] font-medium uppercase tracking-wide text-muted">Zuletzt</div>
          <div className="overflow-hidden rounded-xl border border-line bg-elev">
            {models.slice(0, 8).map((m) => (
              <button key={m.id} onClick={() => useModel.getState().open(m.id)} className="flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left last:border-0 hover:bg-hover">
                <Box className="h-4 w-4 text-muted" />
                <span className="font-medium">{m.name}</span>
                <span className="flex-1" />
                <span className="text-[0.82em] text-muted">
                  {m.versions.length} Versionen · {relativeTime(new Date(m.updated).toISOString())}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolBadge({ label, ok, title }: { label: string; ok: boolean; title: string }) {
  return (
    <span title={title} className={clsx("rounded-full border px-2 py-0.5", ok ? "border-ok/40 text-ok" : "border-line text-muted")}>
      {ok ? "✓" : "–"} {label}
    </span>
  );
}

function Workbench() {
  const meta = useModel((s) => s.models.find((m) => m.id === s.activeId))!;
  const session = useStore((s) => (meta.sessionId ? s.sessions[meta.sessionId] : undefined));
  const [width, setWidth] = useState(() => Number(localStorage.getItem("brise.model.chatWidth")) || 360);
  const pending = session?.pending[0];
  const split = useModel((s) => s.splitSession);

  const drag = (e: React.MouseEvent) => {
    const start = e.clientX;
    const w0 = width;
    const move = (ev: MouseEvent) => setWidth(Math.min(640, Math.max(300, w0 + ev.clientX - start)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setWidth((w) => (localStorage.setItem("brise.model.chatWidth", String(w)), w));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <>
      <div className="flex min-h-0 shrink-0 flex-col border-r border-line" style={{ width }} onMouseDownCapture={() => useSplitFocus.setState({ on: false })}>
        <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line px-3" data-tauri-drag-region>
          <Box className="h-4 w-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate font-medium">{meta.name}</span>
          <ProjectMenu value={meta.project} onChange={(p) => useModel.getState().setProject(meta.id, p)} />
          <IconButton
            label="Umbenennen"
            size="sm"
            onClick={async () => {
              const name = await askText("Neuer Name", meta.name);
              if (name) useModel.getState().rename(meta.id, name);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Alle Modelle" size="sm" onClick={() => useModel.setState({ activeId: null })}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
        {session && session.items.length > 0 ? (
          <Conversation session={session} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-y-auto p-4">
            <div className="mb-1 text-[0.84em] text-muted">{session ? "Beschreibe das Modell – oder fang mit einem Vorschlag an:" : "Verbinde mit Vibe …"}</div>
            {session &&
              STARTERS.map((s) => (
                <button
                  key={s.title}
                  onClick={() => useModel.getState().send(s.prompt, [], 1)}
                  className="rounded-lg border border-line bg-elev px-3 py-2 text-left text-[0.88em] hover:border-line-strong"
                >
                  <span className="font-medium">{s.title}:</span> <span className="text-muted">{s.prompt}</span>
                </button>
              ))}
          </div>
        )}
        <div className="shrink-0 px-3 pb-3">
          {session && pending ? <PermissionPrompt session={session} pending={pending} /> : <ModelComposer />}
        </div>
      </div>
      <div className="w-1 shrink-0 cursor-col-resize hover:bg-accent/40" onMouseDown={drag} role="separator" aria-label="Breite des Chats ändern" />
      <Stage />
      {split && <SplitSession id={split} onClose={() => useModel.setState({ splitSession: null })} />}
    </>
  );
}

function Stage() {
  const meta = useModel((s) => s.models.find((m) => m.id === s.activeId))!;
  const files = useModel((s) => s.files);
  const entry = useModel((s) => s.entry);
  const mode = useModel((s) => s.mode);
  const tab = useModel((s) => s.tab);
  const picking = useModel((s) => s.picking);
  const shown = useModel((s) => s.shown);
  const build = useModel((s) => s.build);
  const params = useModel((s) => (s.entry ? s.params[s.entry] : undefined));
  const { wireframe, bbox, grid, zUp } = useModel();
  const { set, refreshFiles, restore, rebuild } = useModel.getState();
  const list = modelEntries(files);
  const current = list.find((e) => e.entry === entry);
  const version = mode.kind === "version" ? meta.versions.find((v) => v.n === mode.n) : undefined;
  const handle = useRef<ViewportHandle | null>(null);
  const state = entry ? build[entry] : undefined;
  const flags = { wireframe, bbox, grid };

  const screenshot = async () => {
    const url = handle.current?.screenshot(1600, 1200);
    if (!url) return;
    const abs = await modelApi.writeBase64(`${meta.id}/refs/screenshot-${Date.now().toString(36)}.png`, url.split(",")[1]);
    const sid = meta.sessionId;
    if (sid)
      useStore.setState((st) =>
        st.sessions[sid] ? { sessions: { ...st.sessions, [sid]: { ...st.sessions[sid], items: [...st.sessions[sid].items, { type: "notice", id: `shot-${Date.now()}`, text: `Screenshot gespeichert: ${abs}`, tone: "info" }] } } } : {},
      );
  };

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2" data-tauri-drag-region>
        <Segment
          value={tab}
          onChange={(t) => set({ tab: t })}
          items={[
            { id: "view", label: "Ansicht" },
            { id: "code", label: "Code" },
            { id: "files", label: "Dateien" },
          ]}
        />
        {state?.status === "building" && (
          <span className="ml-2 flex items-center gap-1.5 text-[0.84em] text-muted">
            <Spinner /> baut …
          </span>
        )}
        <div className="flex-1" />
        <SplitMenu
          project={meta.project}
          current={useModel((s) => s.splitSession)}
          lastHandoff={meta.handoffs[meta.handoffs.length - 1]?.sessionId}
          onPick={(id) => set({ splitSession: id })}
        />
        <Button variant="primary" size="sm" disabled={!list.length} onClick={() => set({ handoffOpen: true })} title="Modell ins Projekt kopieren und eine Coding-Session mit Einbindungsauftrag starten">
          <Send className="h-3.5 w-3.5" /> <span className="hidden @[560px]:inline">An Session übergeben</span>
          <span className="@[560px]:hidden">Übergeben</span>
        </Button>
      </div>
      {tab === "view" && (
        <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-2">
          {list.length > 1 && mode.kind !== "version" && (
            <select
              value={mode.kind === "compare" ? "" : (entry ?? "")}
              onChange={(e) => set(e.target.value ? { entry: e.target.value, mode: { kind: "single" } } : { mode: { kind: "compare" } })}
              className="h-8 max-w-[180px] rounded-lg border border-line bg-elev px-2 text-[0.9em] outline-none"
              aria-label="Variante"
            >
              {list.map((e) => (
                <option key={e.entry} value={e.entry}>
                  {e.name}
                </option>
              ))}
              <option value="">Alle vergleichen</option>
            </select>
          )}
          <IconButton label="Varianten nebeneinander" active={mode.kind === "compare"} disabled={list.length < 2} onClick={() => set({ mode: mode.kind === "compare" ? { kind: "single" } : { kind: "compare" } })}>
            <Columns3 className="h-4 w-4" />
          </IconButton>
          <IconButton label="Drahtgitter" active={wireframe} onClick={() => set({ wireframe: !wireframe })}>
            <Grid3x3 className="h-4 w-4" />
          </IconButton>
          <IconButton label="Maße (Bounding Box)" active={bbox} onClick={() => set({ bbox: !bbox })}>
            <Ruler className="h-4 w-4" />
          </IconButton>
          <IconButton label="Raster" active={grid} onClick={() => set({ grid: !grid })}>
            <Square className="h-4 w-4" />
          </IconButton>
          <IconButton label="Z zeigt nach oben (CAD/3D-Druck)" active={!!(entry && zUp[entry])} disabled={!entry} onClick={() => entry && set({ zUp: { ...zUp, [entry]: !zUp[entry] } })}>
            <Axis3d className="h-4 w-4" />
          </IconButton>
          <Menu>
            <MenuTrigger asChild>
              <button className="flex h-8 items-center rounded-md px-2 text-[0.86em] text-muted hover:bg-hover hover:text-fg">Ansicht</button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => handle.current?.frame()}>Einpassen</MenuItem>
              <MenuItem onSelect={() => handle.current?.view("front")}>Vorne</MenuItem>
              <MenuItem onSelect={() => handle.current?.view("top")}>Oben</MenuItem>
              <MenuItem onSelect={() => handle.current?.view("right")}>Rechts</MenuItem>
              <MenuItem onSelect={() => handle.current?.view("iso")}>Schräg</MenuItem>
            </MenuContent>
          </Menu>
          <IconButton label="Teil anklicken und gezielt ändern" active={picking} disabled={!current} onClick={() => set({ picking: !picking, mode: mode.kind === "compare" ? { kind: "single" } : mode })}>
            <MousePointerClick className="h-4 w-4" />
          </IconButton>
          <IconButton label="Screenshot speichern (refs/)" disabled={!current} onClick={screenshot}>
            <Camera className="h-4 w-4" />
          </IconButton>
          <IconButton label="Neu bauen" onClick={() => (entry ? rebuild(entry, true) : refreshFiles())}>
            <RefreshCw className="h-4 w-4" />
          </IconButton>
          <div className="flex-1" />
          <VersionsMenu />
        </div>
      )}

      {tab === "code" ? (
        <CodeView />
      ) : tab === "files" ? (
        <FilesView />
      ) : !list.length && mode.kind !== "version" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted">
          <Box className="h-8 w-8" />
          <span>Noch kein Modell. Beschreibe links, was entstehen soll.</span>
        </div>
      ) : mode.kind === "compare" ? (
        <div className="grid min-h-0 flex-1 auto-rows-fr gap-px bg-line" style={{ gridTemplateColumns: `repeat(${list.length > 2 ? 2 : list.length}, minmax(0, 1fr))` }}>
          {list.map((e) => (
            <div key={e.entry} className="flex min-h-0 min-w-0 flex-col bg-bg">
              <div className="flex h-8 items-center gap-2 px-3 text-[0.84em]">
                <span className="font-medium">{e.name}</span>
                <span className="flex-1" />
                {e.dir && (
                  <button className="text-accent hover:underline" onClick={() => useModel.getState().promote(e.entry)}>
                    Übernehmen
                  </button>
                )}
                <button className="text-muted hover:text-fg" onClick={() => set({ entry: e.entry, mode: { kind: "single" } })}>
                  Öffnen
                </button>
              </div>
              <Viewport entry={e.entry} bytes={shown[e.entry]?.bytes ?? null} ext={shown[e.entry]?.ext ?? "glb"} n={shown[e.entry]?.n ?? 0} {...flags} zUp={!!zUp[e.entry]} compact />
            </div>
          ))}
        </div>
      ) : version ? (
        <VersionCompare n={version.n} label={version.label} at={version.at} onRestore={() => restore(version.n)} onBack={() => set({ mode: { kind: "single" } })} />
      ) : (
        current && (
          <div className="relative flex min-h-0 flex-1">
            <Viewport
              entry={current.entry}
              bytes={shown[current.entry]?.bytes ?? null}
              ext={shown[current.entry]?.ext ?? "glb"}
              n={shown[current.entry]?.n ?? 0}
              {...flags}
              zUp={!!zUp[current.entry]}
              picking={picking}
              onPick={(p) => set({ picked: p })}
              onLoaded={(info, shot) => useModel.getState().savePreview(current.entry, shot(), info)}
              handle={(h) => (handle.current = h)}
            />
            {params && params.length > 0 && <ParamsPanel entry={current.entry} />}
          </div>
        )
      )}
      {tab === "view" && state?.status === "error" && (
        <div className="flex shrink-0 items-start gap-2 border-t border-line bg-bad-soft px-3 py-1.5 text-[0.84em] text-bad">
          <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap selectable" title={state.error}>
            Bau fehlgeschlagen: {state.error}
          </span>
          <Button
            size="sm"
            onClick={() => useModel.getState().send(`Der Bau von \`${entry}\` meldet diesen Fehler, bitte beheben:\n${state.error}${state.logs?.length ? `\nAusgaben:\n${state.logs.join("\n")}` : ""}`, [], 1)}
          >
            Beheben lassen
          </Button>
        </div>
      )}
    </div>
  );
}

/** Regler aus `export const params` – ändern das Modell sofort, der Agent bekommt die Werte mit der nächsten Nachricht. */
function ParamsPanel({ entry }: { entry: string }) {
  const specs = useModel((s) => s.params[entry]) ?? [];
  const values = useModel((s) => s.models.find((m) => m.id === s.activeId)?.params?.[entry]) ?? {};
  const { setParam, resetParams } = useModel.getState();
  const [open, setOpen] = useState(true);
  return (
    <div className="absolute right-2 top-2 w-[240px] rounded-xl border border-line bg-elev/95 shadow-soft backdrop-blur">
      <button onClick={() => setOpen(!open)} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[0.84em] font-medium">
        <span className="flex-1">Regler</span>
        {Object.keys(values).length > 0 && (
          <span
            role="button"
            title="Auf Standardwerte zurücksetzen"
            onClick={(e) => (e.stopPropagation(), resetParams(entry))}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </span>
        )}
      </button>
      {open && (
        <div className="max-h-[50vh] space-y-2 overflow-y-auto px-3 pb-3">
          {specs.map((s) => {
            const v = values[s.name] ?? s.value;
            return (
              <label key={s.name} className="block text-[0.82em]">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-fg-2">{s.label}</span>
                  {s.type === "number" && <span className="font-mono text-muted">{String(v)}</span>}
                </span>
                {s.type === "number" ? (
                  <input type="range" min={s.min} max={s.max} step={s.step} value={Number(v)} onChange={(e) => setParam(entry, s.name, Number(e.target.value))} className="w-full accent-[var(--accent)]" />
                ) : s.type === "boolean" ? (
                  <input type="checkbox" checked={!!v} onChange={(e) => setParam(entry, s.name, e.target.checked)} className="mt-1" />
                ) : (
                  <select value={String(v)} onChange={(e) => setParam(entry, s.name, e.target.value)} className="mt-1 h-7 w-full rounded-md border border-line bg-bg px-1">
                    {s.options?.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VersionCompare({ n, label, at, onRestore, onBack }: { n: number; label: string; at: number; onRestore: () => void; onBack: () => void }) {
  const meta = useModel((s) => s.models.find((m) => m.id === s.activeId))!;
  const files = useModel((s) => s.files);
  const entry = useModel((s) => s.entry);
  const shown = useModel((s) => (s.entry ? s.shown[s.entry] : undefined));
  const { wireframe, bbox, grid, zUp } = useModel();
  const [old, setOld] = useState<{ bytes: ArrayBuffer; ext: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const main = modelEntries(files)[0];
    if (!main) return;
    const out = outputOf(main);
    modelApi.bytes(`${meta.id}/.versions/${n}/${out}`).then(
      (bytes) => setOld({ bytes, ext: ext(out) }),
      () => setError(`Version ${n} hat keine gebaute Datei (${out}).`),
    );
  }, [n]);
  const flags = { wireframe, bbox, grid, zUp: !!(entry && zUp[entry]) };
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-accent-soft px-3 py-1.5 text-[0.88em]">
        <History className="h-4 w-4 text-accent" />
        <span className="min-w-0 flex-1 truncate">
          <b>Version {n}</b> · {label || "ohne Titel"} · {relativeTime(new Date(at).toISOString())}
        </span>
        <Button size="sm" variant="primary" onClick={onRestore}>
          Wiederherstellen
        </Button>
        <Button size="sm" variant="ghost" onClick={onBack}>
          Zur aktuellen
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-line">
          <div className="px-3 py-1 text-[0.78em] text-muted">Version {n}</div>
          {error ? <div className="p-4 text-[0.88em] text-muted">{error}</div> : <Viewport entry={`v${n}`} bytes={old?.bytes ?? null} ext={old?.ext ?? "glb"} n={n} {...flags} compact />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="px-3 py-1 text-[0.78em] text-muted">Aktuell</div>
          <Viewport entry={entry ?? ""} bytes={shown?.bytes ?? null} ext={shown?.ext ?? "glb"} n={shown?.n ?? 0} {...flags} compact />
        </div>
      </div>
    </>
  );
}

function Segment<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[] }) {
  return (
    <div className="flex h-8 items-center rounded-lg bg-hover p-0.5">
      {items.map((i) => (
        <button
          key={i.id}
          onClick={() => onChange(i.id)}
          className={clsx("h-7 whitespace-nowrap rounded-md px-2.5 text-[0.88em]", value === i.id ? "bg-elev font-medium text-fg shadow-soft" : "text-muted hover:text-fg")}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

function VersionsMenu() {
  const meta = useModel((s) => s.models.find((m) => m.id === s.activeId))!;
  const mode = useModel((s) => s.mode);
  const versions = [...meta.versions].reverse();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className={clsx("flex h-8 items-center gap-1 rounded-md px-2 text-[0.88em] text-muted hover:bg-hover hover:text-fg", mode.kind === "version" && "bg-active text-fg")} aria-label="Versionen">
          <History className="h-4 w-4" />
          {meta.versions.length > 0 && <span>{meta.versions.length}</span>}
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="max-h-[60vh] w-[320px] overflow-y-auto">
        <MenuLabel>Versionen – nach jedem Turn mit Änderungen</MenuLabel>
        {versions.length === 0 && <div className="px-3 py-2 text-[0.86em] text-muted">Noch keine Versionen.</div>}
        {versions.map((v, i) => (
          <MenuItem key={v.n} onSelect={() => useModel.setState({ mode: i === 0 ? { kind: "single" } : { kind: "version", n: v.n } })}>
            <span className="flex w-[280px] items-baseline gap-2">
              <span className="font-medium">v{v.n}</span>
              <span className="min-w-0 flex-1 truncate">{v.label || "ohne Titel"}</span>
              <span className="text-[0.8em] text-muted">{i === 0 ? "aktuell" : relativeTime(new Date(v.at).toISOString())}</span>
            </span>
          </MenuItem>
        ))}
        {meta.handoffs.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>Übergaben</MenuLabel>
            {[...meta.handoffs].reverse().map((h) => (
              <MenuItem
                key={h.at}
                onSelect={() => {
                  const st = useStore.getState();
                  st.openProject(h.project);
                  if (h.sessionId) st.selectSession(h.sessionId);
                }}
              >
                <span className="flex w-[280px] items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate">{h.project.split(/[\\/]/).pop()}</span>
                  <span className="text-[0.8em] text-muted">{relativeTime(new Date(h.at).toISOString())}</span>
                </span>
              </MenuItem>
            ))}
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

/** Quellcode der angezeigten Einstiegsdatei. */
function CodeView() {
  const id = useModel((s) => s.activeId)!;
  const entry = useModel((s) => s.entry);
  const rev = useModel((s) => s.rev);
  const files = useModel((s) => s.files);
  const [content, setContent] = useState("");
  const e = modelEntries(files).find((x) => x.entry === entry);
  const path = e?.kind === "file" ? (files.find((f) => /(^|\/)model\.py$/.test(f.path))?.path ?? null) : (e?.entry ?? null);
  useEffect(() => {
    if (path) modelApi.read(`${id}/${path}`).then(setContent, (err) => setContent(String(err)));
    else setContent("");
  }, [path, rev]);
  if (!path) return <div className="flex flex-1 items-center justify-center text-muted">Keine Quelle – das Modell ist eine fertige Datei.</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line px-3 py-1 font-mono text-[0.8em] text-muted">{path}</div>
      <pre className="min-h-0 flex-1 overflow-auto bg-code p-4 font-mono text-[0.82em] leading-relaxed selectable">{content}</pre>
    </div>
  );
}

function FilesView() {
  const files = useModel((s) => s.files);
  const id = useModel((s) => s.activeId)!;
  const rev = useModel((s) => s.rev);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const path = selected ?? files.find((f) => f.path === "notes.md")?.path ?? files[0]?.path ?? null;
  const binary = path ? /\.(glb|stl|3mf|png|jpe?g|webp)$/i.test(path) : false;
  useEffect(() => {
    if (!path || binary) return setContent("");
    modelApi.read(`${id}/${path}`).then(setContent, (e) => setContent(String(e)));
  }, [path, rev]);
  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-56 shrink-0 overflow-y-auto border-r border-line p-2">
        {files.map((f) => (
          <button
            key={f.path}
            onClick={() => setSelected(f.path)}
            className={clsx("flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[0.86em] hover:bg-hover", f.path === path && "bg-active")}
          >
            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate">{f.path}</span>
            <span className="text-[0.8em] text-muted">{f.size > 1024 ? `${Math.round(f.size / 1024)} kB` : `${f.size} B`}</span>
          </button>
        ))}
        <div className="mt-2 break-all px-2 text-[0.74em] text-muted">Ordner: …/3d/{id}</div>
      </div>
      {binary ? (
        <div className="flex flex-1 items-center justify-center text-[0.9em] text-muted">Binärdatei – Anzeige im Tab „Ansicht“.</div>
      ) : (
        <pre className="min-w-0 flex-1 overflow-auto bg-code p-4 font-mono text-[0.82em] leading-relaxed selectable">{content}</pre>
      )}
    </div>
  );
}

/** Eingabe im 3D-Modus: der Code-Composer mit ausgewähltem Teil und Anzahl Varianten. */
function ModelComposer() {
  const meta = useModel((s) => s.models.find((m) => m.id === s.activeId))!;
  const session = useStore((s) => (meta.sessionId ? s.sessions[meta.sessionId] : undefined));
  const picked = useModel((s) => s.picked);
  const picking = useModel((s) => s.picking);
  const splitFocus = useSplitFocus((s) => s.on);
  const [variants, setVariants] = useState(1);
  return (
    <Composer
      session={session}
      project={meta.project ?? modelAbs(meta.id)}
      focused={!splitFocus}
      exclude={meta.id}
      disabled={!session}
      focusKey={picked}
      placeholder={
        !session
          ? "Verbinde mit dem Agenten …"
          : picked
            ? "Was soll sich an diesem Teil ändern? (z. B. „Bohrung auf 5 mm“)"
            : "Beschreibe das Modell oder eine Änderung …  @ für Dateien, Projekte, Modelle, / für Befehle"
      }
      onSend={(text, attachments, opts) => {
        useModel.getState().send(text, attachments, variants, opts);
        setVariants(1);
      }}
      onCancel={() => useModel.getState().cancel()}
      onPasteImage={(name, data) => modelApi.writeBase64(`${meta.id}/refs/${Date.now().toString(36)}-${name.replace(/[^\w.-]+/g, "_")}`, data)}
      chips={
        picked && (
          <span className="inline-flex h-7 max-w-full items-center gap-1 rounded-lg border border-accent/50 bg-accent-soft px-2 text-[0.84em]" title={`${picked.size.join(" × ")} mm`}>
            <MousePointerClick className="h-3 w-3 shrink-0 text-accent" />
            <span className="truncate">{picked.path}</span>
            <button onClick={() => useModel.setState({ picked: null })} aria-label="Auswahl entfernen">
              <X className="h-3 w-3" />
            </button>
          </span>
        )
      }
      tools={
        <>
          <IconButton label="Teil im Viewer auswählen" active={picking} onClick={() => useModel.setState((s) => ({ picking: !s.picking, tab: "view" }))}>
            <MousePointerClick className="h-4 w-4" />
          </IconButton>
          <Menu>
            <MenuTrigger asChild>
              <button className={clsx("inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[0.86em] hover:bg-hover", variants > 1 ? "text-accent" : "text-fg-2")} aria-label="Varianten">
                <Columns3 className="h-3.5 w-3.5" /> <span className="hidden @[620px]:inline">{variants > 1 ? `${variants} Varianten` : "1 Entwurf"}</span>
                {variants > 1 && <span className="@[620px]:hidden">{variants}</span>}
              </button>
            </MenuTrigger>
            <MenuContent side="top">
              <MenuLabel>Wie viele Varianten?</MenuLabel>
              {[1, 2, 3, 4].map((n) => (
                <MenuItem key={n} onSelect={() => setVariants(n)} checked={variants === n}>
                  {n === 1 ? "Ein Entwurf" : `${n} Varianten zum Vergleichen`}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </>
      }
    />
  );
}

/** „An Session übergeben“: Modell ins Projekt kopieren und eine Coding-Session mit Einbindungsauftrag starten. */
function HandoffDialog3D() {
  const open = useModel((s) => s.handoffOpen);
  const meta = useModel((s) => s.models.find((m) => m.id === s.activeId));
  const projects = useStore((s) => s.projects);
  const [project, setProject] = useState("");
  const [format, setFormat] = useState<"glb" | "stl">("glb");
  const [target, setTarget] = useState("");
  const [notes, setNotes] = useState("");
  const [criteria, setCriteria] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !meta) return;
    setError(null);
    setBusy(false);
    const last = meta.handoffs[meta.handoffs.length - 1]?.project;
    // Standard: das zugeordnete Projekt.
    setProject(meta.project || last || useStore.getState().activeProject || projects[0] || "");
    modelApi
      .read(`${meta.id}/notes.md`)
      .catch(() => "")
      .then((n) => {
        const own = criteriaFromNotes(n);
        setCriteria([...own, ...DEFAULT_CRITERIA_3D.filter((c) => !own.includes(c))].join("\n"));
      });
  }, [open, meta?.id]);
  useEffect(() => {
    if (meta) setTarget(`public/models/${fileSlug(meta.name)}.${format}`);
  }, [format, meta?.id]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await useModel.getState().handoff({
        project,
        format,
        target: target.trim(),
        notes,
        criteria: criteria
          .split("\n")
          .map((c) => c.trim())
          .filter(Boolean),
      });
      setNotes("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };
  const choices = project && !projects.includes(project) ? [project, ...projects] : projects;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !busy && useModel.setState({ handoffOpen: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 fade-in" />
        <Dialog.Content className="fixed left-1/2 top-[10%] z-50 max-h-[80vh] w-[min(600px,92vw)] -translate-x-1/2 overflow-y-auto rounded-2xl border border-line bg-elev p-6 shadow-pop fade-in">
          <Dialog.Title className="flex items-center gap-2 text-[1.15em] font-semibold">
            <Send className="h-5 w-5 text-accent" /> An Session übergeben
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[0.9em] text-muted">
            Brise kopiert das Modell ins Projekt, legt Quellcode und Notizen nach <code className="font-mono">.brise/3d/</code> und startet dort eine neue Coding-Session mit dem
            Einbindungsauftrag.
          </Dialog.Description>
          <label className="mt-5 block text-[0.86em] font-medium">Projekt</label>
          <div className="mt-1 flex gap-2">
            <select value={project} onChange={(e) => setProject(e.target.value)} className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 outline-none focus:border-accent">
              {!project && <option value="">Projekt wählen …</option>}
              {choices.map((p) => (
                <option key={p} value={p}>
                  {basename(p)} – {p}
                </option>
              ))}
            </select>
            <Button
              className="h-10"
              onClick={async () => {
                const p = await openDialog({ directory: true, title: "Projektordner wählen" });
                if (typeof p === "string") setProject(p);
              }}
            >
              Ordner …
            </Button>
          </div>
          <div className="mt-4 flex gap-3">
            <div>
              <label className="block text-[0.86em] font-medium">Format</label>
              <select value={format} onChange={(e) => setFormat(e.target.value as "glb" | "stl")} className="mt-1 h-10 rounded-lg border border-line bg-bg px-2 outline-none focus:border-accent">
                <option value="glb">glTF (GLB) – Web, Spiele</option>
                <option value="stl">STL – 3D-Druck</option>
              </select>
            </div>
            <div className="min-w-0 flex-1">
              <label className="block text-[0.86em] font-medium">Ziel im Projekt</label>
              <input value={target} onChange={(e) => setTarget(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-line bg-bg px-3 font-mono text-[0.9em] outline-none focus:border-accent" />
            </div>
          </div>
          <label className="mt-4 block text-[0.86em] font-medium">Hinweise für die Einbindung</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="z. B. „Im Hero der Startseite, langsam drehend, mit react-three-fiber“"
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent"
          />
          <label className="mt-4 block text-[0.86em] font-medium">Akzeptanzkriterien (eins pro Zeile)</label>
          <textarea
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            rows={5}
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-[0.92em] outline-none focus:border-accent"
          />
          {error && <div className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-[0.86em] text-bad selectable">{error}</div>}
          <div className="mt-6 flex items-center justify-end gap-2">
            {busy && (
              <span className="mr-auto flex items-center gap-2 text-[0.86em] text-muted">
                <Spinner /> Modell wird kopiert …
              </span>
            )}
            <Button variant="ghost" onClick={() => useModel.setState({ handoffOpen: false })} disabled={busy}>
              Abbrechen
            </Button>
            <Button variant="primary" disabled={!project || !target.trim() || busy || !meta} onClick={run}>
              Session starten
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Terminal (Strg+`) wie im Code-Modus: im zugeordneten Projekt, sonst im Arbeitsordner. */
function WorkTerminal() {
  const meta = useModel((s) => s.models.find((x) => x.id === s.activeId));
  const cwd = meta ? (meta.project ?? modelAbs(meta.id)) : null;
  return cwd ? <TerminalPanel cwd={cwd} /> : null;
}
