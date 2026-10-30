import { useStore } from "./store";

/** Automationen: ein Prompt, täglich zur gewählten Zeit, solange Brise offen ist. */
export type Automation = { id: string; name: string; prompt: string; project: string; time: string; lastRun?: string; enabled: boolean };

const today = () => new Date().toLocaleDateString("sv");
const now = () => new Date().toTimeString().slice(0, 5);

export async function runAutomation(a: Automation) {
  const st = useStore.getState();
  st.setPrefs({ automations: st.prefs.automations.map((x) => (x.id === a.id ? { ...x, lastRun: today() } : x)) });
  const id = await st.createSession(a.project, st.prefs.defaultBackend, { title: a.name });
  await useStore.getState().send(a.prompt, [], { sessionId: id });
}

export function initAutomations() {
  const check = () => {
    for (const a of useStore.getState().prefs.automations) {
      if (a.enabled && a.lastRun !== today() && a.time <= now()) void runAutomation(a).catch((e) => useStore.getState().set({ error: `Automation „${a.name}“: ${e}` }));
    }
  };
  const t = window.setInterval(check, 30_000);
  check();
  return () => window.clearInterval(t);
}
