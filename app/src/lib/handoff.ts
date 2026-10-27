// Gemeinsamer Weg, Ergebnisse aus Design- und 3D-Modus an eine Coding-Session
// zu übergeben (ADR 0007): im Projekt eine neue Session öffnen, den Auftrag mit
// Anhängen senden und die Session-ID melden, sobald sie angelegt ist.

import { basename, useStore, type Attachment } from "./store";
import { api } from "./acp";

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

/**
 * Anweisung, den Skill zu nutzen. Nur Vibe kennt die mitgelieferten Skills;
 * anderen Agenten gibt Brise den Skill-Text direkt mit.
 */
export async function skillInstruction(skill: string, backend: string, label: string): Promise<string> {
  const head = `[Brise ${label}] `;
  if (backend === "vibe") return `${head}Nutze den Skill \`${skill}\` und halte dich an sein Ausgabeformat.`;
  const info = (await api.listSkills().catch(() => [])).find((s) => s.name === skill);
  const text = info ? await api.readFile(info.path, "SKILL.md").catch(() => "") : "";
  const body = text.replace(/^---[\s\S]*?---\s*/, "").trim();
  return body ? `${head}Halte dich an diese Anleitung und ihr Ausgabeformat:\n\n${body}` : `${head}Arbeite nach dem Ausgabeformat des ${label}.`;
}

/** Freigabemodus „Dateiänderungen ohne Rückfrage“ je nach Agent. */
export const ACCEPT_EDITS_MODES = ["accept-edits", "acceptEdits"];

/** Hinweis an den Agenten, zu welchem Projekt die Arbeit gehört. */
export function projectNote(project: string | undefined, what: string): string {
  if (!project) return "";
  return `[Brise] ${what} gehört zum Projekt „${basename(project)}“ (${project}). Orientiere dich bei Bedarf an dessen Code, Komponenten und Styles (lesen, nichts dort ändern) – die Umsetzung im Projekt läuft später über die Übergabe.`;
}
