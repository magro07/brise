// Gemeinsamer Weg, Ergebnisse aus Design- und 3D-Modus an eine Coding-Session
// zu übergeben (ADR 0007): im Projekt eine neue Session öffnen, den Auftrag mit
// Anhängen senden und die Session-ID melden, sobald sie angelegt ist.

import { useStore, type Attachment } from "./store";

/**
 * Startet im Projekt eine neue Session mit `prompt`. `onSession` bekommt die
 * Session-ID, sobald die Session mit dem Auftrag angelegt ist (höchstens 60 s).
 */
export function handoffToSession(project: string, prompt: string, attachments: Attachment[], onSession?: (sessionId: string) => void) {
  const st = useStore.getState();
  st.openProject(project);
  st.newDraft(project);
  if (onSession) {
    const unsub = useStore.subscribe((s) => {
      const id = s.activeSessionId;
      const session = id ? s.sessions[id] : undefined;
      if (!id || session?.cwd !== project || !session.items.some((i) => i.type === "user" && i.text === prompt)) return;
      unsub();
      onSession(id);
    });
    setTimeout(unsub, 60_000);
  }
  void st.send(prompt, attachments);
}

/** Ordnername aus einem Namen (klein, ASCII, Bindestriche). */
export function fileSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "modell"
  );
}
