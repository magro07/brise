---
name: deep-research
description: Gründliche Webrecherche bis hin zu Deep Research – zerlegt eine Frage in Teilfragen, lässt mehrere researcher-Subagents parallel suchen und Quellen lesen, prüft Aussagen gegen, und schreibt einen belegten Bericht. Verwenden für Fragen, die aktuelles Wissen, Vergleiche, Marktüberblicke, Bibliotheks- oder API-Auswahl, Fehler mit externen Ursachen oder „recherchiere …“, „was ist der Stand bei …“, „deep research“ verlangen. Nicht für Fragen, die der Code im Projekt beantwortet.
license: Apache-2.0
---

# Deep Research

Recherchiere so gründlich, wie die Frage es verlangt – nicht gründlicher. Jede
Aussage, die nicht aus dem Projekt stammt, bekommt eine Quelle.

## 1. Tiefe wählen

| Stufe | Wann | Vorgehen |
|---|---|---|
| **Schnell** | eine Tatsache, eine Version, ein Link | 1–3 `web_search`, Antwort direkt im Chat mit Quellen |
| **Gründlich** | Vergleich, Empfehlung, Fehlersuche mit externer Ursache | 3–4 Teilfragen, je ein `researcher`-Subagent, Antwort im Chat |
| **Deep Research** | Überblick, Entscheidungsvorlage, „deep research“, „ausführlich“ | 5–8 Teilfragen, parallele `researcher`, Bericht als Datei |

Ist die Frage mehrdeutig (Zeitraum, Region, Zielgruppe, Budget), stelle **eine**
gebündelte Rückfrage mit `ask_user_question`, bevor du startest.

## 2. Planen

Zerlege die Frage in unabhängige Teilfragen, die sich ohne einander beantworten
lassen. Schreib sie als Aufgabenliste (`todo`), damit der Nutzer den Fortschritt
sieht.

## 3. Parallel recherchieren

Starte für jede Teilfrage einen Subagenten – **alle gleichzeitig**, nicht
nacheinander. Gibt es den Typ `researcher`, nimm ihn; sonst einen normalen
Subagenten, dem du die Recherche-Anweisung unten mitgibst. Gib jedem mit:
- die Teilfrage in einem Satz,
- den Zeitbezug (heute ist das aktuelle Datum; bei schnelllebigen Themen nur
  Quellen der letzten 12 Monate),
- welche Quellen bevorzugt sind (offizielle Doku, Standards, Studien,
  Original-Ankündigungen vor Blogs und Foren).

Für Code-Fragen zusätzlich den Subagenten `explore` auf das Projekt ansetzen.

**Recherche-Anweisung für Subagents** (wörtlich mitgeben):

> Recherchiere genau diese eine Frage im Web. Mach mehrere gezielte
> `web_search`-Suchen (Formulierungen variieren, bei aktuellen Themen das Jahr
> nennen, Englisch und Deutsch). Öffne die maßgeblichen Quellen mit `web_fetch`,
> nicht nur Suchausschnitte. Prüfe wichtige Aussagen gegen mindestens zwei
> unabhängige Quellen. Gib knappe Stichpunkte zurück, jeweils mit URL und Datum,
> dazu offene Fragen und eine Einschätzung des Vertrauens (hoch/mittel/niedrig).
> Erfinde keine Quellen.

## 4. Prüfen und verdichten

- Widersprechen sich Quellen, nenne beide Sichtweisen mit Datum und gewichte
  nach Autorität und Aktualität.
- Fehlt Wesentliches, starte gezielt einen weiteren `researcher`.
- Erfinde nie Quellen, Zahlen oder Zitate. Was du nicht belegen kannst, kennzeichne
  als Einschätzung.

## 5. Ergebnis

**Schnell/Gründlich:** Antwort im Chat – zuerst das Ergebnis in 2–3 Sätzen, dann
Belege als Liste `[Titel](URL) – Datum`.

**Deep Research:** Bericht als `research/<thema>.md` im Projekt (Ordner anlegen,
falls nötig), Aufbau:

```markdown
# <Frage>
_Stand: <Datum> · Vertrauen: hoch/mittel/niedrig_

## Kurzfassung
3–5 Sätze mit der Antwort und der wichtigsten Einschränkung.

## Ergebnisse
### <Teilfrage 1>
… mit Quellenverweisen [1], [2]

## Offene Punkte und Unsicherheiten

## Quellen
1. <Titel> – <URL> – <Datum>
```

Fasse den Bericht danach im Chat in wenigen Sätzen zusammen und nenne den Pfad.

## Effizienz

- Lieber mehrere präzise Suchen als eine breite.
- Subagents liefern verdichtete Notizen, keine Volltexte – so bleibt der
  Kontext der Hauptsession klein.
- Nichts doppelt recherchieren: Was ein Subagent geliefert hat, nicht erneut suchen.
