# ACP-Spike (Meilenstein 1)

Kleiner Konsolen-Client in Rust, der `vibe-acp` über das Agent Client Protocol
steuert. Er dient nur dazu, das Protokoll für die Tauri-App zu verstehen, und
ist keine Nutzer-Oberfläche.

```bash
cargo run -- --cwd /pfad/zum/projekt --mode ask --trace /tmp/acp.log
cargo run -- --prompt "Erkläre dieses Projekt" --cwd .
```

Optionen siehe `cargo run -- --help`. Mit `--trace` wird der komplette
JSON-RPC-Verkehr (`>>` gesendet, `<<` empfangen, `!!` stderr von vibe-acp)
mitgeschrieben.

Zum Testen ohne die eigene `~/.vibe/config.toml` (z. B. wenn dort
`bypass_tool_permissions = true` oder ein Fremdmodell eingestellt ist):

```bash
VIBE_HOME=/tmp/vibe-clean cargo run -- --mode ask
```

Die Anmeldung liegt im OS-Schlüsselbund und gilt auch mit eigenem `VIBE_HOME`.

## Getestet (26.10.2026, Mistral Vibe 3.0.2, Modell Mistral Medium 3.5)

| Ablauf | Ergebnis |
|---|---|
| `initialize` | ✓ Agent meldet `loadSession`, Bilder, `session/list`, `fork`, `close` |
| Auth-Status (`_auth/status`) | ✓ `authenticated: true`, Quelle `os_keyring` |
| `session/new` | ✓ liefert Modi, Config-Optionen (Modus, Modell, …), Ordner-Vertrauen |
| `session/set_mode` | ✓ `ask` aktiviert Freigaben auch für Edits |
| `session/prompt` + Streaming | ✓ Text-, Thinking-, Tool-, Diff- und Verbrauchs-Updates |
| `session/request_permission` | ✓ Einmal erlauben und Ablehnen getestet; Agent reagiert korrekt |
| `session/cancel` | ✓ Turn endet mit `stopReason: cancelled` |
| Login per Browser (`browser-auth-delegated`) | ⚠ implementiert, aber **nicht ausgeführt**: Ein Test hätte den gespeicherten Schlüssel ersetzt. Mit `--login` erzwingbar. |

## Erkenntnisse für die App

### Anmeldung über den Plan

- Der Client meldet in `initialize` unter `clientCapabilities._meta`
  `"browser-auth-delegated": true`. Dann bietet Vibe zwei Methoden an:
  - `browser-auth`: vibe-acp öffnet den Browser selbst und blockiert, bis der Login fertig ist.
  - `browser-auth-delegated`: **die richtige Methode für die GUI.**
- Ablauf der delegierten Anmeldung. Die Parameter gehören in `_meta`, nicht auf die oberste Ebene, sonst verwirft sie das Python-SDK:
  1. `authenticate {methodId: "browser-auth-delegated", _meta: {action: "start"}}`
     → `_meta["browser-auth-delegated"] = {attemptId, signInUrl, expiresAt}`
  2. App öffnet `signInUrl` im Browser und zeigt „Warte auf Anmeldung …“ mit Ablaufzeit.
  3. `authenticate {…, _meta: {action: "complete", attemptId}}` wartet, bis der Login fertig ist.
     Vibe speichert den Schlüssel dann im OS-Schlüsselbund.
- Vibe-eigene Erweiterungsmethoden (mit `_`-Präfix): `_auth/status`, `_auth/signOut`,
  `_account/read`, `_identity/read`, `_trust/status`, `_trust/decision`,
  `_session/set_title`, `_session/delete`, `_rewind/preview`, `_rewind/to`,
  `_loops/*`, `_voice/*`, `_config/schema`.
  → Damit lassen sich Kontoanzeige, Abmelden, Ordner-Vertrauen, „Zurückspulen“ und
  Einstellungen in der GUI abbilden.

### Freigaben

- `session/request_permission` schickt oft nur die `toolCallId`. Titel und Art stammen
  aus dem vorangegangenen `tool_call`-Update. Die GUI muss sich deshalb Tool-Karten nach ID merken.
- Optionen: `allow_once`, `allow_always` (für diese Session), `allow_always_permanent`
  (dauerhaft) und `reject_once`. Bei Shell-Befehlen steht unter
  `option._meta.required_permissions[].label` das Muster, das „immer erlauben“ freigibt,
  z. B. `python3 *`.
- **Sicherheitsfund:** „Always allow“ ohne Muster speichert den *vollständigen*
  Befehl in `config.toml` unter `[tools.bash] allowlist`, auch eingebettete Passwörter.
  Die GUI sollte dauerhaftes Erlauben nur mit Muster anbieten und vor Befehlen warnen,
  die nach Zugangsdaten aussehen.
- `bypass_tool_permissions = true` in der Vibe-Config schaltet alle Freigaben ab, unabhängig vom
  Modus. Die GUI sollte das sichtbar anzeigen.

### Streaming-Updates (`session/update`)

| `sessionUpdate` | Inhalt | GUI-Element |
|---|---|---|
| `agent_message_chunk` | Text-Stücke | Chat-Blase (Markdown) |
| `agent_thought_chunk` | Thinking | einklappbarer Block |
| `tool_call` / `tool_call_update` | ID, Titel, Art (`read`/`edit`/`execute` …), Status, `content` mit `diff` (`path`, `oldText`, `newText`) | Tool-Karte, Diff-Viewer |
| `plan` | Einträge mit Status | Task-Liste |
| `usage_update` | `_meta`: Tokens, Schritte, Tokens/s | Kontext-Anzeige |
| `session_info_update` | automatisch erzeugter Titel | Sidebar-Eintrag |
| `available_commands_update` | Slash-Befehle | `/`-Autovervollständigung |
| `current_mode_update` | neuer Modus | Modus-Umschalter |

`usage_update` kommt mitten im Text-Stream. Die GUI darf deshalb nicht pro Update eine neue Zeile
oder Blase anfangen.

### Sonstiges

- Vibe liest und schreibt Dateien selbst. `fs/read_text_file` / `fs/write_text_file` wurden
  trotz angebotener Fähigkeit nicht aufgerufen. Die Handler bleiben trotzdem drin.
- `ask_user_question` ist nur aktiv, wenn der Client `elicitation.form` anbietet.
  Das ist der nächste Protokollteil, den die App braucht.
- Ordner-Vertrauen: Ein frischer Ordner meldet `untrusted`, der Agent arbeitet trotzdem. Relevant
  wird es, sobald ein Projekt einen `.vibe`-Ordner mitbringt.
- Das Modell ist per `session/set_config_option` (`model`) pro Session umschaltbar.

## Nächste Schritte

1. `elicitation.form` (Rückfragen des Agenten) und `session/list` / `session/load` ausprobieren.
2. Meilenstein 2: Tauri-2-Grundgerüst. `rpc.rs` wird fast unverändert zum Backend,
   die Ausgaben von `main.rs` werden zu Tauri-Events.
