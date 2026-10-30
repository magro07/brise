// Rückfragen ohne window.confirm/prompt – die funktionieren im macOS-WebView
// nicht zuverlässig. Bestätigungen laufen über native Dialoge, Texteingaben
// über einen eigenen Dialog (TextPrompt in App.tsx).

import { ask, message } from "@tauri-apps/plugin-dialog";
import { useStore } from "./store";

export function confirmAction(text: string, danger = false): Promise<boolean> {
  return ask(text, { title: "Brise", kind: danger ? "warning" : "info", okLabel: "Ja", cancelLabel: "Abbrechen" });
}

export async function showError(text: string): Promise<void> {
  await message(text, { title: "Brise", kind: "error" });
}

export function askText(title: string, placeholder = "", secret = false): Promise<string | null> {
  return new Promise((resolve) => useStore.setState({ textPrompt: { title, placeholder, secret, resolve } }));
}
