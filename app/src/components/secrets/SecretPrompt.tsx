import { useState } from "react";
import { Eye, EyeOff, KeyRound, LockKeyhole, X } from "lucide-react";
import { answerSecret, normalizeName, placeholder, SCOPE_HINT, SCOPE_LABEL, secretsApi, validName, type SecretFound, type SecretRequest, type SecretScope } from "../../lib/secrets";
import { Button, Tip, clsx } from "../ui";

/** Maskiertes Eingabefeld mit Auge zum kurzen Aufdecken. */
export function SecretField({ value, onChange, onEnter, autoFocus }: { value: string; onChange: (v: string) => void; onEnter?: () => void; autoFocus?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex h-9 items-center rounded-lg border border-line-strong bg-panel focus-within:border-accent/60">
      <LockKeyhole className="ml-2.5 h-3.5 w-3.5 shrink-0 text-muted" />
      <input
        type={shown ? "text" : "password"}
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        aria-label="Wert des Secrets"
        placeholder="Wert einfügen"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-[0.9em] outline-none placeholder:font-sans placeholder:text-muted"
      />
      <Tip label={shown ? "Verbergen" : "Anzeigen"}>
        <button type="button" className="mr-1 flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg" onClick={() => setShown(!shown)} aria-label={shown ? "Verbergen" : "Anzeigen"}>
          {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </Tip>
    </div>
  );
}

/** Auswahl der Gültigkeit als Segmente. */
export function ScopeChoice({ value, onChange, allowSession = true, allowProject = true }: { value: SecretScope; onChange: (s: SecretScope) => void; allowSession?: boolean; allowProject?: boolean }) {
  const scopes = (["session", "project", "global"] as SecretScope[]).filter((s) => (s !== "session" || allowSession) && (s !== "project" || allowProject));
  return (
    <div className="inline-flex rounded-lg border border-line bg-panel p-0.5" role="radiogroup" aria-label="Gültigkeit">
      {scopes.map((s) => (
        <Tip key={s} label={SCOPE_HINT[s]} side="top">
          <button
            type="button"
            role="radio"
            aria-checked={value === s}
            onClick={() => onChange(s)}
            className={clsx("h-7 rounded-md px-2.5 text-[0.84em]", value === s ? "bg-elev font-medium text-fg shadow-soft" : "text-muted hover:text-fg")}
          >
            {SCOPE_LABEL[s]}
          </button>
        </Tip>
      ))}
    </div>
  );
}

const Note = () => (
  <p className="mt-2 text-[0.8em] text-muted">
    Der Wert geht direkt in den Schlüsselbund des Systems – nicht an das Modell, nicht in den Verlauf. Der Agent bekommt nur den Platzhalter.
  </p>
);

/** Karte für `request_secret`: der Agent bittet um ein Secret. Ersetzt den Composer wie die Freigabe. */
export function SecretPrompt({ request }: { request: SecretRequest }) {
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<SecretScope>(request.scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (v: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await answerSecret(request, v, scope);
      setValue("");
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <div data-brise="secret-prompt" className="mb-2 overflow-hidden rounded-2xl border border-accent/50 bg-elev shadow-pop fade-in">
      <div className="flex items-center gap-2 border-b border-line bg-accent-soft px-4 py-2.5">
        <KeyRound className="h-4 w-4 text-accent" />
        <span className="font-medium">Der Agent braucht ein Secret</span>
        <span className="ml-auto rounded bg-elev px-1.5 font-mono text-[0.82em]">{request.name}</span>
      </div>
      <div className="px-4 py-3">
        {request.purpose && <p className="mb-2.5 text-[0.92em] text-fg-2 selectable">{request.purpose}</p>}
        <SecretField value={value} onChange={setValue} onEnter={() => value && answer(value)} autoFocus />
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <ScopeChoice value={scope} onChange={setScope} allowSession={!!request.sessionId} />
          <div className="flex-1" />
          <Button variant="danger" disabled={busy} onClick={() => answer(null)}>
            Ablehnen
          </Button>
          <Button variant="primary" disabled={busy || !value} onClick={() => answer(value)}>
            Speichern
          </Button>
        </div>
        {error && <p className="mt-2 text-[0.84em] text-bad">{error}</p>}
        <Note />
      </div>
    </div>
  );
}

/**
 * Secret im Composer anlegen: von Hand oder für Zugangsdaten, die im Text
 * erkannt wurden. `onSaved` bekommt je Fund den Platzhalter.
 */
export function SecretCreate({
  found,
  text,
  sessionId,
  project,
  onSaved,
  onSendAnyway,
  onClose,
}: {
  found?: SecretFound[];
  text?: string;
  sessionId?: string;
  project: string;
  onSaved: (placeholders: { found?: SecretFound; placeholder: string }[]) => void;
  onSendAnyway?: () => void;
  onClose: () => void;
}) {
  const detected = !!found?.length;
  const [names, setNames] = useState<string[]>(() => unique(found?.map((f) => f.name) ?? ["API_KEY"]));
  const [value, setValue] = useState("");
  const [purpose, setPurpose] = useState("");
  const [scope, setScope] = useState<SecretScope>(project ? "project" : "global");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalized = names.map(normalizeName);
  const ok = normalized.every(validName) && (detected || !!value);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const out: { found?: SecretFound; placeholder: string }[] = [];
      if (detected && text != null) {
        for (const [n, f] of found!.entries()) {
          const ph = await secretsApi.save(normalized[n], text.slice(f.start, f.end), scope, sessionId, project || undefined, `Aus dem Composer (${f.label})`);
          out.push({ found: f, placeholder: ph });
        }
      } else {
        out.push({ placeholder: await secretsApi.save(normalized[0], value, scope, sessionId, project || undefined, purpose || undefined) });
      }
      setValue("");
      onSaved(out);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-brise="secret-create" className={clsx("mb-2 rounded-2xl border p-3 shadow-soft fade-in", detected ? "border-warn/40 bg-warn-soft" : "border-line bg-elev")}>
      <div className="flex items-start gap-2.5">
        <KeyRound className={clsx("mt-0.5 h-4 w-4 shrink-0", detected ? "text-warn" : "text-accent")} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{detected ? "Das sieht nach Zugangsdaten aus" : "Secret anlegen"}</div>
          <p className="mt-0.5 text-[0.88em] text-fg-2">
            {detected
              ? "Statt den Wert ans Modell zu schicken, kann Brise ihn als Secret speichern und im Text durch einen Platzhalter ersetzen."
              : "Der Agent bekommt nur den Platzhalter und setzt den Wert erst bei der Ausführung ein."}
          </p>
          <div className="mt-2.5 space-y-2">
            {(detected ? found! : [null]).map((f, n) => (
              <div key={n} className="flex flex-wrap items-center gap-2">
                {f && (
                  <span className="rounded border border-line bg-elev px-1.5 text-[0.86em] text-fg-2">
                    {f.label}: <span className="font-mono">{f.sample}</span>
                  </span>
                )}
                <input
                  value={names[n] ?? ""}
                  onChange={(e) => setNames((l) => l.map((x, i) => (i === n ? e.target.value.toUpperCase() : x)))}
                  aria-label="Name des Secrets"
                  spellCheck={false}
                  className={clsx("h-8 w-48 rounded-lg border bg-panel px-2 font-mono text-[0.88em] outline-none", validName(normalized[n] ?? "") ? "border-line-strong focus:border-accent/60" : "border-bad/60")}
                />
                <span className="font-mono text-[0.8em] text-muted">{placeholder(normalized[n] ?? "")}</span>
              </div>
            ))}
            {!detected && (
              <>
                <SecretField value={value} onChange={setValue} onEnter={() => ok && save()} autoFocus />
                <input
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="Wofür? (optional)"
                  className="h-8 w-full rounded-lg border border-line-strong bg-panel px-2 text-[0.88em] outline-none placeholder:text-muted focus:border-accent/60"
                />
              </>
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <ScopeChoice value={scope} onChange={setScope} allowSession={!!sessionId} allowProject={!!project} />
            <div className="flex-1" />
            {onSendAnyway && (
              <Button size="sm" onClick={onSendAnyway}>
                Trotzdem senden
              </Button>
            )}
            <Button size="sm" variant="primary" disabled={!ok || busy} onClick={save} autoFocus={detected}>
              {detected ? "Als Secret speichern und ersetzen" : "Speichern und einfügen"}
            </Button>
          </div>
          {error && <p className="mt-2 text-[0.84em] text-bad">{error}</p>}
        </div>
        <button className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg" onClick={onClose} aria-label="Schließen">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Gleiche Namensvorschläge durchnummerieren (zwei Passwörter → PASSWORD, PASSWORD_2). */
function unique(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const c = (seen.get(n) ?? 0) + 1;
    seen.set(n, c);
    return c === 1 ? n : `${n}_${c}`;
  });
}
