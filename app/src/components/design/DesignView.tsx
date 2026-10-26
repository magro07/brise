import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowUp,
  Columns3,
  FileCode2,
  History,
  ImagePlus,
  LayoutTemplate,
  Monitor,
  Moon,
  MousePointerClick,
  Palette,
  PanelsTopLeft,
  Pencil,
  RefreshCw,
  Send,
  Smartphone,
  Sparkles,
  Square,
  Sun,
  Tablet,
  X,
} from "lucide-react";
import { api } from "../../lib/acp";
import { useStore, type Attachment } from "../../lib/store";
import { relativeTime } from "../../lib/format";
import { askText } from "../../lib/dialogs";
import { designApi, entries, tokensCss, type Device } from "../../lib/design";
import { Conversation } from "../chat/Conversation";
import { PermissionPrompt } from "../composer/Pinned";
import { Button, IconButton, Logo, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, clsx } from "../ui";
import { useDesign } from "./designStore";
import { CompareGrid, PreviewFrame } from "./Preview";
import { SystemEditor } from "./SystemEditor";
import { HandoffDialog } from "./Handoff";

const STARTERS = [
  { icon: PanelsTopLeft, title: "UI-Screen", prompt: "Entwirf einen Dashboard-Screen für eine Projektverwaltung: Seitenleiste, Kennzahlen oben, Tabelle mit Aufgaben, leerer Zustand." },
  { icon: Square, title: "Komponente", prompt: "Entwirf eine Preiskarten-Komponente mit drei Stufen (Monatlich/Jährlich-Umschalter, hervorgehobene Mitte, Hover- und Fokuszustände)." },
  { icon: LayoutTemplate, title: "Landingpage", prompt: "Entwirf eine Landingpage für eine Desktop-App: Hero mit Screenshot, drei Vorteile, Kundenstimmen, FAQ und Footer." },
  { icon: Palette, title: "Design-System", prompt: "Baue eine Styleguide-Seite für das Design-System: Farben, Typografie-Skala, Abstände, Buttons, Eingabefelder, Karten, Badges – jeweils mit Zuständen." },
];

/** Der Design-Modus: links der Chat mit dem Agenten, rechts Vorschau, Design-System und Dateien. */
export function DesignView() {
  const ready = useDesign((s) => s.ready);
  const activeId = useDesign((s) => s.activeId);
  const phase = useStore((s) => s.phase);

  useEffect(() => {
    useDesign.getState().init().catch((e) => useStore.setState({ error: `Design-Modus: ${e}` }));
  }, []);
  // Session erst öffnen, wenn Vibe verbunden ist.
  useEffect(() => {
    const id = useDesign.getState().activeId;
    if (phase === "ready" && id && ready) useDesign.getState().open(id);
  }, [phase === "ready", ready]);

  if (!ready) return <div className="flex flex-1 items-center justify-center text-muted">Lade Designs …</div>;
  return (
    <div data-brise="design" className="flex min-h-0 min-w-0 flex-1">
      {activeId ? <Workbench key={activeId} /> : <DesignHome />}
      <HandoffDialog />
    </div>
  );
}

export async function newDesign(prompt?: string) {
  const name = await askText("Name des Designs", "z. B. Preisseite");
  if (name == null) return;
  await useDesign.getState().create(name || "Neues Design");
  if (prompt) setTimeout(() => useDesign.getState().send(prompt, [], 1), 300);
}

function DesignHome() {
  const designs = useDesign((s) => s.designs);
  const open = useDesign((s) => s.open);
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-14" data-tauri-drag-region>
      <Logo size={44} />
      <h1 className="mt-4 text-[1.6em] font-semibold tracking-tight">Was gestalten wir?</h1>
      <p className="mt-1 max-w-[560px] text-center text-muted">
        Screens, Komponenten und Landingpages mit Live-Vorschau entwerfen, Varianten vergleichen und das Ergebnis an eine Coding-Session übergeben.
      </p>
      <div className="mt-8 grid w-full max-w-[720px] grid-cols-2 gap-2.5">
        {STARTERS.map((s) => (
          <button
            key={s.title}
            onClick={() => newDesign(s.prompt)}
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
      <Button variant="primary" size="lg" className="mt-5" onClick={() => newDesign()}>
        <Sparkles className="h-4 w-4" /> Leeres Design
      </Button>
      {designs.length > 0 && (
        <div className="mt-10 w-full max-w-[720px]">
          <div className="mb-1.5 text-[0.78em] font-medium uppercase tracking-wide text-muted">Zuletzt</div>
          <div className="overflow-hidden rounded-xl border border-line bg-elev">
            {designs.slice(0, 8).map((d) => (
              <button key={d.id} onClick={() => open(d.id)} className="flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left last:border-0 hover:bg-hover">
                <Palette className="h-4 w-4 text-muted" />
                <span className="font-medium">{d.name}</span>
                <span className="flex-1" />
                <span className="text-[0.82em] text-muted">
                  {d.versions.length} Versionen · {relativeTime(new Date(d.updated).toISOString())}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Workbench() {
  const meta = useDesign((s) => s.designs.find((d) => d.id === s.activeId))!;
  const session = useStore((s) => (meta.sessionId ? s.sessions[meta.sessionId] : undefined));
  const [width, setWidth] = useState(() => Number(localStorage.getItem("brise.design.chatWidth")) || 360);
  const pending = session?.pending[0];

  const drag = (e: React.MouseEvent) => {
    const start = e.clientX;
    const w0 = width;
    const move = (ev: MouseEvent) => setWidth(Math.min(640, Math.max(300, w0 + ev.clientX - start)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setWidth((w) => (localStorage.setItem("brise.design.chatWidth", String(w)), w));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <>
      <div className="flex min-h-0 shrink-0 flex-col border-r border-line" style={{ width }}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3" data-tauri-drag-region>
          <Palette className="h-4 w-4 text-accent" />
          <span className="min-w-0 flex-1 truncate font-medium">{meta.name}</span>
          <IconButton
            label="Umbenennen"
            size="sm"
            onClick={async () => {
              const name = await askText("Neuer Name", meta.name);
              if (name) useDesign.getState().rename(meta.id, name);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Alle Designs" size="sm" onClick={() => useDesign.setState({ activeId: null })}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
        {session && session.items.length > 0 ? (
          <Conversation session={session} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-y-auto p-4">
            <div className="mb-1 text-[0.84em] text-muted">{session ? "Beschreibe das Design – oder fang mit einem Vorschlag an:" : "Verbinde mit Vibe …"}</div>
            {session &&
              STARTERS.map((s) => (
                <button
                  key={s.title}
                  onClick={() => useDesign.getState().send(s.prompt, [], 1)}
                  className="rounded-lg border border-line bg-elev px-3 py-2 text-left text-[0.88em] hover:border-line-strong"
                >
                  <span className="font-medium">{s.title}:</span> <span className="text-muted">{s.prompt}</span>
                </button>
              ))}
          </div>
        )}
        <div className="shrink-0 px-3 pb-3">
          {session && pending ? <PermissionPrompt session={session} pending={pending} /> : <DesignComposer running={!!session?.running} />}
        </div>
      </div>
      <div className="w-1 shrink-0 cursor-col-resize hover:bg-accent/40" onMouseDown={drag} role="separator" aria-label="Breite des Chats ändern" />
      <Stage />
    </>
  );
}

const DEVICES: { id: Device; label: string; icon: typeof Monitor }[] = [
  { id: "mobile", label: "Mobil (390 px)", icon: Smartphone },
  { id: "tablet", label: "Tablet (820 px)", icon: Tablet },
  { id: "desktop", label: "Desktop", icon: Monitor },
];

function Stage() {
  const meta = useDesign((s) => s.designs.find((d) => d.id === s.activeId))!;
  const systems = useDesign((s) => s.systems);
  const files = useDesign((s) => s.files);
  const entry = useDesign((s) => s.entry);
  const device = useDesign((s) => s.device);
  const theme = useDesign((s) => s.theme);
  const mode = useDesign((s) => s.mode);
  const tab = useDesign((s) => s.tab);
  const picking = useDesign((s) => s.picking);
  const errors = useDesign((s) => s.previewErrors);
  const { set, refreshFiles, restore } = useDesign.getState();
  const sys = systems.find((s) => s.id === meta.systemId) ?? systems[0];
  const css = useMemo(() => (sys ? tokensCss(sys) : ""), [sys]);
  const list = entries(files);
  const version = mode.kind === "version" ? meta.versions.find((v) => v.n === mode.n) : undefined;

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2" data-tauri-drag-region>
        <Segment
          value={tab}
          onChange={(t) => set({ tab: t })}
          items={[
            { id: "preview", label: "Vorschau" },
            { id: "system", label: "Design-System" },
            { id: "files", label: "Dateien" },
          ]}
        />
        <div className="flex-1" />
        <Button variant="primary" size="sm" disabled={!list.length} onClick={() => set({ handoffOpen: true })} title="Neue Coding-Session mit vollständigem Auftrag in einem Projekt starten">
          <Send className="h-3.5 w-3.5" /> <span className="hidden @[560px]:inline">An Session übergeben</span>
          <span className="@[560px]:hidden">Übergeben</span>
        </Button>
      </div>
      {tab === "preview" && (
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
          <IconButton label="Varianten nebeneinander" active={mode.kind === "compare"} onClick={() => set({ mode: mode.kind === "compare" ? { kind: "single" } : { kind: "compare" } })}>
            <Columns3 className="h-4 w-4" />
          </IconButton>
          {DEVICES.map((d) => (
            <IconButton key={d.id} label={d.label} active={device === d.id} onClick={() => (set({ device: d.id }), localStorage.setItem("brise.design.device", JSON.stringify(d.id)))}>
              <d.icon className="h-4 w-4" />
            </IconButton>
          ))}
          <IconButton label={theme === "dark" ? "Hell anzeigen" : "Dunkel anzeigen"} onClick={() => set({ theme: theme === "dark" ? "light" : "dark" })}>
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </IconButton>
          <IconButton label="Element anklicken und gezielt ändern" active={picking} onClick={() => set({ picking: !picking, mode: mode.kind === "compare" ? { kind: "single" } : mode })} disabled={!list.length}>
            <MousePointerClick className="h-4 w-4" />
          </IconButton>
          <IconButton label="Neu laden" onClick={() => refreshFiles()}>
            <RefreshCw className="h-4 w-4" />
          </IconButton>
          <div className="flex-1" />
          <VersionsMenu />
        </div>
      )}

      {tab === "system" ? (
        <SystemEditor />
      ) : tab === "files" ? (
        <FilesView />
      ) : !list.length && mode.kind !== "version" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted">
          <PanelsTopLeft className="h-8 w-8" />
          <span>Noch keine Vorschau. Beschreibe links, was entstehen soll.</span>
        </div>
      ) : mode.kind === "compare" ? (
        <CompareGrid css={css} />
      ) : version ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-line bg-accent-soft px-3 py-1.5 text-[0.88em]">
            <History className="h-4 w-4 text-accent" />
            <span className="min-w-0 flex-1 truncate">
              <b>Version {version.n}</b> · {version.label || "ohne Titel"} · {relativeTime(new Date(version.at).toISOString())}
            </span>
            <Button size="sm" variant="primary" onClick={() => restore(version.n)}>
              Wiederherstellen
            </Button>
            <Button size="sm" variant="ghost" onClick={() => set({ mode: { kind: "single" } })}>
              Zur aktuellen
            </Button>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col border-r border-line">
              <div className="px-3 py-1 text-[0.78em] text-muted">Version {version.n}</div>
              <PreviewFrame base={`${meta.id}/.versions/${version.n}`} entry={list[0]?.entry ?? "index.html"} device={device} css={css} pickable={false} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="px-3 py-1 text-[0.78em] text-muted">Aktuell</div>
              {entry && <PreviewFrame base={meta.id} entry={entry} device={device} css={css} pickable={false} />}
            </div>
          </div>
        </>
      ) : (
        entry && <PreviewFrame base={meta.id} entry={entry} device={device} css={css} />
      )}
      {tab === "preview" && errors.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-bad-soft px-3 py-1.5 text-[0.84em] text-bad">
          <span className="min-w-0 flex-1 truncate selectable" title={errors.join("\n")}>
            Fehler in der Vorschau: {errors[errors.length - 1]}
          </span>
          <Button
            size="sm"
            onClick={() => {
              useDesign.setState({ previewErrors: [] });
              useDesign.getState().send(`Die Vorschau meldet diese Fehler, bitte beheben:\n${errors.join("\n")}`, [], 1);
            }}
          >
            Beheben lassen
          </Button>
          <button onClick={() => useDesign.setState({ previewErrors: [] })} aria-label="Ausblenden">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
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
  const meta = useDesign((s) => s.designs.find((d) => d.id === s.activeId))!;
  const mode = useDesign((s) => s.mode);
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
          <MenuItem key={v.n} onSelect={() => useDesign.setState({ mode: i === 0 ? { kind: "single" } : { kind: "version", n: v.n } })}>
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
                  if (h.sessionId) {
                    st.openProject(h.project);
                    st.selectSession(h.sessionId);
                  } else st.openProject(h.project);
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

function FilesView() {
  const files = useDesign((s) => s.files);
  const id = useDesign((s) => s.activeId)!;
  const rev = useDesign((s) => s.rev);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const path = selected ?? files.find((f) => f.path === "index.html")?.path ?? files[0]?.path ?? null;
  useEffect(() => {
    if (!path) return;
    if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path)) designApi.dataUrl(`${id}/${path}`).then(setContent, (e) => setContent(String(e)));
    else designApi.read(`${id}/${path}`).then(setContent, (e) => setContent(String(e)));
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
          </button>
        ))}
        <div className="mt-2 break-all px-2 text-[0.74em] text-muted">Ordner: {useDesign.getState().designs.find((d) => d.id === id) && `…/design/${id}`}</div>
      </div>
      {path && content.startsWith("data:image") ? (
        <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto p-6">
          <img src={content} alt={path} className="max-h-full max-w-full rounded border border-line" />
        </div>
      ) : (
        <pre className="min-w-0 flex-1 overflow-auto bg-code p-4 font-mono text-[0.82em] leading-relaxed selectable">{content}</pre>
      )}
    </div>
  );
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** Eingabe im Design-Modus: Text, Vorlagen-Bilder, ausgewähltes Element, Anzahl Varianten. */
function DesignComposer({ running }: { running: boolean }) {
  const id = useDesign((s) => s.activeId)!;
  const picked = useDesign((s) => s.picked);
  const [text, setText] = useState("");
  const [images, setImages] = useState<Attachment[]>([]);
  const [variants, setVariants] = useState(1);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  useEffect(() => {
    if (picked) ref.current?.focus();
  }, [picked]);

  // Bilder in den Design-Ordner kopieren, damit sie bei der Übergabe mitgehen.
  const addImage = async (name: string, data: string) => {
    const safe = name.replace(/[^\w.-]+/g, "_");
    const abs = await designApi.writeBase64(`${id}/refs/${Date.now().toString(36)}-${safe}`, data);
    setImages((l) => [...l, { kind: "image", path: abs, name }]);
  };
  const pick = async () => {
    const chosen = await openDialog({ multiple: true, title: "Vorlage oder Screenshot anhängen", filters: [{ name: "Bilder", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] });
    for (const p of Array.isArray(chosen) ? chosen : chosen ? [chosen] : []) {
      if (!IMAGE_EXT.test(p)) continue;
      const [, data] = await api.readImage(p);
      await addImage(p.split(/[\\/]/).pop()!, data);
    }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = () => addImage(file.name && file.name !== "image.png" ? file.name : `eingefuegt.${file.type.split("/")[1] || "png"}`, String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  };
  const submit = () => {
    const t = text.trim();
    if (!t || running) return;
    useDesign.getState().send(t, images, variants);
    setText("");
    setImages([]);
    setVariants(1);
  };

  return (
    <div className="rounded-2xl border border-line bg-elev shadow-soft focus-within:border-line-strong">
      {(picked || images.length > 0) && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {picked && (
            <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-accent/50 bg-accent-soft px-2 py-0.5 text-[0.8em]" title={picked.html}>
              <MousePointerClick className="h-3 w-3 shrink-0 text-accent" />
              <span className="truncate font-mono">{picked.selector}</span>
              <button onClick={() => useDesign.setState({ picked: null })} aria-label="Auswahl entfernen">
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {images.map((a) => (
            <span key={a.path} className="inline-flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-0.5 text-[0.8em]">
              <ImagePlus className="h-3 w-3" /> {a.name}
              <button onClick={() => setImages((l) => l.filter((x) => x !== a))} aria-label="Entfernen">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        placeholder={picked ? "Was soll sich an diesem Element ändern? (z. B. „größer, mit Icon“)" : "Beschreibe das Design oder eine Änderung …"}
        className="block max-h-[220px] w-full resize-none bg-transparent px-3.5 pt-3 outline-none placeholder:text-muted"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <IconButton label="Vorlage/Screenshot anhängen (auch per Einfügen)" onClick={pick}>
          <ImagePlus className="h-4 w-4" />
        </IconButton>
        <IconButton label="Element in der Vorschau auswählen" active={useDesign((s) => s.picking)} onClick={() => useDesign.setState((s) => ({ picking: !s.picking, tab: "preview" }))}>
          <MousePointerClick className="h-4 w-4" />
        </IconButton>
        <Menu>
          <MenuTrigger asChild>
            <button className={clsx("flex h-8 items-center gap-1 rounded-md px-2 text-[0.86em] hover:bg-hover", variants > 1 ? "text-accent" : "text-muted")}>
              <Columns3 className="h-3.5 w-3.5" /> {variants > 1 ? `${variants} Varianten` : "1 Entwurf"}
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
        <div className="flex-1" />
        {running ? (
          <Button size="sm" variant="secondary" onClick={() => useDesign.getState().cancel()}>
            <Square className="h-3 w-3" /> Stopp
          </Button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim()}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg disabled:opacity-30"
            aria-label="Senden"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
