import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LogIn, X } from "lucide-react";
import { join, leave, useCollab } from "../../lib/collab";
import { useStore } from "../../lib/store";
import { Button } from "../ui";

/** „Einer Session beitreten“: Einladungslink einfügen. */
export function JoinDialog() {
  const open = useCollab((s) => s.joinOpen);
  const name = useCollab((s) => s.prefs.name);
  const setPrefs = useCollab((s) => s.setPrefs);
  const guests = useCollab((s) => s.guests);
  const openTab = useStore((s) => s.openTab);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setLink("");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await join(link);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const joined = Object.values(guests);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => useCollab.setState({ joinOpen: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 fade-in" />
        <Dialog.Content className="fixed left-1/2 top-[16%] z-50 w-[min(560px,92vw)] -translate-x-1/2 rounded-2xl border border-line bg-elev p-6 shadow-pop fade-in">
          <Dialog.Title className="flex items-center gap-2 text-[1.15em] font-semibold">
            <LogIn className="h-5 w-5 text-accent" /> Einer Session beitreten
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[0.9em] text-muted">
            Füge den Einladungslink ein (<span className="font-mono">brise://join/…</span>). Vibe läuft dabei beim Host, nicht bei dir.
          </Dialog.Description>

          <label className="mt-5 block text-[0.86em] font-medium">Einladungslink</label>
          <input
            autoFocus
            value={link}
            onChange={(e) => (setLink(e.target.value), setError(null))}
            onKeyDown={(e) => e.key === "Enter" && link.trim() && submit()}
            placeholder="brise://join/…"
            data-collab="join-link"
            className="mt-1 h-10 w-full rounded-lg border border-line bg-bg px-3 font-mono text-[0.86em] outline-none focus:border-accent"
          />
          <label className="mt-4 block text-[0.86em] font-medium">Dein Name</label>
          <input
            value={name}
            onChange={(e) => setPrefs({ name: e.target.value })}
            placeholder="So sehen dich die anderen"
            className="mt-1 h-9 w-full rounded-lg border border-line bg-bg px-3 outline-none focus:border-accent"
          />
          {error && <p className="mt-3 text-[0.88em] text-bad selectable">{error}</p>}

          {joined.length > 0 && (
            <>
              <div className="mt-5 text-[0.86em] font-medium">Beigetreten</div>
              <div className="mt-1 divide-y divide-line overflow-hidden rounded-xl border border-line">
                {joined.map((g) => (
                  <div key={g.room} className="flex items-center gap-2 px-3 py-1.5 text-[0.9em]">
                    <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => (useCollab.setState({ joinOpen: false }), openTab(g.sessionId))}>
                      Session von {g.hostName ?? "…"}
                    </button>
                    <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-bad" title="Verlassen" onClick={() => leave(g.room)}>
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => useCollab.setState({ joinOpen: false })}>
              Abbrechen
            </Button>
            <Button variant="primary" disabled={!link.trim() || busy} onClick={submit} data-collab="join">
              Beitreten
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
