import { useEffect, useState } from "react";
import { ACTIONS, comboOf, conflicts, keysOf, showCombo } from "../../lib/shortcuts";
import { useStore } from "../../lib/store";
import { Button } from "../ui";

/** Alle Tastenkürzel: ansehen, neu belegen, sichern. */
export function ShortcutsCard() {
  const custom = useStore((s) => s.prefs.shortcuts) ?? {};
  const setPrefs = useStore((s) => s.setPrefs);
  const [recording, setRecording] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!recording) return;
    let first = "";
    let timer = 0;
    const done = (combo: string) => {
      setPrefs({ shortcuts: { ...custom, [recording]: combo } });
      setRecording(null);
    };
    const onKey = (e: KeyboardEvent) => {
      const combo = comboOf(e);
      if (!combo) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (combo === "escape" && !first) return setRecording(null);
      window.clearTimeout(timer);
      if (first) return done(`${first} ${combo}`);
      // Kurz warten: Eine zweite Taste macht daraus eine Tastenfolge.
      first = combo;
      timer = window.setTimeout(() => done(first), 900);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [recording]);

  const clash = conflicts(custom);
  const shown = ACTIONS.filter((a) => a.label.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Kürzel suchen …" className="h-8 flex-1 rounded-lg border border-line bg-elev px-2 outline-none focus:border-accent" />
        <Button size="sm" onClick={() => navigator.clipboard.writeText(JSON.stringify(custom, null, 2))}>Exportieren</Button>
        <Button size="sm" onClick={async () => {
          const parsed = await navigator.clipboard.readText().then((t) => JSON.parse(t)).catch(() => null);
          if (parsed && typeof parsed === "object") setPrefs({ shortcuts: parsed });
        }}>Importieren</Button>
        <Button size="sm" onClick={() => setPrefs({ shortcuts: {} })}>Zurücksetzen</Button>
      </div>
      {Object.keys(clash).length > 0 && <p className="text-[0.86em] text-bad">Doppelt belegt: {Object.entries(clash).map(([k, v]) => `${showCombo(k)} (${v.join(", ")})`).join("; ")}</p>}
      <div className="divide-y divide-line rounded-xl border border-line">
        {shown.map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span>{a.label}</span>
            <button onClick={() => setRecording(a.id)} className="rounded border border-line bg-panel px-2 py-0.5 text-[0.82em] hover:border-accent">
              {recording === a.id ? "Taste drücken … (Esc bricht ab)" : showCombo(keysOf(a, custom)[0])}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
