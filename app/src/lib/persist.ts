// localStorage nur für Komfort-Daten (Projekte, Einstellungen der Oberfläche).
// Kann fehlen oder werfen – dann gelten die Standardwerte.

const PREFIX = "brise.";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* ohne Speicher geht es auch */
  }
}
