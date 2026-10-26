import { LogOut, Share2, Users } from "lucide-react";
import type { Session } from "../../lib/store";
import { ROLE_LABEL, leave, useCollab } from "../../lib/collab";
import { Tip, clsx } from "../ui";

/** Kopfzeile: Zustand der Freigabe (Host) bzw. der beigetretenen Session (Gast). */
export function CollabBadge({ session }: { session?: Session }) {
  const host = useCollab((s) => (session ? s.hosts[session.id] : undefined));
  const guest = useCollab((s) => (session?.guest ? s.guests[session.guest.room] : undefined));

  if (session?.guest) {
    const g = session.guest;
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded bg-accent-soft px-1.5 text-[0.75em] text-fg-2" data-collab="guest-badge">
        <span className={clsx("h-1.5 w-1.5 rounded-full", guest?.connected && !g.ended ? "bg-ok" : "bg-warn")} />
        geteilt von {g.host}
        {g.role && <span className="text-muted">· {ROLE_LABEL[g.role]}</span>}
        <Tip label="Session verlassen">
          <button className="text-muted hover:text-bad" onClick={() => leave(g.room)} aria-label="Session verlassen">
            <LogOut className="h-3 w-3" />
          </button>
        </Tip>
      </span>
    );
  }
  if (!host || !session) return null;
  const online = host.participants.filter((p) => p.online).length;
  return (
    <Tip label="Geteilt – Teilnehmer und Warteschlange">
      <button
        onClick={() => useCollab.setState({ shareFor: session.id })}
        className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[0.85em] text-accent hover:bg-hover"
        data-collab="host-badge"
      >
        {online ? <Users className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
        <span className="tabular-nums">{online}</span>
        {host.queue.length > 0 && <span className="rounded-full bg-accent px-1.5 text-[0.85em] text-accent-fg">{host.queue.length}</span>}
      </button>
    </Tip>
  );
}
