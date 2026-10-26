# ADR 0005 – Team-Workspaces: Admins, Richtlinien und Verwaltung

Stand: 26.10.2026 · Status: **Teil 1 umgesetzt**, Teil 2 teilweise (siehe Fahrplan)

## Anlass

Brise-Teams (siehe `docs/collab-protocol.md`) kennen bisher nur Präsenz,
geteilte Sessions und eine gemeinsame Projektliste. Jeder mit dem Einladungslink
ist gleichberechtigt. Für einen kleinen Workspace – der Nutzer mit Claude Max
und Mistral Vibe, ein Freund mit Claude Pro, ein Freund ohne KI-Abo, der über
das Abo des Nutzers arbeitet – fehlt:

- jemand, der festlegt, was Mitglieder dürfen (Modelle, Freigabe-Modus, Budget …),
- eine Mitgliederverwaltung (Rollen, entfernen),
- ein Überblick, wer wie viel vom geteilten Abo verbraucht,
- eine Nachvollziehbarkeit der Admin-Änderungen.

## Entscheidung

### Vertrauensanker: der Besitzer im Einladungslink

Der Team-Schlüssel ist symmetrisch; jeder mit dem Link kann Nachrichten
verschlüsseln und mit **seiner** Identität signieren. Admin-Rechte dürfen sich
deshalb nicht aus dem Schlüssel ergeben. Wer ein Team anlegt, wird **Besitzer**
(`owner`); seine Ed25519-ID steht im Einladungslink:

```
brise://team/<id>?relay=<url>&name=<name>&owner=<ed25519-id>#<schlüssel>
```

Teams aus der Zeit vor diesem ADR haben keinen Besitzer. Wer so ein Team
angelegt hat, kann es in den Team-Einstellungen „übernehmen“; danach gilt der
neue Link (mit `owner`), alte Mitglieder treten mit ihm erneut bei.

### Team-Stand: ein signiertes Dokument

Rollen, Richtlinien, entfernte Mitglieder und das Audit-Log stehen in **einem**
Dokument, dem Team-Stand:

```json
{
  "team": "<team-id>", "version": 1730000000123,
  "owner": "<id>", "admins": ["<id>", …],
  "members": { "<id>": { "name": "Anna" } },
  "removed": ["<id>", …],
  "defaultPolicy": { … }, "policies": { "<id>": { … } },
  "audit": [ { "at": …, "by": "<id>", "byName": "Max", "action": "policy", "detail": "…" } ]
}
```

Es wird unabhängig vom Frame signiert:

```
doc = { "by": <ed25519-id>, "sig": <signatur>, "body": <Team-Stand als JSON-String> }
sig = Ed25519(by, "brise-team-v1:" + team + ":" + body)
```

Damit kann **jedes** Mitglied den zuletzt bekannten Stand an Nachzügler
weiterreichen (Nachricht `t: "state"`), auch wenn kein Admin online ist. Ein
Empfänger übernimmt einen Stand nur, wenn

1. die Signatur stimmt und `body.team` die eigene Team-ID ist,
2. `by` der Besitzer ist oder im **bisher gültigen** Stand Admin war,
3. `body.owner` dem Besitzer aus dem Link entspricht,
4. `version` größer ist als die bekannte,
5. ein Nicht-Besitzer keinen bisherigen Admin absetzt (nur der Besitzer darf
   Admins entfernen; Admins dürfen weitere Admins ernennen).

Konkurrierende Änderungen zweier Admins: die höhere Version gewinnt (Version =
Zeit in ms, mindestens alte Version + 1). Das Audit-Log ist Teil des signierten
Dokuments und damit gegenüber Nicht-Admins fälschungssicher; es behält die
letzten 200 Einträge.

Der Stand liegt beim Mitglied in `<Datenordner>/teams/<team-id>.json` (nur
öffentliche Daten, keine Schlüssel) und wird beim Lesen erneut geprüft. Auch
Brises MCP-Prozess (`brise --mcp-app`), über den Vibe Einstellungen ändern kann,
liest ihn von dort.

### Richtlinie

Richtlinien gelten für Mitglieder, die nicht Admin sind. Ein Admin legt eine
**Standard-Richtlinie** fest und kann sie für einzelne Mitglieder ersetzen.

| Feld | Bedeutung | Durchgesetzt in |
|---|---|---|
| `sections` | je Einstellungsbereich `hidden`, `read` oder `edit` (Standard) | Oberfläche (ausblenden, „vom Admin verwaltet“) und alle Commands, die den Bereich ändern |
| `backends` | erlaubte Agent-Backends (`vibe`, `claude`, `codex`, `gemini`), leer = alle | `agent_connect`, `new_session`, `install_backend`, `prompt` |
| `models` | erlaubte Modelle (Alias bzw. ID), leer = alle | `set_config_option(model)`, `write_config_value(active_model)`, `prompt` |
| `requireZdr` | Prompts nur über Cortecs-Modelle (ZDR) | `prompt`, Cortecs-Einstellungen |
| `euNative`, `secrecy203` | Cortecs-Routing fest vorgeben | `cortecs_save_settings`, ZDR-Proxy |
| `modes` | erlaubte Freigabe-Modi, leer = alle | `set_mode`, `prompt`, `default_agent` |
| `noAutoEdits` | keine automatischen Edits: kein „Edits automatisch“, „Smart“, „Alles automatisch“, kein Überspringen der Freigaben | wie `modes`, außerdem `bypass_tool_permissions`, `enable_auto_approve` |
| `dailyEur`, `monthlyEur` | Budget aus dem Nutzungsjournal (Tag/Monat in UTC) | `prompt` |
| `webSearch` | `true`/`false` erzwingt Websuche an/aus | Vibe-Konfiguration (`tools.web_search/web_fetch.permission`), Bereich „Websuche“ |
| `mcpServers` | erlaubte MCP-Server (Name), leer = alle | andere werden beim Anwenden deaktiviert; `write_config_value(mcp_servers)`, `enable_mcp` |
| `skills` | erlaubte Skills, leer = alle | andere landen beim Anwenden in `disabled_skills`; Änderungen daran werden geprüft |
| `sharedDailyPrompts`, `sharedDailyTokens` | Tageslimit dieses Mitglieds auf geteilten Abos | beim **Host** (echte Durchsetzung) |

Gehören mehrere Teams zusammen, gilt die strengste Kombination (Bereiche:
niedrigste Stufe, Listen: Schnittmenge, Budgets: Minimum, Pflichten: oder).

Die Prüfung liegt zentral in `app/src-tauri/src/policy.rs`; Commands rufen
`policy::check_*` auf. Fest vorgegebene Werte schreibt `policy::apply` beim Start
und bei jedem neuen Team-Stand in Vibes `config.toml` (z. B. Websuche `never`,
`default_agent = "ask"` statt eines verbotenen Modus). Die Oberfläche fragt
`policy_effective` ab und bekommt Änderungen über das Event `policy:changed`.

Bereiche und ihre Commands: `account` (Konten, API-Key, Abmelden), `backends`
(Installieren), `models` (Modelle, `active_model`, Auto-Wahl), `permissions`
(Freigaben, Allowlist), `cortecs`, `usage` (Budget, Preise; gezeigte Warnstufen
werden weiter gebucht), `bench`, `web`, `tools`, `skills`, `voice`, `agents`,
`advanced` (alle übrigen Schlüssel der `config.toml`), `collab` (Team anlegen,
beitreten, verlassen). Oberflächen-Einstellungen (Design, Sprache …) liegen im
Speicher der Oberfläche; gesperrte Schlüssel übernimmt `setPrefs` nicht, und die
MCP-Selbstanpassung (`brise_set_setting`) prüft denselben Bereich.

### Ehrliche Grenzen

Brise läuft auf dem Rechner des Mitglieds. Wer dort Administrator ist, kann
Brise verändern, den Datenordner löschen, die Vibe-Konfiguration von Hand
bearbeiten oder Vibe ohne Brise starten. **Lokale Richtlinien sind deshalb eine
Leitplanke für ehrliche Nutzer, keine Sicherheitsgrenze.** Sie verhindern
versehentliche Fehlbedienung und machen Regeln sichtbar.

Echt durchgesetzt wird nur, was der Admin selbst bereitstellt:

- **Geteiltes Abo:** Gast-Prompts laufen beim Host. Der Host prüft Rolle,
  Session-Regeln und die Team-Limits je Mitglied (`sharedDaily*`), bevor er
  einen Prompt annimmt. Ein manipuliertes Brise beim Gast ändert daran nichts.
- **Relay:** Entfernte Mitglieder werden vom Host nicht mehr als Team erkannt
  und bekommen keine Team-Rolle. Bis zur Schlüsselrotation (Fahrplan) können
  sie den Team-Raum aber weiter mitlesen.

## Fahrplan Teil 2

Priorisiert nach Nutzen für den Drei-Personen-Workspace:

1. **Mitgliederverwaltung (umgesetzt):** Rollen (Admin/Mitglied), Entfernen,
   Einladen über den Link, Übersicht online/offline. Entfernte Mitglieder sehen
   den Hinweis und verlassen das Team.
2. **Audit-Log (umgesetzt):** jede Änderung am Team-Stand mit Zeit, Admin und
   Beschreibung, signiert im Team-Stand.
3. **Team-Nutzung (umgesetzt):** Der Host führt Buch über Prompts und Tokens
   je Mitglied auf seinem Abo (`<Datenordner>/team-usage.json`, je Tag); der Admin
   sieht heute/Monat je Mitglied neben den Limits.
4. **Schlüsselrotation beim Entfernen (geplant):** Der Admin erzeugt einen neuen
   Team-Schlüssel und schickt ihn jedem verbleibenden Mitglied einzeln
   verschlüsselt (X25519 aus den Ed25519-IDs, `crypto_box`). Neuer Raum-Name, damit
   der alte Puffer nutzlos wird.
5. **Gemeinsame Skills, Prompts und Benchmarks (geplant):** wie die Projektliste
   als „neuester Stand gewinnt“-Listen im Team-Raum; Skills als Dateien (Name,
   Inhalt, Hash), die Brise in `~/.vibe/skills/team-<id>/` ablegt. Nur Admins
   veröffentlichen, damit die Liste mit dem Team-Stand signiert ist. Benchmarks
   über `bench.rs` (Export/Import der Suite-JSON).
6. **Team-Server im Homelab (optional, geplant):** ein zweites Binary in
   `relay/` (`brise-team`), das einen Team-Raum als „stummes Mitglied“ verbindet,
   den zuletzt gültigen Team-Stand und die gemeinsamen Listen **verschlüsselt**
   auf Platte hält und an Nachzügler ausliefert. Es bekommt keinen Team-Schlüssel:
   es speichert nur Chiffretext-Frames der Admins (Puffer ohne Ablauf je Raum).
   Damit bleibt die Ende-zu-Ende-Verschlüsselung erhalten, und Richtlinien kommen
   auch an, wenn kein Admin online ist. Deploy wie das Relay über
   `relay/deploy/compose.yaml` und Caddy.
7. **Einladungen mit Bestätigung (geplant):** Einmal-Einladungen, die ein Admin
   bestätigt, bevor das neue Mitglied im Team-Stand auftaucht.

## Test mit zwei Instanzen

Zwei Brise-Debug-Builds mit eigenem `BRISE_DATA_DIR`, `VIBE_HOME` und
`XDG_DATA_HOME`, ein lokales `brise-relay`, gesteuert per WebDriver
(`tauri-driver`, Xvfb). Ergebnis am 26.10.2026:

- A legt das Team über die Oberfläche an, B tritt per Link bei; der Team-Stand
  kommt bei B an und übersteht einen Neustart beider Instanzen.
- A setzt im Richtlinien-Editor u. a. Freigaben/Modelle/Nutzung „Lesen“,
  Websuche/Konto „Aus“, nur `devstral-small`, keine automatischen Edits, 0,50 €/Tag,
  Websuche aus. Bei B steht sofort `tools.web_search/web_fetch.permission = "never"`,
  `bypass_tool_permissions = false`, `default_agent = "ask"` in der `config.toml`.
- B: ausgeblendete Bereiche fehlen in der Navigation, gesperrte zeigen
  „Vom Admin verwaltet“ und deaktivierte Schalter. Direkte Command-Aufrufe
  (`write_config_value` für Freigaben, Websuche, Modell, Modus; `add_model`;
  `set_mode auto-approve`; `set_config_option model`; `prompt`) und die
  MCP-Selbstanpassung werden mit „POLICY: …“ abgelehnt; freie Bereiche bleiben
  änderbar; ein gesetztes Budget in „Nutzung“ bleibt unverändert.
- Admin ernennen/entziehen, eigene Richtlinie je Mitglied, Verlassen bei
  gesperrter „Zusammenarbeit“ abgelehnt, Mitglied kann den Stand nicht ändern,
  Admin kann den Besitzer nicht entfernen, Entfernen wirkt bei B sofort; alles
  steht im Audit-Log.

Nicht getestet (weder im Zwei-Instanzen-Test noch als Unit-Test): die Team-Limits auf
geteilten Abos beim Host.

## Folgen

- Neue Teams haben immer einen Besitzer; Links ohne `owner` bleiben gültig,
  haben aber keine Admin-Funktionen, bis der Ersteller das Team übernimmt.
- Das Protokoll bekommt die Nachricht `state` (siehe `docs/collab-protocol.md`).
- Tests: `policy.rs` (Zusammenführen, Prüfungen), `collab/team.rs` (Signatur,
  Admin-Kette, Absetzen nur durch Besitzer).
