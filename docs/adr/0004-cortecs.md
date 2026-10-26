# ADR 0004 – Cortecs: Modelle ohne Datenspeicherung und Decision-Modelle

Stand: 26.10.2026 · Status: **umgesetzt** auf `claude/cortecs-630557`

## Anlass

Mistral Vibe schickt Prompts an die Mistral-API. Zero Data Retention (ZDR) ist
dort nicht für alle Pläne zugesichert. Wer mit Brise an Code arbeitet, der
Kundendaten, Geschäftsgeheimnisse oder Berufsgeheimnisse berührt, braucht
einen Weg, solche Prompts nur an Modelle ohne Datenspeicherung zu schicken – und
einen Hinweis, *bevor* es passiert.

[Cortecs](https://cortecs.ai) ist ein europäischer LLM-Router (Cortecs GmbH, Wien)
mit OpenAI-/Anthropic-kompatiblen Endpunkten, EU-Routing, ZDR pro Anfrage
und einer Decisions-API (Beta), die typisierte Fragen mit Wahrscheinlichkeiten
beantwortet.

## Was Cortecs bietet (geprüft am 26.10.2026)

Quelle: docs.cortecs.ai (Decisions, ZDR, Data Governance, Sovereign Cloud,
Professional Secrecy Agreement, Chat Completions, Models, Prompt Caching,
Management API) und Tests mit einem echten Schlüssel.

- **ZDR pro Anfrage:** `allow_zero_data_retention: true` im Body. Cortecs routet
  dann nur zu Anbietern mit 0 Tagen Speicherung (alle außer Microsoft/Azure, 30
  Tage). Getestet: `gpt-5-nano` (nur Azure) mit ZDR → `404 No endpoint passed
  allowed_providers_filter`. Training mit Kundendaten findet laut Cortecs nie statt.
- **ZDR für das ganze Projekt:** Schalter in der Konsole (Settings → Inference)
  oder `PUT /v1/manage/project-configs`. Die Management-API verlangt einen
  *Management*-Schlüssel; ein normaler API-Key bekommt `403`.
  Achtung: Ist „Allow overwrite“ aus, gelten nur die Projekt-Einstellungen –
  Felder aus der Anfrage werden ignoriert.
- **`eu_native`:** nur Anbieter mit Sitz und Aufsicht in der EU.
- **§ 203 StGB:** nur mit unterschriebenem *Professional Secrecy Addendum* und
  `allowed_providers` aus der freigegebenen Liste (amazon_ireland, amazon_paris,
  ionos, ovh, aki, infercom, google, berget, tensorix). Die Einschränkung allein
  reicht nicht.
- **Kosten:** jede Antwort enthält `usage.cost` in Credits (1 € = 1 000 000).
- **Modellkatalog** `GET /v1/models` ist öffentlich (auch ohne oder mit falschem
  Schlüssel `200`), Filter `allow_zero_data_retention`, `eu_native`, `tag`.
  107 Modelle, davon 90 mit ZDR.
- **Decision-Modelle** (Tag „Decision“): `laya` und `clef-flash` (Berget, 0,042 €
  je Mio. Eingabe-Tokens), `clef` (sference, 0,22 €). Ausgabe kostet nichts.
  Alle bei ZDR-Anbietern.
- **Presets** (`@alias`) bilden nur einen Namen auf ein Modell ab, ohne
  Routing-Einstellungen.

## Entscheidung 1: ZDR für Vibe über einen lokalen Proxy

Vibe (3.0.2) kennt pro Anbieter `api_base`, `api_key_env_var`, `api_style`,
`backend` und `extra_headers`, aber **keine zusätzlichen Body-Felder**. Geprüft:

| Weg | Ergebnis |
|---|---|
| Body-Feld `allow_zero_data_retention` | Vibe kann es nicht senden |
| HTTP-Header (`extra_headers`) | Cortecs dokumentiert keinen Header für Routing |
| Modell-Preset `@alias` | nur Name → Modell, keine Routing-Regeln |
| Projekt-Einstellung (Konsole / Management-API) | wirkt, braucht aber Admin bzw. Management-Key und gilt fürs ganze Projekt |
| **Lokaler Proxy in Brise** | **gewählt** |

Brise startet beim Start einen kleinen HTTP-Proxy auf `127.0.0.1:47318` (belegt →
freier Port, `api_base` wird nachgezogen). Vibes Anbieter `cortecs` zeigt mit
`api_base = "http://127.0.0.1:<port>/v1"` darauf. Der Proxy

- setzt in **jede** JSON-Anfrage `allow_zero_data_retention: true` (überschreibt
  ein `false`), bei Bedarf `eu_native: true` und die § 203-Anbieterliste,
- lehnt alles ab, was kein JSON-Objekt ist (sonst wäre ZDR nicht erzwingbar),
- reicht nur `/v1/…` weiter, nie `/manage/…`,
- kennt den Schlüssel nicht: Vibe liest `CORTECS_API_KEY` aus der Umgebung
  (Brise setzt sie beim Start von `vibe-acp` aus dem Schlüsselbund) und schickt
  ihn als Bearer-Token. Andere lokale Programme gewinnen über den Proxy nichts,
- liest Streams mit und schreibt Tokens und Kosten ins Nutzungsjournal.

Läuft Brise nicht (z. B. Vibe-CLI allein), scheitern Cortecs-Modelle mit einem
Verbindungsfehler. Es geht nie etwas ohne ZDR hinaus („fail closed“).

**Empfehlung zusätzlich:** In der Cortecs-Konsole ZDR für das Projekt
einschalten. Dann gilt ZDR auch für Schlüssel, die außerhalb von Brise genutzt
werden, und „Allow overwrite = aus“ kann den Proxy nicht aushebeln.

Getestet (`cargo test --lib cortecs::tests::live -- --ignored`): Nicht-ZDR-Modell
über den Proxy → 404; GLM-5.3 gestreamt über den Proxy, Verbrauch erkannt;
`vibe -p` mit `cortecs-glm-5-3` antwortet über den Proxy.

**Vibe-Hilfsaufrufe:** Vibe erzeugt Session-Titel und Smart-Approve-Urteile mit
einem schnellen Mistral-Modell direkt bei Mistral – mit Inhalten aus dem Prompt.
Die Einstellung „Vibe-Hilfsaufrufe über das aktive Modell“ setzt
`[utility_models] title = "active"` und `smart_approve = "active"`; in
ZDR-Sessions laufen sie dann ebenfalls über Cortecs.

**Modelle:** Brise trägt beim ersten Start mit Schlüssel vier Modelle ein, alle
mit ZDR, Preise in EUR (Vibe zeigt sie ohne Währung): GLM-5.3, Kimi K2.7 Code,
Qwen 3.8 27B, Mistral Medium 3.5 (Aliase `cortecs-…`). Weitere lassen sich in den
Einstellungen hinzufügen; Modelle ohne ZDR lehnt Brise ab.

## Entscheidung 2: Prüfung auf sensible Daten, zweistufig

Vor dem Senden (nur wenn das Ziel kein ZDR-Modell ist) prüft Brise Prompt und
angehängte Textdateien:

1. **Lokal, ohne Netz** (`sensitive.rs`): E-Mail (ohne Beispiel-/No-Reply-Adressen),
   IBAN mit Prüfsumme (bekannte Beispiel-IBANs nur als Verdacht), Steuer-ID mit
   Prüfziffer, Telefonnummern, Geburtsdatum, Anschrift, private Schlüssel, AWS-,
   GitHub-, Slack-, Google- und `sk-`-Schlüssel, JWT, Passwörter im Klartext
   (ohne Platzhalter wie `process.env`), Begriffe zu Art. 9 DSGVO, § 203 StGB,
   Geschäftsgeheimnissen und EU-AI-Act-Praktiken (Art. 5, Anhang III).
2. **Nur bei Treffern:** ein Cortecs-Decision-Modell beantwortet sechs
   `predicate`-Fragen (Personenbezug, Art. 9, Geschäftsgeheimnis, Zugangsdaten,
   § 203, EU AI Act) – mit ZDR und den gleichen Routing-Feldern wie der Proxy.
   Datensparsam: der Prompt (max. 4000 Zeichen) und aus Anhängen nur Ausschnitte
   (±160 Zeichen) rund um Treffer. Schwelle 50 %. Eindeutige lokale Funde
   (Prüfsumme, Schlüsselformat) bleiben hoch, auch wenn das Modell zweifelt.

Ohne Cortecs-Key bleibt es beim lokalen Filter (eindeutige Funde, mehrere
Verdachtsmomente, Art. 9, § 203, AI Act, Zugangsdaten).

Der Hinweis über dem Eingabefeld zeigt Kategorien, Wahrscheinlichkeit,
maskierte Fundstellen und wer geprüft hat (mit Dauer und Kosten). Buttons:
**Auf sicheres Cortecs-Modell (ZDR) wechseln** · **Trotzdem senden** ·
**Immer für dieses Projekt ZDR**.

In ZDR-Sessions und -Projekten

- setzt Brise vor dem Senden ein Cortecs-Modell (sonst wird nicht gesendet),
- nutzt Auto nur Cortecs-Modelle,
- trifft Entscheidungen nur über Cortecs (ohne Key: Heuristik),
- schickt Dokumente nicht durch Mistral OCR, sondern als Verweis an Vibe,
- holen Vorschläge und Commit-Nachrichten ihre Antwort nur über Cortecs.

Grenzen: Die Prüfung ist eine Warnung, keine Rechtsberatung. PDFs und Bilder
prüft Brise nicht lokal (der Hinweis nennt sie). Was Vibe während des Turns
selbst liest (Dateien, Befehlsausgaben), sieht die Prüfung nicht – dafür gibt
es „Immer für dieses Projekt ZDR“.

## Entscheidung 3: Brises Entscheidungen über Cortecs-Decision-Modelle

Einstellung „Entscheidungen: Mistral Small / Cortecs“. Mit Cortecs:

- **Aufgabe einstufen:** `choice` simple/standard/complex. Die Wahrscheinlichkeit
  steht unter der Nachricht („Auto: … · normal 91 %“).
- **Denkstufe nachsteuern:** `choice` low/high/max. Gewechselt wird nur ab 60 %
  Sicherheit – jeder Wechsel kostet Cache. Der Verlauf der Denkstufe zeigt die
  Wahrscheinlichkeiten als Balken.
- **Vorschläge, Commit-Nachrichten** brauchen Text: Chat im JSON-Modus über
  Cortecs (Standard `mistral-small-2603`, bei Mistral selbst ohne Speicherung),
  ebenfalls mit ZDR.

### Vergleich an 20 Beispielaufgaben

`cargo test --lib cortecs::tests::eval -- --ignored --nocapture`, 26.10.2026,
jede Aufgabe einmal, nacheinander. Mistral Small mit dem
bisherigen Prompt aus `assist.rs`. Erwartete Stufe von Hand vergeben (je 6–7
pro Stufe). „Grob falsch“ = simple ↔ complex.

| Modell | richtig | grob falsch | Median | p90 | Kosten je 1000 Entscheidungen |
|---|---|---|---|---|---|
| Mistral Small (`mistral-small-latest`) | 17/20 | 0 | 1353 ms | 1901 ms | ≈ 0,020 €¹ |
| Cortecs `laya` | 8/20 | 5 | 172 ms | 208 ms | 0,005 € |
| **Cortecs `clef-flash`** | **20/20** | 0 | **246 ms** | 285 ms | **0,010 €** |
| Cortecs `clef` | 20/20 | 0 | 164 ms | 204 ms | 0,049 € |

¹ Tokens aus der Antwort × 0,10/0,30 je Mio. (Vibes Preisannahme für Mistral Small, USD ≈ EUR).
Cortecs-Kosten sind die von Cortecs gemeldeten Credits.

Mistral Small stufte drei „standard“-Aufgaben als „simple“ und eine „complex“
als „standard“ ein. `laya` neigt stark zu „simple“ (auch bei Architektur und
Sicherheits-Review) und ist für Brise unbrauchbar. `clef-flash` und `clef`
trafen alle 20, mit klaren Wahrscheinlichkeiten (meist > 75 %, Grenzfälle
wie „moment.js durch date-fns ersetzen“ um 60 %).

Einzelergebnisse:

| # | erwartet | Mistral Small | laya | clef-flash | clef |
|---|---|---|---|---|---|
| 1 | simple | simple | simple 68 % | simple 90 % | simple 98 % |
| 2 | simple | simple | simple 77 % | simple 95 % | simple 98 % |
| 3 | simple | simple | simple 86 % | simple 97 % | simple 99 % |
| 4 | simple | simple | simple 78 % | simple 97 % | simple 99 % |
| 5 | simple | simple | simple 90 % | simple 98 % | simple 98 % |
| 6 | simple | simple | simple 69 % | simple 95 % | simple 97 % |
| 7 | standard | simple | simple 68 % | standard 71 % | standard 73 % |
| 8 | standard | standard | simple 69 % | standard 93 % | standard 97 % |
| 9 | standard | simple | standard 54 % | standard 66 % | standard 77 % |
| 10 | standard | simple | simple 87 % | standard 67 % | standard 91 % |
| 11 | standard | standard | simple 67 % | standard 91 % | standard 95 % |
| 12 | standard | standard | simple 66 % | standard 59 % | standard 73 % |
| 13 | standard | standard | simple 65 % | standard 58 % | standard 83 % |
| 14 | complex | complex | simple 51 % | complex 98 % | complex 98 % |
| 15 | complex | complex | standard 85 % | complex 88 % | complex 94 % |
| 16 | complex | complex | complex 62 % | complex 91 % | complex 93 % |
| 17 | complex | complex | simple 70 % | complex 78 % | complex 92 % |
| 18 | complex | complex | simple 49 % | complex 76 % | complex 92 % |
| 19 | complex | complex | simple 45 % | complex 99 % | complex 98 % |
| 20 | complex | complex | simple 69 % | complex 98 % | complex 96 % |

Aufgaben: 1 `debounce` erklären · 2 Tippfehler · 3 Variable umbenennen ·
4 rustfmt · 5 let/const · 6 Lizenzabschnitt · 7 Schalter in Einstellungen ·
8 Unit-Tests · 9 CSV-Kopfzeile fehlt · 10 Paginierung · 11 REST-Filter mit
Tests · 12 moment.js → date-fns · 13 Dark Mode für Diffs · 14 Redux → Zustand
(40 Slices) · 15 Deadlock unter Last · 16 Echtzeit-Kollaboration mit CRDTs ·
17 Security-Review Auth · 18 Startzeit 1 s → 6 s · 19 Monolith aufteilen ·
20 Plugin-Sandbox in WASM.

### Prüfung auf sensible Daten (12 Prompts)

| Modell | richtig | Median |
|---|---|---|
| laya | 9/12 | 166 ms |
| **clef-flash** | **12/12** | 260 ms |
| clef | 12/12 | 213 ms |

`laya` gibt bei mehreren `predicate`-Fragen fast überall hohe Werte zurück
(z. B. „Zugangsdaten 100 %“ für eine Mahnung). `clef-flash` trennt sauber,
z. B. „Tests für `PatientRepository` mit Mock-Daten“ und „wie funktioniert
Gesichtserkennung in OpenCV“: lokal verdächtig, vom Modell entlastet;
„vertrauliches Board-Memo mit Umsatzplanung“: lokal nur schwach, vom Modell
erkannt (Geschäftsgeheimnis 92 %).

**Ergebnis:** Standard ist `clef-flash` – so genau wie `clef`, ein Fünftel des
Preises, rund fünfmal schneller als Mistral Small und halb so teuer. Die
Einstellung bleibt bei „Mistral Small“, bis der Nutzer umstellt; in
ZDR-Sessions entscheidet immer Cortecs.

## Nutzungsjournal

Jeder Cortecs-Aufruf (Vibe-Chat über den Proxy, Decisions, Chat für Helfer)
landet in `<Datenordner>/usage/YYYY-MM.jsonl` im Format von `usage.rs`
(Usage-Branch), mit zwei Zusatzfeldern:

```json
{"ts":1793026894736,"kind":"chat","feature":"Chat (Vibe)","model":"cortecs/glm-5.3",
 "provider":"cortecs","input":19,"output":3,"calls":1,"costEur":0.000015,"ms":1726}
```

`costEur` sind die Kosten, die Cortecs selbst meldet. Beim Zusammenführen
sollte `usage.rs` für Einträge mit `costEur` diesen Wert statt der
Preistabelle nehmen. Die Schnittstelle ist `cortecs::journal(&UsageEntry)`.

## Zusammenführen mit `DecisionProvider` (Backends-Branch)

`decision.rs` sieht `DecisionProvider::decide(task, DecisionRequest)` vor. Eine
`CortecsDecisions`-Implementierung ruft je `DecisionTask`:

- `ClassifyTask` → `cortecs::classify_task(user, None, None)`
- `AdjustReasoning` → `cortecs::adjust_reasoning(…)` (braucht Aufgabe, Verlauf,
  aktuelle Stufe getrennt – entweder die Anfrage um Felder erweitern oder `user`
  zerlegen)
- `ProjectSuggestions`, `CommitMessage` → `cortecs::chat_json(…)`

`current()` wählt dann nach der Einstellung `decisionProvider` (heute ein
`provider`-Parameter der Commands in `assist.rs`).

## Offen

- Mehrere Brise-Instanzen gleichzeitig: Die zweite bekommt einen anderen Port und
  schreibt ihn in `config.toml`; endet sie, zeigen neue Vibe-Prozesse der ersten
  Instanz bis zum nächsten Start ins Leere (scheitern, senden aber nichts ohne ZDR).
- Prüfung von PDFs und Bildern (Cortecs OCR mit ZDR wäre möglich).
- Projekt-Einstellungen per Management-Key anzeigen und setzen.
- Das Mistral-Konto selbst bleibt unberührt: Wer Mistral-Modelle wählt, sendet
  an Mistral wie bisher.
