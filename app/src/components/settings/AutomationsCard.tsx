import { useState } from "react";
import { runAutomation, type Automation } from "../../lib/automations";
import { useStore } from "../../lib/store";
import { Button, Switch } from "../ui";

const field = "h-8 rounded-lg border border-line bg-elev px-2 outline-none focus:border-accent";

/** Tägliche Aufgaben anlegen. Brise muss dafür geöffnet sein. */
export function AutomationsCard() {
  const list = useStore((s) => s.prefs.automations);
  const project = useStore((s) => s.activeProject);
  const setPrefs = useStore((s) => s.setPrefs);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [time, setTime] = useState("07:00");
  const save = (next: Automation[]) => setPrefs({ automations: next });
  return (
    <div className="space-y-2 rounded-xl border border-line p-3">
      <div className="font-medium">Automationen</div>
      <p className="text-[0.86em] text-muted">Ein Auftrag läuft täglich zur gewählten Zeit als neue Session. Brise muss dafür geöffnet sein; verpasste Läufe holt es am selben Tag nach.</p>
      {list.map((a) => (
        <div key={a.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{a.time} · {a.name}</span>
          <Button size="sm" onClick={() => void runAutomation(a)}>Jetzt</Button>
          <Button size="sm" onClick={() => save(list.filter((x) => x.id !== a.id))}>Löschen</Button>
          <Switch checked={a.enabled} onChange={(v) => save(list.map((x) => (x.id === a.id ? { ...x, enabled: v } : x)))} />
        </div>
      ))}
      <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={`${field} w-40`} />
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={field} />
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Auftrag an den Agenten" className={`${field} flex-1`} />
        <Button size="sm" disabled={!name || !prompt || !project} onClick={() => {
          save([...list, { id: crypto.randomUUID(), name, prompt, time, project: project!, enabled: true }]);
          setName("");
          setPrompt("");
        }}>Anlegen</Button>
      </div>
    </div>
  );
}
