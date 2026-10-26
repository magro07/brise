# Brise – App

Tauri 2 + React + TypeScript + Tailwind 4 + Radix. Das Rust-Backend startet
`vibe-acp` und spricht mit ihm über das Agent Client Protocol. Die Oberfläche
bekommt alles als Tauri-Events.

```
src/
  App.tsx                Gerüst, Backend-Events, Tastenkürzel
  index.css              Design-Tokens (hell/dunkel), Markdown, Highlighting
  lib/store.ts           globaler Zustand (zustand): Sessions, Projekte, Aktionen
  lib/acp.ts             Typen + Aufrufe der Rust-Commands
  components/
    layout/              Sidebar (Projekte → Sessions), Header, Befehlspalette
    chat/                Konversation, Tool-Gruppen, Subagent-Karten, Diff, Markdown
    composer/            Eingabe mit @/Slash, Modus/Modell/Denkstufe, Freigaben, Aufgaben
    panels/              Seitenpanel: Änderungen, Kontext, Subagents, Aufgaben
    settings/            Einstellungen aus Vibes Schema, schreibt config.toml
    screens/             Start, Login, Vibe fehlt, leere Zustände
    ui/                  Buttons, Menüs, Tooltips, Schalter, Ring
src-tauri/src/
  rpc.rs                 JSON-RPC über stdio
  agent.rs               ACP-Commands, Event-Weiterleitung, Login, fs-Handler
  config.rs              config.toml lesen/schreiben (toml_edit, mit Backup), Dateien, Bilder
```

## Entwickeln

Voraussetzungen unter Fedora (einmalig):

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel
```

Für macOS und Windows siehe <https://tauri.app/start/prerequisites/>. Mistral
Vibe muss installiert sein. `vibe-acp` wird im `PATH` und in `~/.local/bin` gesucht.

```bash
npm install
npm run tauri dev                 # Entwicklungsmodus mit Hot Reload
npm run tauri dev -- -- ~/projekt # direkt mit einem Projektordner starten
npm run tauri build               # Installer bauen
```

Umgebungsvariablen:

- `BRISE_ACP_TRACE=/tmp/acp.log` schreibt den gesamten ACP-Verkehr mit.
- `VIBE_HOME=/tmp/vibe-clean` startet Vibe mit eigener, leerer Konfiguration.
  Die Anmeldung aus dem Schlüsselbund gilt weiter.

## Funktionen

- **Projekte und Sessions:** In der Sidebar stehen die Sessions aller Projekte, die
  Vibe kennt (`session/list` ohne Ordner), gruppiert und filterbar. Neue Session pro
  Projekt, laufende Sessions mit Spinner, wartende mit gelbem Punkt. Löschen über
  `_session/delete`.
- **Konversation:** Markdown mit Code-Highlighting und Kopier-Knopf. Werkzeugaufrufe
  werden wie in Claude Code gruppiert („2 Dateien gelesen · 1 Befehl“), Diffs mit
  Zeilennummern bleiben immer sichtbar, der Gedankengang lässt sich aufklappen. Unter
  jedem Turn stehen Dauer und Tokens.
- **Subagents:** eigene Karten mit Agent, Aufgabe, Schritten und Ergebnis. Der
  Verlauf des Subagenten lässt sich öffnen (nur lesbar).
- **Composer:** `@` für Dateien (Fuzzy-Suche, beachtet .gitignore), `/` für Vibes
  Befehle, Anhänge per Knopf oder Drag & Drop (Bilder gehen als Bild an das
  Modell), Freigabe-Modus, Modell und Denkstufe als Auswahl, Kontext-Ring.
- **Freigaben:** erscheinen über dem Eingabefeld, mit Befehlsmuster („python3 *“).
  „Immer erlauben“ gibt es nur mit Muster, Passwörter im Befehl werden maskiert.
- **Aufgabenliste:** Vibes Plan als Leiste mit Fortschritt über dem Eingabefeld.
- **Seitenpanel (Strg+J):**
  - Änderungen pro Datei
  - Kontext: Auslastung, Eingabe/Cache/Ausgabe, Tokens/s, Kosten, „Komprimieren“
  - Subagents
  - Aufgaben
- **Einstellungen (Strg+,):**
  - Darstellung, Benachrichtigungen, Konto
  - Modelle, Freigaben, Agents, MCP-Server
  - „Erweitert“ mit allen übrigen Vibe-Optionen, durchsuchbar
  - Gespeichert wird direkt in `config.toml`. Beim ersten Schreiben legt Brise
    `config.toml.brise-backup` an.
  - Die Liste dauerhaft erlaubter Befehle markiert Einträge mit Zugangsdaten und
    kann sie entfernen.
- **Befehlspalette (Strg+K):** Sessions, Projekte und Aktionen durchsuchen.
- Hell- und Dunkelmodus, einstellbare Schriftgröße, Benachrichtigung, wenn eine
  Session im Hintergrund fertig wird.

Beim Öffnen eines Projekts legt Brise im Hintergrund schon eine leere Session an.
So stehen Modell und Denkstufe vor dem ersten Prompt bereit. Vibe speichert
Sessions erst nach dem ersten Turn, leere tauchen also nirgends auf.

## Noch offen

- Rückfragen des Agenten (`elicitation`)
- automatische Vibe-Installation
- Git-Panel mit Commit
- Worktrees pro Session
- eingebettetes Terminal
- Bearbeiten von MCP-Servern
- Installer für alle Plattformen über CI
