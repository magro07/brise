---
name: council
description: Zieht andere KI-Modelle als Model Council hinzu – unabhängiges Code-Review, Fehlersuche mit mehreren Hypothesen und Schlussprüfung vor „fertig“. Verwenden vor dem Abschluss größerer oder riskanter Änderungen, wenn ein Fehler nach zwei Versuchen noch besteht, und wenn der Nutzer eine Zweitmeinung, ein Review „von anderen Modellen“ oder „Mit Council prüfen“ verlangt.
license: Apache-2.0
---

# Model Council

Du läufst in **Brise**. Der MCP-Server `brise-council` lässt mehrere andere
Modelle (Standard: Mistral Large 4, GLM-5.3, Codestral, Magistral) unabhängig
voneinander urteilen; ein Vorsitz-Modell führt die Urteile zusammen. So siehst du
Fehler, die du mit deinen eigenen Annahmen übersiehst.

| Werkzeug | Wofür |
|---|---|
| `council_review` | Review von Änderungen: `git_diff: true` (aktueller Diff) und/oder `files`, optional `focus` |
| `council_debug` | Ursachen eines Fehlers: `problem` (Fehlerbild, Meldung), `tried`, `files` |
| `council_verify` | Schlussprüfung einer Behauptung: `claim`, `evidence` (z. B. Testausgabe), `git_diff`/`files` |
| `council_result` | Weiter warten, wenn ein Lauf nach ~50 s noch nicht fertig war (`id` aus der Antwort) |

In Vibe heißen sie mit Präfix, z. B. `brise-council_council_review`.

## Wann

Steht in den Hinweisen des Servers „Nur auf ausdrücklichen Wunsch“, nutze das
Council nur, wenn der Nutzer es verlangt. Sonst von dir aus:

- **Vor dem Abschluss größerer Änderungen:** mehrere Dateien, neue Logik,
  Datenhaltung, Sicherheit, Nebenläufigkeit → `council_review` mit `git_diff: true`.
- **Bei hartnäckigen Fehlern:** derselbe Fehler nach zwei Fix-Versuchen →
  `council_debug` mit Fehlermeldung, betroffenen Dateien und dem, was du versucht hast.
- **Vor „fertig“ bei riskanten Aufgaben:** `council_verify` mit einer konkreten,
  prüfbaren Behauptung und echten Belegen (Testausgabe, nicht „sollte gehen“).

Nicht für Kleinigkeiten (Tippfehler, Umbenennungen, reine Doku), nicht nach jeder
Einzeländerung und nicht zweimal hintereinander für denselben Stand. Ein Aufruf
dauert 20–90 s und kostet echtes Geld (meist wenige Cent).

## Gut fragen

- Gib Code über `git_diff`/`files` mit, statt ihn abzuschreiben. Der Server liest
  die Dateien selbst und nummeriert die Zeilen. Bei großen Projekten gezielt:
  `"src/store.py:40-120"`.
- `focus` bzw. `problem` konkret: was sich geändert hat, was erwartet ist, was passiert.
- `opinions: 1` oder `2` reicht für kleine Prüfungen und spart Kosten.

## Befunde abarbeiten

Jeder Befund hat Schweregrad, `Datei:Zeile`, Übereinstimmung (z. B. `2/3` = zwei
von drei Mitgliedern) und eine Entscheidung des Vorsitzes:

1. **bestätigt** – zuerst beheben, von kritisch nach niedrig.
2. **umstritten** – selbst am Code prüfen. Beheben, wenn du es nachvollziehen
   kannst; sonst kurz begründen, warum nicht.
3. **verworfen** – ignorieren.

Danach Tests laufen lassen. Nach größeren Korrekturen höchstens **ein** weiteres
`council_review` bzw. `council_verify` für den neuen Stand. Behaupte nie, das
Council habe etwas bestätigt, das es nicht bestätigt hat.

Fasse für den Nutzer kurz zusammen: welche Modelle geprüft haben, was du
behoben hast, was du bewusst nicht übernommen hast (mit Grund). Das Ergebnis
sieht der Nutzer zusätzlich als Karte im Chat.

## Wenn es nicht geht

- **Tageslimit erreicht:** ohne Council weiterarbeiten und dem Nutzer sagen,
  dass er das Limit unter Einstellungen → Council erhöhen kann.
- **Einzelne Modelle ohne Antwort:** Das Ergebnis der übrigen gilt; erwähne es.
- **„arbeitet noch“:** `council_result` mit der genannten `id` aufrufen.
