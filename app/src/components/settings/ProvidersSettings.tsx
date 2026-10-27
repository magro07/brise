import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, KeyRound, Pencil, Plus, RefreshCw, Server, ShieldCheck, Trash2, X } from "lucide-react";
import { confirmAction } from "../../lib/dialogs";
import { EMPTY_PROVIDER, TEMPLATES, isChatModel, providersApi, useProviders, type KeyCheck, type Provider, type ProviderView, type Template } from "../../lib/providers";
import { useStore } from "../../lib/store";
import { Button, Spinner, Switch, clsx } from "../ui";
import { Card, Row } from "./Settings";

const INPUT = "h-8 w-full rounded-lg border border-line bg-bg px-2.5 text-[0.9em] outline-none focus:border-accent";

/** Was nur bei einem bestimmten Anbieter geht – ehrlich gekennzeichnet. */
const ONLY_HERE: Record<string, string[]> = {
  mistral: ["Codestral-Vervollständigung im Editor (FIM)", "Mistral OCR für PDF-, Word- und PowerPoint-Anhänge", "Voxtral: Spracheingabe und Vorlesen (über Vibe)", "Vibe selbst (Agent)"],
  cortecs: ["Decision-Modelle mit Wahrscheinlichkeiten (clef, laya)", "ZDR-Proxy für Vibe, EU-only und § 203 StGB (siehe Datenschutz & Sicherheit)"],
};

const KEY_HELP: Record<string, string> = {
  mistral: "Vibe-Key (Studio → Code → Vibe CLI) oder API-Key. Geteilt mit Vibe-CLI und VS-Code-Erweiterung.",
  anthropic: "API-Key aus console.anthropic.com (nicht das Claude-Abo – das nutzt Claude Code selbst).",
  openai: "API-Key aus platform.openai.com.",
  gemini: "API-Key aus Google AI Studio.",
  cortecs: "API-Key aus der Cortecs-Konsole.",
};

/** Einstellungen → Anbieter & Schlüssel. */
export function ProvidersSettings() {
  const list = useProviders((s) => s.list);
  const refresh = useProviders((s) => s.refresh);
  const [adding, setAdding] = useState<Template | null>(null);
  const [editing, setEditing] = useState<ProviderView | null>(null);
  useEffect(() => {
    refresh();
  }, []);
  const builtin = list.filter((p) => p.builtin);
  const custom = list.filter((p) => !p.builtin);
  return (
    <>
      <p className="mb-5 text-[0.92em] text-fg-2">
        Brise trifft eigene kleine Entscheidungen (Aufgaben einstufen, Vorschläge, Commit-Nachrichten, Council, Benchmarks, Prüfung auf sensible Daten).
        Welches Modell dabei arbeitet, wählst du unter <b>Modelle &amp; Automatik</b> – aus allen Anbietern, die hier einen Schlüssel haben. Schlüssel liegen nur im
        Schlüsselbund des Systems.
      </p>
      <Card title="Anbieter">
        {!list.length && (
          <div className="flex items-center gap-2 px-4 py-3.5 text-muted">
            <Spinner /> Lade Anbieter …
          </div>
        )}
        {builtin.map((p) => (
          <ProviderRow key={p.id} p={p} onChanged={refresh} />
        ))}
      </Card>

      <Card
        title="OpenAI-kompatibel"
        description="Beliebig viele eigene Endpunkte – lokal (Ollama, LM Studio, vLLM) oder in der Cloud (OpenRouter, Groq, Together, Azure OpenAI). Auf Wunsch auch als Modelle für Vibe."
      >
        {custom.map((p) => (
          <ProviderRow key={p.id} p={p} onChanged={refresh} onEdit={() => setEditing(p)} />
        ))}
        {(adding || editing) && (
          <ProviderEditor
            template={adding}
            initial={editing}
            onDone={() => {
              setAdding(null);
              setEditing(null);
              refresh();
            }}
          />
        )}
        {!adding && !editing && (
          <div className="px-4 py-3">
            <div className="mb-2 text-[0.86em] text-muted">Anbieter hinzufügen:</div>
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATES.map((t) => (
                <Button key={t.id} size="sm" onClick={() => setAdding(t)} data-testid={`provider-template-${t.id}`}>
                  <Plus className="h-3.5 w-3.5" /> {t.name}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

function Badge({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "ok" | "warn" | "accent" }) {
  return (
    <span
      className={clsx(
        "rounded px-1.5 py-px text-[0.75em] font-medium",
        tone === "ok" && "bg-ok-soft text-ok",
        tone === "warn" && "bg-warn-soft text-warn",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "plain" && "bg-hover text-fg-2",
      )}
    >
      {children}
    </span>
  );
}

function ProviderRow({ p, onChanged, onEdit }: { p: ProviderView; onChanged: () => void; onEdit?: () => void }) {
  const [open, setOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<KeyCheck | { valid: boolean; message: string } | null>(null);
  const refreshCortecs = useStore((s) => s.refreshCortecs);

  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try {
      await f();
    } catch (e) {
      setResult({ valid: false, message: String(e) });
    } finally {
      setBusy(null);
    }
  };
  const status = p.hasKey ? (
    <Badge tone="ok">Schlüssel {p.keySource === "env" ? "aus Umgebung" : p.keySource === "vibe" ? "mit Vibe geteilt" : "im Schlüsselbund"}</Badge>
  ) : p.keyOptional ? (
    <Badge tone="ok">ohne Schlüssel</Badge>
  ) : (
    <Badge>kein Schlüssel</Badge>
  );
  return (
    <div data-testid={`provider-${p.id}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button className="text-muted hover:text-fg" onClick={() => setOpen(!open)} aria-label={open ? "Zuklappen" : "Aufklappen"}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-medium">
            {p.name}
            {status}
            {p.local && <Badge tone="accent">lokal</Badge>}
            {(p.zdr || p.local) && <Badge tone="accent">ohne Datenspeicherung</Badge>}
            {p.vibeExport && <Badge>in Vibe</Badge>}
          </div>
          <div className="mt-0.5 truncate font-mono text-[0.8em] text-muted">
            {p.keyHint ? `${p.keyHint} · ` : ""}
            {p.baseUrl}
            {p.models.length ? ` · ${p.models.length} Modelle` : ""}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {p.usable && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy}
              data-testid={`provider-check-${p.id}`}
              onClick={() =>
                run("check", async () => {
                  setResult(await providersApi.check(p.id));
                  onChanged();
                })
              }
            >
              {busy === "check" ? <Spinner /> : <CheckCircle2 className="h-3.5 w-3.5" />} Prüfen
            </Button>
          )}
          <Button size="sm" onClick={() => setKeyOpen(!keyOpen)} data-testid={`provider-key-${p.id}`}>
            <KeyRound className="h-3.5 w-3.5" /> {p.hasKey ? "Ersetzen" : "Schlüssel"}
          </Button>
          {onEdit && (
            <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Bearbeiten">
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      {(keyOpen || result) && (
        <div className="space-y-2 px-4 pb-3 pl-11">
          {keyOpen && (
            <>
              <div className="text-[0.84em] text-muted">{KEY_HELP[p.id] ?? (p.keyOptional ? "Lokaler Server: Schlüssel nur nötig, wenn der Server einen verlangt." : "Schlüssel des Anbieters.")}</div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={key}
                  onChange={(e) => (setKey(e.target.value), setResult(null))}
                  placeholder="Schlüssel einfügen …"
                  className={clsx(INPUT, "font-mono")}
                  data-testid={`provider-key-input-${p.id}`}
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!key.trim() || !!busy}
                  data-testid={`provider-key-save-${p.id}`}
                  onClick={() =>
                    run("save", async () => {
                      const r = await providersApi.setKey(p.id, key);
                      setResult(r);
                      if (r.valid) {
                        setKey("");
                        setKeyOpen(false);
                        onChanged();
                        if (p.id === "cortecs") refreshCortecs();
                      }
                    })
                  }
                >
                  {busy === "save" ? <Spinner /> : null} Prüfen und speichern
                </Button>
                {p.hasKey && p.keySource === "keyring" && p.id !== "mistral" && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() =>
                      run("delete", async () => {
                        if (!(await confirmAction(`Schlüssel für ${p.name} aus dem Schlüsselbund entfernen?`, true))) return;
                        await providersApi.deleteKey(p.id);
                        setKeyOpen(false);
                        onChanged();
                      })
                    }
                  >
                    Entfernen
                  </Button>
                )}
              </div>
            </>
          )}
          {result && (
            <div className={clsx("text-[0.86em]", result.valid ? "text-ok" : "text-bad")} data-testid={`provider-result-${p.id}`}>
              {result.message}
              {"models" in result && result.models.length > 0 && <span className="text-muted"> · {result.models.length} Modelle gefunden</span>}
            </div>
          )}
        </div>
      )}
      {open && <ProviderDetails p={p} onChanged={onChanged} />}
    </div>
  );
}

function ProviderDetails({ p, onChanged }: { p: ProviderView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testModel, setTestModel] = useState(p.testModel);
  const [prices, setPrices] = useState({ input: p.inputPrice?.toString() ?? "", output: p.outputPrice?.toString() ?? "" });
  const save = async (patch: Partial<Provider>) => {
    setError(null);
    try {
      await providersApi.save({ ...p, ...patch });
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  };
  const chat = p.models.filter(isChatModel);
  const num = (s: string) => (s.trim() === "" ? null : Math.max(0, parseFloat(s.replace(",", ".")) || 0));
  return (
    <div className="mx-4 mb-3 ml-11 space-y-3 rounded-lg border border-line bg-panel p-3 text-[0.9em]">
      {ONLY_HERE[p.id] && (
        <div>
          <div className="mb-1 font-medium">Nur bei {p.name}</div>
          <ul className="list-disc pl-5 text-fg-2">
            {ONLY_HERE[p.id].map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className="mb-1 flex items-center gap-2 font-medium">
          Modelle
          <button
            className="text-muted hover:text-fg disabled:opacity-40"
            disabled={busy || !p.usable}
            title="Liste neu laden"
            onClick={async () => {
              setBusy(true);
              setError(null);
              await providersApi.models(p.id, true).catch((e) => setError(String(e)));
              setBusy(false);
              onChanged();
            }}
          >
            {busy ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>
        {chat.length ? (
          <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
            {chat.map((m) => (
              <span key={m} className="rounded border border-line bg-elev px-1.5 font-mono text-[0.82em]">
                {m}
              </span>
            ))}
          </div>
        ) : (
          <div className="text-muted">{p.usable ? "Noch keine Liste – „Prüfen“ oder neu laden." : "Erst einen Schlüssel speichern."}</div>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className="text-[0.86em] text-muted">
          Testmodell
          <input
            value={testModel}
            onChange={(e) => setTestModel(e.target.value)}
            onBlur={() => testModel !== p.testModel && save({ testModel })}
            placeholder="automatisch"
            className={clsx(INPUT, "mt-1 font-mono")}
          />
        </label>
        <label className="text-[0.86em] text-muted">
          Eingabe € / Mio. Tokens
          <input
            value={prices.input}
            onChange={(e) => setPrices({ ...prices, input: e.target.value })}
            onBlur={() => save({ inputPrice: num(prices.input), outputPrice: num(prices.output) })}
            placeholder={p.local ? "0 (lokal)" : "Preistabelle"}
            className={clsx(INPUT, "mt-1")}
          />
        </label>
        <label className="text-[0.86em] text-muted">
          Ausgabe € / Mio. Tokens
          <input
            value={prices.output}
            onChange={(e) => setPrices({ ...prices, output: e.target.value })}
            onBlur={() => save({ inputPrice: num(prices.input), outputPrice: num(prices.output) })}
            placeholder={p.local ? "0 (lokal)" : "Preistabelle"}
            className={clsx(INPUT, "mt-1")}
          />
        </label>
      </div>
      {p.exportable && <VibeExport p={p} chat={chat} save={save} />}
      {!p.builtin && (
        <Button
          size="sm"
          variant="danger"
          onClick={async () => {
            if (!(await confirmAction(`Anbieter „${p.name}“ samt Schlüssel entfernen?`, true))) return;
            await providersApi.remove(p.id).catch((e) => setError(String(e)));
            onChanged();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" /> Anbieter entfernen
        </Button>
      )}
      {error && <div className="text-bad selectable">{error}</div>}
    </div>
  );
}

/** Anbieter samt ausgewählter Modelle in Vibes config.toml eintragen. */
function VibeExport({ p, chat, save }: { p: ProviderView; chat: string[]; save: (patch: Partial<Provider>) => Promise<void> }) {
  const vibe = useStore((s) => !!s.agents.vibe);
  const [extra, setExtra] = useState("");
  const choices = [...new Set([...chat, ...p.vibeModels])];
  const toggle = (m: string, on: boolean) => save({ vibeExport: true, vibeModels: on ? [...p.vibeModels, m] : p.vibeModels.filter((x) => x !== m) });
  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="font-medium">In Vibe nutzen</div>
          <div className="text-[0.86em] text-muted">
            Trägt {p.name} als Anbieter „brise-{p.id}“ in Vibes config.toml ein. Anfragen laufen über Brises lokalen Proxy, der den Schlüssel einsetzt – Vibe
            selbst sieht ihn nie. Ohne laufendes Brise sind diese Modelle in Vibe nicht nutzbar.{!vibe && " (Vibe ist gerade nicht verbunden.)"}
          </div>
        </div>
        <Switch checked={p.vibeExport} disabled={!p.usable} onChange={(v) => save({ vibeExport: v })} data-testid={`provider-vibe-${p.id}`} />
      </div>
      {p.vibeExport && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {choices.map((m) => (
            <label key={m} className="flex items-center gap-1 rounded border border-line bg-elev px-1.5 py-0.5 font-mono text-[0.82em]">
              <input type="checkbox" checked={p.vibeModels.includes(m)} onChange={(e) => toggle(m, e.target.checked)} className="accent-[var(--accent)]" />
              {m}
            </label>
          ))}
          <input
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && extra.trim()) {
                toggle(extra.trim(), true);
                setExtra("");
              }
            }}
            placeholder="weiteres Modell + Enter"
            className="h-6 w-44 rounded border border-line bg-bg px-1.5 font-mono text-[0.82em] outline-none focus:border-accent"
          />
        </div>
      )}
    </div>
  );
}

/** Neuer oder geänderter OpenAI-kompatibler Anbieter. */
function ProviderEditor({ template, initial, onDone }: { template: Template | null; initial: ProviderView | null; onDone: () => void }) {
  const [p, setP] = useState<Provider>(() =>
    initial
      ? { ...initial }
      : {
          ...EMPTY_PROVIDER,
          name: template?.id === "custom" ? "" : template?.name ?? "",
          baseUrl: template?.baseUrl ?? "",
          template: template?.id ?? null,
          authHeader: template?.authHeader ?? "",
          headers: template?.headers ?? {},
          zdr: !!template?.zdr,
          testModel: template?.testModel ?? "",
        },
  );
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const headers = Object.entries(p.headers);
  const setHeaders = (rows: [string, string][]) => setP({ ...p, headers: Object.fromEntries(rows) });

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await providersApi.save(p);
      if (key.trim()) {
        const r = await providersApi.setKey(saved.id, key);
        if (!r.valid) {
          setP({ ...p, id: saved.id });
          setMessage({ ok: false, text: r.message });
          return;
        }
      } else if (saved.keyOptional || saved.hasKey) {
        const r = await providersApi.check(saved.id).catch((e) => ({ valid: false, message: String(e) }) as KeyCheck);
        if (!r.valid) {
          setP({ ...p, id: saved.id });
          setMessage({ ok: false, text: `Gespeichert, aber die Prüfung schlug fehl: ${r.message}` });
          return;
        }
      }
      onDone();
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5 bg-panel px-4 py-3" data-testid="provider-editor">
      <div className="flex items-center gap-2 font-medium">
        <Server className="h-4 w-4 text-muted" /> {initial ? `${initial.name} bearbeiten` : template?.name ?? "Neuer Anbieter"}
        <div className="flex-1" />
        <button className="text-muted hover:text-fg" onClick={onDone} aria-label="Abbrechen">
          <X className="h-4 w-4" />
        </button>
      </div>
      {template?.hint && <div className="text-[0.86em] text-muted">{template.hint}</div>}
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[0.86em] text-muted">
          Name
          <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} className={clsx(INPUT, "mt-1")} data-testid="provider-name" />
        </label>
        <label className="text-[0.86em] text-muted">
          Base-URL (mit /v1)
          <input value={p.baseUrl} onChange={(e) => setP({ ...p, baseUrl: e.target.value })} className={clsx(INPUT, "mt-1 font-mono")} data-testid="provider-base-url" />
        </label>
        <label className="text-[0.86em] text-muted">
          Schlüssel {template?.keyless || initial?.keyOptional ? "(optional)" : ""}
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={initial?.hasKey ? "unverändert" : ""}
            className={clsx(INPUT, "mt-1 font-mono")}
            data-testid="provider-key"
          />
        </label>
        <label className="text-[0.86em] text-muted">
          Schlüssel-Kopfzeile
          <input value={p.authHeader} onChange={(e) => setP({ ...p, authHeader: e.target.value })} placeholder="Authorization: Bearer" className={clsx(INPUT, "mt-1 font-mono")} />
        </label>
        <label className="text-[0.86em] text-muted">
          Testmodell (optional)
          <input value={p.testModel} onChange={(e) => setP({ ...p, testModel: e.target.value })} placeholder="automatisch aus /models" className={clsx(INPUT, "mt-1 font-mono")} data-testid="provider-test-model" />
        </label>
        <label className="flex items-end gap-2 pb-1.5 text-[0.86em]">
          <input type="checkbox" checked={p.zdr} onChange={(e) => setP({ ...p, zdr: e.target.checked })} className="accent-[var(--accent)]" />
          <ShieldCheck className="h-3.5 w-3.5 text-muted" /> Speichert keine Daten (lokal oder ZDR-Vertrag)
        </label>
      </div>
      <div>
        <div className="mb-1 text-[0.86em] text-muted">Weitere Kopfzeilen (keine Geheimnisse – die gehören ins Schlüsselfeld)</div>
        {headers.map(([k, v], n) => (
          <div key={n} className="mb-1 flex gap-2">
            <input value={k} onChange={(e) => setHeaders(headers.map((h, i) => (i === n ? [e.target.value, h[1]] : h)))} placeholder="Name" className={clsx(INPUT, "font-mono")} />
            <input value={v} onChange={(e) => setHeaders(headers.map((h, i) => (i === n ? [h[0], e.target.value] : h)))} placeholder="Wert" className={clsx(INPUT, "font-mono")} />
            <button className="text-muted hover:text-bad" onClick={() => setHeaders(headers.filter((_, i) => i !== n))} aria-label="Kopfzeile entfernen">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setHeaders([...headers, ["", ""]])}>
          <Plus className="h-3.5 w-3.5" /> Kopfzeile
        </Button>
      </div>
      {message && <div className={clsx("text-[0.86em] selectable", message.ok ? "text-ok" : "text-bad")}>{message.text}</div>}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={busy || !p.name.trim() || !p.baseUrl.trim()} onClick={submit} data-testid="provider-save">
          {busy ? <Spinner /> : null} Speichern und prüfen
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Abbrechen
        </Button>
      </div>
    </div>
  );
}

/** Kurzer Hinweis für andere Seiten, wenn kein Anbieter eingerichtet ist. */
export function NoProviderHint() {
  const list = useProviders((s) => s.list);
  const setView = useStore((s) => s.setView);
  if (!list.length || list.some((p) => p.usable)) return null;
  return (
    <Row
      title="Kein Anbieter eingerichtet"
      description="Ohne Schlüssel schätzt Brise mit einfachen Regeln statt mit einem Modell."
      control={
        <Button size="sm" onClick={() => setView("settings", "providers")}>
          Anbieter einrichten
        </Button>
      }
    />
  );
}
