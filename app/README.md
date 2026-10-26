# Brise – App

Brise ist ein Desktop-Client für KI-Coding-Agenten mit Zusammenarbeit im kleinen
Team als Kern (Positionierung: [docs/positionierung.md](../docs/positionierung.md)).
Diese Datei beschreibt Aufbau und Funktionen im Detail.

Tauri 2 + React + TypeScript + Tailwind 4 + Radix. Das Rust-Backend startet
Coding-Agenten – Mistral Vibe (`vibe-acp`), Claude Code, Codex, Gemini CLI – und
spricht mit ihnen über das Agent Client Protocol (siehe
[ADR 0001](../docs/adr/0001-agent-backends.md)). Die Oberfläche bekommt alles als
Tauri-Events.

```
src/
  App.tsx                Gerüst, Backend-Events, Tastenkürzel
  index.css              Design-Tokens (hell/dunkel), Markdown, Highlighting
  lib/store.ts           globaler Zustand (zustand): Sessions, Projekte, Aktionen
  lib/acp.ts             Typen + Aufrufe der Rust-Commands
  lib/backends.ts        Backend-Kurznamen, Capabilities, Terminal-Befehle
  lib/collab.ts          Kollaboration: Spiegeln (Host), Ansicht aufbauen (Gast)
  components/
    layout/              Sidebar (Projekte → Sessions), Header, Befehlspalette
    chat/                Konversation, Tool-Gruppen, Subagent-Karten, Diff, Markdown
    agents/              Agent-Wahl, Backend-Badges, Einstellungen „Agenten“
    composer/            Eingabe mit @/Slash, Modus/Modell/Denkstufe, Freigaben, Aufgaben
    panels/              Seitenpanel: Änderungen, Kontext, Subagents, Aufgaben
    settings/            Einstellungen aus Vibes Schema, schreibt config.toml
    design/              Design-Modus: Chat + Live-Vorschau, Varianten, Versionen, Tokens, Übergabe
    screens/             Start, Login, Vibe fehlt, leere Zustände
    ui/                  Buttons, Menüs, Tooltips, Schalter, Ring
    collab/              Session teilen, beitreten, Gast-Composer, Einstellungen
    bench/               Benchmarks: Liste, Editor, Lauf, Vergleichstabelle, Verlauf
src-tauri/src/
  rpc.rs                 JSON-RPC über stdio
  agent.rs               ACP-Commands, ein Prozess je Backend, Session-Routing, Events, fs-Handler
  backends.rs            bekannte Agenten: finden, installieren (uv/npm), Anmeldung, Capabilities
  decision.rs            DecisionProvider: Task-Modell für Brises Entscheidungen (heute Mistral)
  config.rs              config.toml lesen/schreiben (toml_edit, mit Backup), Dateien, Bilder
  credentials.rs         Mistral-Key prüfen/speichern (Schlüsselbund wie Vibe, sonst .env)
  accounts.rs            weitere Schlüssel mit Namen, Account je Projekt/Session, Reserve bei Limit
  installer.rs           lädt uv und installiert Vibe in Brises Datenordner
  embeddings.rs          Projektindex + semantische Suche, MCP-Server-Modus
  models.rs              Mistral-Modellkatalog, Modelle in config.toml, Startprüfung
  skills.rs              mitgelieferte Skills installieren, Skill-Liste
  assist.rs              Auto-Modellwahl, personalisierte Vorschläge, Commit-Nachrichten
  cortecs.rs             Cortecs: Schlüssel, Modelle für Vibe, ZDR-Proxy, Decisions-API, Kosten
  sensitive.rs           Prüfung auf sensible Daten (lokaler Vorfilter + Decision-Modell)
  decision.rs            DecisionProvider-Schnittstelle (Mistral Small; Cortecs über cortecs.rs)
  git.rs                 Git über die Kommandozeile, MinGit unter Windows
  terminal.rs            eingebautes Terminal (PTY)
  files.rs               Dateien für den Editor, externe Editoren (VS Code & Co.)
  customize.rs           Selbstanpassung per Chat: MCP-Server brise-app, Live-Übernahme
  council.rs             Model Council: andere Modelle um Rat fragen, MCP-Server brise-council
  meter.rs               Mikrofonpegel für die Wellen-Animation (cpal, nur Messung)
  usage.rs               Nutzungsjournal, Preistabelle, Import aus Vibes Session-Logs
  bench.rs               eigene Benchmarks: Definitionen, isolierte Läufe, Prüfungen, Ergebnisse
  selftest.rs            `brise --self-test` für die CI auf allen Systemen
  collab/                Kollaboration: Verschlüsselung, Einladungslinks, Relay-Verbindung, LAN-Relay
  design.rs              Design-Modus: Arbeitsordner, Kopien/Versionen, Export ins Projekt, Token-Import
src-tauri/resources/skills/   mitgelieferte Skills (Lizenzen und Quellen in NOTICE.md)
```

## Erster Start: Agent wählen

Findet Brise beim ersten Start kein Vibe, zeigt es eine Auswahl, in der alle Agenten
gleichwertig stehen: „Mistral Vibe installieren und nutzen“, „Mit Claude Code arbeiten“ bzw.
„Claude Code installieren und nutzen“, ebenso für Codex und Gemini CLI. Fehlt
Node.js (≥ 22) für die npm-basierten Adapter, steht der Grund am Eintrag. Die Wahl
wird zum Standard-Agenten, weitere kommen unter *Einstellungen → Agenten* dazu. Ist
Vibe installiert, aber nicht angemeldet, stehen die anderen Agenten unter der
Mistral-Anmeldung.

### Mistral Vibe installieren

1. Brise lädt das offizielle `uv` von GitHub (astral-sh/uv) und prüft die SHA-256-Summe.
2. `uv tool install --python 3.13 mistral-vibe` installiert Vibe in Brises
   Datenordner (`~/.local/share/Brise`, `%LOCALAPPDATA%\Brise`,
   `~/Library/Application Support/Brise`). Python 3.13 bringt uv selbst mit.
   Neuere Pythons scheitern an fehlenden fertigen Paketen.
3. PATH und Systemdateien bleiben unverändert. Ein schon installiertes Vibe hat Vorrang.

### Vibe-Anmeldung und mehrere Schlüssel

Nach der Installation kommt die Anmeldung: im Browser (Mistral-Konto, Kontingent des Plans) oder per
eingefügtem Vibe-Key bzw. API-Key. Der Key wird gegen `GET /v1/models` geprüft und
dort gespeichert, wo Vibe ihn selbst ablegt: im Schlüsselbund unter Dienst
`ai.mistral.vibe`, Konto `MISTRAL_API_KEY`, ersatzweise in `$VIBE_HOME/.env`.

Weitere Schlüssel (Firma, Kunde, Pay-as-you-go) trägt man unter *Einstellungen →
Konto → Accounts* mit Namen ein. Sie liegen nur im Schlüsselbund (Konto
`BRISE_KEY_<id>`), `accounts.json` im Datenordner enthält nur Namen und
Zuordnungen. Für jeden benutzten Account startet Brise einen eigenen `vibe-acp`.
Eine Session bleibt bei ihrem Account, damit der Prompt-Cache erhalten bleibt.
Bei einem Limit kann sie auf einen Pay-as-you-go-Schlüssel als Reserve wechseln.
Mehrere eigene Abo-Accounts sind laut Mistrals Bedingungen nicht erlaubt, deshalb
rotiert Brise nicht zwischen ihnen. Hintergrund: `docs/adr/0002-mehrere-schluessel.md`.

## Mehrere Agenten (Backends)

Brise arbeitet mit mehreren ACP-Agenten, keiner davon ist Voraussetzung. Jede Session
gehört einem Agenten; welcher, steht als Badge an Session und Tab, sobald mehr als einer im Spiel ist.

| Agent | Wie Brise ihn startet | Anmeldung |
|---|---|---|
| Mistral Vibe | `vibe-acp` (uv-Installation wie oben) | Mistral-Konto oder Key, in Brise |
| Claude Code | `claude-agent-acp` aus dem PATH oder `npm install @agentclientprotocol/claude-agent-acp` in `<Datenordner>/backends/claude`, gestartet mit `node` (Node.js ≥ 22) | Claude-Code-Anmeldung: „Anmelden“ führt `… --cli auth login --claudeai` im eingebauten Terminal aus (Claude Pro/Max). Variablen wie `ANTHROPIC_API_KEY` und `~/.claude/settings.json` gelten ebenfalls |
| OpenAI Codex | `codex-acp` bzw. `@agentclientprotocol/codex-acp` | `codex login` oder `OPENAI_API_KEY` |
| Gemini CLI | `gemini --acp` bzw. `@google/gemini-cli` | Google-Login beim ersten `gemini` oder `GEMINI_API_KEY` |

- **Neue Session:** Im Eingabefeld wählt „Agent“ das Backend für die nächste Session
  (erscheint, sobald mehr als ein Agent installiert ist). Standard unter
  Einstellungen → Agenten.
- **Einstellungen → Agenten:** installiert, angemeldet (bei Zugangsdaten aus Variablen
  oder `settings.json` mit „nicht geprüft“), Installieren, Anmelden, Neu verbinden,
  Standard-Agent, welche Agenten beim Start verbinden (deren Sessions stehen dann in
  der Seitenleiste).
- **Capabilities:** Vibe-Erweiterungen (Konto, Einstellungen aus dem Schema, Skills,
  Modellverwaltung, Auto-Modellwahl) gibt es nur für Vibe-Sessions; ohne
  Vibe-Verbindung blendet Brise diese Einstellungsabschnitte aus. Sprache (Voxtral)
  läuft über Vibe und steht allen Sessions zur Verfügung, wenn Vibe angemeldet ist.
  Modus, Modell, Freigaben, Diffs, Plan, Slash-Befehle und Sessions-Liste kommen
  per Standard-ACP vom jeweiligen Agenten.
- **Ohne Vibe:** siehe [Erster Start](#erster-start-agent-wählen). Ist ein anderer
  Agent Standard, braucht Brise beim Start kein Vibe.
- **Entscheidungen:** Einstufen, Denkstufe, Vorschläge und Commit-Nachrichten laufen
  über Mistral Small oder – mit Einstellungen → Cortecs & Datenschutz – über
  Cortecs-Decision-Modelle ohne Datenspeicherung.

## Zusammenarbeit (geteilte Sessions)

Der Agent läuft immer nur beim Host. Gäste sehen live mit, Mitarbeiter schlagen Prompts
vor, Freigeber entscheiden Freigaben. Protokoll: [`docs/collab-protocol.md`](../docs/collab-protocol.md),
Relay-Dienst: [`relay/`](../relay/README.md).

- **Teilen:** Session-Menü (⋯ in der Kopfzeile) → „Session teilen …“. Brise erzeugt einen
  Einladungslink `brise://join/<raum>?relay=…#<schlüssel>.<host>` und stellt die Session auf
  „Alles fragen“. Der Dialog zeigt Teilnehmer (Rolle ändern, Freigabe entziehen) und die
  Warteschlange der Gast-Prompts („Ausführen“, Verwerfen, optional automatisch).
- **Beitreten:** Strg+K → „Einer Session beitreten …“ oder Sidebar → Projekt-Menü. Die Session
  öffnet sich als nur lesbarer Tab. Mitarbeiter bekommen ein Eingabefeld für Vorschläge.
- **Verbindung:** Standard ist „Direkt im LAN“: Brise startet das Relay selbst (Port 47800,
  Firewall freigeben). Für Gäste von außerhalb unter Einstellungen → Zusammenarbeit die
  Adresse eines eigenen Relays eintragen (`wss://…`, Homelab-Anleitung in `relay/README.md`).
- **Teams:** Sidebar → Projekt-Menü → „Team anlegen oder beitreten …“. Im Team seht ihr, wer
  online ist, welche Abos es gibt, welche Sessions geteilt sind (ein Klick zum Beitreten) und
  eine gemeinsame Projektliste. Teammitglieder bekommen in geteilten Sessions die Team-Rolle.
- **Abo:** Jede geteilte Session läuft auf dem Abo des Hosts (`backend`, `billedTo`). Der Host
  legt fest, ob Gäste Prompts darauf schicken dürfen, optional mit Tageslimit je Gast; die
  Nutzung pro Gast steht im Teilen-Dialog und kommt als Event `collab:usage`.
- **Was Gäste sehen:** Konversation und Diffs. Werkzeug-Ausgaben (gelesene Dateien,
  Befehlsausgaben) nur, wenn „Werkzeug-Ausgaben zeigen“ an ist. Alles ist Ende-zu-Ende
  verschlüsselt (XChaCha20-Poly1305), Rollen signiert der Host (Ed25519).

Zwei Instanzen auf einem Rechner testen, z. B. unter Xvfb:

```bash
Xvfb :77 -screen 0 2440x860x24 &
export DISPLAY=:77 GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
XDG_DATA_HOME=/tmp/host/data XDG_CONFIG_HOME=/tmp/host/cfg ./src-tauri/target/debug/brise ~/projekt &
XDG_DATA_HOME=/tmp/gast/data XDG_CONFIG_HOME=/tmp/gast/cfg ./src-tauri/target/debug/brise &
```

Eigene `XDG_*`-Ordner trennen die Oberflächen-Daten der Instanzen, Vibe und der
Schlüsselbund bleiben gemeinsam.

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

## Master-Session (Untersessions)

Eine Session kann Arbeit planen und Teilaufgaben als eigene Sessions laufen lassen –
wie die Hauptsession in Claude Code Desktop (Konzept: `docs/adr/0006-master-session.md`).
Dazu bekommt jede Session im MCP-Server `brise-app` diese Werkzeuge:

| Werkzeug | Was es tut |
|---|---|
| `start_session(title, task, backend?, model?, worktree?, difficulty?, thinking?)` | Teilaufgabe vorschlagen bzw. starten; ohne `model` wählt Brise einen Arbeiter aus dem Pool |
| `list_sessions` | eigene Untersessions mit Status und Branch |
| `get_session(session)` | Status, letzter Bericht, Branch, Commits vor der Basis, nicht committete Dateien |
| `send_message(session, text)` | Nachricht an eine Untersession (läuft sie, nach dem Turn) |
| `escalate_session(session, feedback)` | Teilaufgabe auf die nächste Stufe des Arbeiter-Pools heben |
| `stop_session(session)` | Turn abbrechen, Untersession beenden (Worktree bleibt) |
| `merge_session(session)` | Freigabe zum Mergen ihres Branches anfragen |

- **Vorschlagskarten:** Mit „Erst nach Bestätigung starten“ (Standard) erscheint jeder
  Vorschlag als Karte im Chat der Master-Session: **Neue Session** startet sie,
  **Hier erledigen** gibt die Aufgabe an die Master-Session zurück.
- **Worktrees:** Untersessions arbeiten standardmäßig in einem eigenen `git worktree` auf
  dem Branch `brise/<titel>-<xxxx>` (Ordner `<Datenordner>/worktrees/<repo>-<hash>/…`,
  außerhalb des Repos). Ihr Auftrag beginnt mit einem kurzen Rahmen: Branch, Basis,
  „committe deine Arbeit“, „schließe mit kurzem Bericht“.
- **Rückmeldung:** Beendet eine Untersession einen Turn, bekommt die Master-Session eine
  Notiz (`[Brise · Rückmeldung]`) mit Status, Branch, Commits und Bericht. Wartet sie, geht
  es sofort weiter; arbeitet sie gerade, wird die Notiz nach ihrem Turn zugestellt.
- **Mergen nur mit Freigabe:** `merge_session` zeigt eine Karte (Branch → Ziel, Commits,
  Diffstat). Erst **Mergen** führt `git merge --no-ff` im Ordner der Master-Session aus;
  danach werden Worktree und Branch entfernt. Bei Konflikten wird abgebrochen
  (`git merge --abort`) und die Master-Session bekommt die Konfliktdateien.
- **Oberfläche:** Untersessions stehen in der Seitenleiste eingerückt unter ihrer
  Master-Session (läuft, wartet auf Freigabe, fertig, Fehler, gestoppt, gemerged); Klick
  öffnet sie als Tab, im Menü „Rechts daneben öffnen“. Über dem Composer zeigt eine Leiste
  die Untersessions der Session (Alt+Klick öffnet daneben).
- **Nutzung:** Jeder Turn einer Untersession landet im Usage-Journal mit `master` und der
  Funktion „Untersession“; *Einstellungen → Nutzung* zeigt die Kosten je Master-Session.
- **Grenzen:** *Einstellungen → Master-Session*: an/aus, Bestätigung, gleichzeitige
  Untersessions (Standard 3), Worktree als Standard. Ist das Monatsbudget erreicht, startet
  keine Untersession. Team-Admins können die Funktion sperren oder die Zahl begrenzen
  (Richtlinie `orchestra`, `maxSubSessions`); Backend- und Modell-Listen gelten auch hier.
- **Kurator und Arbeiter:** *Einstellungen → Master-Session → Kurator und Arbeiter* legt das
  Kurator-Modell fest (z. B. Claude Code mit Opus oder Vibe mit Mistral Large 4; „Neue
  Kurator-Session“ im Projektmenü startet es mit festem Modell) und einen Arbeiter-Pool mit
  Stufen 1–3 (Standard: GLM-5.3, Mistral Medium 3.5, Mistral Large 4). Gibt der Kurator bei
  `start_session` nur `difficulty` an, wählt Brise Modell und Denkstufe: einfach/normal →
  Stufe 1, komplex → Stufe 2; innerhalb einer Stufe das günstigste Modell (Preistabelle),
  bei Gleichstand das schnellere (t/s im Journal). Ab 70 % des Budgets je Lauf nur noch
  Stufe 1, bei 100 % keine neuen Arbeiter. Team-Richtlinien filtern den Pool.
- **Eskalation:** `escalate_session(session, feedback)` hebt eine Teilaufgabe auf die nächste
  Stufe (gleiches Backend: Modellwechsel in der Session; sonst neue Session im selben
  Worktree). Scheitert ein Arbeiter (Fehler, Token- oder Schrittlimit), eskaliert Brise
  selbst; höchstens „Höchste Eskalation“ Stufen. Leiste, Seitenleiste und Notizen zeigen
  Modell, Stufe und Eskalationen; die Leiste die Kosten von Kurator und Arbeitern.
- **Claude-Abo:** Claude Code läuft über dein persönliches Claude-Abo. Ist eine
  Master-Session mit Gästen geteilt, lehnt Brise Claude Code als Kurator oder Arbeiter ab
  (Anthropics Bedingungen); für Teams passt ein API-Schlüssel oder ein anderes Backend.
- **Kanal:** Der MCP-Server erreicht die laufende App über einen Port auf `127.0.0.1` mit
  Zufallstoken (nur in der Umgebung der Kindprozesse, gilt bis zum Neustart). Buch führt
  `<Datenordner>/orchestra/state.json` (ohne Schlüssel). Untersessions bekommen keine
  Orchestrierungs-Werkzeuge.

## Benchmarks

Unter *Einstellungen → Benchmarks* legt man eigene Benchmarks an und lässt sie beliebig oft
laufen, um Modelle und Agenten auf den eigenen Aufgaben zu vergleichen und Regressionen zu
sehen. Brise liefert den Beispiel-Benchmark `beispiel.json` mit (Rechenfrage, Bugfix mit
Tests, Erklärung mit Richtermodell; Quelle `src-tauri/resources/benchmarks/`). Er wird beim
ersten Öffnen einmal angelegt und kommt nach dem Löschen nicht wieder.

**Definition:** eine JSON-Datei je Benchmark in `<Datenordner>/benchmarks/<id>.json`. Man
bearbeitet sie im Formular, als JSON in Brise oder direkt in der Datei, und kann sie
versionieren:

```json
{
  "name": "Refactorings im Backend",
  "judgeModel": "mistral-small-latest",
  "tasks": [{
    "id": "bugfix",
    "name": "Bugfix mit Tests",
    "prompt": "Behebe den Fehler in calc.py, sodass die Tests grün sind.",
    "project": "/home/ich/code/projekt",
    "ref": "v1.2",
    "files": { "notiz.txt": "zusätzliche Datei" },
    "setup": "npm ci",
    "timeoutSec": 600,
    "checks": [
      { "type": "command", "run": "npm test", "timeoutSec": 300 },
      { "type": "regex", "pattern": "(?i)behoben" },
      { "type": "contains", "value": "calc.py", "ignoreCase": true },
      { "type": "file", "path": "src/calc.py", "pattern": "def mittelwert" },
      { "type": "judge", "criteria": "Erklärt die Ursache korrekt", "threshold": 0.6 }
    ]
  }],
  "targets": [
    { "backend": "vibe", "model": "glm-5-3", "options": { "thinking": "high" }, "label": "GLM-5.3 hoch" },
    { "backend": "vibe", "model": "mistral-large-4" },
    { "backend": "vibe", "model": "cortecs-kimi-k2-7-code" },
    { "backend": "claude" }
  ]
}
```

- **Ziele:** `backend` ist ein Agent aus *Einstellungen → Agenten* (`vibe`, `claude`,
  `codex`, `gemini`). `model` ist der Wert der Session-Option „Modell“, so wie ihn die
  Modellauswahl zeigt (Vibe-Alias wie `glm-5-3`, Cortecs-Modelle als `cortecs-…`). Fehlt
  er, gilt der Standard des Agenten. `options` setzt weitere Session-Optionen, etwa die
  Denkstufe `thinking`. Kennt der Agent den Wert nicht, steht das als Fehler im Ergebnis,
  zusammen mit den Werten, die er kennt.
- **Prüfungen:** Eine Aufgabe ist bestanden, wenn alle Prüfungen bestehen. Der Score ist
  der Mittelwert, beim Richter zählen dessen Punkte (0–10). `regex` und `contains` prüfen
  die Textantwort des Agenten. `command` läuft im Arbeitsordner über `sh -c` bzw.
  `cmd /C` und muss mit Code 0 enden. `file` prüft eine Datei im Arbeitsordner. `judge`
  lässt ein Richtermodell Aufgabe, Kriterien und Antwort bewerten (Mistral-Modell-ID
  oder `cortecs/<modell>`, Standard Mistral Small). Den Diff sieht es nicht: Für Code
  nimmt man `command`.

**Lauf:** „Starten“ führt jede Aufgabe gegen jedes Ziel aus, eine Kombination nach der
anderen, im Hintergrund (Event `bench:progress`, ein Lauf zur Zeit, „Abbrechen“ möglich):

1. Arbeitsordner `<Datenordner>/benchmarks/work/<lauf>/<aufgabe>--<ziel>`: mit `ref` ein
   `git clone` des Projekts, auf den Ref ausgecheckt. Ohne `ref` eine Kopie des
   Arbeitsstands, ohne `.git` und ohne alles, was `.gitignore` ausschließt. Ohne Projekt
   ist der Ordner leer. Danach schreibt Brise `files` und führt `setup` aus. Das echte
   Projekt wird nur gelesen.
2. Eine frische Session des Agenten in diesem Ordner, ohne semantische Suche. Wenn der
   Agent es kann, läuft sie im Modus „Alles automatisch“. Freigaben beantwortet Brise
   selbst mit „erlauben“. Die Session erscheint nicht in der Oberfläche und wird danach
   gelöscht. **Der Agent führt Befehle ohne Rückfrage aus.** Der Ordner ist nur eine
   Kopie, keine Sandbox.
3. Gemessen werden die Dauer, das erste Token (TTFT), t/s (Generierungszeit wie bei
   normalen Turns) und Tokens laut Agent. Die Kosten schätzt Brise mit der Preistabelle,
   bei Cortecs-Modellen kommen sie aus dem Cortecs-Journal. Jeder Turn landet als
   `kind: "bench"` im Nutzungsjournal, der Richter als „Benchmark: Richter“.
4. Prüfungen auswerten. Bestandene Arbeitsordner werden gelöscht, nicht bestandene
   bleiben zum Nachsehen („Arbeitsordner“ im Detail).

**Ergebnisse:** `<Datenordner>/benchmarks/runs/<id>/<lauf>.json`, einer je Lauf, mit allen
Messwerten, Prüfdetails und der Antwort (gekürzt auf 6000 Zeichen). Die Seite zeigt die
Vergleichstabelle Aufgabe × Ziel mit Summen je Ziel (bestanden, Score, Dauer, Tokens,
Kosten, Median von TTFT und t/s). Unter jeder Zelle zeigen kleine Balken dieselbe
Kombination in früheren Läufen. Darunter steht der Verlauf aller Läufe je Ziel, mit
Pfeilen für Verbesserung und Regression gegenüber dem vorigen Lauf. Die Ziele werden
über `backend:model:option=wert` zugeordnet. Ein umbenannter Anzeigename bricht den
Verlauf also nicht, ein anderes Modell beginnt einen neuen.

## Secrets (Passwörter, API-Keys, Tokens)

Secrets gibt man in Brise in ein eigenes, maskiertes Feld ein, nie in den Chat.
Das Modell sieht nur einen Platzhalter wie `{{secret:GITHUB_TOKEN}}`.

- **Anfordern durch den Agenten:** Der MCP-Server `brise-app` hat das Werkzeug
  `request_secret(name, purpose, scope)`. Brise zeigt dafür statt des Composers
  eine Karte mit Zweck, maskiertem Feld und Gültigkeit: *nur diese Session*
  (gelöscht beim nächsten Start von Brise), *dieses Projekt* oder *dauerhaft*.
  Der Agent bekommt danach nur den Platzhalter zurück. Antwortet man nicht
  innerhalb von 50 s, ruft der Agent das Werkzeug erneut auf und wartet weiter
  (Vibe bricht MCP-Werkzeuge nach 60 s ab).
- **Selbst anlegen:** Schlüssel-Knopf im Composer (fügt den Platzhalter an der
  Cursorposition ein) oder Einstellungen → Freigaben & Sicherheit → Secrets. Dort
  stehen alle Secrets mit Namen und Gültigkeit, ohne Wert. Man kann sie löschen
  oder die Gültigkeit ändern.
- **Versehentlich eingetippt:** Vor jedem Senden prüft Brise den Text lokal
  mit den Schlüsselmustern aus `sensitive.rs` (GitHub-/Slack-/AWS-/Google-Token,
  `sk-…`, JWT, private Schlüssel, `password=…`, Verbindungs-URLs mit Passwort).
  Bei einem Treffer bietet Brise an, den Wert als Secret zu speichern und im Text
  durch den Platzhalter zu ersetzen. Diese Prüfung läuft vor der Cortecs-Prüfung,
  der Wert geht also auch nicht an das Decision-Modell.
- **Benutzen:** `run_with_secrets(command, env?)` führt einen Shell-Befehl aus.
  Platzhalter im Befehl werden zu Verweisen auf Umgebungsvariablen
  (`"${BRISE_SECRET_NAME}"`, passend zum Quoting), der Wert steht also nicht in
  der Befehlszeile. `env` setzt eigene Variablen, z. B.
  `{"GH_TOKEN": "{{secret:GITHUB_TOKEN}}"}`. `http_request_with_secrets(method,
  url, headers, body)` setzt Platzhalter in URL, Header und Body ein. Beide
  schwärzen ihre Ausgabe, bevor sie ans Modell geht: der Wert selbst sowie seine
  base64-, hex-, URL- und JSON-Form werden durch den Platzhalter ersetzt. Werte
  unter vier Zeichen werden nicht geschwärzt. `list_secrets` nennt die verfügbaren
  Namen. Bei gleichem Namen gilt: Session vor Projekt vor dauerhaft.

**Ablage:** Werte liegen nur im System-Schlüsselbund (Secret Service/GNOME
Keyring bzw. KWallet unter Linux, macOS-Schlüsselbund, Windows-Anmeldeinformationen),
Dienst `dev.brise.secrets`. Ohne Schlüsselbund speichert Brise keine Secrets, es
gibt keine Datei als Ausweichlösung. In `<Datenordner>/secrets/` liegen nur Namen,
Gültigkeit, Zweck und offene Anfragen (`index.json`, `requests/`). Den Wert trägt
die Oberfläche über einen Tauri-Befehl direkt in den Schlüsselbund ein. Er erscheint
nicht im ACP-Verkehr (`BRISE_ACP_TRACE`), nicht im Session-Verlauf von Vibe, nicht
im Nutzungsjournal und nicht in Logs.

**Wie weit der Schutz reicht:**

- Der Schlüsselbund schützt gegen **andere Nutzer** am Rechner und **offline**
  (gestohlene Platte, Backup): Die Werte sind mit dem Login verschlüsselt.
- Gegen **Prozesse desselben Nutzers** schützt er je nach System nur begrenzt.
  Unter Linux kann jedes Programm der eigenen Sitzung den entsperrten Secret
  Service auslesen, z. B. mit `secret-tool lookup service dev.brise.secrets …`.
  Das gilt auch für Shell-Befehle, die der Agent über sein normales
  Shell-Werkzeug ausführt. macOS fragt bei fremden Programmen nach, Windows nicht.
- Ein Befehl, den `run_with_secrets` startet, hat den Wert in seiner Umgebung.
  Er kann ihn weitergeben, in Dateien schreiben oder an einen beliebigen Server
  schicken. Gleiches gilt für die URL bei `http_request_with_secrets`. Beide
  Werkzeuge laufen über Vibes normale Freigabe, also vorher Befehl bzw. URL ansehen.
  Mit „Alle Freigaben überspringen“ (`bypass_tool_permissions`) entfällt diese
  Rückfrage, und der Agent kann ein Secret ohne Rückfrage benutzen.
- Das Schwärzen erkennt nur exakte Werte und die genannten Kodierungen. Ein
  Befehl, der den Wert umgedreht, gekürzt, zeichenweise oder verschlüsselt
  ausgibt, kommt ungeschwärzt durch. Schwärzen ist also eine Absicherung gegen
  Versehen, keine Schranke gegen einen Agenten, der den Wert absichtlich
  herausholen will.
- Der lokale Vorfilter im Composer erkennt bekannte Schlüsselformate, aber nicht
  jedes Passwort. Freier Text ohne Muster (etwa „mein Passwort ist sommer2026“)
  geht unerkannt durch.

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
  gauntlet-loop, frontend-design, webapp-testing, mcp-builder, skill-creator und design-mode mit.
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

## Oberfläche

- **Projekte und Sessions:** In der Sidebar stehen die Sessions aller Projekte, die
  die verbundenen Agenten kennen (`session/list` ohne Ordner), gruppiert und filterbar. Neue Session pro
  Projekt, laufende Sessions mit Spinner, wartende mit gelbem Punkt. Löschen über
  `_session/delete`.
- **Konversation:** Markdown mit Code-Highlighting und Kopier-Knopf. Werkzeugaufrufe
  werden wie in Claude Code gruppiert („2 Dateien gelesen · 1 Befehl“), Diffs mit
  Zeilennummern bleiben immer sichtbar, der Gedankengang lässt sich aufklappen. Unter
  jedem Turn stehen Dauer und Tokens.
- **Subagents:** eigene Karten mit Agent, Aufgabe, Schritten und Ergebnis. Der
  Verlauf des Subagenten lässt sich öffnen (nur lesbar).
- **Composer:** `@` für Dateien (Fuzzy-Suche, beachtet .gitignore), `/` für die
  Befehle des Agenten, Anhänge per Knopf oder Drag & Drop (Bilder gehen als Bild an das
  Modell), Freigabe-Modus, Modell und Denkstufe als Auswahl, Kontext-Ring.
- **Freigaben:** erscheinen über dem Eingabefeld, mit Befehlsmuster („python3 *“).
  „Immer erlauben“ gibt es nur mit Muster, Passwörter im Befehl werden maskiert.
- **Aufgabenliste:** der Plan des Agenten als Leiste mit Fortschritt über dem Eingabefeld.
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
- **Leistung (Nutzung → Statistik):** Jeder Turn und jeder Hilfsaufruf (Einstufung,
  Council, Codestral, OCR, Cortecs) bekommt Dauer, Zeit bis zum ersten Token und t/s.
  Die Statistik zeigt Median und p90 je Modell und Verlauf für den gewählten Zeitraum;
  unter jedem Turn steht „erstes Token nach … · … t/s“.
- Hell- und Dunkelmodus, einstellbare Schriftgröße, Benachrichtigung, wenn eine
  Session im Hintergrund fertig wird.

Beim Öffnen eines Projekts legt Brise im Hintergrund schon eine leere Session an.
So stehen Modell und Denkstufe vor dem ersten Prompt bereit. Vibe speichert
Sessions erst nach dem ersten Turn, leere tauchen also nirgends auf.

## Design-Modus

Umschalter „Code | Design“ in der Seitenleiste. Im Design-Modus stehen statt der Projekte
die Designs; links chattet man mit dem Agenten, rechts läuft die Live-Vorschau.

- **Arbeitsordner:** jedes Design liegt in `<Datenordner>/design/d-…/` (`index.html` oder
  `App.jsx`, `variants/<a|b…>/`, `notes.md`, `tokens.css`/`tokens.json`, Versionen unter
  `.versions/`). Die Session dazu ist eine normale Vibe-Session mit diesem Ordner als `cwd`
  im Modus „Edits automatisch“. Sie taucht nicht bei den Projekten auf.
- **Skill `design-mode`:** gibt Arbeitsweise, Dateiformat, Token-Regeln, Varianten und den
  Aufbau von `notes.md` vor. Die erste Nachricht nennt Ordner und Design-System.
- **Vorschau:** isoliertes iframe (`sandbox="allow-scripts"`, kein Zugriff auf Brise).
  Brise bettet relative CSS-/JS-/Bilddateien ein und lädt die Tokens als CSS-Variablen.
  `App.jsx` läuft mit React 19 (esm.sh), Tailwind-CDN und Babel. Mobil/Tablet/Desktop,
  Hell/Dunkel (`data-theme="dark"` und Klasse `dark`), Laufzeitfehler mit „Beheben lassen“.
  Jede abgeschlossene Dateiänderung des Agenten lädt die Vorschau neu.
- **Iterieren:** 1–4 Varianten pro Nachricht, Vergleich nebeneinander, „Übernehmen“ macht
  eine Variante zum Hauptdesign. Nach jedem Turn mit Änderungen entsteht eine Version;
  ältere lassen sich neben der aktuellen ansehen und wiederherstellen. Mit dem
  Auswahlwerkzeug ein Element anklicken – Selektor und HTML gehen mit der nächsten
  Nachricht mit. Bilder (Dialog oder Einfügen) landen in `refs/` und gehen als Bild ans Modell.
- **Design-System:** Farben (hell/dunkel), Schriften, Größen, Abstände, Radien, Schatten und
  freie Regeln, gespeichert unter `<Datenordner>/design/systems/`. „Aus Projekt übernehmen“
  liest CSS-Variablen (auch Tailwind 4 `@theme`, dunkle Werte aus `.dark`/`[data-theme=dark]`)
  und Farben aus `tailwind.config.*`. Änderungen meldet Brise dem Agenten bei der nächsten Nachricht.
- **Übergabe:** „An Session übergeben“ rendert Screenshots (Desktop, Mobil), kopiert das
  Design nach `<Projekt>/.brise/design/<name>/` (mit `.gitignore`) und startet im gewählten
  Projekt eine neue Coding-Session mit Auftrag: Dateien, Tokens, `notes.md`, Hinweise,
  Akzeptanzkriterien (aus `notes.md` plus Standardkriterien, im Dialog änderbar) und Vorgehen.
  Der Auftrag liegt zusätzlich als `handoff/AUFTRAG.md` bei.

## Selbstanpassung per Chat

Jede Session bekommt den MCP-Server `brise-app` (`brise --mcp-app`). Seine Werkzeuge:

| Werkzeug | Was es tut |
|---|---|
| `brise_get_settings` | aktuelle Einstellungen, eigenes CSS, Schnellaktionen lesen |
| `brise_set_setting` | Theme, Schriftgröße, Akzentfarbe, Sprache, Auto-Modellwahl, Modell je Stufe |
| `brise_set_custom_css` | eigenes CSS (Variablen wie `--accent`, Bereiche über `[data-brise="…"]`) |
| `brise_set_quick_actions` | eigene Karten auf der Startseite |
| `brise_set_vibe_config` | Einträge in Vibes `config.toml`, Freigaben abschalten ausgenommen |
| `request_secret`, `list_secrets`, `run_with_secrets`, `http_request_with_secrets` | Secrets anfordern und verwenden, siehe [Secrets](#secrets-passwörter-api-keys-tokens) |

Die Werkzeuge schreiben nach `<Datenordner>/custom/`. Brise beobachtet den Ordner
und übernimmt Änderungen sofort. Der mitgelieferte Skill `brise-anpassen` erklärt
dem Agenten, wann und wie er die Werkzeuge nutzt.

## Entwickeln

Voraussetzungen unter Fedora (einmalig):

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel
```

Für macOS und Windows siehe <https://tauri.app/start/prerequisites/>. Zum
Ausprobieren reicht einer der Agenten. `vibe-acp` wird im `PATH` und in `~/.local/bin`
gesucht, die übrigen im `PATH` und in `<Datenordner>/backends/`.

```bash
npm install
npm run tauri dev                 # Entwicklungsmodus mit Hot Reload
npm run tauri dev -- -- ~/projekt # direkt mit einem Projektordner starten
npm run tauri build               # Installer bauen
```

Umgebungsvariablen:

- `BRISE_ACP_TRACE=/tmp/acp.log` schreibt den gesamten ACP-Verkehr mit (weitere
  Backends in `/tmp/acp.log.<backend>`).
- `brise --self-test` prüft Vibe, ACP, alle installierten Agenten (Start, Session),
  MCP-Server, Terminal und Git. `BRISE_SELFTEST_PROMPT=1` schickt jedem Agenten
  zusätzlich einen echten Mini-Prompt, `BRISE_SELFTEST_INSTALL=claude` installiert
  den Claude-Adapter vorher, falls er fehlt.
- `VIBE_HOME=/tmp/vibe-clean` startet Vibe mit eigener, leerer Konfiguration.
  Die Anmeldung aus dem Schlüsselbund gilt weiter.

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
- Bearbeiten von MCP-Servern
- signierte Installer
