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
  credentials.rs         Mistral-Key prüfen/speichern (Schlüsselbund wie Vibe, sonst .env)
  installer.rs           lädt uv und installiert Vibe in Brises Datenordner
  embeddings.rs          Projektindex + semantische Suche, MCP-Server-Modus
  models.rs              Mistral-Modellkatalog, Modelle in config.toml, Startprüfung
  skills.rs              mitgelieferte Skills installieren, Skill-Liste
  assist.rs              Auto-Modellwahl, personalisierte Vorschläge, Commit-Nachrichten
  cortecs.rs             Cortecs: Schlüssel, Modelle für Vibe, ZDR-Proxy, Decisions-API, Kosten
  sensitive.rs           Prüfung auf sensible Daten (lokaler Vorfilter + Decision-Modell)
  git.rs                 Git über die Kommandozeile, MinGit unter Windows
  terminal.rs            eingebautes Terminal (PTY)
  files.rs               Dateien für den Editor, externe Editoren (VS Code & Co.)
  customize.rs           Selbstanpassung per Chat: MCP-Server brise-app, Live-Übernahme
  council.rs             Model Council: andere Modelle um Rat fragen, MCP-Server brise-council
  meter.rs               Mikrofonpegel für die Wellen-Animation (cpal, nur Messung)
  usage.rs               Nutzungsjournal, Preistabelle, Import aus Vibes Session-Logs
  selftest.rs            `brise --self-test` für die CI auf allen Systemen
src-tauri/resources/skills/   mitgelieferte Skills (Lizenzen und Quellen in NOTICE.md)
```

## Erster Start ohne Vibe

Ist kein Vibe installiert, bietet Brise „Mistral Vibe installieren“ an:

1. Brise lädt das offizielle `uv` von GitHub (astral-sh/uv) und prüft die SHA-256-Summe.
2. `uv tool install --python 3.13 mistral-vibe` installiert Vibe in Brises
   Datenordner (`~/.local/share/Brise`, `%LOCALAPPDATA%\Brise`,
   `~/Library/Application Support/Brise`). Python 3.13 bringt uv selbst mit.
   Neuere Pythons scheitern an fehlenden fertigen Paketen.
3. PATH und Systemdateien bleiben unverändert. Ein schon installiertes Vibe hat Vorrang.

Danach kommt die Anmeldung: im Browser (Mistral-Konto, Kontingent des Plans) oder per
eingefügtem Vibe-Key bzw. API-Key. Der Key wird gegen `GET /v1/models` geprüft und
dort gespeichert, wo Vibe ihn selbst ablegt: im Schlüsselbund unter Dienst
`ai.mistral.vibe`, Konto `MISTRAL_API_KEY`, ersatzweise in `$VIBE_HOME/.env`.

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
- **Sprache:** Mikrofon im Composer, Vibe transkribiert live mit Voxtral Realtime.
  „Vorlesen“ an jeder Antwort fasst sie mit Voxtral TTS zusammen und liest sie vor,
  auf Wunsch automatisch. Aufnahme und Wiedergabe übernimmt Vibe
  (`_voice/*`-Erweiterungen von ACP).
- **Embeddings und semantische Suche:**
  - Reiter „Suche“ im Seitenpanel: indexiert das Projekt mit `codestral-embed`
    (oder `mistral-embed`). Beim Aktualisieren werden nur geänderte Dateien neu
    eingebettet. Die Suche findet Code nach Bedeutung, ein Treffer lässt sich als
    `@Datei` anhängen.
  - Für indexierte Projekte startet Brise sich selbst als MCP-Server
    (`brise --mcp-search <ordner>`) und gibt ihn neuen Sessions mit. Vibe kann dann
    `semantic_code_search` als Werkzeug nutzen.
- **Nutzung (Einstellungen → Nutzung, Balken in der Kopfzeile):** Mistral liefert weder
  über Vibe (`/whoami` kennt nur den Plan) noch über die API Verbrauch oder Limit. Brise
  schreibt deshalb jeden Vorgang mit Modell, Tokens (Eingabe/Cache/Ausgabe), Projekt,
  Session, Funktion, Zugang (Fingerabdruck des Schlüssels) und Backend nach
  `<Datenordner>/usage/YYYY-MM.jsonl` und rechnet mit `resources/prices.json` (änderbar).
  Monatsbudget (Standard 255 €) mit Prognose, Warnungen bei 50/80/95 %, optional weicht
  Auto ab 95 % auf günstigere Modelle aus. Statistik für heute, 7 Tage, Monat, Jahr und
  gesamt: Verlauf nach Modell, Verteilung, Aufschlüsselung, Top-Sessions und -Projekte,
  Cache-Trefferquote, Aktivitäts-Heatmap. Der Verlauf vor Brise (und Nutzung über die
  Vibe-CLI) kommt aus Vibes Session-Logs (`$VIBE_HOME/logs/session`), dort nur als Summe
  je Session. Abgleich über „Stand laut Console eintragen“.
- Hell- und Dunkelmodus, einstellbare Schriftgröße, Benachrichtigung, wenn eine
  Session im Hintergrund fertig wird.

Beim Öffnen eines Projekts legt Brise im Hintergrund schon eine leere Session an.
So stehen Modell und Denkstufe vor dem ersten Prompt bereit. Vibe speichert
Sessions erst nach dem ersten Turn, leere tauchen also nirgends auf.

## Modelle, Skills, Werkzeuge

- **Modelle:** Vibe selbst bietet nur Mistral Medium 3.5 an. Bei jedem Start trägt Brise
  Mistral Large 4 und GLM-5.3 in Vibes `config.toml` ein (`[[models]]`), falls sie fehlen.
  Außerdem gleicht Brise mit Mistrals Modellkatalog ab und meldet neue Modelle per Banner.
  Unter Einstellungen → Modelle lassen sich Katalogmodelle und eigene Modell-IDs hinzufügen
  oder entfernen.
- **Auto-Modellwahl:** „Auto“ in der Modellwahl. Mistral Small stuft jede Aufgabe als
  einfach, normal oder komplex ein. Ohne Netz greift eine Heuristik. Brise setzt dann das
  zugeordnete Modell (Standard: GLM-5.3 Flash, Medium 3.5, Large 4). Bei Bildern nimmt
  Brise ein Modell, das Bilder versteht. Unter jeder Nachricht steht die Wahl.
- **Skills:** Brise liefert reverse-engineer-anything (rea), sechs ponytail-Skills,
  gauntlet-loop, frontend-design, webapp-testing, mcp-builder und skill-creator mit.
  Bei jedem Start kopiert Brise sie in den Datenordner und trägt diesen in Vibes
  `skill_paths` ein. Einzelne Skills lassen sich abschalten (`disabled_skills`). Die
  REA-Werkzeuge laufen als MCP-Server über `npx rea-agents mcp`, wenn Node.js da ist.
- **Kontext-Aufschlüsselung:** Die Summe kommt exakt von Vibe. Brise schätzt die
  Anteile (etwa 3,6 Zeichen pro Token): System und Werkzeuge, Skills, Projektkontext,
  Nachrichten, Antworten, Gedankengang, Werkzeug-Ergebnisse, Subagents, freier Platz.
  Dazu kommen die größten Einzelposten.
- **Terminal (Strg+ö):** echte Shell im Projektordner, mehrere Tabs, Höhe ziehbar.
- **Git:** Branch wechseln oder anlegen, Dateien vormerken oder verwerfen, Commit mit
  KI-Nachricht, Pull (nur Fast-Forward), Push mit Rückfrage, Verlauf. Unter Windows
  installiert Brise bei Bedarf MinGit.
- **Editor:** Monaco (der Editor von VS Code) mit Datei-Explorer, Tabs, Strg+S und
  Vergleich mit dem letzten Commit. „Öffnen in“ für VS Code, VSCodium, Cursor, Zed
  oder IntelliJ, falls installiert.
- **Personalisierte Vorschläge:** Auf der Startseite eines Projekts formuliert Mistral
  Small vier Aufgaben aus Manifest, README, Git-Status, Commits, TODOs und den letzten
  Sessions. Zwischengespeichert, bis sich der Git-Stand ändert oder 12 Stunden um sind.

## Cortecs und Zero Data Retention

[Cortecs](https://cortecs.ai) ist ein europäischer LLM-Router. Mit einem
Cortecs-Key (Einstellungen → Cortecs & Datenschutz, gespeichert im Schlüsselbund
unter Dienst `dev.brise.cortecs`, Konto `CORTECS_API_KEY`) bekommt Brise:

- **Modelle ohne Datenspeicherung für Vibe:** Anbieter `cortecs` in Vibes
  `config.toml` mit GLM-5.3, Kimi K2.7 Code, Qwen 3.8 27B und Mistral Medium 3.5
  (Aliase `cortecs-…`, mit „Cortecs ZDR“ im Namen). Vibe kann keine zusätzlichen
  Body-Felder senden, deshalb läuft jeder Aufruf über einen lokalen Proxy in Brise
  (`127.0.0.1:47318`), der `allow_zero_data_retention: true` setzt. Ohne Brise
  scheitern diese Modelle, statt ohne ZDR zu senden.
- **„Achtung, sensible Daten“:** Vor dem Senden prüft Brise Prompt und
  angehängte Textdateien lokal (IBAN, Steuer-ID, Schlüssel, Gesundheitsdaten,
  Berufsgeheimnis, EU AI Act …) und bei Treffern mit einem Cortecs-Decision-Modell
  (ebenfalls ohne Datenspeicherung). Der Hinweis bietet den Wechsel auf ein
  ZDR-Modell, „Trotzdem senden“ oder „Immer für dieses Projekt ZDR“.
- **Entscheidungen über Cortecs:** Einstufung und Denkstufe über die
  Decisions-API mit Wahrscheinlichkeiten (Standard `clef-flash`: 20/20 richtig,
  ~250 ms, ~1 Cent je 1000 Entscheidungen).
- **Kosten in EUR** im Nutzungsjournal, so wie Cortecs sie meldet.

Details, Messwerte und Grenzen: [docs/adr/0004-cortecs.md](../docs/adr/0004-cortecs.md).
Live-Tests mit Schlüssel: `cargo test --lib cortecs::tests -- --ignored --test-threads=1`.

## Selbstanpassung per Chat

Jede Session bekommt den MCP-Server `brise-app` (`brise --mcp-app`). Seine Werkzeuge:

| Werkzeug | Was es tut |
|---|---|
| `brise_get_settings` | aktuelle Einstellungen, eigenes CSS, Schnellaktionen lesen |
| `brise_set_setting` | Theme, Schriftgröße, Akzentfarbe, Sprache, Auto-Modellwahl, Modell je Stufe |
| `brise_set_custom_css` | eigenes CSS (Variablen wie `--accent`, Bereiche über `[data-brise="…"]`) |
| `brise_set_quick_actions` | eigene Karten auf der Startseite |
| `brise_set_vibe_config` | Einträge in Vibes `config.toml`, Freigaben abschalten ausgenommen |

Die Werkzeuge schreiben nach `<Datenordner>/custom/`. Brise beobachtet den Ordner
und übernimmt Änderungen sofort. Der mitgelieferte Skill `brise-anpassen` erklärt
Vibe, wann und wie er die Werkzeuge nutzt.

## Model Council

Der Agent kann andere Modelle um Rat fragen (Konzept: `docs/adr/0003-model-council.md`).
Jede Session bekommt dazu den MCP-Server `brise-council` (`brise --mcp-council <ordner>`):

| Werkzeug | Was es tut |
|---|---|
| `council_review` | Review von `git_diff`/`diff`/`files`: Befunde mit Schweregrad, `Datei:Zeile`, Übereinstimmung |
| `council_debug` | Fehlerbild → priorisierte Hypothesen mit Prüfschritt |
| `council_verify` | Behauptung „ist erledigt“ + Belege → bestätigt, Einwände oder unklar (Mehrheit) |
| `council_result` | wartet auf einen Lauf, der nach 50 s noch nicht fertig war (Vibe bricht MCP-Aufrufe nach 60 s ab) |

- Standard: drei Meinungen (Mistral Large 4, GLM-5.3, Codestral bzw. Magistral) parallel in
  den Rollen Gutachter, Bug-Jäger, Skeptiker. Mistral Large 4 führt als Vorsitz zusammen,
  sonst gruppiert Brise selbst. Dateien liest der Server nur innerhalb des Projektordners.
- Im Chat erscheint jeder Aufruf als Karte mit Modellen, Ergebnis, aufklappbaren
  Einzelurteilen, Dauer, Tokens und Kosten. „Mit Council prüfen“ steht unter jeder Antwort
  (bittet den Agenten) und im Git-Panel (prüft den aktuellen Diff direkt).
- Einstellungen → Council: automatisch / nur auf Wunsch / aus, Modelle je Rolle, Anzahl,
  Vorsitz, Denkaufwand, Zeitlimit und Tageslimit (Standard 2 €).
- Läufe: `<Datenordner>/council/runs/`, Tageskosten: `council/journal.jsonl`. Jeder
  Modellaufruf landet zusätzlich im Usage-Journal (`usage/JJJJ-MM.jsonl`, `kind: "council"`).
- Der Skill `council` erklärt dem Agenten, wann er das Council einbezieht und wie er
  Befunde abarbeitet.

## Plattformen

- **macOS:** Brise übernimmt beim Start den PATH der Login-Shell, damit Vibe, Git,
  Node und VS Code auch beim Start aus dem Finder gefunden werden. `Info.plist`
  enthält `NSMicrophoneUsageDescription`, sonst verweigert macOS Brise und Vibe das
  Mikrofon.
- **Windows:** Unterprozesse starten ohne Konsolenfenster. MCP-Server bekommen die
  nötigen Systemvariablen (`SystemRoot`, `TEMP` …). Fehlt Git, installiert Brise
  MinGit. Der Mistral-Key liegt in der Windows-Anmeldeinformationsverwaltung, dort
  wo Vibe ihn auch sucht.
- **Linux:** getestet unter Fedora 44 (GNOME/Wayland). Zum Bauen sind WebKitGTK 4.1 und
  die ALSA-Header nötig.

## Noch offen

- Rückfragen des Agenten (`elicitation`)
- Git-Panel mit Commit
- Worktrees pro Session
- eingebettetes Terminal
- Bearbeiten von MCP-Servern
- Installer für alle Plattformen über CI
