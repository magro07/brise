# ADR 0002 – Mehrere Mistral-Schlüssel

Stand: 26.10.2026 · Status: **angenommen** (Sticky + Reserve, umgesetzt auf `claude/multikey-caaa53`)

## Anlass

Brise kennt genau einen Mistral-Schlüssel (Schlüsselbund, Dienst
`ai.mistral.vibe`, Konto `MISTRAL_API_KEY`, geteilt mit Vibe-CLI und
VS-Code-Erweiterung). Gewünscht ist, mehrere Accounts bzw. Schlüssel einzutragen
und „intelligent verteilt“ zu nutzen, etwa nacheinander volllaufen lassen –
ohne dass beim Wechsel der Prompt-Cache verloren geht.

## 1. Was Mistral erlaubt

Geprüft am 26.10.2026 auf legal.mistral.ai und docs.mistral.ai.

**Privatnutzer (Le-Chat-/Vibe-Abo, Free oder Pro):** Es gelten die
*Terms of Service for consumers in the EEA* (gültig ab 08.10.2026), Abschnitt
„Mistral AI accounts“. Dort steht sinngemäß: Ein Account ist nur für die
eigene Person. Mehrere Accounts derselben Person sind *strikt verboten* – auch
und ausdrücklich, um Rate-Limits oder andere Beschränkungen zu umgehen. Laut
Abschnitt „Usage limitations“ wird der Zugang beim Erreichen des Limits bis
zum Reset gesperrt, oder man stuft das Abo hoch.

**Geschäftskunden (Commercial Terms, gültig ab 25.09.2026):** Ein ausdrückliches
Verbot mehrerer Accounts gibt es dort nicht. Verboten sind Kauf, Verkauf und
Weitergabe von API-Keys oder Accounts an Dritte (2.2 h) sowie das Umgehen von
Sicherheitsmechanismen (2.2 f). Eigene Workspaces für Tochterfirmen sind
vorgesehen (1.5). Zuständig für alle Aktivitäten unter dem Kundenkonto ist der
Kunde (1.4).

**Limits liegen bei der Organisation, nicht beim Schlüssel:** Laut Doku
„Usage and limits“ gelten Rate-Limits pro Organisation. Spending-Caps gibt es
pro Organisation und pro Workspace, und beide umfassen API- und Vibe-Verbrauch.
Mehrere Schlüssel in derselben Organisation bringen also **kein** zusätzliches
Kontingent. Sie trennen nur Budgets und Auswertung (über Workspaces).
Pay-as-you-go erweitert die enthaltene Menge über Prepaid-Guthaben.

**Folgerung:** Ein Rotieren über mehrere private Accounts, um mehr Kontingent zu
bekommen, ist untersagt. Wer das automatisiert in eine öffentliche App einbaut,
riskiert die Sperre der Accounts und bringt auch andere Nutzer von Brise in
diese Lage. Brise baut das deshalb nicht.

Erlaubt und sinnvoll sind:

| Fall | Warum er konform ist |
|---|---|
| Privater Account **und** beruflicher Account (Team/Enterprise des Arbeitgebers) | Zwei Vertragspartner, zwei Zwecke. Gewählt wird pro Projekt, nicht um Limits zu strecken |
| Mehrere Workspaces/Keys **einer** Organisation | Budget- und Projekttrennung. Limits bleiben die der Organisation |
| Abo-Login (Vibe-Kontingent) plus **Pay-as-you-go-Key** derselben Person als Reserve | Mehr Kontingent wird bezahlt, nicht umgangen. Laut Doku läuft „Vibe usage beyond quota“ ohnehin über Pay-as-you-go |
| Kunden-/Fremdkeys, die ein Auftraggeber für sein Projekt stellt | Das Konto gehört dem Auftraggeber, genutzt wird es nur in dessen Projekt |

## 2. Cache-Verhalten

**Doku (Prompt caching):**
- Mistral cached automatisch gemeinsame Präfixe in Blöcken zu 64 Tokens.
- Cache-Treffer kosten **10 %** des normalen Eingabepreises.
- Gemeldet werden sie in `usage.prompt_tokens_details.cached_tokens`.
- Der optionale Parameter `prompt_cache_key` erhöht die Trefferchance, garantiert
  aber nichts.
- Zum Geltungsbereich des Caches (Schlüssel, Workspace, Organisation) und zur
  Lebensdauer schweigt die Doku.

**Vibe 3.0.2:**
- `core/llm/backend/mistral.py` liest `cached_tokens` aus und summiert es zu
  `session_cached_tokens`.
- `acp/agent.py` meldet die Summe in `usage_update._meta.cachedTokens`
  (kumuliert über die Session).
- Vibe setzt **keinen** `prompt_cache_key`. Treffer hängen also allein am
  gleichen Präfix und daran, welcher Server die Anfrage bekommt.

**Annahme:** Ein Cache, den eine fremde Organisation mitlesen kann, wäre ein
Datenleck. Deshalb gehen wir davon aus, dass der Cache mindestens pro
Organisation getrennt ist. Ein Wechsel auf einen Schlüssel einer anderen
Organisation verliert den Cache also sicher. Ein Wechsel innerhalb derselben
Organisation verliert ihn vermutlich nicht, das ist aber unbelegt.

**Kosten eines Wechsels mitten in der Session:** Der nächste Modellaufruf
schickt den kompletten Verlauf ungecacht, das kostet 100 % statt 10 % für
diesen Teil. Bei 100 000 Tokens Kontext sind das einmalig rund 90 000 Tokens
zum vollen Eingabepreis. Danach füllt sich der Cache im neuen Konto wieder.
Teuer ist das nur, wenn häufig gewechselt wird.

Messbar ist das in Brise ohne eigenen Test: Der Anteil
`cachedTokens / promptTokens` aus `usage_update` fällt nach einem Wechsel
sichtbar ab. Das liefert die Usage-Auswertung mit dem Feld `account` (Paket
Usage/Stats).

## 3. Technische Randbedingungen

- **Ein Schlüssel pro Vibe-Prozess.** Über ACP gibt es keine Zugangsdaten pro
  Session. Vibe sucht den Schlüssel in dieser Reihenfolge: Session-Kontext
  (nur App-Server-Kanäle, nicht ACP), dann Umgebung, dann Schlüsselbund
  (`vibe/utils/api_keys.py`). Ein zweiter Account braucht also einen zweiten
  `vibe-acp`-Prozess.
- **Schlüssel nicht über die Umgebung.** Vibe gibt seine komplette Umgebung an
  Shell-Befehle des Modells weiter (`vibe/core/utils/shell.py`,
  `{**os.environ, …}`). `MISTRAL_API_KEY` in der Kind-Umgebung wäre also per
  `env` für das Modell lesbar. Stattdessen setzt Brise
  `VIBE_PROVIDERS='[{"name":"mistral", …, "api_key_env_var":"BRISE_KEY_<id>"}]'`.
  Vibe führt das per Feld mit dem eingebauten Provider zusammen und liest den
  Schlüssel dann selbst aus dem Schlüsselbund (Dienst `ai.mistral.vibe`, Konto
  `BRISE_KEY_<id>`). In der Umgebung steht nur der Variablenname. Geprüft mit
  Vibe 3.0.2: Ein Dummy-Eintrag wird gefunden („from the keyring“), und ein
  Prompt scheitert erwartungsgemäß mit -31002 (ungültiger Schlüssel).
- **Sessions sind prozessübergreifend.** Sessions liegen im gemeinsamen
  `VIBE_HOME`. Ein anderer Prozess kann sie per `session/load` übernehmen.
  Das ist der Weg für einen Wechsel, er kostet aber den Cache (siehe oben).
- **Limit-Erkennung:** Vibe wiederholt 429/5xx selbst mit Backoff, bis zu
  300 s (`DEFAULT_API_RETRY_MAX_ELAPSED_TIME`). Jeder Versuch wird über die
  ACP-Erweiterung `session/retrying` (Kategorie, Detail) gemeldet. Erst danach
  scheitert der Prompt mit JSON-RPC-Fehler **-31001** (`RateLimitError`,
  `data.provider`, `data.model`). Ein abgelaufenes Abo-Kontingent und ein
  kurzfristiges Rate-Limit sehen dabei gleich aus.
- **Restkontingent ist nicht abfragbar.** Die Admin-API für Verbrauch gibt es
  nur im Enterprise-Plan. Für Abo-Konten liefert Vibe keinen Stand.

## 4. Kandidaten

Bewertet nach Cache-Erhalt, Ausfallsicherheit, Transparenz und Konformität.

| Strategie | Cache | Ausfall | Transparenz | Konform |
|---|---|---|---|---|
| A Nacheinander volllaufen (Rotation über Accounts) | gut, solange kein Wechsel | gut | mittel | **nein** bei mehreren Privat-Accounts, sonst wie D |
| B Sticky pro Session, Wahl pro Projekt, Wechsel nur zwischen Sessions | **sehr gut** | schwach (Limit = Stillstand) | **sehr gut** | ja |
| C Wechsel nur bei Limit (-31001) auf einen Reserve-Schlüssel | einmaliger Verlust pro Wechsel | **gut** | gut mit Hinweis | ja, wenn die Reserve bezahlter Mehrverbrauch derselben Person ist |
| D Nach Restkontingent gewichtet | schlecht (häufige Wechsel) | gut | schlecht | wie A |

D scheitert schon technisch: Ohne Restkontingent gibt es keine Gewichtung. A ist
in der gewünschten Form (mehrere Privat-Accounts) nicht erlaubt. Für erlaubte
Konstellationen schrumpft A auf C: Ein bezahlter Reserve-Schlüssel springt erst
ein, wenn der Haupt-Account am Limit ist.

## 5. Entscheidung (Vorschlag)

**B als Grundregel, C als freiwillige Ergänzung.**

1. **Schlüssel mit Namen:** Jeder Schlüssel bekommt einen Namen, z. B.
   „Privat (Abo)“, „Firma“, „Reserve (Pay-as-you-go)“, und einen
   Schlüsselbund-Eintrag unter Dienst `ai.mistral.vibe`, Konto
   `BRISE_KEY_<id>`. Der bisherige Eintrag `MISTRAL_API_KEY` bleibt der
   Standard-Account und wird mit Vibe-CLI geteilt. Angezeigt werden nur Name
   und Kurzform (`abcd…wxyz`).
2. **Zuordnung:** Es gibt einen Standard-Account, pro Projekt überschreibbar.
   Eine Session bleibt bei ihrem Account (sticky). Der Account steht im Tab und
   in der Kopfzeile.
3. **Ein Prozess pro Account, der benutzt wird:** Brise startet `vibe-acp`
   erst, wenn eine Session diesen Account braucht. Die Verbindungen liegen im
   `AgentState` als Map nach Account, Befehle laufen über `session_id` zum
   richtigen Prozess.
4. **Reserve bei Limit (Opt-in, pro Schlüssel „als Reserve erlauben“):**
   - Bei -31001 zeigt Brise einen Hinweis:
     „Limit von ‚Privat‘ erreicht. Mit ‚Reserve‘ fortsetzen? Der Verlauf wird
     einmal ungecacht gesendet (≈ N Tokens).“
   - Optional geht das automatisch, mit Hinweis im Verlauf.
   - Die Session wird im Reserve-Prozess per `session/load` geladen, der letzte
     Prompt erneut gesendet. Danach bleibt sie dort, ohne Zurückspringen
     mitten in der Session.
   - Neue Sessions starten wieder beim Haupt-Account.
5. **Keine Rotation über mehrere Privat-Accounts.** Brise weist beim Anlegen
   darauf hin, dass mehrere private Accounts laut Mistral nicht erlaubt sind.
   Die Reserve-Funktion ist für bezahlte Mehrnutzung gedacht.
6. **Usage:** Jeder Journal-Eintrag trägt `account` (Name, nie den Schlüssel).
   So zeigt die Usage-Seite Verbrauch und Cache-Quote pro Account.

## Konsequenzen

- `agent.rs` wird von einer Verbindung auf mehrere umgebaut. Diese Datei teilen
  sich mehrere Arbeitspakete, deshalb kommt die Logik in ein neues Modul
  (`accounts.rs`). `agent.rs` bekommt nur die Prozess-Map und die Weiterleitung.
- Jeder zusätzliche `vibe-acp`-Prozess ist ein eigener Python-Prozess (Speicherbedarf
  noch nicht gemessen). Er läuft nur,
  solange eine Session des Accounts offen ist.
- Abo-Login per Browser (`browser-auth-delegated`) schreibt weiterhin in den
  Standard-Eintrag. Weitere Accounts kommen nur per eingefügtem Schlüssel.
- Offen: Sobald Mistral den Cache-Geltungsbereich dokumentiert oder Vibe
  `prompt_cache_key` setzt, die Kostenschätzung im Wechsel-Hinweis anpassen.

## Quellen

- https://legal.mistral.ai/terms/eu-consumers-terms-of-service – „Mistral AI accounts“, „Usage limitations“
- https://legal.mistral.ai/terms/commercial-terms-of-service – 1.4, 1.5, 2.2
- https://docs.mistral.ai/studio/conversations/advanced/prompt-caching.md
- https://docs.mistral.ai/admin/billing-usage/usage-limits.md, https://docs.mistral.ai/admin/workspaces/usage-limits.md
- Vibe 3.0.2: `vibe/utils/api_keys.py`, `vibe/core/llm/backend/mistral.py`, `vibe/acp/agent.py`, `vibe/acp/exceptions.py`
