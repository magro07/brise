import { invoke } from "@tauri-apps/api/core";
import { runGoal } from "../../lib/goals";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ArrowUp, AtSign, Box, FileText, Folder, Image, KeyRound, MessageSquare, Mic, Lightbulb, Palette, Paperclip, Plus, ShieldCheck, Target, Slash, Square, X, type LucideIcon } from "lucide-react";
import { basename, isZdr, useStore, type Attachment, type Session, type SlashCommand } from "../../lib/store";
import { cortecs, type SensitiveVerdict } from "../../lib/cortecs";
import { SensitiveNotice } from "./SensitiveNotice";
import { SecretCreate } from "../secrets/SecretPrompt";
import { secretsApi, type SecretFound } from "../../lib/secrets";
import { IconButton, Tip, clsx } from "../ui";
import { VoiceRecorder } from "./VoiceRecorder";
import { ContextMeter, ModelEffortPicker, ModePicker } from "./Pickers";
import { useVoiceAvailable } from "../../lib/backends";
import { BackendPicker } from "../agents/BackendPicker";
import { REF_LABEL, resolveReferences, useReferences, type ComposerRef, type RefKind } from "./references";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const DOC_EXT = /\.(pdf|docx|pptx)$/i;

type Suggestion =
  | { kind: "file"; value: string; label: string; detail: string }
  | { kind: "command"; value: string; label: string; detail: string }
  | { kind: "ref"; value: string; label: string; detail: string; ref: ComposerRef };

const REF_ICON: Record<RefKind, LucideIcon> = { project: Folder, design: Palette, model: Box, session: MessageSquare, image: Image };

/** Treffer unter den Referenzen: Name, sonst Art („@design“ listet alle Designs). */
function matchRefs(list: ComposerRef[], query: string, limit = 6): ComposerRef[] {
  const q = query.toLowerCase();
  if (!q) return list.slice(0, limit);
  const score = (r: ComposerRef) => {
    const name = r.label.toLowerCase();
    return name.startsWith(q) ? 3 : name.includes(q) ? 2 : REF_LABEL[r.kind].toLowerCase().startsWith(q) ? 1 : 0;
  };
  return list
    .map((r) => [score(r), r] as const)
    .filter(([n]) => n > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map(([, r]) => r);
}

export interface ComposerProps {
  session?: Session;
  /** Ordner für @Dateien, Anhänge und Prüfungen; im Design-/3D-Modus das zugeordnete Projekt. */
  project: string;
  focused?: boolean;
  /** Eigenes Senden (Design, 3D); sonst `store.send` an die aktive Session. */
  onSend?: (text: string, attachments: Attachment[], opts: { zdr?: boolean; prefix?: string }) => void;
  onCancel?: () => void;
  /** Eingefügte Bilder als Datei ablegen (Rückgabe: absoluter Pfad). */
  onPasteImage?: (name: string, base64: string) => Promise<string>;
  placeholder?: string;
  disabled?: boolean;
  /** Weitere Knöpfe in der Leiste (Element wählen, Varianten …). */
  tools?: ReactNode;
  /** Weitere Chips über dem Eingabefeld (z. B. ausgewähltes Element). */
  chips?: ReactNode;
  /** Ändert sich der Wert, bekommt das Eingabefeld den Fokus. */
  focusKey?: unknown;
  /** Dieses Design bzw. Modell nicht als Referenz anbieten. */
  exclude?: string;
}

/** Einfache Fuzzy-Suche: Teilfolge, Treffer im Dateinamen zählen mehr. */
function fuzzy(list: string[], query: string, limit = 8): string[] {
  if (!query) return list.slice(0, limit);
  const q = query.toLowerCase();
  const scored: [number, string][] = [];
  for (const item of list) {
    const s = item.toLowerCase();
    const name = s.slice(s.lastIndexOf("/") + 1);
    let score = 0;
    if (name.startsWith(q)) score = 100;
    else if (name.includes(q)) score = 80;
    else if (s.includes(q)) score = 50;
    else {
      let i = 0;
      for (const ch of s) if (ch === q[i]) i++;
      if (i < q.length) continue;
      score = 10;
    }
    scored.push([score - item.length / 1000, item]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, v]) => v);
}

function PlusLabel({ children }: { children: string }) {
  return <div className="px-2.5 pb-1 pt-1.5 text-[0.9em] text-muted">{children}</div>;
}

function PlusRow({ icon: Icon, label, hint, onClick }: { icon: LucideIcon; label: string; hint?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left hover:bg-hover">
      <Icon className="h-4 w-4 shrink-0 text-fg-2" />
      <span className="shrink-0">{label}</span>
      {hint && <span className="truncate text-muted">{hint}</span>}
    </button>
  );
}

export function Composer({ session, project, focused = true, onSend, onCancel, onPasteImage, placeholder, disabled: blocked, tools, chips, focusKey, exclude }: ComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [refs, setRefs] = useState<ComposerRef[]>([]);
  const references = useReferences(project, files, exclude);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = useStore((s) => s.send);
  const cancel = useStore((s) => s.cancel);
  const loadFiles = useStore((s) => s.loadFiles);
  const templateCommands = useStore((s) => s.template?.commands);
  const running = !!session?.running;
  const disabled = !!blocked || !!session?.replaying || !!session?.readOnly;
  const stop = onCancel ?? cancel;
  const commands: SlashCommand[] = session?.commands.length ? session.commands : (templateCommands ?? []);
  const recording = useStore((s) => s.recording);
  const simple = useStore((s) => s.prefs.simpleMode);
  const localStt = useStore((s) => s.prefs.sttEngine === "local");
  const composerInsert = useStore((s) => s.composerInsert);
  const { startRecording, stopRecording, cancelRecording, set: setStore } = useStore.getState();
  const [voiceBusy, setVoiceBusy] = useState(false);
  const voice = useVoiceAvailable();
  const [plusPage, setPlusPage] = useState<"main" | "projects" | null>(null);
  const projects = useStore((s) => s.projects);
  const setOption = useStore((s) => s.setOption);
  const template = useStore((s) => s.template);
  const modes = session?.modes.length ? session.modes : (template?.modes ?? []);
  const insertCommand = (name: string) => {
    setPlusPage(null);
    setText(`/${name} `);
    ref.current?.focus();
  };
  // Bei mehreren Bereichen gehören Drop, Einfügen und Sprache nur dem fokussierten.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const recordingHere = recording && focused;
  const [checking, setChecking] = useState(false);
  const [flagged, setFlagged] = useState<{ verdict: SensitiveVerdict; text: string; attachments: Attachment[] } | null>(null);
  // Secret anlegen: von Hand (ohne found) oder für erkannte Zugangsdaten im Text.
  const [secretPanel, setSecretPanel] = useState<{ found?: SecretFound[]; text?: string; attachments?: Attachment[] } | null>(null);
  const zdrActive = useStore((s) => (session ? isZdr(s, session) : s.prefs.zdrProjects.includes(project)));

  // Von außen eingefügter Text (z. B. Treffer der semantischen Suche).
  useEffect(() => {
    if (!composerInsert || !focusedRef.current) return;
    setText((t) => (t && !t.endsWith(" ") ? `${t} ` : t) + composerInsert.text);
    const m = /^@(\S+)/.exec(composerInsert.text);
    if (m) setAttachments((l) => (l.some((a) => a.path === m[1]) ? l : [...l, { kind: "file", path: m[1], name: basename(m[1]) }]));
    ref.current?.focus();
  }, [composerInsert?.seq]);

  const toggleVoice = async () => {
    if (voiceBusy) return;
    setVoiceBusy(true);
    try {
      if (recording) {
        const spoken = (await stopRecording()).trim();
        if (spoken) setText((t) => (t.trim() ? `${t.trimEnd()} ${spoken}` : spoken));
        ref.current?.focus();
      } else {
        await startRecording();
      }
    } catch (e) {
      setStore({ error: String(e) });
    } finally {
      setVoiceBusy(false);
    }
  };

  useEffect(() => {
    loadFiles(project).then(setFiles);
  }, [project, loadFiles]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  useEffect(() => {
    if (!running) ref.current?.focus();
  }, [running, session?.id]);

  useEffect(() => {
    if (focusKey) ref.current?.focus();
  }, [focusKey]);

  // @Dateien eines anderen Ordners als dem der Session (Design/3D mit Projekt) absolut anhängen.
  const filePath = (f: string) => (session && session.cwd !== project ? `${project.replace(/[\\/]+$/, "")}/${f}` : f);

  const onPaste = (e: React.ClipboardEvent) => {
    const file = onPasteImage && [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
    if (!file || !onPasteImage) return;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = async () => {
      const name = file.name && file.name !== "image.png" ? file.name : `eingefuegt.${file.type.split("/")[1] || "png"}`;
      const path = await onPasteImage(name, String(reader.result).split(",")[1]).catch((err) => (setStore({ error: String(err) }), null));
      if (path) setAttachments((l) => [...l, { kind: "image", path, name }]);
    };
    reader.readAsDataURL(file);
  };

  // Dateien per Drag & Drop anhängen.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if ((e.payload.type === "enter" || e.payload.type === "over") && focusedRef.current) setDragging(true);
        else if (e.payload.type === "leave") setDragging(false);
        else if (e.payload.type === "drop") {
          setDragging(false);
          if (focusedRef.current) addPaths(e.payload.paths);
        }
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  const addPaths = (paths: string[]) =>
    setAttachments((list) => [
      ...list,
      ...paths
        .filter((p) => !list.some((a) => a.path === p))
        .map((p) => ({
          kind: IMAGE_EXT.test(p) ? ("image" as const) : DOC_EXT.test(p) ? ("document" as const) : ("file" as const),
          path: p,
          name: basename(p),
        })),
    ]);

  // Autovervollständigung für @Datei und /Befehl an der Cursorposition.
  const before = text.slice(0, cursor);
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  const slash = /^\/([\w-]*)$/.exec(before);
  const suggestions: Suggestion[] = useMemo(() => {
    if (mention) {
      const found: Suggestion[] = fuzzy(files, mention[2], 5).map((f) => ({ kind: "file", value: f, label: basename(f), detail: f }));
      for (const r of matchRefs(references, mention[2])) found.push({ kind: "ref", value: `${r.kind}:${r.id}`, label: r.label, detail: r.detail, ref: r });
      return found;
    }
    if (slash) {
      const q = slash[1].toLowerCase();
      return [{ name: "goal", description: "Ziel setzen: Der Agent arbeitet weiter, bis es erreicht ist" }, ...commands]
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((c) => ({ kind: "command", value: c.name, label: `/${c.name}`, detail: c.description ?? "" }));
    }
    return [];
  }, [mention?.[2], slash?.[1], files, commands, references]);

  useEffect(() => setSelected(0), [suggestions.length, mention?.[2], slash?.[1]]);

  const accept = (s: Suggestion) => {
    if (s.kind === "ref" && mention) {
      const start = before.length - mention[2].length - 1;
      const word = s.label.replace(/\s+/g, "-");
      setText(`${text.slice(0, start)}@${word} ${text.slice(cursor)}`);
      const r = s.ref;
      if (r.kind === "image") setAttachments((list) => (list.some((a) => a.path === r.id) ? list : [...list, { kind: "image", path: r.id, name: r.label }]));
      else setRefs((list) => (list.some((x) => x.kind === r.kind && x.id === r.id) ? list : [...list, r]));
      requestAnimationFrame(() => {
        const pos = start + word.length + 2;
        ref.current?.setSelectionRange(pos, pos);
        setCursor(pos);
      });
    } else if (s.kind === "file" && mention) {
      const start = before.length - mention[2].length - 1;
      const next = `${text.slice(0, start)}@${s.value} ${text.slice(cursor)}`;
      setText(next);
      const path = filePath(s.value);
      setAttachments((list) => (list.some((a) => a.path === path) ? list : [...list, { kind: "file", path, name: basename(s.value) }]));
      requestAnimationFrame(() => {
        const pos = start + s.value.length + 2;
        ref.current?.setSelectionRange(pos, pos);
        setCursor(pos);
      });
    } else if (s.kind === "command") {
      const next = `/${s.value} ${text.slice(cursor)}`;
      setText(next);
      requestAnimationFrame(() => {
        const pos = s.value.length + 2;
        ref.current?.setSelectionRange(pos, pos);
        setCursor(pos);
      });
    }
  };

  const dispatch = async (t: string, list: Attachment[], opts?: { zdr?: boolean }) => {
    const picked = refs;
    setText("");
    setAttachments([]);
    setRefs([]);
    setCursor(0);
    setFlagged(null);
    setSecretPanel(null);
    // Referenzen als Kontext vor die Nachricht, ihre Vorschaubilder als Anhänge.
    const resolved = picked.length ? await resolveReferences(picked).catch(() => null) : null;
    const all = resolved ? [...list, ...resolved.images.filter((i) => !list.some((a) => a.path === i.path))] : list;
    // YouTube-Links: Titel und Transkript gehen als Kontext mit, bei jedem Agenten.
    const youtube = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/\S+/.exec(t)?.[0];
    const video = youtube ? await invoke<string>("youtube_context", { url: youtube }).catch(() => "") : "";
    const prefix = [resolved?.context, video].filter(Boolean).join("\n\n") || undefined;
    const goal = /^\/goal\s+([\s\S]+)/.exec(t)?.[1];
    if (goal && !onSend) void runGoal(goal, (text, rule, sessionId) => send(text, all, { ...opts, prefix: [prefix, rule].filter(Boolean).join("\n\n"), sessionId }));
    else if (onSend) onSend(t, all, { ...opts, prefix });
    else send(t, all, { ...opts, prefix });
  };

  /** Platzhalter an der Cursorposition einfügen. */
  const insertAtCursor = (snippet: string) => {
    const pos = cursor >= 0 && cursor <= text.length ? cursor : text.length;
    const pre = text.slice(0, pos);
    const glue = pre && !/\s$/.test(pre) ? " " : "";
    setText(`${pre}${glue}${snippet}${text.slice(pos)}`);
    requestAnimationFrame(() => {
      const at = pos + glue.length + snippet.length;
      ref.current?.focus();
      ref.current?.setSelectionRange(at, at);
      setCursor(at);
    });
  };

  /**
   * Vor dem Senden: Zugangsdaten im Text? Dann als Secret anbieten (immer, lokal).
   * Danach sensible Daten – nur nötig, wenn das Ziel kein ZDR-Modell ist.
   */
  const submit = async (skipSecrets = false) => {
    const t = text.trim();
    if (!t || running || disabled || checking) return;
    if (!skipSecrets && !t.startsWith("/")) {
      const found = await secretsApi.scan(t).catch(() => [] as SecretFound[]);
      if (found.length) {
        setSecretPanel({ found, text: t, attachments });
        return;
      }
    }
    setSecretPanel(null);
    const st = useStore.getState();
    const model = String(session?.config.find((o) => o.id === "model")?.currentValue ?? st.draft.model ?? "");
    const safe = zdrActive || (!st.prefs.autoModel && st.cortecs.models.includes(model));
    if (st.prefs.sensitivityCheck && !safe && !t.startsWith("/")) {
      setChecking(true);
      const files = attachments.filter((a) => a.kind === "file").map((a) => a.path);
      const remote = !!st.prefs.taskModels.sensitivity || st.cortecs.key;
      const verdict = await cortecs.checkSensitivity(t, files, project, remote, st.prefs.taskModels.sensitivity || null).catch(() => null);
      setChecking(false);
      if (verdict?.flagged) {
        setFlagged({ verdict, text: t, attachments });
        return;
      }
    }
    dispatch(t, attachments);
  };

  const attach = async () => {
    const picked = await openDialog({ multiple: true, defaultPath: project, title: "Dateien anhängen" });
    if (Array.isArray(picked)) addPaths(picked);
    else if (typeof picked === "string") addPaths([picked]);
  };

  return (
    <div data-brise="composer" className="@container relative">
      {secretPanel && (
        <SecretCreate
          key={secretPanel.text ?? "manual"}
          found={secretPanel.found}
          text={secretPanel.text}
          sessionId={session?.id}
          project={project}
          onSaved={(saved) => {
            const original = secretPanel.text;
            setSecretPanel(null);
            if (original == null) return insertAtCursor(saved[0].placeholder);
            // Von hinten ersetzen, damit die vorderen Bereiche gültig bleiben.
            let next = original;
            for (const { found: f, placeholder } of [...saved].sort((a, b) => (b.found?.start ?? 0) - (a.found?.start ?? 0))) {
              if (f) next = next.slice(0, f.start) + placeholder + next.slice(f.end);
            }
            setText(next);
            setCursor(next.length);
            ref.current?.focus();
          }}
          onSendAnyway={secretPanel.found ? () => submit(true) : undefined}
          onClose={() => {
            setSecretPanel(null);
            ref.current?.focus();
          }}
        />
      )}
      {flagged && (
        <SensitiveNotice
          verdict={flagged.verdict}
          project={project}
          onZdr={() => dispatch(flagged.text, flagged.attachments, { zdr: true })}
          onSend={() => dispatch(flagged.text, flagged.attachments)}
          onAlways={() => {
            const prefs = useStore.getState().prefs;
            useStore.getState().setPrefs({ zdrProjects: [...new Set([...prefs.zdrProjects, project])] });
            dispatch(flagged.text, flagged.attachments, { zdr: true });
          }}
          onClose={() => {
            setFlagged(null);
            ref.current?.focus();
          }}
        />
      )}
      {suggestions.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-line bg-elev p-1 shadow-pop fade-in">
          <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[0.75em] font-medium uppercase tracking-wide text-muted">
            {mention ? <AtSign className="h-3 w-3" /> : <Slash className="h-3 w-3" />}
            {mention ? "Dateien und Referenzen" : "Befehle"}
          </div>
          {suggestions.map((s, n) => (
            <button
              key={s.value}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s);
              }}
              onMouseEnter={() => setSelected(n)}
              className={clsx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left", n === selected && "bg-hover")}
            >
              {s.kind === "ref" ? (
                (() => {
                  const Icon = REF_ICON[s.ref.kind];
                  return <Icon className="h-3.5 w-3.5 text-muted" />;
                })()
              ) : s.kind === "file" ? (
                <FileText className="h-3.5 w-3.5 text-muted" />
              ) : (
                <Slash className="h-3.5 w-3.5 text-muted" />
              )}
              <span className="font-medium">{s.label}</span>
              <span className="min-w-0 flex-1 truncate text-[0.86em] text-muted">{s.detail}</span>
            </button>
          ))}
        </div>
      )}

      {plusPage && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPlusPage(null)} />
          <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[380px] overflow-y-auto rounded-2xl border border-line bg-elev p-1.5 shadow-pop fade-in">
            {plusPage === "main" ? (
              <>
                <PlusLabel>Hinzufügen</PlusLabel>
                <PlusRow icon={Paperclip} label="Dateien und Ordner" onClick={() => { setPlusPage(null); attach(); }} />
                {!session && <PlusRow icon={Folder} label="In einem Projekt arbeiten" hint="Projekt für neue Sessions auswählen" onClick={() => setPlusPage("projects")} />}
                <PlusRow icon={Target} label="Ziel" hint="Ein Ziel zum Weiterverfolgen festlegen" onClick={() => insertCommand("goal")} />
                {modes.some((m) => m.id === "plan") && <PlusRow icon={Lightbulb} label="Planmodus" hint="Planmodus einschalten" onClick={() => { setPlusPage(null); setOption("mode", "plan", session?.id).catch(() => {}); }} />}
                {!simple && <PlusRow icon={KeyRound} label="Secret" hint="Passwort oder Token anlegen, der Agent sieht nur den Platzhalter" onClick={() => { setPlusPage(null); setSecretPanel({}); }} />}
                {commands.length > 0 && <PlusLabel>Skills und Befehle</PlusLabel>}
                {commands.map((c) => <PlusRow key={c.name} icon={Slash} label={c.name} hint={c.description} onClick={() => insertCommand(c.name)} />)}
              </>
            ) : (
              <>
                <PlusLabel>Projekt wählen</PlusLabel>
                {projects.map((p) => <PlusRow key={p} icon={Folder} label={basename(p)} hint={p} onClick={() => { setPlusPage(null); useStore.getState().newDraft(p); }} />)}
              </>
            )}
          </div>
        </>
      )}
      {!session && !simple && (
        <div className="mx-3 flex h-9 items-center gap-1.5 rounded-t-2xl bg-hover px-3 text-[0.92em] text-fg-2">
          <Folder className="h-4 w-4 text-muted" />
          <span className="truncate">{basename(project)}</span>
        </div>
      )}
      <div
        className={clsx(
          "relative rounded-3xl border bg-elev shadow-soft transition-colors",
          dragging ? "border-accent bg-accent-soft" : "border-line-strong",
        )}
      >
        {(attachments.length > 0 || refs.length > 0 || chips) && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {chips}
            {refs.map((r) => {
              const Icon = REF_ICON[r.kind];
              return (
                <span key={`${r.kind}:${r.id}`} data-brise="ref-chip" className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent-soft pl-2 pr-1 text-[0.84em]" title={`${REF_LABEL[r.kind]}: ${r.detail}`}>
                  <Icon className="h-3.5 w-3.5 text-accent" />
                  <span className="max-w-[200px] truncate">{r.label}</span>
                  <button
                    className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
                    onClick={() => setRefs((l) => l.filter((x) => x !== r))}
                    aria-label="Referenz entfernen"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
            {attachments.map((a) => (
              <span key={a.path} className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-panel pl-2 pr-1 text-[0.84em]" title={a.path}>
                {a.kind === "image" ? <Image className="h-3.5 w-3.5 text-muted" /> : <FileText className="h-3.5 w-3.5 text-muted" />}
                <span className="max-w-[200px] truncate">{a.name}</span>
                {a.kind === "document" && <span className="rounded bg-accent-soft px-1 text-[0.8em] text-accent" title="Wird mit Mistral OCR gelesen">OCR</span>}
                <button
                  className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
                  onClick={() => setAttachments((l) => l.filter((x) => x.path !== a.path))}
                  aria-label="Anhang entfernen"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {recordingHere && <VoiceRecorder onDone={toggleVoice} onCancel={() => cancelRecording()} />}
        <textarea
          hidden={recordingHere}
          ref={ref}
          value={text}
          rows={1}
          disabled={disabled}
          onPaste={onPaste}
          placeholder={
            placeholder ??
            (session?.readOnly
              ? "Subagenten-Verläufe sind nur lesbar"
              : session
                ? "Antworten, nachfragen oder nächste Aufgabe …"
                : "Leg einfach los")
          }
          onChange={(e) => {
            setText(e.target.value);
            setCursor(e.target.selectionStart);
          }}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (suggestions.length) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                return setSelected((selected + 1) % suggestions.length);
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                return setSelected((selected - 1 + suggestions.length) % suggestions.length);
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                return accept(suggestions[selected]);
              }
              if (e.key === "Escape") return setCursor(-1);
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape" && running) stop();
            if (e.key === "Escape" && recording) cancelRecording();
          }}
          className="block max-h-[280px] w-full resize-none bg-transparent px-4 pb-2 pt-3.5 outline-none placeholder:text-muted focus-visible:outline-none"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <button hidden aria-label="Dateien oder Bilder anhängen" onClick={attach} />
          <IconButton label="Hinzufügen" onClick={() => setPlusPage(plusPage ? null : "main")} disabled={disabled}>
            <Plus className="h-[18px] w-[18px]" />
          </IconButton>
          {tools}
          {!simple && (
            <>
              <BackendPicker session={session} />
              <ModePicker session={session} />
            </>
          )}
          {zdrActive && (
            <Tip label="Nur Cortecs-Modelle ohne Datenspeicherung (Zero Data Retention)" side="top">
              <span data-brise="zdr-badge" className="ml-1 inline-flex h-6 items-center gap-1 rounded-md bg-ok-soft px-1.5 text-[0.78em] font-medium text-ok">
                <ShieldCheck className="h-3 w-3" /> ZDR
              </span>
            </Tip>
          )}
          <div className="flex-1" />
          {!simple && <ContextMeter session={session} />}
          {!simple && (
            <ModelEffortPicker session={session} />
          )}
          {(voice || localStt) && <Tip label={recording ? "Aufnahme beenden und übernehmen" : localStt ? "Spracheingabe (lokal)" : "Spracheingabe (Voxtral)"}>
            <button
              onClick={toggleVoice}
              disabled={disabled || voiceBusy}
              aria-label="Spracheingabe"
              className={clsx(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition disabled:opacity-40",
                recording ? "bg-bad text-white shadow-[0_0_0_4px_color-mix(in_srgb,var(--bad)_25%,transparent)]" : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              {recording ? <Square className="h-3 w-3 fill-current" /> : <Mic className="h-4 w-4" />}
            </button>
          </Tip>}
          {running ? (
            <button
              onClick={() => stop()}
              className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fg text-bg hover:opacity-85"
              aria-label="Stopp (Esc)"
              title="Stopp (Esc)"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={() => submit()}
              disabled={!text.trim() || disabled || checking}
              className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fg text-bg transition hover:opacity-85 disabled:bg-line-strong disabled:text-muted"
              aria-label="Senden (Enter)"
              title={checking ? "Prüfe auf sensible Daten …" : "Senden (Enter)"}
            >
              {checking ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <ArrowUp className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
