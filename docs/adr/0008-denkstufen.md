# ADR 0008 – Denkstufen: gemessen statt geraten

Stand: 27.10.2026 · Status: **umgesetzt** auf `integration`

## Anlass

Beim Standardmodell GLM-5.3 bot Brise nur „Standard | hoch“ an, obwohl das
Modell mehr kann. Ursache war Vibes Mistral-Anbindung, die Denkstufen auf zwei
Leitungswerte zusammenfaltet. Die Frage war dann: Welche Stufen kann welches
Modell wirklich – und wie kommen sie unverfälscht bei der API an?

## Messung (26./27.10.2026)

Je Modell ein Mini-Aufruf pro `reasoning_effort`-Wert und einer ohne,
direkt gegen die API (`POST /v1/chat/completions`, „Wie viel ist 17*23?“).
„denkt“ = Reasoning-Tokens laut `usage` oder ein `thinking`-Teil in der Antwort.

### Mistral (api.mistral.ai)

| Modell (Aliase gleich) | none | low | medium | high | max | ohne Angabe |
|---|---|---|---|---|---|---|
| `zai-glm-5-3` (GLM-5.3) | 400 | 200 | 400 | 200 | 200, denkt | 200, denkt |
| `zai-glm-5-3-flash` | 400 | 200 | 400 | 200 | 200, denkt | 200, denkt |
| `zai-glm-5-2` | 200 | 200, denkt | 200, denkt | 200, denkt | 200, denkt | 200 |
| `mistral-large-4` | 200 | 400 | 400 | 200, denkt | 400 | 200, denkt |
| `mistral-medium-3.5` (= `mistral-vibe-cli-latest`, Magistral Medium) | 200 | 400 | 400 | 200, denkt | 400 | 200 |
| `mistral-small-latest` (Magistral Small) | 200 | 400 | 400 | 200, denkt | 400 | 200 |
| `codestral-latest` | 400 | 400 | 400 | 400 | 400 | 200 |
| `ministral-14b/8b/3b` | 400 | 400 | 400 | 400 | 400 | 200 |
| `mistral-large-latest` (Large 3, 2512) | 400 | 400 | 400 | 400 | 400 | 200 |
| `labs-leanstral-1-5` | 403 (Labs-Modell, im Konto nicht freigeschaltet) | | | | | |

Devstral steht nicht mehr im Katalog. Bei GLM-5.3 und Flash kam für die kleine
Aufgabe bei low/high kein Reasoning heraus, bei max und ohne Angabe schon.

### Cortecs (api.cortecs.ai, mit `allow_zero_data_retention`)

| Modell | none | low | medium | high | max | ohne Angabe |
|---|---|---|---|---|---|---|
| `glm-5.3` | 200 | 200, denkt | 200, denkt | 200, denkt | 200, denkt | 200, denkt |
| `kimi-k2.7-code` | 200 | 200, denkt | 200, denkt | 200, denkt | 200, denkt | 200, denkt |
| `qwen3.8-27b` | 200 | 200, denkt | 200, denkt | 200, denkt | 200, denkt | 200, denkt |
| `mistral-medium-3.5` | 200 | 200, denkt | 200, denkt | 200, denkt | 200, denkt | 200 |

### Was Vibe 3.0.x tatsächlich schickt

Mitgeschnitten mit einem lokalen Server als `api_base`:

| Stufe in Vibe | Mistral-Anbindung (`backend = "mistral"`) | generische Anbindung |
|---|---|---|
| off („Standard“) | kein Wert | kein Wert |
| low („niedrig“) | `none` | `low` |
| medium („mittel“) | `high` | `medium` |
| high („hoch“) | `high` | `high` |
| max („maximal“) | `high` | `max` |

Über die Mistral-Anbindung sind low, medium und max also nicht erreichbar. Die
generische Anbindung reicht die Stufe roh durch, versteht aber Mistrals
Gedankengang-Format nicht (`content` als Liste mit `thinking`-Teilen) und
schickt frühere Gedankengänge als `reasoning_content` zurück – das lehnt
Mistral mit HTTP 422 ab.

## Entscheidung

1. **Tabelle als Quelle der Wahrheit:** `app/src-tauri/src/thinking.rs`
   (`MEASURED`). Daraus leitet Brise die Stufen je Modell ab:
   - Kann ein Mistral-Modell low, medium oder max, läuft es über den Proxy mit
     „off“ plus allen angenommenen Werten. GLM-5.3: Standard, niedrig, hoch,
     maximal. GLM-5.2: alle fünf.
   - Sonst bleibt es bei Vibes Mistral-Anbindung: „off“, „low“ (= `none`, nur
     wenn das Modell ohne Angabe denkt, sonst wäre es ein zweites „Standard“)
     und „high“, falls angenommen. Large 4: Standard, niedrig, hoch.
     Medium 3.5 und Small: Standard, hoch. Codestral, Ministral, Large 3: nur Standard.
   - Cortecs (generisch): „off“ plus alle angenommenen Werte außer `none`.
2. **Proxy:** `app/src-tauri/src/mistral_proxy.rs`, Pfad `/mistral/v1/chat/completions`
   im vorhandenen lokalen Proxy (cortecs.rs). Er reicht `reasoning_effort`
   unverändert weiter, setzt `reasoning_content` im Verlauf in einen
   `thinking`-Teil um (wie Vibes Mistral-Anbindung) und in der Antwort
   (Stream und ganz) die `thinking`-Teile in `reasoning_content`. So zeigt
   Brise den Gedankengang wie bisher.
3. **Nur für Brises Vibe-Prozesse:** Beim Start von `vibe-acp` ergänzt Brise
   `VIBE_PROVIDERS` (Anbieter `brise-mistral`, `backend = "generic"`) und
   `VIBE_MODELS` (vollständige Kopien der betroffenen Einträge aus config.toml
   mit den gemessenen Stufen; Vibe merged per Alias, Teil-Einträge verwirft es).
   config.toml bleibt dafür unverändert – die Vibe-CLI ohne laufendes Brise
   nutzt GLM weiter direkt mit „Standard“ und „hoch“. Wie bisher passt Brise
   in config.toml nur die Stufen von GLM- und Large-4-Einträgen an das an,
   was Vibes Mistral-Anbindung richtig schickt.
4. **Schlüssel:** Vibe liest ihn wie bisher selbst (Umgebung, `.env`,
   Schlüsselbund) und schickt ihn mit; `brise-mistral` nutzt dieselbe
   Variable wie der Mistral-Anbieter, weitere Accounts (ADR 0002) behalten
   ihre eigene. Der Proxy reicht ihn nur an api.mistral.ai weiter und nimmt
   nur `POST …/chat/completions` für umgeleitete Modelle an. Kein Schlüssel
   in config.toml oder in der Umgebung.
5. **Verbrauch:** Vibe meldet die Tokens weiter per ACP (`usage_update`),
   usage.rs bucht den Turn unter dem gewohnten Alias. Der Proxy bucht nichts –
   sonst zählte er doppelt.
6. **Neue Modelle:** Beim Start misst Brise im Hintergrund Mistral- und
   Cortecs-Modelle aus config.toml, die nicht in der Tabelle stehen (sechs
   Mini-Aufrufe je Modell), und speichert das Ergebnis in
   `<Datenordner>/thinking-levels.json`. Es gilt ab dem nächsten Start von Vibe.
7. **Andere Agenten** (Claude Code, Codex, Gemini) liefern ihre Stufen selbst
   über ACP `configOptions`. Brise übernimmt die Liste unverändert, nach einem
   Modellwechsel die neue aus der Antwort von `set_config_option` (seit
   dfffdb1) bzw. aus `config_option_update`.

Oberfläche: Die Labels („Standard, niedrig, mittel, hoch, maximal“) und die
Auto-Denkstufe (`LEVEL_TO_THINKING`: einfach → niedrig, normal → hoch,
komplex → maximal, sonst die nächste verfügbare) arbeiten auf der Liste, die
Vibe liefert – sie zeigen damit je Modell genau die gemessenen Stufen.

## Grenzen

- Die Tabelle ist ein Stand. Ändert Mistral die angenommenen Werte, misst Brise
  bekannte Modelle nicht von selbst neu; dann die Tabelle aktualisieren.
- Bei Large 4 bedeutet „niedrig“ `none` (keine Denkphase); feiner geht es dort nicht.
- Der Proxy hängt an Brise: Wird Brise beendet, verlieren laufende
  Vibe-Prozesse den Weg – sie enden aber ohnehin mit Brise.
