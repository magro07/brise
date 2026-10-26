# ADR 0006 – Master-Session: Sessions planen, starten, steuern und zusammenführen

Stand: 26.10.2026 · Status: **umgesetzt** (siehe Testprotokoll)

## Anlass

Größere Aufgaben zerfallen in Teilaufgaben, die nebeneinander laufen können:
eine Session schreibt Code, eine zweite schreibt Tests, eine dritte prüft.
In Claude Code Desktop schlägt eine Hauptsession solche Teilaufgaben als Karten
vor, startet sie auf Wunsch als eigene Sessions (oft in eigenem Git-Worktree),
bekommt eine Notiz, sobald eine fertig ist, prüft das Ergebnis und merged.
Brise soll denselben Ablauf bieten, mit allen Backends (Vibe, Claude Code,
Codex, Gemini) und unter den Grenzen, die Brise schon kennt (Budget,
Team-Richtlinien).

## Entscheidung

### Rollen

- **Master-Session**: jede normale Session, die Untersessions startet. Es gibt
  keinen eigenen Session-Typ; eine Session wird zur Master-Session, sobald sie
  `start_session` benutzt.
- **Untersession**: eine Session, die eine Master-Session gestartet hat. Sie
  bekommt keine Orchestrierungs-Werkzeuge (nur eine Ebene, keine Kaskaden).

### Werkzeuge im MCP-Server `brise-app`

`brise --mcp-app` (siehe `customize.rs`) läuft als Kindprozess des Agenten und
bekommt zusätzliche Werkzeuge, solange die Funktion eingeschaltet und nicht per
Team-Richtlinie gesperrt ist:

| Werkzeug | Zweck |
| --- | --- |
| `start_session(title, task, backend?, model?, worktree?)` | Teilaufgabe vorschlagen bzw. starten |
| `list_sessions()` | eigene Untersessions mit Status und Branch |
| `get_session(session)` | Status, letzter Bericht, Branch, Commits, offene Änderungen |
| `send_message(session, text)` | Nachricht an eine Untersession (läuft sie, wird eingereiht) |
| `stop_session(session)` | laufenden Turn abbrechen, Untersession beenden |
| `merge_session(session)` | Freigabe zum Mergen des Branches anfragen |

Werkzeuge antworten sofort; alles, was auf den Nutzer oder eine Untersession
wartet, kommt später als **Notiz** (siehe unten). Grund: Vibe bricht
Werkzeugaufrufe nach 60 s ab, und eine Master-Session soll nicht blockieren,
während der Nutzer überlegt.

### Kanal zur laufenden App

Der MCP-Server darf keine zweite App-Instanz starten. Die App öffnet beim Start
einen TCP-Port nur auf `127.0.0.1` (Port vom System) und erzeugt ein zufälliges
Token (32 Byte). Beides bekommt der MCP-Server über seine Umgebung
(`BRISE_ORCH_ADDR`, `BRISE_ORCH_TOKEN`) – nur Kindprozesse der App kennen es,
es steht in keiner Datei und gilt nur bis zum nächsten Start.

Protokoll: eine Verbindung je Aufruf, eine Zeile JSON hin, eine zurück:

```json
→ {"token":"…","tag":"<Session-Kennung>","tool":"start_session","args":{…}}
← {"ok":true,"text":"…"}  bzw.  {"ok":false,"error":"…"}
```

Das Token wird in konstanter Zeit verglichen. Die aufrufende Session ergibt
sich aus der Session-Kennung, die schon die Secrets nutzen (`BRISE_SECRET_TAG`,
`n:<zufall>` bzw. `s:<id>`, siehe `secrets.rs`). Untersessions bekommen
zusätzlich `BRISE_ORCH_PARENT` und darum keine Orchestrierungs-Werkzeuge.

### Wer was macht

- **Rust (`orchestra.rs`)** führt Buch: Untersessions, Vorschläge und
  Merge-Anfragen in `<Datenordner>/orchestra/state.json` (ohne Inhalte von
  Prompts außer Titel/Auftrag, ohne Schlüssel). Es prüft Grenzen, legt
  Worktrees an, merged und baut die Notizen.
- **Oberfläche (`lib/orchestra.ts`)** startet die Sessions über den
  normalen Weg im Store (`createSession` + `send`). So gelten Nutzungsjournal,
  t/s-Messung, ZDR, Accounts und Richtlinien unverändert. Rust ruft die
  Oberfläche per Event `orch:call` und wartet auf `orch_reply`.

### Bestätigung durch den Nutzer

Einstellung **„Neue Sessions erst nach Bestätigung starten“** (Standard: an):

- an: `start_session` legt einen Vorschlag an; im Chat der Master-Session
  erscheint eine Karte mit Titel, Auftrag, Backend/Modell und Worktree und den
  Knöpfen **„Neue Session“** und **„Hier erledigen“**. Beides löst eine Notiz an
  die Master-Session aus („gestartet als …“ bzw. „erledige es selbst“).
- aus: `start_session` startet sofort und liefert die Session-ID.

Mergen braucht **immer** die Freigabe des Nutzers: `merge_session` legt eine
Merge-Karte an (Branch, Ziel, Commits, Diffstat) mit **„Mergen“** und
**„Ablehnen“**. Erst der Klick führt `git merge` aus.

### Worktrees

`worktree` (Standard aus den Einstellungen, an) legt für die Untersession einen
eigenen Worktree an:

```
git worktree add -b brise/<slug>-<4 hex> <Datenordner>/worktrees/<repo>-<hash>/<slug>-<4 hex> HEAD
```

Der Worktree liegt außerhalb des Repos, damit `git status` der Master-Session
sauber bleibt. Die Untersession bekommt vor ihrem Auftrag einen kurzen Rahmen
(Worktree, Branch, Basis, „committe deine Arbeit“, „schließe mit kurzem
Bericht“). Ohne Git-Repo oder mit `worktree: false` arbeitet sie im Ordner der
Master-Session.

Merge nach Freigabe, im Ordner der Master-Session:

1. Ziel = aktueller Branch dort; nicht committete Änderungen an versionierten
   Dateien → Abbruch mit Hinweis.
2. Untersession hat nicht committete Änderungen → Abbruch mit Hinweis (die
   Master-Session kann sie per `send_message` zum Committen auffordern).
3. `git merge --no-ff --no-edit <branch>`; bei Konflikten `git merge --abort`
   und Notiz mit den Konfliktdateien.
4. Danach `git worktree remove` (ohne `--force`) und `git branch -d`.

### Rückmeldung

Beendet eine Untersession einen Turn, meldet die Oberfläche das an Rust
(`orch_status`). Rust baut eine Notiz:

```
[Brise · Rückmeldung] Untersession „Tests schreiben“ ist fertig.
Branch brise/tests-schreiben-3f2a: 2 Commits vor main, sauber.
Bericht: …(letzte Antwort, gekürzt)…
Noch aktiv: 1 Untersession.
```

Die Oberfläche schickt die Notiz als Prompt an die Master-Session, wenn diese
wartet; läuft sie gerade, wird die Notiz eingereiht und nach dem Turn
(gebündelt) zugestellt. Notizen erscheinen im Chat mit dem Absender
„Brise · Untersessions“. Hat die Master-Session eine Untersession selbst
gestoppt, gibt es keine Notiz.

### Oberfläche

- Seitenleiste: Untersessions stehen eingerückt unter ihrer Master-Session mit
  Status (läuft, wartet auf Freigabe, fertig, Fehler, gestoppt, gemerged),
  Backend-Badge und Branch; Klick öffnet als Tab, Menü „Rechts daneben öffnen“.
  Worktree-Ordner erscheinen nicht als eigene Projekte.
- Chat der Master-Session: Vorschlags- und Merge-Karten; eine Leiste mit den
  Untersessions über dem Composer.
- Einstellungen → **Master-Session**: an/aus, Bestätigung, maximale Zahl
  gleichzeitiger Untersessions, Worktree als Standard.

### Backends, Modelle, Nutzung

`backend` und `model` sind je Untersession frei (z. B. Vibe mit GLM-5.3 für
Code, Claude Code für Reviews). Mit festem `model` greift die Auto-Modellwahl
nicht. Jeder Turn einer Untersession landet wie gewohnt im Nutzungsjournal,
zusätzlich mit `master` (Session-ID der Master-Session); die Nutzungsseite
zeigt die Summe je Master-Session.

### Grenzen

- **Gleichzeitige Untersessions**: Einstellung (Standard 3); gezählt werden
  startende, laufende und auf Freigabe wartende.
- **Monatsbudget**: Ist das eigene Monatsbudget (Nutzung) oder ein Team-Budget
  erreicht, startet keine Untersession. Prompts prüft `policy::check_prompt`
  wie bisher.
- **Team-Richtlinie**: neue Felder `orchestra` (`false` = gesperrt) und
  `maxSubSessions`. Gesperrt heißt: keine Werkzeuge, Bereich in den
  Einstellungen gesperrt. Backend- und Modell-Listen der Richtlinie gelten auch
  für Untersessions.

### Vibe wartet mit `wait`

Vibe 3 hat ein eingebautes Werkzeug `wait` (bis 10 Minuten), mit dem ein Agent
auf „eingehende Nachrichten“ wartet. Über ACP nimmt Vibe während eines Turns
aber keinen neuen Prompt an (`A turn is already running`, kein Steering). Eine
Master-Session, die nach `start_session` mit `wait` wartet, bekäme ihre Notiz
deshalb erst nach Ablauf. Zwei Gegenmittel:

- Werkzeugantworten und Anleitung sagen ausdrücklich „Turn beenden, nicht mit
  wait warten – die Notiz startet dich neu“.
- Wartet eine Session trotzdem nur im Werkzeug `wait` (letztes Element ist ein
  laufender `wait`-Aufruf, keine offene Freigabe), bricht Brise den Turn ab und
  stellt die Notiz danach zu. Dasselbe gilt für Nachrichten an Untersessions.

## Nachtrag: Kurator und Arbeiter (Stand 26.10.2026)

### Anlass

Ein sehr gutes Modell soll planen und prüfen, günstigere Modelle sollen die
Menge der Umsetzung erledigen.

### Entscheidung

- **Kurator** ist die Master-Session. Ihr Modell steht in den Einstellungen
  (Backend + Modell, z. B. Claude Code mit Opus oder Vibe mit Mistral Large 4).
  „Neue Kurator-Session“ (Projektmenü, Einstellungen) legt eine Session mit
  diesem Modell an; das Modell bleibt fest (keine Auto-Modellwahl). Der Kurator
  plant, schreibt Aufträge, prüft (Tests, `council_review`) und entscheidet über
  Nacharbeit, Eskalation und Merge.
- **Arbeiter-Pool**: geordnete Liste `{backend, model, tier}` mit Stufe 1
  (günstig/schnell) bis 3 (stark). Standard: Vibe GLM-5.3 (1), Mistral Medium
  3.5 (2), Mistral Large 4 (3).
- **Automatische Wahl** bei `start_session` ohne `model`: Schwierigkeit
  `difficulty` gibt der Kurator an (er ist das starke Modell), sonst stuft
  `assist::classify_task` ein. Abbildung: einfach und normal → Stufe 1,
  komplex → Stufe 2; Stufe 3 bleibt der Eskalation vorbehalten. Innerhalb einer
  Stufe gewinnt der niedrigste Preis laut Preistabelle, bei Gleichstand die
  höhere mittlere t/s laut Journal. Ist das Budget des Laufs zu 70 % verbraucht,
  wird nur noch Stufe 1 gewählt. Denkstufe: einfach → niedrig, normal → mittel,
  komplex → hoch, Eskalation → maximal (jeweils die nächste, die das Modell kann).
  Modelle und Backends, die die Team-Richtlinie nicht erlaubt, fallen aus dem Pool.
- **Eskalation**: `escalate_session(session, feedback)` hebt eine Untersession
  auf die nächsthöhere Stufe. Gleiches Backend: Modell und Denkstufe in der
  Session wechseln, Feedback als Nachricht (Verlauf bleibt). Anderes Backend:
  neue Session im selben Worktree mit Auftrag und Feedback; die alte gilt als
  „eskaliert“. Scheitert ein Arbeiter (Fehler, Token- oder Schrittlimit),
  eskaliert Brise selbst. Höchstens `maxEscalation` Stufen je Teilaufgabe.
- **Budget je Master-Lauf**: Kosten von Kurator und Arbeitern laut Journal
  (Feld `master`). Ist es erreicht, starten und eskalieren keine Arbeiter mehr.
- **Sichtbarkeit**: Leiste und Seitenleiste zeigen Modell, Stufe und
  Eskalationen je Arbeiter; Kosten „Kurator“ und „Arbeiter“ je Master-Session
  in der Leiste und auf der Nutzungsseite.

### Abos und geteilte Sessions

Claude-Code-Sessions laufen über das Claude-Abo des Nutzers (Pro/Max). Nach
Anthropics Bedingungen ist das Abo persönlich; es darf nicht als Kurator für
andere Personen arbeiten. Brise setzt das so um, wie es selbst prüfen kann:

- Eine Master-Session, die gerade mit Gästen geteilt ist, darf keine
  Untersessions über das Backend `claude` starten, und eine geteilte
  Claude-Code-Session bekommt keine Orchestrierung (Werkzeugaufruf wird
  abgelehnt).
- Gäste lösen in geteilten Sessions ohnehin nur Prompts beim Host aus; ob ein
  Host sein Abo anderweitig teilt, kann Brise nicht prüfen – das bleibt in der
  Verantwortung des Nutzers. Für Teams ist ein API-Schlüssel (Anthropic Console)
  oder ein anderes Backend der passende Weg.

### Grenzen

- Kosten von Cortecs-Turns erfasst `cortecs.rs` direkt am Proxy, ohne Zuordnung
  zur Master-Session; sie fehlen in den Kurator-/Arbeiter-Summen.
- Claude-Code-Turns stehen ohne Preis im Journal (Abo, Preistabelle kennt keine Claude-Modelle): Tokens ja, Euro 0.

## Verworfen

- **Unix-Socket / Named Pipe**: je Betriebssystem eigener Code; TCP auf
  127.0.0.1 mit Token läuft überall gleich.
- **Datei-Warteschlange wie bei den Secrets**: Abfragen im Takt sind für
  Steuerbefehle zu träge; Notizen müssen sofort kommen.
- **Sessions direkt aus Rust starten** (wie Benchmarks): dann liefen sie an
  Store, Nutzungsjournal, ZDR und Account-Wechsel vorbei und wären in der
  Oberfläche nicht wie normale Sessions bedienbar.
- **Blockierende Werkzeuge** (warten auf Nutzer bzw. Turn-Ende): scheitern am
  60-s-Timeout von Vibe.

## Grenzen und offene Punkte

- Untersessions laufen nur, solange Brise läuft; nach einem Neustart sind sie
  „unterbrochen“ und können per `send_message` fortgesetzt werden.
- Kein automatisches Rebase; bei Konflikten entscheidet der Nutzer bzw. die
  Master-Session.
- Geteilte Sessions (Collab): Gäste sehen Untersessions nicht.

## Testprotokoll (26.10.2026)

Echter Durchlauf unter Xvfb mit `tauri-driver` (WebDriver), eigenem
`BRISE_DATA_DIR`, `VIBE_HOME` und `XDG_DATA_HOME`, Vibe 3.0.2 mit GLM-5.3,
Test-Repo mit `calc.py` und `README.md`:

1. Prompt an die Master-Session: zwei Teilaufgaben („Multiplizieren“: `multiply`
   in `calc.py`; „Doku“: Abschnitt in `README.md`), je in eigenem Worktree.
2. Zwei Vorschlagskarten erscheinen; Klick auf „Neue Session“ → Untersessions in
   `<Datenordner>/worktrees/proj-<hash>/…` auf `brise/multiplizieren-…` bzw.
   `brise/doku-…`, in der Seitenleiste unter der Master-Session.
3. Beide committen; die Master-Session bekommt je eine Rückmeldung, prüft mit
   `get_session` und ruft `merge_session` für beide auf.
4. Zwei Merge-Karten; Klick auf „Mergen“ → `git merge --no-ff` in `main`,
   Worktrees und Branches entfernt, Notizen an die Master-Session, die den
   Endstand prüft. Nutzungsjournal: Untersession-Turns mit `master`.

Letzter Lauf vollautomatisch in 99 s (Karten nach 10 s, beide Untersessions
nach 32 s fertig, Merges nach 47 s). Außerdem geprüft: Warten per `wait` wird
abgebrochen und die Notiz kommt sofort (ca. 18 s nach dem Start der
Untersession); „Master-Session erlauben“ aus → keine Werkzeuge im MCP-Server und
`blocked` gesetzt; Nutzungsseite zeigt die Kosten je Master-Session.
Unit-Tests: Worktree anlegen, committen, mergen, aufräumen mit echtem Git;
Sperre per Team-Richtlinie (strengste Kombination).

Nicht getestet: Claude Code, Codex und Gemini als Backend einer Untersession
(hier nicht angemeldet), Merge-Konflikte in der Oberfläche (nur der Abbruchpfad
im Code), Sperre über einen echten Team-Stand.

### Testprotokoll Kurator und Arbeiter (26.10.2026)

Echter Lauf wie oben (Xvfb, tauri-driver, Vibe 3.0.2). „Neue Kurator-Session“
legte eine Session mit Mistral Large 4 an (Modell fest, trotz Auto-Modellwahl).
Auftrag: `multiply` in `calc.py` und `divide` in `division.py`, Abnahme
`tests/check.py`, ohne Modellvorgabe.

- Der Kurator las das Repo, setzte `difficulty: "simple"`; Brise wählte beide
  Arbeiter aus dem Pool: Vibe GLM-5.3, Stufe 1, angeforderte Denkstufe „low“
  („Automatik: einfach → Stufe 1“).
- Beide Arbeiter committeten nach 27 bzw. 40 s. Der Kurator führte
  `tests/check.py` in jedem Worktree aus – rot, weil die Prüfung beide Teile
  verlangt (Fehler im Testaufbau, nicht bei den Arbeitern) – und eskalierte
  beide mit `escalate_session` auf Mistral Medium 3.5 (Stufe 2, Modellwechsel in
  derselben Session, Feedback mit der Testausgabe).
- Die eskalierten Arbeiter bauten daraufhin auch den jeweils anderen Teil. Nach
  der Freigabe wurde der erste Branch gemerged; der zweite kollidierte in
  `calc.py`, Brise brach mit `git merge --abort` ab, `main` blieb sauber, die
  Master-Session bekam die Notiz mit der Konfliktdatei.
- Kosten laut Leiste: Kurator 0,31 € (700 k Tokens), Arbeiter 0,11 € (je
  Session und Modell getrennt im Journal). Bei so kleinen Aufgaben kostet das
  Kuratieren mehr als die Umsetzung.

Folgerung im Code: Arbeiter bekommen den Hinweis, keine Teile anderer
Untersessions nachzubauen; der Kurator prüft je Untersession nur deren Teil
und eskaliert nur bei echten Mängeln.

Nicht live getestet: automatische Eskalation nach einem Fehler des Arbeiters
(Logik per Unit-Test der Auswahl), Eskalation auf ein anderes Backend,
Claude Code als Kurator (hier nicht angemeldet), Abo-Schutz in einer
geteilten Session.
