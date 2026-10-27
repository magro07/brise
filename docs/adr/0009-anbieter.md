# ADR 0009 – Anbieter als zentrales Konzept, Brise-Konto, Nutzung über alle Anbieter

Stand: 27.10.2026 · Status: **umgesetzt** auf `wip/anbieter-glm`

## Anlass

Brise begann als Client für Mistral Vibe. Inzwischen spricht es mit mehreren
Coding-Agenten (Vibe, Claude Code, Codex, Gemini) und trifft eigene kleine
Entscheidungen (Einstufung, Denkstufe, Vorschläge, Commit-Nachrichten,
Council, Benchmark-Richter, Sensitivitätsprüfung). Diese Aufrufe gingen fest an
die Mistral-API, die Einstellungen sprachen von „deinem Mistral-Plan“, unten
links stand „Mistral Vibe“. Nutzerfeedback nach 0.2.0: unübersichtlich und zu
sehr auf Mistral fokussiert.

## Entscheidung

### Anbieter (providers.rs)

- Feste Anbieter: Mistral, Anthropic, OpenAI, Google Gemini (OpenAI-kompatibler
  Endpunkt), Cortecs. Dazu beliebig viele **OpenAI-kompatible** Anbieter mit
  Name, Base-URL, Schlüssel, Schlüssel-Kopfzeile (z. B. `api-key` für Azure),
  festen Kopfzeilen (z. B. `HTTP-Referer` für OpenRouter), ZDR-Kennzeichen,
  eigenen Preisen und Testmodell. Vorlagen: Ollama, LM Studio, vLLM, OpenRouter,
  Groq, Together, Azure OpenAI.
- Konfiguration ohne Geheimnisse in `<Datenordner>/providers.json`,
  Modelllisten in `provider-models.json`. Schlüssel nur im Schlüsselbund
  (`dev.brise.providers`, Konto = Anbieter-ID). Mistral bleibt unter Vibes
  Dienst (geteilt mit Vibe-CLI und VS-Code), Cortecs unter `dev.brise.cortecs`
  – **Migration heißt: nichts verschieben**, die alten Schlüssel gelten weiter.
  Kopfzeilen, deren Name nach Geheimnis aussieht, lehnt Brise ab.
- Modelle heißen `anbieter/modell` (`openai/gpt-4.1-mini`,
  `ollama/qwen3:8b`). Ohne bekanntes Präfix ist es ein Mistral-Modell – so
  stehen sie in alten Einstellungen; OpenRouter-IDs mit Schrägstrich bleiben heil.
- **Schlüsselprüfung:** `GET /models` plus ein echter Mini-Aufruf
  (`max_tokens` 16, kleinstes Modell der Liste). Manche Anbieter (Cortecs,
  OpenRouter, lokale Server) antworten auf `/models` auch mit ungültigem
  Schlüssel mit 200. 401/403 beim Aufruf = ungültig; 400/404/422 = Schlüssel
  angenommen, nur das Modell nicht.
- Einheitlicher Aufruf `providers::ask`: OpenAI-Stil (`/chat/completions`) bzw.
  Anthropic `/messages`. Parameter, die ein Anbieter ablehnt
  (`max_tokens` → `max_completion_tokens`, `temperature`, `response_format`,
  `reasoning_effort`), passt Brise nach der Fehlermeldung an.

### Brises Funktionen

Je Funktion ein Modellwähler aus allen Anbietern mit Schlüssel (Einstellung
`taskModels`: `decide`, `helper`, `sensitivity`, `judge`), dazu Council-Rollen
und Vorsitz, Embeddings (jeder Anbieter mit `/embeddings`). Leer = automatisch:
alte Einstellungen (`assistModel`, `decisionProvider`), sonst erster Anbieter
mit Schlüssel. Cortecs-Decision-Modelle (clef, laya) laufen weiter über die
Decisions-API. In ZDR-Projekten nur Modelle ohne Datenspeicherung (Cortecs,
lokal, als ZDR markiert). Nur bei Mistral und gekennzeichnet: Codestral-FIM,
OCR, Voxtral (über Vibe). Eine Whisper-Alternative für Sprache gibt es noch nicht.

### Vibe

Vibe kann über `[[providers]]` OpenAI- und Anthropic-kompatible Anbieter
nutzen, wertet aber `extra_headers` nur für Bildaufrufe aus. Brise trägt
freigegebene Anbieter daher als `brise-<id>` mit `api_base` auf den lokalen
Proxy (`/p/<id>`) ein. Vibe weist sich dort mit einem Sitzungs-Token
(`BRISE_PROVIDER_TOKEN`, zufällig je Brise-Start) aus; der Proxy setzt Schlüssel
und Kopfzeilen ein. Vibe sieht den Schlüssel nie, eine Webseite kann den Proxy
ohne Token nicht nutzen. Ohne laufendes Brise sind diese Modelle in Vibe nicht
nutzbar (wie bei Cortecs). Der Proxy bucht den Verbrauch je Anbieter.

### Einstellungen

Neun Bereiche statt achtzehn, mit Suchfeld: Allgemein · Anbieter & Schlüssel ·
Agenten (Übersicht | Vibe) · Modelle & Automatik · Datenschutz & Sicherheit ·
Nutzung & Budget (Nutzung | Seit Beginn | Benchmarks) · Werkzeuge ·
Zusammenarbeit & Team · Erweitert. Vibe-Spezifisches (Konto, mehrere Accounts,
Modelle, Subagents, config.toml) steht nur unter Agenten → Vibe; Freigaben und
MCP bleiben thematisch (Datenschutz bzw. Werkzeuge) mit Vermerk „für Vibe“.

**Team-Richtlinien:** Die Bereichs-IDs sind zugleich Richtlinien-Bereiche.
Alte IDs (`account`, `cortecs`, `web` …) bildet `policy::canonical_section` auf
die neuen ab; es gilt der strengste Zugriff. Gespeicherte Team-Stände bleiben
gültig, die Oberfläche bekommt die Richtlinie schon mit neuen IDs.

### Brise-Konto (profile.rs)

Lokales Konto ohne Server: Name, optional E-Mail, Farbe, Avatar (Data-URL,
≤ 256 KB) in `<Datenordner>/profile.json`. Beim ersten Start bzw. für
bestehende Nutzer einmal „Konto anlegen“ (vorbelegt aus `git config --global`),
„Später“ geht immer. Der Name gilt für Teams, geteilte Sessions, Gastzugang und
Audit-Log (über die vorhandenen Team-Profile); auf Wunsch als Git-Autor für
Commits aus Brise. Unten links: Avatar, Name, verbundene Agenten.

### Nutzung

Journal-Einträge tragen den Anbieter (`provider`, leer = Mistral). Turns von
Claude Code, Codex und Gemini bekommen Anthropic, OpenAI bzw. Google als
Anbieter und ein Abo-Kennzeichen, wenn der Agent über ein Abo angemeldet ist:
Diese Turns zählen mit **0 €** (echte Kosten unbekannt) und nicht ins Budget;
der Listenpreis steht nur zum Vergleich da. Das Monatsbudget gilt über alle
Anbieter. Über Brises Proxy laufende Vibe-Modelle bucht der Proxy, der Turn
selbst wird nicht doppelt gezählt. Neue Ansicht „Seit Beginn“: Gesamtübersicht,
Aktivitätskalender, Serien, Lieblingsmodelle und -agenten, Anteil je Anbieter,
Monatsverlauf, Tempo, Ersparnis (Cache, Arbeiter-Modelle), Meilensteine.

## Getestet

Unter Xvfb mit eigenem Datenordner und `VIBE_HOME`, lokaler Mock einer
OpenAI-kompatiblen API (`/models` immer 200, Chat nur mit gültigem Schlüssel):
falscher Schlüssel abgelehnt, richtiger angenommen, `providers.json` ohne
Schlüssel; Einstufung, Denkstufe und Council (zwei Mitglieder plus Vorsitz) über
den Mock, Journal mit `provider`; Vibe-Export mit Proxy-Token; vorhandene
Mistral- und Cortecs-Schlüssel ohne erneute Eingabe sichtbar (Migration).

## Offen

- Sprache (STT/TTS) nur über Vibe/Voxtral; Whisper über OpenAI-kompatible
  Anbieter wäre ein eigener Aufnahmeweg in Brise.
- Anthropic-Denkmodus (`thinking`) für Brises eigene Aufrufe.
- Abo-Erkennung bei Codex und Gemini ist eine Heuristik (Anmeldedatei statt
  API-Schlüssel in der Umgebung).
