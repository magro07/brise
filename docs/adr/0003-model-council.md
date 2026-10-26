# ADR 0003: Model Council – andere Modelle um Rat fragen

- Status: angenommen
- Datum: 2026-10-26

## Kontext

Ein einzelnes Modell übersieht eigene Fehler: Es prüft seinen Code mit denselben
Annahmen, mit denen es ihn geschrieben hat. Brise ruft mit dem Mistral-Key des
Nutzers ohnehin schon weitere Modelle direkt auf (Task-Modell, Embeddings, OCR,
Codestral). Der arbeitende Agent soll deshalb selbst entscheiden können, andere
Modelle hinzuzuziehen – vor allem für Code-Reviews, hartnäckige Fehler und eine
unabhängige Schlussprüfung, bevor er „fertig“ meldet.

## Entscheidung

Brise bekommt einen dritten eigenen MCP-Server, `brise --mcp-council <ordner>`
(Name `brise-council`). Jede Session bekommt ihn mit, solange das Council nicht
abgeschaltet ist. Der mitgelieferte Skill `council` erklärt dem Agenten, wann er
ihn nutzt und wie er Befunde abarbeitet.

### Werkzeuge

| Werkzeug | Eingabe | Ergebnis |
|---|---|---|
| `council_review` | `git_diff` (aktueller Diff) und/oder `diff`, `files` (`pfad` oder `pfad:von-bis`), `focus` | Befunde mit Schweregrad, `Datei:Zeile`, Begründung, Vorschlag, Übereinstimmung (z. B. 3/3) |
| `council_debug` | `problem` (Fehlerbild, Meldung, Stacktrace), `files`, `diff`, `tried` | Hypothesen, priorisiert nach Wahrscheinlichkeit und Zustimmung, mit Prüfschritt |
| `council_verify` | `claim` („ist erledigt/korrekt“), `evidence` (Testausgabe …), `files`, `git_diff` | Urteil `bestätigt` / `einwände` / `unklar` je Modell, Mehrheit, gesammelte Einwände |

Dateien liest der Server selbst aus dem Projektordner (mit Zeilennummern, damit
die Modelle Stellen zitieren können). Pfade werden kanonisiert und müssen im
Projektordner liegen; Binärdateien und Dateien über 512 KB werden übersprungen.
Der Kontext ist auf rund 120 000 Zeichen begrenzt, Kürzungen werden vermerkt.
`git_diff: true` nimmt `git diff HEAD` und neue, nicht ignorierte Dateien.

### Rollen

Jede Meinung kommt von einem Modell in einer Rolle. Rollen sorgen dafür, dass
die Meinungen nicht nur von verschiedenen Modellen, sondern auch aus
verschiedenen Blickwinkeln kommen:

- **Gutachter** – Korrektheit, Logik, ob der Code tut, was er soll.
- **Bug-Jäger** – Randfälle, Fehlerpfade, Off-by-one, leere Eingaben, Nebenläufigkeit.
- **Skeptiker/Verifizierer** – Sicherheit, Regressionen, unbelegte Annahmen,
  fehlende Tests; bei `council_verify` sucht er gezielt, was gegen „fertig“ spricht.
- **Ursachenforscher** (nur `council_debug`) – vom Symptom rückwärts zur Ursache.
- **Vorsitz** – führt die Einzelurteile zusammen (siehe unten), urteilt selbst nicht neu.

Meinung *i* bekommt Modell `modelle[i mod n]` und Rolle `rollen[i mod m]`.

### Modelle

Standard (alle über die Mistral-API mit dem Nutzer-Key):

| Rolle/Werkzeug | Modelle |
|---|---|
| Review | Mistral Large 4, GLM-5.3, Codestral |
| Fehlersuche | Magistral Medium, Mistral Large 4, GLM-5.3 |
| Schlussprüfung | Mistral Large 4, GLM-5.3, Mistral Medium 3.5 |
| Vorsitz | Mistral Large 4 |

Codestral ist schnell und billig und kennt Code gut, Magistral denkt bei
Fehlersuche länger nach, GLM-5.3 ist eine andere Modellfamilie und bringt damit
die unabhängigste zweite Meinung. Alles ist in den Einstellungen pro Rolle
änderbar. Andere Backends (eigene OpenAI-kompatible Endpunkte, Anthropic …)
sind vorgesehen: Ein Modelleintrag ist eine ID; ein späteres Präfix
(`backend:modell`) wählt den Anbieter. Bis dahin geht alles an Mistral.

### Wie viele Meinungen

Standard sind **3** (einstellbar 1–5). Drei erlaubt eine echte Mehrheit, kostet
aber nur das Dreifache eines Einzel-Reviews. Bei nur einem Modell in der Liste
kommen die Meinungen vom selben Modell in verschiedenen Rollen.

### Zusammenführung

1. **Unabhängige Urteile:** Alle Meinungen laufen parallel und sehen sich
   gegenseitig nicht (kein Ankereffekt). Jede antwortet als JSON.
2. **Abgleich:** Der Vorsitz bekommt Kontext und alle Einzelurteile und fasst
   gleiche Befunde zusammen, zählt, wer sie genannt hat, und entscheidet je
   Befund: `bestätigt` (Mehrheit oder am Code belegbar), `umstritten` (nur eine
   Stimme, plausibel) oder `verworfen` (am Code widerlegt) – jeweils mit Begründung.
3. **Ersatzweg ohne Vorsitz:** Fällt der Vorsitz aus oder ist abgeschaltet,
   gruppiert Brise deterministisch (gleiche Datei, Zeilen ±3 bzw. ähnlicher
   Titel). Übereinstimmung = Anzahl Meinungen; Mehrheit → `bestätigt`, sonst `umstritten`.
4. **Schlussprüfung** braucht keinen Vorsitz: Mehrheit der Urteile; bei
   Gleichstand oder wenn ein Modell einen kritischen Einwand hat, gilt `einwände`.

Fehler sind tolerant: Antwortet ein Modell nicht (Timeout, Standard 120 s) oder
liefert kein gültiges JSON, fehlt seine Meinung, das Ergebnis vermerkt es. Erst
wenn keine einzige Meinung kommt, scheitert der Aufruf.

### Kostenbremse

- Preise aus einer kleinen eingebauten Tabelle (EUR je Million Tokens, Stand
  der Mistral-Preisseite), unbekannte Modelle zum Preis von Mistral Large.
- Vor jedem Aufruf schätzt Brise die Kosten (Eingabe ≈ Zeichen/3,5 je Meinung
  plus Vorsitz, Ausgabe pauschal). Übersteigen bisherige Tageskosten plus
  Schätzung das **Tageslimit** (Standard 2,00 €, 0 = ohne Limit), lehnt der
  Server ab und sagt dem Agenten warum.
- Abgerechnet wird mit den echten Token-Zahlen der Antworten. Tagesstand liegt
  in `<Datenordner>/council/journal.jsonl`, jeder Lauf vollständig unter
  `<Datenordner>/council/runs/<id>.json` (für die Karte im Chat).
- Jeder Modellaufruf geht zusätzlich ins Usage-Journal
  (`<Datenordner>/usage/JJJJ-MM.jsonl`, `kind: "council"`), damit er in der
  Verbrauchsanzeige auftaucht.

### Automatisch oder auf Wunsch

- **Automatisch:** Der Agent zieht das Council von sich aus hinzu: vor dem
  Abschluss größerer Änderungen (mehrere Dateien, Logik, Sicherheit), nach zwei
  gescheiterten Fix-Versuchen und vor „fertig“ bei riskanten Aufgaben.
- **Nur auf Wunsch:** Werkzeuge sind da, der Agent nutzt sie nur, wenn der
  Nutzer es verlangt (oder über „Mit Council prüfen“).
- **Aus:** Der Server wird Sessions nicht mitgegeben.

Der Modus steht in den `instructions` des MCP-Servers und in den
Werkzeugbeschreibungen, der Skill richtet sich danach.

### Oberfläche

- Council-Aufrufe erscheinen als eigene Karte: Werkzeug, Modelle mit Rolle und
  Status, Ergebnis (Befunde mit Schweregrad, `Datei:Zeile`, Übereinstimmung),
  Einzelurteile aufklappbar, Dauer, Tokens und Kosten.
- „Mit Council prüfen“ unter jeder Antwort bittet den Agenten, seine
  Änderungen prüfen zu lassen und Befunde abzuarbeiten. Im Git-Panel prüft
  derselbe Knopf den aktuellen Diff direkt (ohne Agent); das Ergebnis erscheint
  als Karte in der Session und lässt sich dem Agenten übergeben.
- Einstellungen → Council: Modus, Modelle je Rolle, Anzahl, Vorsitz, Timeout,
  Tageslimit und heutiger Stand.

## Folgen

- Bessere Reviews und weniger „fertig“-Meldungen, die es nicht sind; die
  Kosten bleiben durch Limit und Schätzung sichtbar und gedeckelt.
- Ein Council-Aufruf dauert so lange wie die langsamste Meinung plus Vorsitz
  (typisch 20–90 s). Der Skill setzt ihn deshalb gezielt ein, nicht nach jeder Änderung.
- Die Einstellungen liest der MCP-Server aus `custom/settings.json`
  (`current.council`), die die Oberfläche ohnehin synchronisiert. Neue Werte
  gelten ab dem nächsten Aufruf, ohne Neustart der Session.
- Der Code des Projekts geht an mehrere Modelle. Das ist derselbe Anbieter wie
  beim Agenten selbst; für andere Backends muss die Oberfläche das künftig
  deutlich machen.
