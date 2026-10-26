import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { shortcut } from "../../lib/platform";
import {
  Globe,
  Sparkles,
  Plus,
  Wand2,
  FolderOpen,
  AlertTriangle,
  ArrowLeft,
  AudioLines,
  DatabaseZap,
  Download,
  Bot,
  ChartColumn,
  Boxes,
  Cpu,
  KeyRound,
  Palette,
  Plug,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Scale,
  Users,
} from "lucide-react";
import { CouncilSettings } from "./CouncilSettings";
import { api, type CatalogModel, type ConfigFile, type IndexStatus, type JsonSchema, type SkillInfo } from "../../lib/acp";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { tokens } from "../../lib/format";
import { useStore, type Theme } from "../../lib/store";
import { AgentsSettings } from "../agents/AgentsSettings";

/** Abschnitte, die Vibes Konfiguration brauchen – ohne Vibe-Verbindung ausgeblendet. */
const VIBE_SECTIONS = new Set(["account", "models", "permissions", "agents", "skills", "web", "voice", "advanced"]);
import { looksSecret, maskSecrets } from "../../lib/format";
import { AccountsCard } from "./Accounts";
import { Button, Spinner, Switch, clsx } from "../ui";
import { MODE_INFO } from "../composer/Pickers";
import { confirmAction } from "../../lib/dialogs";
import { UsagePage } from "../usage/UsagePage";
import { CortecsView } from "./CortecsSettings";
import { CollabSettings } from "../collab/CollabSettings";

const SECTIONS = [
  { id: "general", label: "Allgemein", icon: Palette },
  { id: "backends", label: "Agenten", icon: Boxes },
  { id: "account", label: "Konto", icon: UserRound },
  { id: "usage", label: "Nutzung", icon: ChartColumn },
  { id: "models", label: "Modelle & Kontext", icon: Cpu },
  { id: "permissions", label: "Freigaben & Sicherheit", icon: ShieldCheck },
  { id: "cortecs", label: "Cortecs & Datenschutz", icon: ShieldCheck },
  { id: "agents", label: "Vibe-Agents & Subagents", icon: Bot },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "web", label: "Websuche & Recherche", icon: Globe },
  { id: "voice", label: "Sprache", icon: AudioLines },
  { id: "embeddings", label: "Embeddings & Suche", icon: DatabaseZap },
  { id: "council", label: "Council", icon: Scale },
  { id: "tools", label: "Werkzeuge & MCP", icon: Plug },
  { id: "collab", label: "Zusammenarbeit", icon: Users },
  { id: "advanced", label: "Erweitert", icon: SlidersHorizontal },
] as const;

/** Deutsche Bezeichnungen für die wichtigsten Vibe-Einstellungen. */
const LABELS: Record<string, [string, string?]> = {
  default_agent: ["Standard-Freigabemodus", "Mit diesem Modus starten neue Sessions."],
  bypass_tool_permissions: ["Alle Freigaben überspringen", "Vibe führt jede Aktion ohne Rückfrage aus – auch Shell-Befehle."],
  enable_auto_approve: ["Modus „Alles automatisch“ erlauben", "Ohne diese Option ist der YOLO-Modus nicht wählbar."],
  smart_approve_available: ["Modus „Smart“ anbieten", "Vibe stuft jede Aktion nach Risiko ein."],
  auto_compact_threshold: ["Automatisch komprimieren ab (Tokens)", "Für Modelle ohne eigenes Limit."],
  show_thinking_nodes: ["Gedankengang anzeigen"],
  enable_subagents: ["Subagents erlauben", "Vibe darf Teilaufgaben an eigenständige Subagents abgeben."],
  max_subagents: ["Maximale Anzahl Subagents"],
  max_concurrent_subagents: ["Gleichzeitig laufende Subagents"],
  enable_background_processes: ["Hintergrundprozesse erlauben", "z. B. Dev-Server, die weiterlaufen."],
  enable_mcp: ["MCP-Server aktivieren"],
  enable_connectors: ["Mistral-Connectors aktivieren"],
  enable_notifications: ["Benachrichtigungen von Vibe"],
  enable_update_checks: ["Nach Vibe-Updates suchen"],
  enable_auto_update: ["Vibe automatisch aktualisieren"],
  enable_telemetry: ["Telemetrie an Mistral senden"],
  include_commit_signature: ["Commit-Signatur von Vibe anhängen"],
  include_project_context: ["Projektkontext mitsenden", "Git-Branch, letzte Commits und AGENTS.md."],
  worktree_limit: ["Maximal behaltene Worktrees"],
  api_timeout: ["API-Timeout (Sekunden)"],
  active_model: ["Aktives Modell"],
  active_transcribe_model: ["Modell für Spracheingabe", "Voxtral Realtime transkribiert live beim Sprechen."],
  active_tts_model: ["Modell zum Vorlesen"],
};

const SECTION_KEYS: Record<string, string[]> = {
  models: ["active_model", "auto_compact_threshold", "show_thinking_nodes"],
  permissions: ["default_agent", "bypass_tool_permissions", "enable_auto_approve", "smart_approve_available"],
  agents: ["enable_subagents", "max_subagents", "max_concurrent_subagents", "enable_background_processes"],
  tools: ["enable_mcp", "enable_connectors"],
  voice: ["active_transcribe_model", "active_tts_model"],
};

const STT_LANGUAGES = [
  ["de", "Deutsch"],
  ["en", "Englisch"],
  ["fr", "Französisch"],
  ["es", "Spanisch"],
  ["it", "Italienisch"],
  ["pt", "Portugiesisch"],
  ["nl", "Niederländisch"],
  ["hi", "Hindi"],
];

const EMBED_MODELS = [
  ["codestral-embed", "Codestral Embed", "Für Code optimiert (1536 Dimensionen) – empfohlen"],
  ["mistral-embed", "Mistral Embed", "Allgemeiner Text (1024 Dimensionen)"],
];

/** Optionen, die nur Vibes Terminal-Oberfläche betreffen. */
const CLI_ONLY = new Set([
  "theme",
  "cursor_blink",
  "autocopy_to_clipboard",
  "enable_mouse_capture",
  "ask_confirmation_on_exit",
  "disable_welcome_banner_animation",
  "show_greeting",
  "file_watcher_for_autocomplete",
  "displayed_workdir",
  "show_subagent_status_list",
  "experimental_enable_tab_status",
  "voice_mode_enabled",
  "narrator_enabled",
]);

function prettify(key: string) {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function resolve(prop: JsonSchema, defs: Record<string, JsonSchema>): JsonSchema {
  if (prop.$ref) return { ...defs[prop.$ref.split("/").pop()!], ...prop, $ref: undefined };
  if (prop.anyOf) {
    const main = prop.anyOf.find((p) => p.type !== "null");
    if (main) return { ...resolve(main, defs), description: prop.description, default: prop.default, title: prop.title };
  }
  return prop;
}

function scalarType(p: JsonSchema): "boolean" | "integer" | "number" | "string" | "enum" | null {
  if (p.enum) return "enum";
  const t = Array.isArray(p.type) ? p.type.find((x) => x !== "null") : p.type;
  return t === "boolean" || t === "integer" || t === "number" || t === "string" ? t : null;
}

interface FieldProps {
  name: string;
  prop: JsonSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  options?: { value: string; label: string }[];
}

export function Row({ title, description, control, warn, reset }: { title: ReactNode; description?: ReactNode; control: ReactNode; warn?: boolean; reset?: () => void }) {
  return (
    <div className={clsx("flex items-center gap-6 px-4 py-3.5", warn && "bg-bad-soft/60")}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">
          {title}
          {reset && (
            <button className="text-muted hover:text-fg" onClick={reset} title="Auf Vibe-Standard zurücksetzen">
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
        </div>
        {description && <div className="mt-0.5 text-[0.86em] text-muted">{description}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function Field({ name, prop, value, onChange, options }: FieldProps) {
  const type = options ? "enum" : scalarType(prop);
  const effective = value ?? prop.default;
  const [label, desc] = LABELS[name] ?? [prop.title && prop.title !== prettify(name) ? prop.title : prettify(name), undefined];
  const description = desc ?? prop.description;
  const [draft, setDraft] = useState(effective == null ? "" : String(effective));
  useEffect(() => setDraft(effective == null ? "" : String(effective)), [effective]);
  const reset = value !== undefined ? () => onChange(null) : undefined;

  let control: ReactNode = <span className="text-[0.86em] text-muted">nur in config.toml</span>;
  if (type === "boolean") control = <Switch checked={!!effective} onChange={(v) => onChange(v)} />;
  else if (type === "enum") {
    const opts = options ?? (prop.enum ?? []).map((v) => ({ value: String(v), label: String(v) }));
    control = (
      <select
        value={String(effective ?? "")}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 min-w-[180px] rounded-lg border border-line bg-elev px-2 text-[0.92em] outline-none focus:border-accent"
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (type === "integer" || type === "number" || type === "string") {
    control = (
      <input
        value={draft}
        type={type === "string" ? "text" : "number"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === String(effective ?? "")) return;
          if (draft === "") return onChange(null);
          onChange(type === "string" ? draft : type === "integer" ? parseInt(draft, 10) : parseFloat(draft));
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="h-8 w-[220px] rounded-lg border border-line bg-elev px-2.5 text-[0.92em] outline-none focus:border-accent"
      />
    );
  }
  return <Row title={label} description={description} control={control} warn={name === "bypass_tool_permissions" && !!effective} reset={reset} />;
}

export function Card({ title, children, description }: { title?: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      {title && <h3 className="mb-1 text-[0.95em] font-semibold">{title}</h3>}
      {description && <p className="mb-2 text-[0.88em] text-muted">{description}</p>}
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-elev">{children}</div>
    </section>
  );
}

export function SettingsView() {
  const section = useStore((s) => s.settingsSection);
  const setView = useStore((s) => s.setView);
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const auth = useStore((s) => s.auth);
  const info = useStore((s) => s.connectInfo);
  const template = useStore((s) => s.template);
  const { signOut, connect } = useStore.getState();
  const [schema, setSchema] = useState<JsonSchema | null>(null);
  const [config, setConfig] = useState<ConfigFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const vibe = useStore((s) => !!s.agents.vibe);
  const sections = SECTIONS.filter((s) => vibe || !VIBE_SECTIONS.has(s.id));

  const reload = useCallback(async () => {
    try {
      setConfig(await api.readConfig());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (!vibe) return;
    reload();
    api.configSchema().then((r) => setSchema(r.schema)).catch((e) => setError(String(e)));
  }, [reload, vibe]);

  const write = async (key: string[], value: unknown) => {
    try {
      await api.writeConfig(key, value);
      await reload();
      setDirty(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const defs = schema?.$defs ?? {};
  const props = schema?.properties ?? {};
  const values = (config?.values ?? {}) as Record<string, unknown>;

  const modeOptions = (template?.modes.length ? template.modes : Object.keys(MODE_INFO).map((id) => ({ id, name: id }))).map((m) => ({
    value: m.id,
    label: MODE_INFO[m.id]?.label ?? m.name,
  }));
  const modelOptions = template?.config.find((o) => o.id === "model")?.options?.map((o) => ({ value: o.value, label: o.name }));

  const field = (key: string) => {
    const prop = props[key];
    if (!prop) return null;
    const options = key === "default_agent" ? modeOptions : key === "active_model" && modelOptions?.length ? modelOptions : undefined;
    return <Field key={key} name={key} prop={resolve(prop, defs)} value={values[key]} onChange={(v) => write([key], v)} options={options} />;
  };

  const shownElsewhere = new Set(Object.values(SECTION_KEYS).flat());
  const advanced = useMemo(
    () =>
      Object.entries(props)
        .filter(([k, p]) => !shownElsewhere.has(k) && !CLI_ONLY.has(k) && scalarType(resolve(p, defs)) && !/deprecated/i.test(p.description ?? ""))
        .filter(([k, p]) => !query || `${k} ${p.description ?? ""}`.toLowerCase().includes(query.toLowerCase())),
    [schema, query],
  );

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="w-60 shrink-0 border-r border-line bg-panel p-3">
        <button className="mb-3 flex h-8 items-center gap-2 rounded-lg px-2 text-fg-2 hover:bg-hover hover:text-fg" onClick={() => setView("chat")}>
          <ArrowLeft className="h-4 w-4" /> Zurück
        </button>
        {sections.map((s) => (
          <button
            key={s.id}
            onClick={() => setView("settings", s.id)}
            className={clsx(
              "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left",
              section === s.id ? "bg-active text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
            )}
          >
            <s.icon className="h-4 w-4 text-muted" />
            {s.label}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-8 py-8">
          <h1 className="mb-6 text-[1.5em] font-semibold tracking-tight">{SECTIONS.find((s) => s.id === section)?.label}</h1>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[0.9em] text-bad">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <span className="flex-1 selectable">{error}</span>
              <button onClick={() => setError(null)}>×</button>
            </div>
          )}
          {dirty && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-[0.9em]">
              <span className="flex-1">Gespeichert. Neue Einstellungen gelten für neue Sessions.</span>
              <Button size="sm" onClick={() => (setDirty(false), connect())}>
                Vibe neu verbinden
              </Button>
            </div>
          )}

          {section === "backends" && <AgentsSettings />}

          {section === "general" && (
            <>
              <Card title="Darstellung">
                <Row
                  title="Farbschema"
                  control={
                    <div className="flex rounded-lg border border-line bg-panel p-0.5">
                      {(["system", "light", "dark"] as Theme[]).map((t) => (
                        <button
                          key={t}
                          onClick={() => setPrefs({ theme: t })}
                          className={clsx("h-7 rounded-md px-3 text-[0.88em]", prefs.theme === t ? "bg-elev text-fg shadow-soft" : "text-muted hover:text-fg")}
                        >
                          {t === "system" ? "System" : t === "light" ? "Hell" : "Dunkel"}
                        </button>
                      ))}
                    </div>
                  }
                />
                <Row
                  title="Akzentfarbe"
                  description="Lässt sich auch im Chat ändern: „mach Brise orange“."
                  control={
                    <div className="flex items-center gap-1.5">
                      {[null, "#e8590c", "#d6336c", "#7048e8", "#0c8599", "#2f9e44"].map((c) => (
                        <button
                          key={c ?? "std"}
                          onClick={() => setPrefs({ accent: c })}
                          title={c ?? "Standard"}
                          className={clsx("h-6 w-6 rounded-full border-2", prefs.accent === c ? "border-fg" : "border-transparent")}
                          style={{ background: c ?? "linear-gradient(135deg,#3d6ef0,#18b6a4)" }}
                        />
                      ))}
                      <input type="color" value={prefs.accent ?? "#3d6ef0"} onChange={(e) => setPrefs({ accent: e.target.value })} className="h-6 w-7 cursor-pointer bg-transparent" />
                    </div>
                  }
                />
                <Row
                  title="Schriftgröße"
                  description={`${prefs.fontSize} px`}
                  control={
                    <input type="range" min={12} max={18} value={prefs.fontSize} onChange={(e) => setPrefs({ fontSize: Number(e.target.value) })} className="w-44 accent-[var(--accent)]" />
                  }
                />
              </Card>
              <Card title="Benachrichtigungen">
                <Row
                  title="Melden, wenn eine Session fertig ist"
                  description="Nur wenn Brise gerade nicht im Vordergrund ist."
                  control={<Switch checked={prefs.notify} onChange={(v) => setPrefs({ notify: v })} />}
                />
              </Card>
              <Card title="Einführung">
                <Row
                  title="Tour durch Brise"
                  description="Zeigt die wichtigsten Bereiche Schritt für Schritt."
                  control={
                    <Button size="sm" onClick={() => (setView("chat"), useStore.setState({ tourStep: 0 }))}>
                      Tour starten
                    </Button>
                  }
                />
              </Card>
              <Card title="Tastenkürzel">
                {[
                  ["Neue Session", shortcut("N")],
                  ["Suchen und Befehle", shortcut("K")],
                  ["Einstellungen", shortcut(",")],
                  ["Seitenleiste ein/aus", shortcut("B")],
                  ["Detailpanel ein/aus", shortcut("J")],
                  ["Laufenden Turn abbrechen", "Esc"],
                  ["Terminal ein/aus", shortcut("ö")],
                ].map(([l, k]) => (
                  <Row key={l} title={<span className="font-normal">{l}</span>} control={<kbd className="rounded border border-line bg-panel px-2 py-0.5 text-[0.82em]">{k}</kbd>} />
                ))}
              </Card>
            </>
          )}

          {section === "account" && (
            <>
              <Card title="Mistral-Konto">
                <Row
                  title={auth?.authenticated ? "Angemeldet" : "Nicht angemeldet"}
                  description={auth?.authenticated ? `Zugang über deinen Mistral-Plan (gespeichert: ${auth.authState === "os_keyring" ? "Schlüsselbund des Systems" : auth.authState})` : "Melde dich an, um Vibe zu nutzen."}
                  control={
                    auth?.signOutAvailable ? (
                      <Button variant="danger" onClick={async () => (await confirmAction("Wirklich abmelden? Der gespeicherte Schlüssel wird entfernt.", true)) && signOut()}>
                        Abmelden
                      </Button>
                    ) : null
                  }
                />
              </Card>
              <KeyCard />
              <AccountsCard />
              <Card title="Mistral Vibe">
                <Row title="Version" control={<span className="text-fg-2">{info?.init.agentInfo?.version ?? "–"}</span>} />
                <VibeUpdateRow />
                <Row title="Programm" control={<span className="font-mono text-[0.82em] text-fg-2 selectable">{info?.agentPath}</span>} />
                <Row title="Konfiguration" control={<span className="font-mono text-[0.82em] text-fg-2 selectable">{config?.path}</span>} />
              </Card>
            </>
          )}

          {section === "usage" && <UsagePage />}

          {section === "models" && (
            <>
              <AutoModelCard />
              <ModelsCard onChange={() => setDirty(true)} />
              <MoreMistralCard />
              <EfficiencyCard values={values} write={write} />
              <Card title="Weitere Einstellungen">{SECTION_KEYS.models.map(field)}</Card>
            </>
          )}

          {section === "skills" && <SkillsView values={values} write={write} />}

          {section === "cortecs" && <CortecsView onModelsChanged={() => setDirty(true)} />}

          {section === "permissions" && (
            <>
              {values.bypass_tool_permissions === true && (
                <div className="mb-4 flex items-start gap-3 rounded-xl border border-bad/40 bg-bad-soft px-4 py-3 text-[0.92em]">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-bad" />
                  <div>
                    <div className="font-semibold text-bad">Freigaben sind komplett abgeschaltet</div>
                    <div className="text-fg-2">Vibe führt Shell-Befehle und Änderungen ohne Rückfrage aus, egal welcher Modus gewählt ist.</div>
                  </div>
                </div>
              )}
              <Card>{SECTION_KEYS.permissions.map(field)}</Card>
              <Allowlist values={values} write={write} />
            </>
          )}

          {section === "voice" && (
            <>
              <Card title="Spracheingabe" description="Über das Mikrofon im Eingabefeld. Vibe nimmt auf und transkribiert live mit Mistrals Voxtral.">
                <Row
                  title="Sprache"
                  description="Voxtral erkennt die Sprache meist auch selbst."
                  control={
                    <select
                      value={prefs.sttLanguage}
                      onChange={(e) => setPrefs({ sttLanguage: e.target.value })}
                      className="h-8 min-w-[180px] rounded-lg border border-line bg-elev px-2 text-[0.92em] outline-none focus:border-accent"
                    >
                      {STT_LANGUAGES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  }
                />
                {field("active_transcribe_model")}
              </Card>
              <Card title="Vorlesen" description="Vibe fasst die Antwort kurz zusammen und liest sie mit Voxtral TTS vor.">
                <Row
                  title="Antworten automatisch vorlesen"
                  description="Nach jedem abgeschlossenen Turn."
                  control={<Switch checked={prefs.autoNarrate} onChange={(v) => setPrefs({ autoNarrate: v })} />}
                />
                {field("active_tts_model")}
              </Card>
            </>
          )}

          {section === "embeddings" && (
            <>
              <Card title="Embedding-Modell" description="Für die semantische Codesuche. Läuft über deinen Mistral-Key; ein Modellwechsel erfordert neues Indexieren.">
                {EMBED_MODELS.map(([id, label, desc]) => (
                  <Row
                    key={id}
                    title={label}
                    description={desc}
                    control={
                      <input type="radio" name="embed" checked={prefs.embedModel === id} onChange={() => setPrefs({ embedModel: id })} className="h-4 w-4 accent-[var(--accent)]" />
                    }
                  />
                ))}
              </Card>
              <Card title="Vibe und die Suche">
                <Row
                  title="Vibe darf die semantische Suche nutzen"
                  description="Brise hängt sich als MCP-Werkzeug „semantic_code_search“ in neue Sessions indexierter Projekte."
                  control={<Switch checked={prefs.agentSearch} onChange={(v) => setPrefs({ agentSearch: v })} />}
                />
              </Card>
              <IndexCard />
            </>
          )}

          {section === "agents" && (
            <>
              <Card description="Subagents übernehmen Teilaufgaben mit eigenem Kontext, z. B. „explore“ zum Durchsuchen des Codes oder „researcher“ für Webrecherche. Sie nutzen das Modell der Hauptsession – ein eigenes Modell pro Subagent unterstützt Vibe derzeit nicht.">
                {SECTION_KEYS.agents.map(field)}
              </Card>
            </>
          )}

          {section === "web" && <WebCard values={values} write={write} />}
          {section === "council" && <CouncilSettings />}
          {section === "collab" && <CollabSettings />}

          {section === "tools" && (
            <>
              <Card>{SECTION_KEYS.tools.map(field)}</Card>
              <McpServers values={values} write={write} />
            </>
          )}

          {section === "advanced" && (
            <>
              <div className="relative mb-4">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Einstellung suchen …"
                  className="h-9 w-full rounded-lg border border-line bg-elev pl-9 pr-3 outline-none focus:border-accent"
                />
              </div>
              <Card description="Alle weiteren Optionen aus Vibes config.toml. Leere Felder nutzen Vibes Standardwert.">
                {advanced.map(([k]) => field(k))}
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Dauerhaft erlaubte Shell-Befehle – mit Warnung bei eingebetteten Zugangsdaten. */
function Allowlist({ values, write }: { values: Record<string, unknown>; write: (k: string[], v: unknown) => Promise<void> }) {
  const tools = (values.tools ?? {}) as Record<string, Record<string, unknown>>;
  const list = (tools.bash?.allowlist ?? []) as string[];
  const secret = list.filter(looksSecret);
  const remove = (items: string[]) => write(["tools", "bash", "allowlist"], list.filter((c) => !items.includes(c)));
  return (
    <section className="mb-6">
      <h3 className="mb-1 flex items-center gap-2 text-[0.95em] font-semibold">
        <KeyRound className="h-4 w-4" /> Dauerhaft erlaubte Befehle
      </h3>
      <p className="mb-2 text-[0.88em] text-muted">Was du mit „Immer erlauben“ freigegeben hast. Vibe speichert dabei den kompletten Befehl.</p>
      {secret.length > 0 && (
        <div className="mb-2 flex items-center gap-3 rounded-xl border border-bad/40 bg-bad-soft px-4 py-3 text-[0.9em]">
          <AlertTriangle className="h-5 w-5 shrink-0 text-bad" />
          <div className="flex-1">
            <b className="text-bad">{secret.length} Einträge enthalten vermutlich Passwörter oder Tokens</b> im Klartext. Entfernen und die Zugangsdaten ändern.
          </div>
          <Button variant="danger" size="sm" onClick={async () => (await confirmAction(`${secret.length} Einträge entfernen?`, true)) && remove(secret)}>
            Alle entfernen
          </Button>
        </div>
      )}
      <div className="max-h-[420px] divide-y divide-line overflow-y-auto rounded-xl border border-line bg-elev">
        {list.length === 0 && <div className="px-4 py-6 text-center text-[0.9em] text-muted">Keine dauerhaft erlaubten Befehle.</div>}
        {list.map((cmd, n) => (
          <div key={n} className={clsx("group flex items-start gap-3 px-4 py-2", looksSecret(cmd) && "bg-bad-soft/40")}>
            {looksSecret(cmd) && <AlertTriangle className="mt-1 h-3.5 w-3.5 shrink-0 text-bad" />}
            <code className="line-clamp-2 flex-1 break-all font-mono text-[0.8em] text-fg-2">{maskSecrets(cmd)}</code>
            <button className="mt-0.5 text-muted opacity-0 hover:text-bad group-hover:opacity-100" onClick={() => remove([cmd])} aria-label="Entfernen">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function McpServers({ values, write }: { values: Record<string, unknown>; write: (k: string[], v: unknown) => Promise<void> }) {
  const servers = (values.mcp_servers ?? []) as Record<string, unknown>[];
  const toggle = (n: number, disabled: boolean) => write(["mcp_servers"], servers.map((s, i) => (i === n ? { ...s, disabled } : s)));
  return (
    <Card title="MCP-Server" description="Externe Werkzeuge, die Vibe nutzen kann. Bearbeiten weiterer Details folgt; bis dahin in config.toml.">
      {servers.length === 0 && <div className="px-4 py-6 text-center text-[0.9em] text-muted">Keine MCP-Server eingerichtet.</div>}
      {servers.map((s, n) => (
        <Row
          key={n}
          title={<span className="font-mono text-[0.92em]">{String(s.name ?? `Server ${n + 1}`)}</span>}
          description={<span className="font-mono text-[0.82em]">{String(s.transport ?? "stdio")} · {String(s.url ?? s.command ?? "")}</span>}
          control={<Switch checked={!s.disabled} onChange={(v) => toggle(n, !v)} />}
        />
      ))}
    </Card>
  );
}

function KeyCard() {
  const saveKey = useStore((s) => s.saveKey);
  const [info, setInfo] = useState<{ present: boolean; hint: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [result, setResult] = useState<{ valid: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.apiKeyInfo().then(setInfo);
  }, [result]);
  return (
    <Card title="Schlüssel" description="Vibe-Key (Studio → Code → Vibe CLI) oder API-Key. Wird von Brise, Vibe-CLI und VS-Code-Erweiterung gemeinsam genutzt.">
      <Row
        title={info?.present ? "Schlüssel gespeichert" : "Kein Schlüssel gespeichert"}
        description={info?.hint ? <span className="font-mono">{info.hint}</span> : "Anmeldung über den Browser speichert ihn automatisch."}
        control={
          <Button size="sm" onClick={() => setEditing(!editing)}>
            <KeyRound className="h-3.5 w-3.5" /> {info?.present ? "Ersetzen" : "Einfügen"}
          </Button>
        }
      />
      {editing && (
        <div className="space-y-2 px-4 py-3">
          <input
            type="password"
            value={key}
            onChange={(e) => (setKey(e.target.value), setResult(null))}
            placeholder="Schlüssel einfügen …"
            className="h-9 w-full rounded-lg border border-line bg-bg px-3 font-mono text-[0.88em] outline-none focus:border-accent"
          />
          {result && <div className={clsx("text-[0.86em]", result.valid ? "text-ok" : "text-bad")}>{result.message}</div>}
          <Button
            variant="primary"
            size="sm"
            disabled={!key.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await saveKey(key);
                setResult(r);
                if (r.valid) setKey("");
              } catch (e) {
                setResult({ valid: false, message: String(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Prüfen und speichern
          </Button>
        </div>
      )}
    </Card>
  );
}

function VibeUpdateRow() {
  const install = useStore((s) => s.install);
  const [info, setInfo] = useState<{ managed: boolean; path: string | null } | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  useEffect(() => {
    api.installInfo().then(setInfo);
  }, []);
  return (
    <Row
      title="Aktualisieren"
      description={
        info?.managed
          ? state === "busy"
            ? install.lines[install.lines.length - 1] ?? "Aktualisiere …"
            : state === "done"
              ? "Vibe ist aktuell. Für neue Sessions gilt die neue Version nach „Vibe neu verbinden“."
              : "Von Brise installiert – Brise kann Vibe selbst aktualisieren."
          : "Vibe wurde außerhalb von Brise installiert und aktualisiert sich selbst."
      }
      control={
        info?.managed ? (
          <Button
            size="sm"
            disabled={state === "busy"}
            onClick={async () => {
              setState("busy");
              try {
                await api.upgradeVibe();
                setState("done");
              } catch {
                setState("error");
              }
            }}
          >
            {state === "busy" ? <Spinner /> : <Download className="h-3.5 w-3.5" />} Nach Updates suchen
          </Button>
        ) : null
      }
    />
  );
}

function IndexCard() {
  const project = useStore((s) => s.activeProject);
  const model = useStore((s) => s.prefs.embedModel);
  const togglePanel = useStore((s) => s.togglePanel);
  const setView = useStore((s) => s.setView);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  useEffect(() => {
    if (project) api.indexStatus(project).then(setStatus);
  }, [project]);
  if (!project) return null;
  return (
    <Card title="Aktuelles Projekt">
      <Row
        title={project.split(/[\\/]/).pop()}
        description={
          status?.indexed
            ? `${status.files} Dateien, ${status.chunks} Abschnitte mit ${status.model}${status.model !== model ? " – passt nicht zum gewählten Modell, bitte neu indexieren" : ""}`
            : "Noch nicht indexiert."
        }
        control={
          <div className="flex gap-2">
            {status?.indexed && (
              <Button size="sm" variant="danger" onClick={() => api.deleteIndex(project).then(() => api.indexStatus(project).then(setStatus))}>
                <Trash2 className="h-3.5 w-3.5" /> Löschen
              </Button>
            )}
            <Button size="sm" onClick={() => (setView("chat"), togglePanel("search"))}>
              <Search className="h-3.5 w-3.5" /> Zur Suche
            </Button>
          </div>
        }
      />
    </Card>
  );
}

const LEVELS = [
  ["simple", "Einfache Aufgaben", "Fragen, Erklärungen, kleine Änderungen"],
  ["standard", "Normale Aufgaben", "Features, Bugfixes, Tests"],
  ["complex", "Komplexe Aufgaben", "Architektur, große Refactorings, schwierige Fehler"],
] as const;

function AutoModelCard() {
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const options = useStore((s) => s.template?.config.find((o) => o.id === "model")?.options ?? []);
  return (
    <Card
      title="Auto"
      description="Das Task-Modell stuft jede Anfrage ein. Standard: GLM-5.3 arbeitet, und die Denkstufe wird pro Anfrage gesetzt und während der Arbeit nachgesteuert (z. B. höher bei wiederholten Fehlern, niedriger bei reinem Lesen). Unter jeder Nachricht und per Klick auf die Denkstufe siehst du, was gewählt wurde."
    >
      <Row
        title={
          <span className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-accent" /> Auto aktiv
          </span>
        }
        control={<Switch checked={prefs.autoModel} onChange={(v) => setPrefs({ autoModel: v })} />}
      />
      <Row
        title="Strategie"
        control={
          <select
            value={prefs.autoStrategy}
            disabled={!prefs.autoModel}
            onChange={(e) => setPrefs({ autoStrategy: e.target.value as "reasoning" | "routing" })}
            className="h-8 min-w-[260px] rounded-lg border border-line bg-elev px-2 text-[0.92em] outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="reasoning">Festes Modell, Denkstufe automatisch</option>
            <option value="routing">Modell je Aufgabe wechseln</option>
          </select>
        }
      />
      {prefs.autoStrategy === "reasoning" && (
        <Row
          title="Modell für Auto"
          description="Bei Bildern nimmt Brise automatisch ein Modell, das Bilder versteht."
          control={
            <select
              value={prefs.autoBaseModel}
              disabled={!prefs.autoModel}
              onChange={(e) => setPrefs({ autoBaseModel: e.target.value })}
              className="h-8 min-w-[260px] rounded-lg border border-line bg-elev px-2 text-[0.92em] outline-none focus:border-accent disabled:opacity-50"
            >
              {!options.some((o) => o.value === prefs.autoBaseModel) && <option value={prefs.autoBaseModel}>{prefs.autoBaseModel}</option>}
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.name}
                </option>
              ))}
            </select>
          }
        />
      )}
      {prefs.autoStrategy === "routing" && LEVELS.map(([key, label, desc]) => (
        <Row
          key={key}
          title={label}
          description={desc}
          control={
            <select
              value={prefs.routing[key]}
              disabled={!prefs.autoModel}
              onChange={(e) => setPrefs({ routing: { ...prefs.routing, [key]: e.target.value } })}
              className="h-8 min-w-[200px] rounded-lg border border-line bg-elev px-2 text-[0.92em] outline-none focus:border-accent disabled:opacity-50"
            >
              {!options.some((o) => o.value === prefs.routing[key]) && <option value={prefs.routing[key]}>{prefs.routing[key]} (nicht verfügbar)</option>}
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.name}
                </option>
              ))}
            </select>
          }
        />
      ))}
    </Card>
  );
}

function ModelsCard({ onChange }: { onChange: () => void }) {
  const project = useStore((s) => s.activeProject);
  const available = useStore((s) => s.template?.config.find((o) => o.id === "model")?.options ?? []);
  const [configured, setConfigured] = useState<{ alias: string; name: string; displayName: string | null }[]>([]);
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState({ name: "", alias: "", display: "" });
  const [busy, setBusy] = useState<string | null>(null);

  const reload = () => {
    api.configuredModels().then(setConfigured).catch((e) => setError(String(e)));
  };
  useEffect(() => {
    reload();
    api.modelCatalog().then(setCatalog).catch((e) => setError(String(e)));
  }, []);

  const changed = () => {
    reload();
    onChange();
    if (project) useStore.getState().resetPrepared(project);
  };
  const add = async (name: string, alias?: string, display?: string) => {
    setBusy(name);
    setError(null);
    try {
      await api.addModel(name, alias, display);
      changed();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };
  const isConfigured = (m: CatalogModel) => configured.some((c) => m.aliases.includes(c.name)) || available.some((a) => m.aliases.includes(a.description ?? ""));

  return (
    <>
      {error && <div className="mb-3 rounded-lg bg-bad-soft px-3 py-2 text-[0.88em] text-bad selectable">{error}</div>}
      <Card title="In Vibe verfügbar" description="Diese Modelle erscheinen in der Modellwahl. Vibe selbst bringt nur Mistral Medium mit; Brise trägt Mistral Large 4 und GLM-5.3 automatisch ein.">
        {available.map((o) => {
          const entry = configured.find((c) => c.alias === o.value);
          return (
            <Row
              key={o.value}
              title={o.name}
              description={<span className="font-mono text-[0.85em]">{o.description ?? o.value}</span>}
              control={
                entry ? (
                  <Button size="sm" variant="danger" onClick={() => api.removeModel(entry.alias).then(changed).catch((e) => setError(String(e)))}>
                    <Trash2 className="h-3.5 w-3.5" /> Entfernen
                  </Button>
                ) : (
                  <span className="text-[0.82em] text-muted">Vibe-Standard</span>
                )
              }
            />
          );
        })}
        {configured
          .filter((c) => !available.some((a) => a.value === c.alias))
          .map((c) => (
            <Row
              key={c.alias}
              title={c.displayName ?? c.alias}
              description={<span className="font-mono text-[0.85em]">{c.name} · ab der nächsten Session</span>}
              control={
                <Button size="sm" variant="danger" onClick={() => api.removeModel(c.alias).then(changed)}>
                  <Trash2 className="h-3.5 w-3.5" /> Entfernen
                </Button>
              }
            />
          ))}
      </Card>

      <Card title="Mistral-Katalog" description="Alle Chat-Modelle, die dein Key nutzen darf. Brise prüft bei jedem Start auf neue Modelle und meldet sie.">
        {!catalog && !error && (
          <div className="flex items-center gap-2 px-4 py-4 text-muted">
            <Spinner /> Lade Katalog …
          </div>
        )}
        {catalog?.map((m) => (
          <Row
            key={m.id}
            title={<span className="font-mono text-[0.92em]">{m.id}</span>}
            description={
              <span className="flex flex-wrap items-center gap-1.5">
                <span>{m.description}</span>
                <Badge>{tokens(m.context)} Kontext</Badge>
                {m.vision && <Badge>Bilder</Badge>}
                {m.reasoning && <Badge>Denken</Badge>}
                {!m.tools && <Badge warn>keine Werkzeuge</Badge>}
              </span>
            }
            control={
              isConfigured(m) ? (
                <span className="text-[0.82em] text-ok">verfügbar</span>
              ) : (
                <Button size="sm" disabled={busy === m.id || !m.tools} onClick={() => add(m.id)}>
                  {busy === m.id ? <Spinner /> : <Plus className="h-3.5 w-3.5" />} Hinzufügen
                </Button>
              )
            }
          />
        ))}
      </Card>

      <Card title="Modell manuell hinzufügen" description="Für Modelle, die (noch) nicht im Katalog stehen, z. B. Labs- oder Fine-Tuning-Modelle.">
        <div className="grid grid-cols-3 gap-2 px-4 py-3">
          {(
            [
              ["name", "Modell-ID bei Mistral", "z. B. ft:open-mistral…"],
              ["alias", "Kurzname (optional)", "mein-modell"],
              ["display", "Anzeigename (optional)", "Mein Modell"],
            ] as const
          ).map(([k, label, ph]) => (
            <label key={k} className="text-[0.82em] text-muted">
              {label}
              <input
                value={manual[k]}
                placeholder={ph}
                onChange={(e) => setManual({ ...manual, [k]: e.target.value })}
                className="mt-1 h-8 w-full rounded-lg border border-line bg-bg px-2 font-mono text-[0.95em] text-fg outline-none focus:border-accent"
              />
            </label>
          ))}
        </div>
        <div className="px-4 pb-3">
          <Button
            size="sm"
            variant="primary"
            disabled={!manual.name.trim() || busy !== null}
            onClick={() => add(manual.name.trim(), manual.alias.trim(), manual.display.trim()).then(() => setManual({ name: "", alias: "", display: "" }))}
          >
            <Plus className="h-3.5 w-3.5" /> Hinzufügen
          </Button>
        </div>
      </Card>
    </>
  );
}

function Badge({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return <span className={clsx("rounded px-1.5 py-px text-[0.85em]", warn ? "bg-warn-soft text-warn" : "bg-hover text-fg-2")}>{children}</span>;
}

const SOURCE_LABEL = { brise: "Mit Brise geliefert", user: "Eigene Skills", project: "Skills dieses Projekts" } as const;

function SkillsView({ values, write }: { values: Record<string, unknown>; write: (k: string[], v: unknown) => Promise<void> }) {
  const project = useStore((s) => s.activeProject);
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [npx, setNpx] = useState<boolean | null>(null);
  useEffect(() => {
    api.listSkills(project ?? undefined).then(setSkills);
    api.npxAvailable().then(setNpx);
  }, [project]);
  const disabled = (values.disabled_skills ?? []) as string[];
  const toggle = (name: string, on: boolean) =>
    write(["disabled_skills"], on ? disabled.filter((d) => d !== name) : [...disabled, name]).then(() => {
      if (project) useStore.getState().resetPrepared(project);
    });

  return (
    <>
      <p className="mb-4 text-[0.92em] text-fg-2">
        Skills sind Anleitungen, die Vibe bei passenden Aufgaben selbst lädt – oder die du mit <code className="font-mono">/name</code> im Eingabefeld aufrufst.
      </p>
      <Card title="REA – Reverse Engineering" description="Der Skill „reverse-engineer-anything“ nutzt die REA-Werkzeuge (Binärdateien, Electron-Apps, .NET, Websites). Brise startet sie als MCP-Server über npx.">
        <Row
          title="REA-Werkzeuge in Sessions mitgeben"
          description={npx === false ? "Node.js (npx) wurde nicht gefunden – bitte Node.js installieren." : "Beim ersten Mal lädt npx das Paket rea-agents."}
          control={<Switch checked={prefs.rea && npx !== false} disabled={npx === false} onChange={(v) => setPrefs({ rea: v })} />}
        />
      </Card>
      {(["brise", "user", "project"] as const).map((src) => {
        const list = skills.filter((s) => s.source === src);
        if (!list.length) return null;
        return (
          <Card key={src} title={SOURCE_LABEL[src]}>
            {list.map((sk) => (
              <Row
                key={sk.path}
                title={
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[0.92em]">{sk.name}</span>
                    {sk.license && sk.license.length < 24 && <Badge>{sk.license}</Badge>}
                    <button className="text-muted hover:text-fg" title="Ordner zeigen" onClick={() => revealItemInDir(sk.path)}>
                      <FolderOpen className="h-3.5 w-3.5" />
                    </button>
                  </span>
                }
                description={<span className="line-clamp-2">{sk.description}</span>}
                control={<Switch checked={!disabled.includes(sk.name)} onChange={(v) => toggle(sk.name, v)} />}
              />
            ))}
          </Card>
        );
      })}
    </>
  );
}

function MoreMistralCard() {
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  return (
    <Card title="Weitere Mistral-Modelle" description="Brise nutzt neben dem Chat-Modell gezielt spezialisierte Modelle – alles über deinen Mistral-Key.">
      <Row
        title="Codestral-Vervollständigung im Editor"
        description="Grauer Vorschlag beim Tippen (Fill-in-the-Middle), Tab übernimmt."
        control={<Switch checked={prefs.fim} onChange={(v) => setPrefs({ fim: v })} />}
      />
      <Row
        title="Task-Modell"
        description="Stuft Aufgaben für „Auto“ ein und schreibt persönliche Vorschläge und Commit-Nachrichten. Schnell und günstig ist hier wichtiger als klug."
        control={
          <select
            value={prefs.assistModel}
            onChange={(e) => setPrefs({ assistModel: e.target.value })}
            className="h-8 min-w-[220px] rounded-lg border border-line bg-elev px-2 text-[0.92em] outline-none focus:border-accent"
          >
            <option value="mistral-small-latest">Mistral Small (empfohlen)</option>
            <option value="ministral-8b-latest">Ministral 8B (schneller)</option>
            <option value="ministral-3b-latest">Ministral 3B (am schnellsten)</option>
            <option value="mistral-medium-latest">Mistral Medium (gründlicher)</option>
          </select>
        }
      />
      <Row title="Mistral OCR" description="PDF-, Word- und PowerPoint-Anhänge werden automatisch in Text umgewandelt, bevor Vibe sie liest." control={<Badge>automatisch</Badge>} />
      <Row title="Voxtral" description="Spracheingabe (Realtime) und Vorlesen (TTS) – siehe Einstellungen → Sprache." control={<Badge>aktiv</Badge>} />
      <Row title="Codestral Embed" description="Semantische Codesuche – siehe Einstellungen → Embeddings & Suche." control={<Badge>aktiv</Badge>} />
    </Card>
  );
}

const COMPACT_PRESETS = [
  ["", "Vibe-Standard"],
  ["300000", "Ausgewogen (300k)"],
  ["150000", "Sparsam (150k)"],
  ["80000", "Sehr sparsam (80k)"],
];

function EfficiencyCard({ values, write }: { values: Record<string, unknown>; write: (k: string[], v: unknown) => Promise<void> }) {
  const current = values.auto_compact_threshold == null ? "" : String(values.auto_compact_threshold);
  return (
    <Card
      title="Effizienz"
      description="Weniger Kontext heißt schnellere und günstigere Antworten. Brise spart bereits durch Auto-Modellwahl, Prompt-Cache, semantische Suche statt Volltext-Lesen und Subagents, die nur Ergebnisse zurückgeben."
    >
      <Row
        title="Automatisch komprimieren ab"
        description="Wird der Verlauf größer, fasst Vibe ältere Teile zusammen."
        control={
          <select
            value={COMPACT_PRESETS.some(([v]) => v === current) ? current : "custom"}
            onChange={(e) => write(["auto_compact_threshold"], e.target.value ? Number(e.target.value) : null)}
            className="h-8 min-w-[200px] rounded-lg border border-line bg-elev px-2 text-[0.92em] outline-none focus:border-accent"
          >
            {COMPACT_PRESETS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
            {!COMPACT_PRESETS.some(([v]) => v === current) && <option value="custom">{current} Tokens</option>}
          </select>
        }
      />
      <Row
        title="Knapper Arbeitsstil (ponytail)"
        description="Der Skill ponytail hält Änderungen und Antworten minimal. Vibe nutzt ihn bei passenden Aufgaben selbst – oder du schreibst /ponytail."
        control={<Badge>Skill</Badge>}
      />
    </Card>
  );
}

function WebCard({ values, write }: { values: Record<string, unknown>; write: (k: string[], v: unknown) => Promise<void> }) {
  const tools = (values.tools ?? {}) as Record<string, Record<string, unknown>>;
  const searchAlways = tools.web_search?.permission === "always";
  const fetchAlways = tools.web_fetch?.permission === "always";
  const searchModel = (tools.web_search?.model as string | undefined) ?? "";
  return (
    <>
      <Card
        title="Websuche"
        description="Vibe sucht über Mistrals Websuche und liest Seiten mit web_fetch. Die Subagents „researcher“ dürfen das ohne Rückfrage – sie lesen nur."
      >
        <Row
          title="Websuche ohne Rückfrage"
          description="Sonst fragt Vibe vor jeder Suche in der Hauptsession."
          control={<Switch checked={searchAlways} onChange={(v) => write(["tools", "web_search", "permission"], v ? "always" : null)} />}
        />
        <Row
          title="Webseiten lesen ohne Rückfrage"
          description="web_fetch lädt Seiten nur lesend; Ziele außerhalb der Allowlist fragt Vibe sonst nach."
          control={<Switch checked={fetchAlways} onChange={(v) => write(["tools", "web_fetch", "permission"], v ? "always" : null)} />}
        />
        <Row
          title="Modell für die Websuche"
          control={
            <select
              value={searchModel}
              onChange={(e) => write(["tools", "web_search", "model"], e.target.value || null)}
              className="h-8 min-w-[220px] rounded-lg border border-line bg-elev px-2 text-[0.92em] outline-none focus:border-accent"
            >
              <option value="">Vibe-Standard (mit Such-Werkzeugen)</option>
              <option value="mistral-medium-latest">Mistral Medium</option>
              <option value="mistral-large-4">Mistral Large 4</option>
              <option value="mistral-small-latest">Mistral Small (schnell)</option>
            </select>
          }
        />
      </Card>
      <Card title="Deep Research" description="Der mitgelieferte Skill „deep-research“ wählt die Tiefe selbst: schnelle Antwort mit Quellen, gründlicher Vergleich oder ein vollständiger Bericht mit parallelen Recherche-Subagents.">
        <Row title={<code className="font-mono">/deep-research &lt;Frage&gt;</code>} description="Direkt aufrufen – oder einfach „recherchiere …“ schreiben." control={<Badge>Skill</Badge>} />
        <Row title="Berichte" description="Ausführliche Recherchen landen als Markdown unter research/ im Projekt, mit Quellenliste und Vertrauensstufe." control={<Badge>research/*.md</Badge>} />
      </Card>
    </>
  );
}
