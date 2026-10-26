import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ArrowUp, AtSign, FileText, Image, Mic, Paperclip, ShieldCheck, Slash, Square, X } from "lucide-react";
import { basename, isZdr, useStore, type Attachment, type Session, type SlashCommand } from "../../lib/store";
import { cortecs, type SensitiveVerdict } from "../../lib/cortecs";
import { SensitiveNotice } from "./SensitiveNotice";
import { IconButton, Tip, clsx } from "../ui";
import { VoiceRecorder } from "./VoiceRecorder";
import { ContextMeter, ModePicker, OptionPicker, ThinkingPicker } from "./Pickers";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const DOC_EXT = /\.(pdf|docx|pptx)$/i;

type Suggestion =
  | { kind: "file"; value: string; label: string; detail: string }
  | { kind: "command"; value: string; label: string; detail: string };

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

export function Composer({ session, project, focused = true }: { session?: Session; project: string; focused?: boolean }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = useStore((s) => s.send);
  const cancel = useStore((s) => s.cancel);
  const loadFiles = useStore((s) => s.loadFiles);
  const templateCommands = useStore((s) => s.template?.commands);
  const running = !!session?.running;
  const disabled = !!session?.replaying || !!session?.readOnly;
  const commands: SlashCommand[] = session?.commands.length ? session.commands : (templateCommands ?? []);
  const recording = useStore((s) => s.recording);
  const composerInsert = useStore((s) => s.composerInsert);
  const { startRecording, stopRecording, cancelRecording, set: setStore } = useStore.getState();
  const [voiceBusy, setVoiceBusy] = useState(false);
  // Bei mehreren Bereichen gehören Drop, Einfügen und Sprache nur dem fokussierten.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const recordingHere = recording && focused;
  const [checking, setChecking] = useState(false);
  const [flagged, setFlagged] = useState<{ verdict: SensitiveVerdict; text: string; attachments: Attachment[] } | null>(null);
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
      return fuzzy(files, mention[2]).map((f) => ({ kind: "file", value: f, label: basename(f), detail: f }));
    }
    if (slash) {
      const q = slash[1].toLowerCase();
      return commands
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((c) => ({ kind: "command", value: c.name, label: `/${c.name}`, detail: c.description ?? "" }));
    }
    return [];
  }, [mention?.[2], slash?.[1], files, commands]);

  useEffect(() => setSelected(0), [suggestions.length, mention?.[2], slash?.[1]]);

  const accept = (s: Suggestion) => {
    if (s.kind === "file" && mention) {
      const start = before.length - mention[2].length - 1;
      const next = `${text.slice(0, start)}@${s.value} ${text.slice(cursor)}`;
      setText(next);
      setAttachments((list) => (list.some((a) => a.path === s.value) ? list : [...list, { kind: "file", path: s.value, name: basename(s.value) }]));
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

  const dispatch = (t: string, list: Attachment[], opts?: { zdr?: boolean }) => {
    send(t, list, opts);
    setText("");
    setAttachments([]);
    setCursor(0);
    setFlagged(null);
  };

  /** Vor dem Senden: sensible Daten? Nur nötig, wenn das Ziel kein ZDR-Modell ist. */
  const submit = async () => {
    const t = text.trim();
    if (!t || running || disabled || checking) return;
    const st = useStore.getState();
    const model = String(session?.config.find((o) => o.id === "model")?.currentValue ?? st.draft.model ?? "");
    const safe = zdrActive || (!st.prefs.autoModel && st.cortecs.models.includes(model));
    if (st.prefs.sensitivityCheck && !safe && !t.startsWith("/")) {
      setChecking(true);
      const files = attachments.filter((a) => a.kind === "file").map((a) => a.path);
      const verdict = await cortecs.checkSensitivity(t, files, project, st.cortecs.key).catch(() => null);
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
            {mention ? "Dateien" : "Befehle"}
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
              {s.kind === "file" ? <FileText className="h-3.5 w-3.5 text-muted" /> : <Slash className="h-3.5 w-3.5 text-muted" />}
              <span className="font-medium">{s.label}</span>
              <span className="min-w-0 flex-1 truncate text-[0.86em] text-muted">{s.detail}</span>
            </button>
          ))}
        </div>
      )}

      <div
        className={clsx(
          "rounded-2xl border bg-elev shadow-soft transition-colors",
          dragging ? "border-accent bg-accent-soft" : "border-line-strong focus-within:border-accent/60",
        )}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
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
          placeholder={
            session?.readOnly
              ? "Subagenten-Verläufe sind nur lesbar"
              : session
                ? "Antworten, nachfragen oder nächste Aufgabe …"
                : `Was soll Vibe in ${basename(project)} tun?  @ für Dateien, / für Befehle`
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
            if (e.key === "Escape" && running) cancel();
            if (e.key === "Escape" && recording) cancelRecording();
          }}
          className="block max-h-[280px] w-full resize-none bg-transparent px-4 pb-2 pt-3.5 outline-none placeholder:text-muted focus-visible:outline-none"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <IconButton label="Dateien oder Bilder anhängen" onClick={attach} disabled={disabled}>
            <Paperclip className="h-4 w-4" />
          </IconButton>
          <ModePicker session={session} />
          <OptionPicker session={session} id="model" />
          <ThinkingPicker session={session} />
          {zdrActive && (
            <Tip label="Nur Cortecs-Modelle ohne Datenspeicherung (Zero Data Retention)" side="top">
              <span data-brise="zdr-badge" className="ml-1 inline-flex h-6 items-center gap-1 rounded-md bg-ok-soft px-1.5 text-[0.78em] font-medium text-ok">
                <ShieldCheck className="h-3 w-3" /> ZDR
              </span>
            </Tip>
          )}
          <div className="flex-1" />
          <ContextMeter session={session} />
          <Tip label={recording ? "Aufnahme beenden und übernehmen" : "Spracheingabe (Voxtral)"}>
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
          </Tip>
          {running ? (
            <button
              onClick={() => cancel()}
              className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fg text-bg hover:opacity-85"
              aria-label="Stopp (Esc)"
              title="Stopp (Esc)"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!text.trim() || disabled || checking}
              className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition hover:brightness-110 disabled:bg-line-strong disabled:text-muted"
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
