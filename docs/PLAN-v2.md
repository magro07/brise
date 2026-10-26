# Brise – Plan für die nächste Ausbaustufe

Stand: 26.10.2026. Basis ist der Stand auf `main` (Commit nach „Websuche, Tour,
OCR, Codestral“).

Vier Themen, nach Aufwand und Abhängigkeiten geordnet:

| # | Thema | Aufwand | Abhängig von |
|---|---|---|---|
| A | Auto = GLM-5.3 mit automatischem Reasoning-Aufwand | klein–mittel | – |
| B | Usage-Anzeige mit Monatsbudget (255 €) | mittel | – |
| C | Tabs und geteilte Ansicht (mehrere Sessions nebeneinander) | mittel | – |
| D | Kollaboration über Nutzer und Rechner hinweg | groß | C hilft, ist aber keine Voraussetzung |

A, B und C berühren alle die Oberfläche (`store.ts`, Composer, Kopfzeile), D ist
weitgehend eigenständig: ein neuer Relay-Dienst plus ein Client-Modul.

---

## A. Auto = GLM-5.3, Reasoning-Aufwand automatisch

**Ziel:** „Auto“ nutzt immer GLM-5.3. Das Task-Modell stellt die Denkstufe
(`low` / `high` / `max`) ein, beim ersten Prompt, danach bei jedem weiteren und
auch während Vibe arbeitet. Ein Klick auf die Anzeige zeigt, wann und warum die
Stufe gewechselt hat.

**Umsetzung**
1. Die Modellwahl „Auto“ setzt GLM-5.3 (`glm-5-3`) fest. Die bisherige
   Modell-Zuordnung je Stufe bleibt als Option „Auto (Modell wechseln)“.
2. Einstufung vor jedem Prompt (vorhanden, `classify_task`). Ergebnis wird
   künftig auf die **Denkstufe** abgebildet: einfach → `low`, normal → `high`,
   komplex → `max`. Beim ersten Prompt einer Session mit Verlauf bewerten.
3. **Nachsteuern während der Arbeit:** Brise beobachtet die Updates des laufenden
   Turns und fragt das Task-Modell nur bei Signalen erneut (spart Kosten):
   - fehlgeschlagene Werkzeugaufrufe in Folge (z. B. 2×) → hoch,
   - neue Aufgabenliste mit vielen Schritten → hoch,
   - reine Lese- und Suchschritte über längere Zeit → runter,
   - Subagent gestartet → unverändert.

   Gesetzt wird über `session/set_config_option` (`thinking`). Vibe übernimmt
   die Stufe ab dem nächsten Modellaufruf. **Vorab prüfen**, ob das mitten im
   Turn greift, sonst nur zwischen Turns.
4. **Anzeige:** Die Denkstufe im Composer zeigt „Auto · Hoch“. Ein Klick öffnet
   den Verlauf: Zeitpunkt, alte → neue Stufe, Begründung des Task-Modells.
5. Manuelle Wahl einer Stufe schaltet die Automatik für diese Session ab.

**Risiken:** Ständige Wechsel kosten Cache-Treffer (Prompt-Cache). Deshalb nur
eine Änderung pro 30 s und nur bei klaren Signalen.

---

## B. Usage-Anzeige wie in Claude Code

**Ziel:** jederzeit sehen, wie viel vom Monatsbudget (255 €) verbraucht ist,
wofür, und wann es bei aktuellem Tempo aufgebraucht wäre.

**Datenquellen**
1. **Mistral-Konto:** prüfen, ob Vibe (`_account/read`, `/whoami`) oder die
   Console-API Verbrauch und Limit des Plans liefern. Falls ja, ist das die
   maßgebliche Zahl.
2. **Eigenes Protokoll (immer):** Brise schreibt jeden Vorgang mit Tokens und
   Modell in ein lokales Journal (`<Datenordner>/usage/2026-10.jsonl`):
   - Vibe-Turns (`usage_update`, `PromptResponse.usage`),
   - Task-Modell, Embeddings, OCR, Codestral-Vervollständigung, Websuche, Voxtral.
3. **Preistabelle** je Modell (Eingabe, Cache, Ausgabe, pro Minute Audio, pro
   Seite OCR). Mitgeliefert und in den Einstellungen änderbar, weil Mistral keine
   Preis-API hat.

**Anzeige**
- **Kopfzeile:** kleiner Balken „62 € / 255 €“, Farbe ab 75 % bzw. 90 %.
- **Seite „Nutzung“:**
  - Monatsbalken mit Prognose („bei diesem Tempo am 24.11. erreicht“)
  - Verlauf pro Tag
  - Aufschlüsselung nach Modell, Projekt, Session und Funktion (Chat, Subagents, Suche, OCR …)
  - teuerste Sessions
  - Cache-Ersparnis
- Warnungen bei 50 / 80 / 95 %. Optional pausiert Brise teure Modelle
  (Auto weicht dann auf kleinere aus).

**Risiko:** Ohne Konto-API ist die Zahl eine Schätzung. Das muss klar
gekennzeichnet sein, mit einem Abgleich über „Stand laut Mistral-Console
eintragen“.

---

## C. Tabs und geteilte Ansicht

**Ziel:** mehrere Sessions gleichzeitig offen, als Tabs und nebeneinander, auch
über Projekte hinweg.

**Umsetzung**
1. **Tab-Leiste** über der Konversation. Jede geöffnete Session ist ein Tab mit
   Status-Punkt (läuft / wartet auf Freigabe / fertig). Mittelklick schließt,
   Ziehen sortiert um, Strg+Tab wechselt.
2. **Geteilte Ansicht:** bis zu drei Bereiche nebeneinander (Tab an den Rand
   ziehen oder „Rechts öffnen“). Jeder Bereich hat eigene Konversation, eigenen
   Composer und eigene Freigaben.
3. Der Zustand wandert von `activeSessionId` zu `panes: { tabs[], active }[]`
   plus „fokussierter Bereich“. Seitenpanel und Terminal folgen dem Fokus.
4. Benachrichtigung und Tab-Markierung, wenn eine Session im Hintergrund eine
   Freigabe braucht.

**Technik:** Vibe kann mehrere Sessions in einem Prozess (ACP). Das Backend ist
schon dafür ausgelegt, `session/update` wird nach `sessionId` verteilt.

---

## D. Kollaboration über Nutzer und Rechner hinweg

**Ziel:** Sessions teilen, gemeinsam an einer Session arbeiten und Arbeit
zwischen Rechnern übergeben.

### Grundsatz

Der Agent läuft immer **auf genau einem Rechner (Host)**, mit dessen Dateien und
dessen Mistral-Plan. Andere verbinden sich mit dieser Session. Schlüssel und
Dateien verlassen den Host nie, nur Konversation, Diffs und Freigabe-Anfragen.

### Stufen

| Stufe | Inhalt |
|---|---|
| D1 Live ansehen | Session per Einladungslink teilen; Gäste sehen Streaming, Tool-Karten, Diffs live (nur lesen) |
| D2 Mitarbeiten | Gäste schreiben Prompts (Warteschlange beim Host), Host entscheidet Freigaben; Rollen: Betrachter, Mitarbeiter, Freigeber |
| D3 Präsenz | wer schaut zu, wer tippt, Kommentare an Nachrichten und Diffs |
| D4 Übergabe | Session auf einen anderen Rechner umziehen: Verlauf (Vibe-Journal) + Git-Branch; alternativ Vibes `/teleport` nach Vibe Code Web |
| D5 Team-Bereich | gemeinsame Projektliste, laufende Sessions des Teams, Benachrichtigungen |

### Architektur

```
 Host (Brise + Vibe)  ⇄  Relay (WebSocket, selbst hostbar)  ⇄  Gäste (Brise)
          └── Ende-zu-Ende verschlüsselt: Relay sieht nur Chiffretext
```

**Relay:** kleiner Rust-Dienst (axum), Räume pro geteilter Session, keine
Speicherung außer optionalem Puffer der letzten Ereignisse. Als Docker-Image,
z. B. im eigenen Homelab, Betrieb hinter einem Reverse-Proxy mit TLS.

**Verschlüsselung:** Der Einladungslink enthält Raum-ID und Schlüssel im
Fragment (`brise://join/<raum>#<schlüssel>`). Ereignisse werden mit
XChaCha20-Poly1305 verschlüsselt, Rollen vom Host signiert.

**Ereignisse:** dieselben, die Brise schon verarbeitet (`session/update`,
Freigaben, Turn-Ende), dazu Gast-Prompts und Präsenz. Ein Gast baut daraus mit
dem vorhandenen Store dieselbe Ansicht.

**Sicherheit:**
- Gast-Prompts laufen mit den Rechten des Hosts.
- Deshalb gilt standardmäßig „Alles fragen“, und Freigaben trifft nur der Host oder
  ein ausdrücklich ernannter Freigeber.
- Links sind ablaufend und widerrufbar.
- Kosten trägt der Plan des Hosts, die Usage-Anzeige (B) zeigt sie pro Gast.

**Offene Fragen an dich:**
- Eigenes Relay im Homelab oder ein öffentlicher Dienst?
- Reicht für den Anfang D1 und D2 im selben Netz (LAN, ohne Relay, direkt per
  WebSocket)?
- Sollen Gäste Dateien sehen können (nur lesen) oder nur die Konversation?

---

## Aufteilung in parallele Arbeit

| Paket | Wo | Inhalt |
|---|---|---|
| 1 | eigene Session, eigener Branch | **D – Kollaboration**: Relay-Dienst (`relay/`), Protokoll, Verschlüsselung, Host- und Gast-Modus in Brise (D1 + D2), Docker-Image |
| 2 | eigene Session, eigener Branch | **B – Usage**: Journal, Preistabelle, Konto-Abfrage prüfen, Usage-Seite, Kopfzeilen-Balken, Warnungen |
| 3 | diese Session | **A – Auto-Reasoning** und **C – Tabs/geteilte Ansicht** (beide eng mit Composer und Store verbunden) |

Am Ende werden die Branches nacheinander nach `main` gemergt. Konflikte entstehen
vor allem in `store.ts` und `App.tsx`. Die Pakete halten Änderungen dort klein
und bauen neue Teile als eigene Dateien.
