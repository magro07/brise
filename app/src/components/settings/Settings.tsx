import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
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
} from "lucide-react";
import { api, type ConfigFile, type JsonSchema } from "../../lib/acp";
import { useStore, type Theme } from "../../lib/store";
import { looksSecret, maskSecrets } from "../../lib/format";
import { Button, Switch, clsx } from "../ui";
import { MODE_INFO } from "../composer/Pickers";

const SECTIONS = [
  { id: "general", label: "Allgemein", icon: Palette },
  { id: "account", label: "Konto", icon: UserRound },
  { id: "models", label: "Modelle & Kontext", icon: Cpu },
  { id: "permissions", label: "Freigaben & Sicherheit", icon: ShieldCheck },
  { id: "agents", label: "Agents & Subagents", icon: Bot },
  { id: "tools", label: "Werkzeuge & MCP", icon: Plug },
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
};

const SECTION_KEYS: Record<string, string[]> = {
  models: ["active_model", "auto_compact_threshold", "show_thinking_nodes"],
  permissions: ["default_agent", "bypass_tool_permissions", "enable_auto_approve", "smart_approve_available"],
  agents: ["enable_subagents", "max_subagents", "max_concurrent_subagents", "enable_background_processes"],
  tools: ["enable_mcp", "enable_connectors"],
};

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

function Row({ title, description, control, warn, reset }: { title: ReactNode; description?: ReactNode; control: ReactNode; warn?: boolean; reset?: () => void }) {
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

function Card({ title, children, description }: { title?: string; description?: ReactNode; children: ReactNode }) {
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

  const reload = useCallback(async () => {
    try {
      setConfig(await api.readConfig());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    reload();
    api.configSchema().then((r) => setSchema(r.schema)).catch((e) => setError(String(e)));
  }, [reload]);

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
        {SECTIONS.map((s) => (
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
              <Card title="Tastenkürzel">
                {[
                  ["Neue Session", "Strg+N"],
                  ["Suchen und Befehle", "Strg+K"],
                  ["Einstellungen", "Strg+,"],
                  ["Seitenleiste ein/aus", "Strg+B"],
                  ["Detailpanel ein/aus", "Strg+J"],
                  ["Laufenden Turn abbrechen", "Esc"],
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
                      <Button variant="danger" onClick={() => window.confirm("Wirklich abmelden? Der gespeicherte Schlüssel wird entfernt.") && signOut()}>
                        Abmelden
                      </Button>
                    ) : null
                  }
                />
              </Card>
              <Card title="Mistral Vibe">
                <Row title="Version" control={<span className="text-fg-2">{info?.init.agentInfo?.version ?? "–"}</span>} />
                <Row title="Programm" control={<span className="font-mono text-[0.82em] text-fg-2 selectable">{info?.agentPath}</span>} />
                <Row title="Konfiguration" control={<span className="font-mono text-[0.82em] text-fg-2 selectable">{config?.path}</span>} />
              </Card>
            </>
          )}

          {section === "models" && <Card>{SECTION_KEYS.models.map(field)}</Card>}

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

          {section === "agents" && <Card description="Subagents übernehmen Teilaufgaben mit eigenem Kontext, z. B. „explore“ zum Durchsuchen des Codes.">{SECTION_KEYS.agents.map(field)}</Card>}

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
          <Button variant="danger" size="sm" onClick={() => window.confirm(`${secret.length} Einträge entfernen?`) && remove(secret)}>
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
