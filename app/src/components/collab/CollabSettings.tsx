import { useCollab } from "../../lib/collab";
import { Switch, clsx } from "../ui";
import { RolePicker } from "./ShareDialog";

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
  return (
    <>
      <section className="mb-6">
        <h3 className="mb-1 text-[0.95em] font-semibold">Verbindung</h3>
        <p className="mb-2 text-[0.88em] text-muted">
          Ohne Relay bietet Brise den WebSocket selbst an – das reicht im selben Netz. Für Gäste von außerhalb ein eigenes Relay betreiben (siehe
          <span className="font-mono"> relay/README.md</span>). Das Relay sieht nur verschlüsselte Daten.
        </p>
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-elev">
          <Row title="Dein Name" description="So sehen dich Host und Gäste." control={<input value={prefs.name} onChange={(e) => setPrefs({ name: e.target.value })} placeholder="z. B. Max" className={clsx(input, "w-[220px]")} />} />
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
          <Row title="Rolle neuer Gäste" control={<RolePicker value={prefs.defaultRole} onChange={(r) => setPrefs({ defaultRole: r })} />} />
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
