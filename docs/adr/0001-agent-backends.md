# ADR 0001 – Mehrere Agent-Backends über ACP

Status: angenommen · Datum: 26.10.2026

## Kontext

Brise war bisher fest an Mistral Vibe gebunden: ein `vibe-acp`-Prozess, alle
Sessions, Anmeldung, Sprache, Einstellungen und Modellverwaltung über ihn. Brise
soll von mehreren Leuten mit unterschiedlichen Abos genutzt werden (Claude Max,
Claude Pro, Mistral Vibe, gar nichts). Außerdem sollen Entscheidungen, die heute
ein Task-Modell (Mistral Small) trifft, später von „Cortex AI“ Decision Models
kommen können.

Brise spricht mit Vibe bereits das **Agent Client Protocol** (ACP, JSON-RPC 2.0
über stdio, eine Nachricht pro Zeile). Die Konversationsansicht, Freigaben,
Diffs, Aufgabenlisten und Tabs arbeiten ausschließlich mit ACP-Standardnachrichten
(`session/new|load|list|prompt|cancel|set_mode|set_config_option`,
`session/update`, `session/request_permission`, `fs/*`). Vibe-eigene Teile sind
Erweiterungen mit Unterstrich (`_auth/*`, `_voice/*`, `_config/schema`,
`_session/delete`) oder Dateien, die Brise direkt schreibt (`config.toml`,
Skills-Pfade, Modelle).

## Geprüfte Agenten (Stand 26.10.2026)

| Agent | ACP-Anbindung | Paket / Aufruf | Anmeldung | Bemerkungen |
|---|---|---|---|---|
| **Mistral Vibe** | nativ | `vibe-acp` (uv, `mistral-vibe`) | `_auth/*`, Browser-Login oder Key | Referenz, alle Brise-Erweiterungen |
| **Claude Code** | Adapter | `@agentclientprotocol/claude-agent-acp` 0.97 (Bin `claude-agent-acp`, Node ≥ 22) | Claude-Code-Anmeldung (`claude auth login --claudeai` für Pro/Max, `--console` für API), Umgebungsvariablen oder `~/.claude/settings.json` | Früher `@zed-industries/claude-code-acp` bzw. `@zed-industries/claude-agent-acp`, beide als *deprecated* umbenannt. Kann `session/list`, `load`, `resume`, `fork`, `delete`, `close`; Modi `default/acceptEdits/plan/auto/bypassPermissions`; Config-Optionen `mode`, `model`; meldet die Identität per `_auth/status_update` |
| **OpenAI Codex** | Adapter | `@agentclientprotocol/codex-acp` 2.3 (früher `@zed-industries/codex-acp`) | ChatGPT-Konto oder `OPENAI_API_KEY` über `codex login` | bringt `@openai/codex` als Abhängigkeit mit |
| **Gemini CLI** | nativ | `gemini --acp` (`@google/gemini-cli` 0.65; `--experimental-acp` geht weiter) | Google-Login oder `GEMINI_API_KEY` | |
| **Eigene Engine** | – | in Brise (Rust) | eigene Key-Verwaltung | müsste Werkzeuge, Freigaben, Diffs, Kontextverwaltung, Subagents, Sessions neu bauen |

Beim Nutzer geprüft: `claude-agent-acp` 0.97 startet, liefert nach `initialize`
und `session/new` Modi, Modelle und Slash-Befehle (auch die Skills aus
`~/.claude/skills`). Die CLI meldet „nicht angemeldet“, `~/.claude/settings.json`
setzt aber per `env` einen Gateway (`ANTHROPIC_BASE_URL=https://api.cortecs.ai`,
Modell `glm-5.3-flash`) samt Token. Claude Code läuft dort also über diesen
Gateway statt über das Max-Abo – das ist eine Einstellung des Nutzers, Brise
übernimmt sie unverändert.

## Entscheidung

1. **ACP bleibt die einzige Schnittstelle zu Coding-Agenten.** Jeder Agent, den
   Brise unterstützt, ist ein ACP-Agent-Prozess. Claude Code, Codex und Gemini
   kommen über ihre offiziellen ACP-Adapter bzw. den ACP-Modus. Eine eigene Engine
   wird **nicht** gebaut; wenn sie je kommt, wird auch sie als ACP-Agent
   angebunden (z. B. `brise --agent`, wie heute schon `--mcp-app`), damit die
   Oberfläche nichts davon wissen muss.
2. **Backend = Beschreibung + Prozess.** Rust führt eine Registry
   (`backends.rs`): ID, Name, wie man ihn findet/installiert, wie man die
   Anmeldung prüft, welche Brise-Erweiterungen er kann (Capabilities). `agent.rs`
   hält je Backend höchstens einen laufenden Prozess (`Agent`), Verbindungen
   entstehen bei Bedarf (erste Session dieses Backends). Jede Session gehört genau
   einem Backend; Rust merkt sich `sessionId → backend` und leitet Anfragen dorthin.
3. **Capabilities statt Sonderfälle.** Die Oberfläche fragt nur Capabilities ab:
   - `vibeExtensions`: `_auth/*`, `_voice/*`, `_config/schema`, `_session/delete`
   - `voice`, `settingsSchema`, `skills` (Brises Skill-Pfade), `models`
     (Modelle in `config.toml`), `autoModel` (Brises Auto-Modell/Denkstufe)
   - aus `initialize`: `listSessions`, `deleteSession`, `loadSession`, Bilder

   Was ein Backend nicht kann, blendet die Oberfläche aus (Mikrofon, Vorlesen,
   Auto-Modellwahl, Vibe-Einstellungen …). Standard-ACP (Modus, Modell, Freigaben,
   Diffs, Plan) funktioniert für alle.
4. **Installation über die Werkzeuge des Ökosystems:** Vibe wie bisher über uv in
   Brises Datenordner; Node-Adapter über `npm install --prefix
   <Datenordner>/backends/<id>` (Node ≥ 22 nötig), gestartet direkt mit `node`.
   Ein im PATH vorhandener Adapter hat Vorrang. PATH und Systemdateien bleiben
   unverändert.
5. **Anmeldung bleibt beim Agenten.** Brise speichert für Claude/Codex/Gemini
   keine Schlüssel. Status: für Vibe `_auth/status`, für Claude `claude auth
   status --json` plus Erkennung von Token-Variablen (nur Namen, nie Werte) in
   Umgebung und `~/.claude/settings.json` und laufend `_auth/status_update`. Die
   Anmeldung selbst startet Brise im eingebauten Terminal mit dem Befehl des
   Agenten (`claude auth login --claudeai`), so wie Zed es über `terminal-auth`
   macht.
6. **Entscheidungsschicht getrennt von den Coding-Agenten.** Aufgaben einstufen,
   Denkstufe nachsteuern, Vorschläge und Commit-Nachrichten laufen über ein
   Rust-Trait `DecisionProvider` (`decision.rs`). Heute gibt es genau eine
   Implementierung (`MistralDecisions`, Mistral Small, JSON-Modus). Jede Aufgabe
   ist als `DecisionTask` benannt, damit ein späterer Anbieter je Aufgabe ein
   eigenes Modell oder eigenes Format nutzen kann.

## Begründung

- **Wiederverwendung:** Konversation, Freigaben, Tabs, Diffs, Plan und Kontext
  sind schon ACP-basiert. Ein zweiter ACP-Agent kostet Registry + Routing, keine
  neue Oberfläche.
- **Abos der Nutzer:** Nur die offiziellen Adapter nutzen die vorhandenen
  Anmeldungen (Claude Pro/Max über Claude Code, ChatGPT über Codex). Eine eigene
  Engine dürfte diese Abos nicht verwenden und bräuchte API-Keys.
- **Aufwand und Pflege:** Werkzeuge, Sandboxing, Kontextkompression, Subagents
  pflegen Anthropic, OpenAI, Google und Mistral selbst. Eine eigene Engine wäre ein
  zweites Produkt.
- **Offen für Neues:** Alles, was ACP spricht (auch eine spätere eigene Engine
  oder ein Agent eines Freundes), passt ohne Änderung der Oberfläche.

## Folgen

- Brise ist für Vibe-Nutzer unverändert: Vibe ist Standard-Backend, Start,
  Installation und Anmeldung wie bisher.
- Freunde ohne Vibe können Claude Code als Standard-Backend wählen; der
  Startbildschirm verlangt dann kein Vibe mehr.
- Brise-eigene Mistral-Funktionen (Embeddings, OCR, Codestral, Task-Modell)
  brauchen weiter einen Mistral-Key. Ohne Key schaltet Brise auf Heuristiken
  zurück (Einstufung) bzw. die Funktion meldet den fehlenden Schlüssel.
- Die MCP-Server `brise-app`, `brise-search`, `rea` bekommen alle Backends mit
  (`mcpServers` in `session/new` ist Standard-ACP).
- Slash-Befehle, Modi und Modelle kommen vom jeweiligen Agenten, die Oberfläche
  zeigt sie generisch.

## Schnittstelle für Entscheidungsmodelle („Cortex AI“)

```rust
pub enum DecisionTask { ClassifyTask, AdjustReasoning, ProjectSuggestions, CommitMessage }

pub trait DecisionProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn available(&self) -> bool;
    /// Liefert ein JSON-Objekt nach dem in `system` beschriebenen Schema.
    fn decide<'a>(&'a self, task: DecisionTask, req: DecisionRequest<'a>) -> BoxFuture<'a, Result<Value, String>>;
}
```

`DecisionRequest` enthält Systemanweisung, Nutzertext, gewünschtes Modell
(optional) und Zeitlimit. Die fachliche Auswertung (z. B. nur `simple|standard|
complex` akzeptieren) bleibt in `assist.rs`, damit jeder Anbieter dieselben
Prüfungen durchläuft.

Für Cortex AI ist **noch nichts implementiert** – API, Modelle und Format sind
offen. Hinweis: `~/.claude/settings.json` des Nutzers zeigt auf
`api.cortecs.ai`; falls „Cortex AI“ dieser Anbieter ist, wäre er ein
OpenAI-kompatibler Endpunkt und ließe sich als zweite Implementierung
(`CortecsDecisions`) neben `MistralDecisions` einhängen, ausgewählt über die
Einstellung `decisionProvider`. Der Schlüssel gehört dann in den Schlüsselbund,
nicht in Dateien.

## Verworfen

- **Eigene Agent-Engine** (direkt gegen Anthropic/Mistral-API): hoher Aufwand,
  keine Abo-Nutzung, doppelte Pflege.
- **Claude Agent SDK direkt aus Rust/Node einbinden:** Der ACP-Adapter *ist*
  genau diese Einbindung, gepflegt vom ACP-Projekt.
- **Ein Prozess für alle Backends:** jeder Agent ist ein eigenes Programm; ein
  Multiplexer würde nur Komplexität verschieben.
