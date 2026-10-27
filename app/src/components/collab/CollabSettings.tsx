import { Users } from "lucide-react";
import { useCollab } from "../../lib/collab";
import { Button, Switch, clsx } from "../ui";
import { RolePicker } from "./ShareDialog";
import { TeamAdmin } from "./TeamAdmin";

function Row({ title, description, control }: { title: string; description?: string; control: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[0.95em]">{title}</div>
        {description && <div className="text-[0.86em] text-muted">{description}</div>}
      </div>
      {control}
    </div>
  );
}

const input = "h-8 rounded-lg border border-line bg-elev px-2.5 text-[0.92em] outline-none focus:border-accent";

/** Einstellungen → Zusammenarbeit. */
export function CollabSettings() {
  const prefs = useCollab((s) => s.prefs);
  const setPrefs = useCollab((s) => s.setPrefs);
  const teams = Object.values(useCollab((s) => s.teams));
  return (
    <>
      <section className="mb-6">
        <h3 className="mb-1 text-[0.95em] font-semibold">Team</h3>
        <p className="mb-2 text-[0.88em] text-muted">
          Ein Team sieht, wer online ist, welche Abos es gibt und welche Sessions geteilt sind. Wer kein Abo hat, arbeitet in den Sessions der anderen mit.
        </p>
        <div className="flex items-center gap-3 rounded-xl border border-line bg-elev px-4 py-3">
          <span className="flex-1 text-[0.95em]">{teams.length ? teams.map((t) => t.name).join(", ") : "Noch in keinem Team"}</span>
          <Button size="sm" onClick={() => useCollab.setState({ teamOpen: true })}>
            <Users className="h-3.5 w-3.5" /> {teams.length ? "Einladen / beitreten" : "Team anlegen oder beitreten"}
          </Button>
        </div>
      </section>
      {teams.map((t) => (
        <TeamAdmin key={t.id} team={t} />
      ))}
      <section className="mb-6">
        <h3 className="mb-1 text-[0.95em] font-semibold">Verbindung</h3>
        <p className="mb-2 text-[0.88em] text-muted">
          Ohne Relay bietet Brise den WebSocket selbst an – das reicht im selben Netz. Für Gäste von außerhalb ein eigenes Relay betreiben (siehe
          <span className="font-mono"> relay/README.md</span>). Das Relay sieht nur verschlüsselte Daten.
        </p>
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-elev">
          <Row title="Dein Name" description="So sehen dich Host und Gäste." control={<input value={prefs.name} onChange={(e) => setPrefs({ name: e.target.value })} placeholder="z. B. Max" className={clsx(input, "w-[220px]")} />} />
          <Row
            title="Dein Abo"
            description="So erscheint es im Team und bei Gästen, z. B. „Vibe Pro“ oder „Claude Max“."
            control={<input value={prefs.plan} onChange={(e) => setPrefs({ plan: e.target.value })} placeholder="eigenes Abo" className={clsx(input, "w-[220px]")} />}
          />
          <Row
            title="Standard beim Teilen"
            control={
              <div className="flex rounded-lg border border-line bg-panel p-0.5 text-[0.9em]">
                {(["lan", "relay"] as const).map((m) => (
                  <button key={m} onClick={() => setPrefs({ mode: m })} className={clsx("h-7 rounded-md px-3", prefs.mode === m ? "bg-elev text-fg shadow-sm" : "text-muted hover:text-fg")}>
                    {m === "lan" ? "Direkt im LAN" : "Über Relay"}
                  </button>
                ))}
              </div>
            }
          />
          <Row
            title="Relay-Adresse"
            description="WebSocket-URL des Relays, z. B. wss://relay.example.org"
            control={<input value={prefs.relayUrl} onChange={(e) => setPrefs({ relayUrl: e.target.value.trim() })} placeholder="wss://…" className={clsx(input, "w-[260px] font-mono")} />}
          />
          <Row
            title="Port im LAN"
            description="Ist er belegt, nimmt Brise einen freien. Die Firewall muss ihn durchlassen."
            control={<input type="number" min={1024} max={65535} value={prefs.lanPort} onChange={(e) => setPrefs({ lanPort: Number(e.target.value) || 47800 })} className={clsx(input, "w-[100px]")} />}
          />
        </div>
      </section>
      <section className="mb-6">
        <h3 className="mb-1 text-[0.95em] font-semibold">Geteilte Sessions</h3>
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-elev">
          <Row title="Rolle für Teammitglieder" control={<RolePicker value={prefs.teamRole} onChange={(r) => setPrefs({ teamRole: r })} />} />
          <Row title="Rolle anderer Gäste" control={<RolePicker value={prefs.defaultRole} onChange={(r) => setPrefs({ defaultRole: r })} />} />
          <Row
            title="Gäste dürfen Prompts auf mein Abo schicken"
            description="Standard für neue Freigaben, je Session im Teilen-Dialog änderbar."
            control={<Switch checked={prefs.guestPrompts} onChange={(v) => setPrefs({ guestPrompts: v })} />}
          />
          <Row
            title="Tageslimit je Gast"
            description="Prompts bzw. Tokens auf deinem Abo, leer = ohne Limit."
            control={
              <div className="flex gap-2">
                <input type="number" min={0} value={prefs.dailyPrompts || ""} placeholder="Prompts" onChange={(e) => setPrefs({ dailyPrompts: Math.max(0, Number(e.target.value) || 0) })} className={clsx(input, "w-[90px]")} />
                <input type="number" min={0} step={10000} value={prefs.dailyTokens || ""} placeholder="Tokens" onChange={(e) => setPrefs({ dailyTokens: Math.max(0, Number(e.target.value) || 0) })} className={clsx(input, "w-[110px]")} />
              </div>
            }
          />
          <Row
            title="Werkzeug-Ausgaben zeigen"
            description="Aus: Gäste sehen Konversation und Diffs, aber keine gelesenen Dateien oder Befehlsausgaben."
            control={<Switch checked={prefs.showOutputs} onChange={(v) => setPrefs({ showOutputs: v })} />}
          />
          <Row
            title="Gast-Prompts automatisch ausführen"
            description="Sonst bestätigst du jeden Prompt aus der Warteschlange. Slash-Befehle immer von Hand."
            control={<Switch checked={prefs.autoRun} onChange={(v) => setPrefs({ autoRun: v })} />}
          />
        </div>
      </section>
    </>
  );
}
