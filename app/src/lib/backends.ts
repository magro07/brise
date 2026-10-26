// Hilfen rund um Agent-Backends für die Oberfläche: Kurznamen, Farben und
// Capabilities. Was ein Backend nicht kann, blenden die Komponenten aus.

import { create } from "zustand";
import type { BackendCaps } from "./acp";
import { draftBackendOf, useStore, type Session } from "./store";

export const BACKEND_SHORT: Record<string, string> = { vibe: "Vibe", claude: "Claude", codex: "Codex", gemini: "Gemini" };

/** Kurzname des Backends für Fließtext, ohne bekanntes Backend neutral „Der Agent“. */
export const agentName = (backend: string | undefined) => (backend && BACKEND_SHORT[backend]) || "Der Agent";

/** Farbton je Backend für Badges (Tailwind-Klassen mit Design-Tokens). */
export const BACKEND_TONE: Record<string, string> = {
  vibe: "bg-accent-soft text-accent",
  claude: "bg-[color-mix(in_srgb,#d97757_16%,var(--bg))] text-[#c4643f]",
  codex: "bg-hover text-fg-2",
  gemini: "bg-[color-mix(in_srgb,#4f7cf0_16%,var(--bg))] text-[#3d68d8]",
};

const NO_CAPS: BackendCaps = { vibeExtensions: false, voice: false, settingsSchema: false, skills: false, models: false, autoModel: false };
const VIBE_CAPS: BackendCaps = { vibeExtensions: true, voice: true, settingsSchema: true, skills: true, models: true, autoModel: true };

/** Capabilities eines Backends (aus der Verbindung, sonst aus der Liste). */
export function useCaps(backend: string | undefined): BackendCaps {
  return useStore((s) => {
    const id = backend ?? draftBackendOf(s);
    return s.agents[id]?.caps ?? s.backends.find((b) => b.id === id)?.caps ?? (id === "vibe" ? VIBE_CAPS : NO_CAPS);
  });
}

/** Backend der Session bzw. – ohne Session – das gewählte für die nächste. */
export function useSessionBackend(session?: Session): string {
  return useStore((s) => session?.backend ?? draftBackendOf(s));
}

/** Sprache (Voxtral) läuft über Vibe – auch für Sessions anderer Backends. */
export function useVoiceAvailable(): boolean {
  return useStore((s) => !!s.agents.vibe?.caps.voice && !!s.agents.vibe?.auth?.authenticated);
}

/** Badges lohnen sich erst, wenn mehr als ein Backend im Spiel ist. */
export function useMultiBackend(): boolean {
  return useStore((s) => {
    const used = new Set<string>([s.prefs.defaultBackend, ...Object.keys(s.agents), ...Object.values(s.sessions).map((x) => x.backend)]);
    return used.size > 1;
  });
}

/** Befehl, den das eingebaute Terminal in einem neuen Tab ausführen soll (z. B. eine Anmeldung). */
export const useTerminalRequest = create<{ seq: number; command: string | null; run(command: string): void; take(): string | null }>((set, get) => ({
  seq: 0,
  command: null,
  run: (command) => set((s) => ({ seq: s.seq + 1, command })),
  // Genau einmal ausführen: Ein neu aufgebautes Terminal (Projekt-, Ansichts- oder
  // Bereichswechsel) darf eine alte Anmeldung nicht erneut starten.
  take: () => {
    const { command } = get();
    if (command) set({ command: null });
    return command;
  },
}));
