import { useEffect, useRef, useState } from "react";
import { ArrowUp, Eye, Hourglass, ShieldQuestion, Square, WifiOff } from "lucide-react";
import type { Session } from "../../lib/store";
import { ROLE_LABEL, guestCancel, guestPrompt, useCollab } from "../../lib/collab";
import { PermissionPrompt } from "../composer/Pinned";
import { IconButton, clsx } from "../ui";

function Note({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-line bg-panel px-4 py-3 text-[0.9em] text-muted [&>svg]:h-4 [&>svg]:w-4">
      {icon}
      <span className="flex-1">{children}</span>
    </div>
  );
}

/** Unterer Bereich einer Session, der man als Gast beigetreten ist. */
export function GuestPane({ session }: { session: Session }) {
  const room = session.guest!.room;
  const guest = useCollab((s) => s.guests[room]);
  const role = session.guest?.role ?? null;
  const pending = session.pending[0];
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mine = guest?.queue.filter((q) => q.authorId === guest.me) ?? [];
  const canWrite = role === "collaborator" || role === "approver";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  if (session.guest?.ended) return <Note icon={<WifiOff />}>Der Host hat die Freigabe beendet.</Note>;
  if (guest && !guest.connected) return <Note icon={<WifiOff />}>{guest.error ?? "Verbinde mit dem Host …"}</Note>;
  if (pending && role === "approver") return <PermissionPrompt session={session} pending={pending} />;

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      await guestPrompt(room, t);
      setText("");
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-2">
      {pending && <Note icon={<ShieldQuestion />}>Vibe wartet auf eine Freigabe durch {session.guest?.host ?? "den Host"}.</Note>}
      {mine.length > 0 && (
        <Note icon={<Hourglass />}>
          {mine.length === 1 ? "Deine Nachricht wartet" : `${mine.length} Nachrichten warten`} beim Host, bis er sie ausführt.
        </Note>
      )}
      {canWrite ? (
        <div data-brise="composer" className="rounded-2xl border border-line bg-elev shadow-soft focus-within:border-accent/60">
          <textarea
            ref={ref}
            value={text}
            rows={1}
            data-collab="guest-input"
            placeholder={`Prompt für ${session.guest?.host ?? "den Host"} vorschlagen …`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            className="block max-h-[220px] w-full resize-none bg-transparent px-4 pt-3 outline-none placeholder:text-muted"
          />
          <div className="flex items-center gap-2 px-3 pb-2 pt-1 text-[0.82em] text-muted">
            <span className="flex-1">
              Rolle {role ? ROLE_LABEL[role] : "…"} · Prompts landen in der Warteschlange von {session.guest?.host ?? "dem Host"}
            </span>
            {session.running && (
              <IconButton label="Turn abbrechen" onClick={() => guestCancel(room)}>
                <Square className="h-3.5 w-3.5" />
              </IconButton>
            )}
            <button
              onClick={submit}
              disabled={!text.trim()}
              aria-label="Senden"
              className={clsx(
                "flex h-8 w-8 items-center justify-center rounded-full",
                text.trim() ? "bg-accent text-accent-fg" : "bg-hover text-muted",
              )}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
          {error && <div className="px-4 pb-2 text-[0.84em] text-bad">{error}</div>}
        </div>
      ) : (
        <Note icon={<Eye />}>
          Du schaust zu{role ? ` (Rolle ${ROLE_LABEL[role]})` : ""}. Zum Mitschreiben muss {session.guest?.host ?? "der Host"} dich zum Mitarbeiter machen.
        </Note>
      )}
    </div>
  );
}
