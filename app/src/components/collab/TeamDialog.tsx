import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, Users } from "lucide-react";
import { createTeam, joinTeam, useCollab } from "../../lib/collab";
import { Button, clsx } from "../ui";

/** Team anlegen, beitreten oder einladen. */
export function TeamDialog() {
  const open = useCollab((s) => s.teamOpen);
  const teams = Object.values(useCollab((s) => s.teams));
  const prefs = useCollab((s) => s.prefs);
  const setPrefs = useCollab((s) => s.setPrefs);
  const [tab, setTab] = useState<"join" | "create">("join");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue("");
      setError(null);
    }
  }, [open, tab]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (tab === "create") await createTeam(value.trim());
      else await joinTeam(value);
      setValue("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = (link: string) => {
    navigator.clipboard.writeText(link).catch(() => {});
    setCopied(link);
    setTimeout(() => setCopied(null), 1500);
  };
  const relayMissing = tab === "create" && prefs.mode === "relay" && !prefs.relayUrl.trim();

  return (
    <Dialog.Root open={open} onOpenChange={(o) => useCollab.setState({ teamOpen: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 fade-in" />
        <Dialog.Content className="fixed left-1/2 top-[12%] z-50 max-h-[80vh] w-[min(580px,92vw)] -translate-x-1/2 overflow-y-auto rounded-2xl border border-line bg-elev p-6 shadow-pop fade-in">
          <Dialog.Title className="flex items-center gap-2 text-[1.15em] font-semibold">
            <Users className="h-5 w-5 text-accent" /> Team
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[0.9em] text-muted">
            Im Team seht ihr, wer online ist, welche Abos es gibt und welche Sessions geteilt sind – ein Klick genügt zum Mitmachen. Wer kein Abo hat,
            arbeitet in den Sessions der anderen mit.
          </Dialog.Description>

          {teams.length > 0 && (
            <div className="mt-5 space-y-2">
              {teams.map((t) => (
                <div key={t.id} className="rounded-xl border border-line px-3 py-2">
                  <div className="flex items-center gap-2 text-[0.92em]">
                    <span className={clsx("h-2 w-2 rounded-full", t.connected ? "bg-ok" : "bg-warn")} />
                    <span className="flex-1 font-medium">{t.name}</span>
                    <span className="text-[0.85em] text-muted">{t.members.length + 1} Mitglieder</span>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <input readOnly value={t.link} onFocus={(e) => e.currentTarget.select()} className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 font-mono text-[0.76em] selectable" data-collab="team-link" />
                    <Button size="sm" onClick={() => copy(t.link)}>
                      {copied === t.link ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Einladen
                    </Button>
                  </div>
                  <p className="mt-1 text-[0.8em] text-muted">Wer diesen Link hat, gehört zum Team. Nur an Vertraute schicken.</p>
                </div>
              ))}
            </div>
          )}

          <div className="mt-5 flex rounded-lg border border-line bg-panel p-0.5 text-[0.9em]">
            {(["join", "create"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={clsx("h-8 flex-1 rounded-md", tab === t ? "bg-elev text-fg shadow-sm" : "text-muted hover:text-fg")}>
                {t === "join" ? "Team beitreten" : "Neues Team"}
              </button>
            ))}
          </div>
          <label className="mt-4 block text-[0.86em] font-medium">Dein Name</label>
          <input
            value={prefs.name}
            onChange={(e) => setPrefs({ name: e.target.value })}
            placeholder="So sehen dich die anderen"
            className="mt-1 h-9 w-full rounded-lg border border-line bg-bg px-3 outline-none focus:border-accent"
          />
          <label className="mt-3 block text-[0.86em] font-medium">{tab === "join" ? "Einladungslink" : "Name des Teams"}</label>
          <input
            value={value}
            onChange={(e) => (setValue(e.target.value), setError(null))}
            onKeyDown={(e) => e.key === "Enter" && value.trim() && submit()}
            placeholder={tab === "join" ? "brise://team/…" : "z. B. Die Drei"}
            data-collab="team-input"
            className={clsx("mt-1 h-10 w-full rounded-lg border border-line bg-bg px-3 outline-none focus:border-accent", tab === "join" && "font-mono text-[0.86em]")}
          />
          {tab === "create" && (
            <p className="mt-1.5 text-[0.84em] text-muted">
              {prefs.mode === "relay"
                ? `Läuft über dein Relay ${prefs.relayUrl || "(unter Einstellungen → Zusammenarbeit eintragen)"}.`
                : "Ohne Relay läuft das Team über diesen Rechner und ist nur erreichbar, solange Brise hier offen ist. Für Freunde außerhalb ein Relay im Homelab eintragen."}
            </p>
          )}
          {error && <p className="mt-3 text-[0.88em] text-bad selectable">{error}</p>}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => useCollab.setState({ teamOpen: false })}>
              Schließen
            </Button>
            <Button variant="primary" disabled={!value.trim() || busy || relayMissing} onClick={submit} data-collab="team-submit">
              {tab === "join" ? "Beitreten" : "Team anlegen"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
