import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, FolderOpen, Plus, Trash2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { benchApi, type BenchTarget, type BenchTask, type Benchmark, type Check } from "../../lib/bench";
import { useStore } from "../../lib/store";
import { Button, clsx } from "../ui";
import { ModelSelect } from "../settings/ModelSelect";

const input = "h-8 w-full rounded-md border border-line bg-bg px-2 text-[0.92em] outline-none focus:border-accent";
const area = "w-full rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[0.88em] outline-none focus:border-accent selectable";

function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      <div className="mb-1 text-[0.85em] font-medium text-fg-2">{label}</div>
      {children}
      {hint && <div className="mt-0.5 text-[0.8em] text-muted">{hint}</div>}
    </label>
  );
}

const CHECK_TYPES: { type: Check["type"]; label: string }[] = [
  { type: "regex", label: "Antwort passt auf Regex" },
  { type: "contains", label: "Antwort enthält Text" },
  { type: "command", label: "Befehl muss grün sein" },
  { type: "file", label: "Datei vorhanden / passt" },
  { type: "judge", label: "Richtermodell bewertet" },
];

function emptyCheck(type: Check["type"]): Check {
  switch (type) {
    case "regex":
      return { type, pattern: "" };
    case "contains":
      return { type, value: "" };
    case "command":
      return { type, run: "" };
    case "file":
      return { type, path: "" };
    case "judge":
      return { type, criteria: "" };
  }
}

const emptyTask = (n: number): BenchTask => ({ id: "", name: `Aufgabe ${n}`, prompt: "", checks: [{ type: "regex", pattern: "" }] });

/** Leere Felder weglassen, damit die Datei schlank bleibt. */
function clean(b: Benchmark): Benchmark {
  const opt = (s?: string) => (s && s.trim() ? s.trim() : undefined);
  return {
    ...b,
    description: b.description?.trim() || undefined,
    judgeModel: opt(b.judgeModel),
    tasks: b.tasks.map((t) => ({
      ...t,
      project: opt(t.project),
      ref: opt(t.ref),
      setup: opt(t.setup),
      files: t.files && Object.keys(t.files).length ? t.files : undefined,
      timeoutSec: t.timeoutSec || undefined,
    })),
    targets: b.targets.map((t) => ({ ...t, model: opt(t.model), label: opt(t.label), options: t.options && Object.keys(t.options).length ? t.options : undefined })),
  };
}

export function BenchEditor({ initial, onCancel, onSaved }: { initial: Benchmark; onCancel: () => void; onSaved: (id: string) => void }) {
  const [bench, setBench] = useState<Benchmark>(initial);
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const patchTask = (i: number, p: Partial<BenchTask>) => setBench((b) => ({ ...b, tasks: b.tasks.map((t, n) => (n === i ? { ...t, ...p } : t)) }));
  const patchTarget = (i: number, p: Partial<BenchTarget>) => setBench((b) => ({ ...b, targets: b.targets.map((t, n) => (n === i ? { ...t, ...p } : t)) }));

  const current = (): Benchmark => {
    if (json === null) return clean(bench);
    const parsed = JSON.parse(json) as Benchmark;
    return { ...parsed, id: bench.id };
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      onSaved(await benchApi.save(current()));
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleJson = () => {
    setError(null);
    if (json === null) {
      const { id: _id, ...rest } = clean(bench);
      setJson(JSON.stringify(rest, null, 2));
    } else {
      try {
        setBench(current());
        setJson(null);
      } catch (e) {
        setError(`JSON: ${e}`);
      }
    }
  };

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <ArrowLeft className="h-3.5 w-3.5" /> Zurück
        </Button>
        <div className="flex-1 truncate font-medium">{bench.id ? `${bench.id}.json` : "Neuer Benchmark"}</div>
        <Button size="sm" variant="ghost" onClick={toggleJson}>
          {json === null ? "Als JSON bearbeiten" : "Formular"}
        </Button>
        <Button size="sm" variant="primary" disabled={saving} onClick={save}>
          Speichern
        </Button>
      </div>
      {error && <div className="mb-4 whitespace-pre-wrap rounded-lg bg-bad-soft px-3 py-2 text-[0.9em] text-bad selectable">{error}</div>}

      {json !== null ? (
        <textarea value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} className={clsx(area, "h-[60vh]")} />
      ) : (
        <div className="space-y-6">
          <section className="space-y-3 rounded-xl border border-line bg-elev p-4">
            <Field label="Name">
              <input className={input} value={bench.name} onChange={(e) => setBench({ ...bench, name: e.target.value })} placeholder="z. B. Refactorings im Backend" />
            </Field>
            <Field label="Beschreibung">
              <input className={input} value={bench.description ?? ""} onChange={(e) => setBench({ ...bench, description: e.target.value })} />
            </Field>
            <Field label="Richtermodell" hint="Für Prüfungen „Richtermodell bewertet“ ohne eigenes Modell – jeder Anbieter mit Schlüssel, z. B. cortecs/<modell> für ZDR. Standard: Richter unter Modelle & Automatik.">
              <ModelSelect value={bench.judgeModel ?? ""} emptyLabel="Standard (Modelle & Automatik)" onChange={(judgeModel) => setBench({ ...bench, judgeModel })} className="w-full max-w-none" />
            </Field>
          </section>

          <section>
            <div className="mb-2 flex items-center">
              <h3 className="flex-1 text-[0.95em] font-semibold">Ziele</h3>
              <Button size="sm" onClick={() => setBench({ ...bench, targets: [...bench.targets, { backend: "vibe" }] })}>
                <Plus className="h-3.5 w-3.5" /> Ziel
              </Button>
            </div>
            <div className="space-y-2">
              {bench.targets.length === 0 && <p className="text-[0.88em] text-muted">Noch keine Ziele – welche Modelle bzw. Agenten sollen die Aufgaben lösen?</p>}
              {bench.targets.map((t, i) => (
                <TargetRow key={i} target={t} onChange={(p) => patchTarget(i, p)} onRemove={() => setBench({ ...bench, targets: bench.targets.filter((_, n) => n !== i) })} />
              ))}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center">
              <h3 className="flex-1 text-[0.95em] font-semibold">Aufgaben</h3>
              <Button size="sm" onClick={() => setBench({ ...bench, tasks: [...bench.tasks, emptyTask(bench.tasks.length + 1)] })}>
                <Plus className="h-3.5 w-3.5" /> Aufgabe
              </Button>
            </div>
            <div className="space-y-4">
              {bench.tasks.map((t, i) => (
                <TaskForm key={i} task={t} onChange={(p) => patchTask(i, p)} onRemove={() => setBench({ ...bench, tasks: bench.tasks.filter((_, n) => n !== i) })} />
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function TargetRow({ target, onChange, onRemove }: { target: BenchTarget; onChange: (p: Partial<BenchTarget>) => void; onRemove: () => void }) {
  const backends = useStore((s) => s.backends);
  const templates = useStore((s) => s.templates);
  const models = templates[target.backend]?.config.find((o) => o.id === "model")?.options ?? [];
  const listId = `bench-models-${target.backend}`;
  const [options, setOptions] = useState(() =>
    Object.entries(target.options ?? {})
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(", "),
  );
  const parseOptions = (text: string) => {
    const out: Record<string, unknown> = {};
    for (const part of text.split(",")) {
      const [k, ...v] = part.split("=");
      if (k?.trim() && v.length) out[k.trim()] = v.join("=").trim();
    }
    return out;
  };
  const known = backends.length ? backends : [{ id: "vibe", title: "Vibe", installed: true }];
  return (
    <div className="grid grid-cols-[130px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2 rounded-xl border border-line bg-elev p-3">
      <Field label="Agent">
        <select className={input} value={target.backend} onChange={(e) => onChange({ backend: e.target.value })}>
          {known.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
              {b.installed ? "" : " (nicht installiert)"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Modell">
        <input className={input} list={listId} value={target.model ?? ""} onChange={(e) => onChange({ model: e.target.value })} placeholder="Standard des Agenten" />
        <datalist id={listId}>
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.name}
            </option>
          ))}
        </datalist>
      </Field>
      <Field label="Optionen">
        <input
          className={input}
          value={options}
          onChange={(e) => (setOptions(e.target.value), onChange({ options: parseOptions(e.target.value) }))}
          placeholder="thinking=high"
        />
      </Field>
      <Field label="Anzeigename">
        <input className={input} value={target.label ?? ""} onChange={(e) => onChange({ label: e.target.value })} placeholder="optional" />
      </Field>
      <Button size="sm" variant="ghost" className="mb-0.5" onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function TaskForm({ task, onChange, onRemove }: { task: BenchTask; onChange: (p: Partial<BenchTask>) => void; onRemove: () => void }) {
  const files = useMemo(() => Object.entries(task.files ?? {}), [task.files]);
  const setFiles = (entries: [string, string][]) => onChange({ files: Object.fromEntries(entries) });
  const setCheck = (i: number, c: Check) => onChange({ checks: task.checks.map((x, n) => (n === i ? c : x)) });

  return (
    <div className="space-y-3 rounded-xl border border-line bg-elev p-4">
      <div className="flex items-end gap-2">
        <Field label="Name" className="flex-1">
          <input className={input} value={task.name} onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        <Field label="Zeitlimit (s)" className="w-28">
          <input className={input} type="number" min={10} value={task.timeoutSec ?? ""} placeholder="600" onChange={(e) => onChange({ timeoutSec: Number(e.target.value) || undefined })} />
        </Field>
        <Button size="sm" variant="ghost" className="mb-0.5" onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <Field label="Prompt">
        <textarea className={clsx(area, "h-24 font-sans")} value={task.prompt} onChange={(e) => onChange({ prompt: e.target.value })} />
      </Field>
      <div className="grid grid-cols-[minmax(0,1fr)_160px] gap-2">
        <Field label="Projektordner" hint="Wird je Lauf kopiert (ohne .git und Ignoriertes), mit Ref per git clone. Leer = leerer Ordner.">
          <div className="flex gap-1">
            <input className={input} value={task.project ?? ""} onChange={(e) => onChange({ project: e.target.value })} placeholder="optional" />
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const dir = await openDialog({ directory: true });
                if (typeof dir === "string") onChange({ project: dir });
              }}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          </div>
        </Field>
        <Field label="Startzustand (Git-Ref)">
          <input className={input} value={task.ref ?? ""} onChange={(e) => onChange({ ref: e.target.value })} placeholder="z. B. main, v1.2, a1b2c3" />
        </Field>
      </div>
      <Field label="Vorbereitung" hint="Befehl im Arbeitsordner vor dem Prompt, z. B. npm ci.">
        <input className={clsx(input, "font-mono")} value={task.setup ?? ""} onChange={(e) => onChange({ setup: e.target.value })} placeholder="optional" />
      </Field>

      <div>
        <div className="mb-1 flex items-center">
          <div className="flex-1 text-[0.85em] font-medium text-fg-2">Zusätzliche Dateien</div>
          <Button size="sm" variant="ghost" onClick={() => setFiles([...files, [`datei${files.length + 1}.txt`, ""]])}>
            <Plus className="h-3.5 w-3.5" /> Datei
          </Button>
        </div>
        {files.map(([path, content], i) => (
          <div key={i} className="mb-2 space-y-1">
            <div className="flex gap-1">
              <input className={clsx(input, "font-mono")} value={path} onChange={(e) => setFiles(files.map((f, n) => (n === i ? [e.target.value, f[1]] : f)))} />
              <Button size="sm" variant="ghost" onClick={() => setFiles(files.filter((_, n) => n !== i))}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <textarea className={clsx(area, "h-24")} value={content} spellCheck={false} onChange={(e) => setFiles(files.map((f, n) => (n === i ? [f[0], e.target.value] : f)))} />
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1 flex items-center">
          <div className="flex-1 text-[0.85em] font-medium text-fg-2">Prüfungen (alle müssen bestehen)</div>
          <Button size="sm" variant="ghost" onClick={() => onChange({ checks: [...task.checks, emptyCheck("regex")] })}>
            <Plus className="h-3.5 w-3.5" /> Prüfung
          </Button>
        </div>
        <div className="space-y-2">
          {task.checks.map((c, i) => (
            <CheckForm key={i} check={c} onChange={(c) => setCheck(i, c)} onRemove={() => onChange({ checks: task.checks.filter((_, n) => n !== i) })} />
          ))}
        </div>
      </div>
    </div>
  );
}

function CheckForm({ check, onChange, onRemove }: { check: Check; onChange: (c: Check) => void; onRemove: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line p-2">
      <select className={clsx(input, "w-52 shrink-0")} value={check.type} onChange={(e) => onChange(emptyCheck(e.target.value as Check["type"]))}>
        {CHECK_TYPES.map((t) => (
          <option key={t.type} value={t.type}>
            {t.label}
          </option>
        ))}
      </select>
      <div className="min-w-0 flex-1 space-y-1">
        {check.type === "regex" && <input className={clsx(input, "font-mono")} value={check.pattern} onChange={(e) => onChange({ ...check, pattern: e.target.value })} placeholder="\b391\b" />}
        {check.type === "contains" && (
          <div className="flex items-center gap-2">
            <input className={input} value={check.value} onChange={(e) => onChange({ ...check, value: e.target.value })} />
            <label className="flex shrink-0 items-center gap-1 text-[0.85em] text-fg-2">
              <input type="checkbox" checked={!!check.ignoreCase} onChange={(e) => onChange({ ...check, ignoreCase: e.target.checked })} /> Groß/klein egal
            </label>
          </div>
        )}
        {check.type === "command" && (
          <div className="flex gap-2">
            <input className={clsx(input, "font-mono")} value={check.run} onChange={(e) => onChange({ ...check, run: e.target.value })} placeholder="npm test" />
            <input
              className={clsx(input, "w-24")}
              type="number"
              value={check.timeoutSec ?? ""}
              placeholder="300 s"
              onChange={(e) => onChange({ ...check, timeoutSec: Number(e.target.value) || undefined })}
            />
          </div>
        )}
        {check.type === "file" && (
          <div className="flex gap-2">
            <input className={clsx(input, "font-mono")} value={check.path} onChange={(e) => onChange({ ...check, path: e.target.value })} placeholder="src/neu.ts" />
            <input
              className={clsx(input, "font-mono")}
              value={check.pattern ?? ""}
              onChange={(e) => onChange({ ...check, pattern: e.target.value || undefined })}
              placeholder="Regex für den Inhalt (optional)"
            />
          </div>
        )}
        {check.type === "judge" && (
          <>
            <textarea
              className={clsx(area, "h-16 font-sans")}
              value={check.criteria}
              onChange={(e) => onChange({ ...check, criteria: e.target.value })}
              placeholder="Woran soll der Richter die Antwort messen?"
            />
            <div className="flex gap-2">
              <ModelSelect value={check.model ?? ""} emptyLabel="Richtermodell des Benchmarks" onChange={(m) => onChange({ ...check, model: m || undefined })} className="max-w-none flex-1" />
              <input
                className={clsx(input, "w-36")}
                type="number"
                step={0.05}
                min={0}
                max={1}
                value={check.threshold ?? ""}
                placeholder="Schwelle 0,6"
                onChange={(e) => onChange({ ...check, threshold: e.target.value === "" ? undefined : Number(e.target.value) })}
              />
            </div>
          </>
        )}
      </div>
      <Button size="sm" variant="ghost" onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
