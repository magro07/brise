# Brise – App

Tauri 2 + React + TypeScript. Das Rust-Backend startet `vibe-acp` und spricht
mit ihm über das Agent Client Protocol. Die Oberfläche bekommt alles als
Tauri-Events.

```
src/                 Oberfläche (React)
  App.tsx            Startbildschirme, Sidebar, Kopfzeile, Session-Logik
  store.ts           setzt session/update-Nachrichten zu Chat-Einträgen zusammen
  acp.ts             Typen + Aufrufe der Rust-Commands
  components/        Messages (Chat, Tool-Karten, Freigaben, Plan), Diff, Composer
src-tauri/src/
  rpc.rs             JSON-RPC über stdio (aus dem Spike übernommen)
  agent.rs           Tauri-Commands und Event-Weiterleitung, fs-Handler
```

## Entwickeln

Voraussetzungen unter Fedora (einmalig):

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel
```

Für macOS und Windows siehe <https://tauri.app/start/prerequisites/>. Mistral
Vibe muss installiert sein, und `vibe-acp` wird automatisch in `PATH` bzw.
`~/.local/bin` gesucht.

```bash
npm install
npm run tauri dev                 # Entwicklungsmodus mit Hot Reload
npm run tauri dev -- -- ~/projekt # direkt mit einem Projektordner starten
npm run tauri build               # Installer bauen
```

Umgebungsvariablen:

- `BRISE_ACP_TRACE=/tmp/acp.log` schreibt den gesamten ACP-Verkehr mit.
- `VIBE_HOME=/tmp/vibe-clean` startet Vibe mit einer eigenen, leeren
  Konfiguration. Die Anmeldung aus dem Schlüsselbund bleibt erhalten.

## Stand (Meilenstein 2)

Getestet unter Linux (GNOME, Wayland sowie Xvfb) mit Mistral Vibe 3.0.2:

- Start: Vibe finden, verbinden, Anmeldestatus prüfen. Ist Vibe nicht angemeldet,
  zeigt die App einen Login-Bildschirm („Im Browser anmelden“ über `browser-auth-delegated`).
  Den Login-Ablauf selbst habe ich nicht ausprobiert.
- Projektordner wählen (nativer Dialog, zuletzt genutzte Ordner, CLI-Argument)
- Sessions: neue Session beim ersten Prompt; frühere Sessions des Projekts in der
  Sidebar (`session/list`), Laden mit vollständigem Verlauf (`session/load`)
- Chat: Markdown-Streaming, einklappbare Gedanken, Tool-Karten mit Status,
  Diffs inline, Plan-Anzeige, Stopp-Knopf (Esc)
- Freigaben als Karten. „Immer erlauben“ wird nur angeboten, wenn Vibe ein
  Befehlsmuster liefert, damit nie ein kompletter Befehl samt Passwörtern
  dauerhaft gespeichert wird.
- Freigabe-Modus, Modell und Kontextgröße in der Kopfzeile
- Heller und dunkler Modus nach Systemeinstellung

Noch offen: Rückfragen des Agenten (`elicitation`), automatische
Vibe-Installation, Bilder und `@`-Erwähnungen, Git-Panel, Code-Highlighting,
Installer für alle Plattformen über CI.
