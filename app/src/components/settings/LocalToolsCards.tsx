import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../lib/store";
import { Switch } from "../ui";

type Roblox = { path: string | null; enabled: boolean; external: boolean };

/** Roblox Studio: Brise findet den MCP-Server selbst. */
export function RobloxCard() {
  const [s, setS] = useState<Roblox | null>(null);
  const load = () => invoke<Roblox>("roblox_status").then(setS);
  useEffect(() => void load(), []);
  if (!s) return null;
  const found = s.path || s.external;
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">Roblox Studio</div>
          <div className="text-[0.86em] text-muted">
            {found ? "Gefunden. Neue Sessions verbinden sich automatisch." : "Nicht gefunden. Installiere Roblox Studio und starte es einmal."}
          </div>
        </div>
        {s.path && <Switch checked={s.enabled} onChange={(v) => invoke("roblox_set_enabled", { enabled: v }).then(load)} />}
      </div>
      <p className="mt-2 text-[0.86em] text-muted">
        Einmalig in Studio: Assistant öffnen, „Manage MCP Servers“, „Enable Studio as MCP server“ einschalten. Studio muss offen sein, wenn der Agent es benutzt. Nach einem Neustart von Studio eine neue Session beginnen.
      </p>
    </div>
  );
}

/** Spracheingabe lokal: Aufnahme in Brise, Text von einem Whisper-Server. */
export function LocalSttCard() {
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const [test, setTest] = useState("");
  return (
    <div className="space-y-2 rounded-xl border border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">Lokale Transkription</div>
          <div className="text-[0.86em] text-muted">Das Audio geht nur an deinen eigenen Transkriptionsserver mit OpenAI-kompatibler Schnittstelle, auch im Heimnetz. Empfohlen für Deutsch: Parakeet TDT v3.</div>
        </div>
        <Switch checked={prefs.sttEngine === "local"} onChange={(v) => setPrefs({ sttEngine: v ? "local" : "vibe" })} />
      </div>
      {prefs.sttEngine === "local" && (
        <div className="flex gap-2">
          <input value={prefs.sttEndpoint} onChange={(e) => setPrefs({ sttEndpoint: e.target.value })} aria-label="Adresse" className="h-8 flex-1 rounded-lg border border-line bg-elev px-2 outline-none focus:border-accent" />
          <input value={prefs.sttLocalModel} onChange={(e) => setPrefs({ sttLocalModel: e.target.value })} aria-label="Modell" className="h-8 w-40 rounded-lg border border-line bg-elev px-2 outline-none focus:border-accent" />
          <button className="rounded-lg border border-line px-2" onClick={() => invoke("stt_check", { endpoint: prefs.sttEndpoint }).then(() => setTest("Erreichbar"), (e) => setTest(String(e)))}>Prüfen</button>
        </div>
      )}
      {test && <p className="text-[0.86em] text-muted">{test}</p>}
    </div>
  );
}
