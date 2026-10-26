# Kollaborationsprotokoll (v1)

Stand: Stufen D1 (Live ansehen) und D2 (Mitarbeiten) aus `PLAN-v2.md`, dazu Teile
von D3/D5: Teams mit Präsenz, Sessions der anderen und gemeinsamer Projektliste.

## Grundsatz

Der Agent läuft immer auf genau einem Rechner, dem **Host**, mit dessen Dateien,
Schlüsseln und Mistral-Plan. **Gäste** verbinden sich mit einer geteilten
Session. Über die Leitung gehen nur Konversation, Diffs, Freigabe-Anfragen und
Steuernachrichten. Dateien, Mistral-Key und Vibe-Konfiguration verlassen den
Host nie.

```
 Host (Brise + Vibe)  ⇄  Relay (WebSocket)  ⇄  Gäste (Brise)
          └── Ende-zu-Ende verschlüsselt: das Relay sieht nur Chiffretext
```

Als Relay dient entweder der eigenständige Dienst `relay/` (z. B. im Homelab
hinter einem Reverse-Proxy mit TLS) oder, für Gäste im selben Netz, das in
Brise eingebaute LAN-Relay (gleicher Code, Port 47800).

## Einladungslink

```
brise://join/<raum>?relay=<url>&exp=<unix-sekunden>#<schlüssel>.<host-id>
```

| Teil | Inhalt |
|---|---|
| `raum` | 16 Zufallsbytes, base64url (22 Zeichen). Adressiert den Raum auf dem Relay. |
| `relay` | WebSocket-Adresse des Relays (`ws://…` oder `wss://…`), prozentkodiert. |
| `exp` | optional, Ablauf des Links. Danach nimmt der Host keine neuen Teilnehmer an. |
| `schlüssel` | 32 Zufallsbytes, base64url. Symmetrischer Raumschlüssel. |
| `host-id` | öffentlicher Ed25519-Schlüssel des Hosts (seine Identität), base64url. |

Schlüssel und Host-ID stehen im **Fragment** (nach `#`). Das Relay bekommt nur
`GET /ws/<raum>` zu sehen. Den Raumschlüssel erzeugt der Host für jede Freigabe
neu und hält ihn nur im Arbeitsspeicher. Wer den Link hat, kann mitlesen: Er ist
wie ein Passwort zu behandeln.

## Identität

Jede Brise-Installation hat eine feste Ed25519-Identität. Ihr öffentlicher
Schlüssel ist die Teilnehmer-ID. Seed und Team-Schlüssel liegen im Schlüsselbund
(Dienst `dev.brise.app`), ersatzweise in `<Datenordner>/collab.json` mit Rechten
nur für den Nutzer. So erkennt ein Host Teammitglieder wieder und gibt ihnen die
Team-Rolle.

## Relay

- `GET /ws/<raum>`: WebSocket. Jeder Binär-Frame eines Teilnehmers geht an alle
  anderen im selben Raum. Text-Frames werden ignoriert.
- Optionaler **Puffer**: die letzten N Frames (Standard 256, max. 16 MiB) je
  Raum. Wer neu beitritt, bekommt sie zuerst. Leere Räume bleiben samt Puffer
  10 Minuten erhalten, dann werden sie gelöscht.
- `GET /healthz`: `{"status":"ok","rooms":…,"connections":…}`.
- Ping alle 30 s. Ein zu langsamer Empfänger wird getrennt, verbindet neu und
  bekommt einen frischen Snapshot.

Das Relay speichert nichts auf Platte und kennt weder Schlüssel noch Namen.

## Frames

```
frame    = nonce(24 Byte) ‖ XChaCha20-Poly1305(raumschlüssel, nonce, umschlag, aad)
aad      = "brise-collab-v1:" + raum
umschlag = {"from": <ed25519-public base64url>, "sig": <signatur base64url>, "body": <JSON als String>}
sig      = Ed25519(absender, "brise-collab-v1:" + raum + ":" + body)
```

- Jede Nachricht hat eine zufällige Nonce.
- Die Signatur bindet die Nachricht an Absender und Raum. Gäste haben den
  Raumschlüssel und könnten verschlüsseln, aber nicht als Host signieren.
- Gäste akzeptieren nur Nachrichten, deren `from` der Host-ID aus dem Link
  entspricht. Der Host ordnet Gast-Nachrichten über `from` einem Teilnehmer zu.

## Rollen

| Rolle | Darf |
|---|---|
| `viewer` (Betrachter) | live zusehen |
| `collaborator` (Mitarbeiter) | zusätzlich Prompts in die Warteschlange des Hosts stellen, den laufenden Turn abbrechen |
| `approver` (Freigeber) | zusätzlich Freigabe-Anfragen entscheiden |

Neue Teilnehmer bekommen die Standardrolle der Freigabe (Standard: Betrachter),
Mitglieder eines gemeinsamen Teams die Team-Rolle (Standard: Mitarbeiter).
Der Host verkündet Rollen mit der signierten Nachricht `roster`. Durchgesetzt
werden sie **beim Host**: Er verwirft Nachrichten, die die Rolle des Absenders
nicht erlaubt. „Freigabe entziehen“ entfernt einen Teilnehmer und verwirft
alle weiteren Nachrichten seiner ID. Mitlesen kann er mit dem Link weiterhin,
für einen vollständigen Ausschluss beendet der Host die Freigabe und teilt neu
(neuer Raum, neuer Schlüssel).

„Immer erlauben“ (dauerhaft, schreibt in Vibes Konfiguration) bleibt dem Host
vorbehalten. Gäste sehen diese Option nicht, der Host lehnt sie ab.

## Nachrichten

Jede Nachricht ist ein JSON-Objekt mit Typ `t`.

### Host → alle

Jede Host-Nachricht trägt eine fortlaufende Nummer `seq`. Gäste verarbeiten
Ereignisse nur in aufsteigender Reihenfolge und erst nach einem Snapshot.

| `t` | Felder | Bedeutung |
|---|---|---|
| `snapshot` | `session: {title, cwd, running, elapsed, currentMode, plan, usage, items, pending}` | vollständiger Stand der Session (Store-Format). Kommt nach jedem `hello`. |
| `update` | `update` | ein ACP-`session/update` von Vibe, unverändert (Text, Gedanken, Werkzeugaufrufe, Plan, Nutzung, Titel …) |
| `prompt` | `text, author, attachments?, backend, billedTo` | ein Turn beginnt (Prompt des Hosts oder ausgeführter Gast-Prompt) |
| `turn_end` | `stopReason, ms, tokens?, backend, billedTo` | der Turn ist zu Ende |
| `notice` | `text, tone` | Hinweis in der Konversation (Fehler, „Anna hat freigegeben“) |
| `permission` | `key, request: {toolCall, options}` | Vibe bittet um Freigabe |
| `permission_closed` | `key, optionId` | Freigabe entschieden oder abgebrochen |
| `roster` | `host: {id, name}, participants: [{id, name, role, online, prompts, tokens}], expires, backend, billedTo, policy` | Teilnehmer, Rollen, Abo-Regeln, Nutzung heute |
| `rejected` | `to, ref, reason` | Gast-Prompt abgelehnt (Abo-Regeln, Tageslimit, Warteschlange voll); nur für `to` gedacht |
| `queue` | `items: [{id, author, authorId, text}]` | Warteschlange der Gast-Prompts |
| `ended` | – | der Host hat die Freigabe beendet |

### Gast → Host

Jede Gast-Nachricht hat eine zufällige `id`. Der Host verwirft doppelte IDs.

| `t` | Felder | Rolle | Bedeutung |
|---|---|---|---|
| `hello` | `name` | alle | Anmeldung, auch nach jedem Neuverbinden. Der Host antwortet mit `roster`, `queue`, `snapshot`. |
| `presence` | `state` | alle | Lebenszeichen alle 20 s. Nach 60 s ohne gilt ein Gast als abwesend. |
| `bye` | – | alle | Gast verlässt die Session. |
| `prompt` | `text` | Mitarbeiter | Prompt in die Warteschlange (max. 20 Einträge, 50 000 Zeichen) |
| `cancel` | – | Mitarbeiter | laufenden Turn abbrechen |
| `decide` | `key, optionId` | Freigeber | Freigabe-Anfrage entscheiden (`optionId: null` = abbrechen) |

## Agent-Backend und Abo

Jede geteilte Session trägt:

| Feld | Bedeutung |
|---|---|
| `backend` | Agent-Backend der Session, heute `vibe`, künftig z. B. `claude-code` (über ACP) |
| `billedTo` | `{id, name, plan}`: wessen Abo bzw. Kontingent die Session nutzt – immer der Host |
| `policy` | `{guestPrompts, dailyPrompts, dailyTokens}`: was Gäste auf dieses Abo dürfen |

Der Host legt fest, ob Gäste überhaupt Prompts auf sein Abo schicken dürfen und
mit welchen Tageslimits je Gast (Prompts und/oder Tokens, Zählung pro Kalendertag
UTC). Abgelehnte Prompts beantwortet er mit `rejected`. Wer kein eigenes Abo hat,
arbeitet so in den Sessions anderer mit.

Für die Usage-Anzeige (Paket B) meldet Rust beim Host nach jedem Turn das Tauri-Event
`collab:usage` mit `{sessionId, backend, billedTo, authorId, authorName, tokens}`.
`authorId` ist `null` bei eigenen Prompts des Hosts.

## Teams

Ein Team ist ein dauerhafter Raum auf dem Relay mit eigenem Schlüssel:

```
brise://team/<team-id>?relay=<url>&name=<name>&owner=<besitzer-id>#<team-schlüssel>
```

Wer den Link hat, gehört dazu. `owner` ist die Ed25519-ID dessen, der das Team
angelegt hat; sie ist der Vertrauensanker für Admin-Rechte (fehlt bei alten Links). Team-ID und Schlüssel speichert jedes Mitglied
(siehe Identität), Brise verbindet beim Start alle Teams. Frames wie oben,
signiert mit der eigenen Identität, AAD mit der Team-ID.

| `t` | Felder | Bedeutung |
|---|---|---|
| `announce` | `id, name, backends: [{id, label, plan, active}], sessions: [{sessionId, title, project, backend, billedTo, policy, link, running, participants}]` | alle 25 s und bei Änderungen. Nach 75 s Stille gilt ein Mitglied als abwesend. |
| `projects` | `id, items: [{id, name, repo?, note?, addedBy?}], at` | gemeinsame Projektliste, der neueste Stand (`at`) gewinnt |
| `state` | `id, doc: {by, sig, body}` | signierter Team-Stand: Admins, Richtlinien, entfernte Mitglieder, Audit-Log. Jeder reicht den neuesten an Nachzügler weiter. |
| `bye` | `id` | Mitglied verlässt das Team |

Der Team-Stand ist unabhängig vom Frame signiert
(`Ed25519(by, "brise-team-v1:" + team + ":" + body)`) und wird nur übernommen,
wenn `by` der Besitzer oder ein bisheriger Admin ist und die Version steigt.
Einzelheiten, Richtlinien und Grenzen der Durchsetzung:
`docs/adr/0005-team-workspaces.md`. Hosts lehnen Gast-Prompts von Mitgliedern ab,
deren Team-Limit für geteilte Abos (`sharedDailyPrompts`, `sharedDailyTokens`)
erreicht ist, und buchen deren Nutzung in `<Datenordner>/team-usage.json`.

In `sessions` steht der Beitritts-Link der geteilten Session. Teammitglieder
treten mit einem Klick bei; der Host erkennt sie an der Identität und gibt ihnen
die Team-Rolle. Projekte enthalten nur Name und Git-Adresse, keine Dateien.

## Was Gäste sehen

Standard: **Konversation und Diffs.** Vor dem Versand entfernt der Host aus
Werkzeugaufrufen alle Ausgaben außer Diffs (`content` vom Typ `content`,
`rawOutput`). Gelesene Dateien, Suchergebnisse und Befehlsausgaben bleiben
damit beim Host. Mit der Option „Werkzeug-Ausgaben zeigen“ gehen sie mit.
Anhänge erscheinen nur mit Namen, ohne Pfad.

## Ablauf beim Host

1. „Session teilen“ erzeugt Raum, Schlüssel und Host-Identität, verbindet mit
   dem Relay (bzw. startet das LAN-Relay) und stellt den Freigabe-Modus der
   Session auf „Alles fragen“.
2. Brise spiegelt alle ACP-Updates, Freigaben, Prompts und Turn-Enden der
   Session (`src/lib/collab.ts`). Die Oberfläche übergibt sie in Reihenfolge an
   Rust (`collab_publish`), Rust nummeriert, filtert, signiert und verschlüsselt.
3. Gast-Prompts landen in der Warteschlange. Der Host führt sie aus („Ausführen“)
   oder lässt sie automatisch laufen, sobald die Session frei ist (Slash-Befehle
   immer nur von Hand). Sie laufen mit den Rechten und auf Kosten des Hosts.
4. Freigaben entscheidet der Host oder ein Freigeber. Die Entscheidung eines
   Freigebers erscheint beim Host als Hinweis in der Konversation.

## Ablauf beim Gast

1. „Einer Session beitreten“ (Sidebar → Projekt-Menü, oder Strg+K) nimmt den Link.
2. Brise verbindet mit dem Relay, schickt `hello` und baut aus dem Snapshot
   eine nur lesbare Session im vorhandenen Store auf (`collab-<raum>`). Updates
   laufen durch dieselbe Logik wie beim Host.
3. Mit Rolle Mitarbeiter erscheint statt des normalen Composers ein Eingabefeld
   für Vorschläge an den Host. Freigeber sehen Freigabe-Anfragen wie gewohnt.

## Grenzen und offene Punkte

- Der Raumschlüssel ist für alle Teilnehmer gleich. Ein Gast mit Link kann alte
  Host-Frames erneut einspielen. Das verändert nur Ansichten anderer Gäste,
  keine Rechte, denn Rollen setzt der Host durch.
- Entfernen eines Gasts sperrt seine Beiträge, nicht sein Mitlesen (siehe Rollen).
- `brise://`-Links werden noch nicht vom System geöffnet, sie werden eingefügt.
- Präsenz beschränkt sich auf online/abwesend. „Tippt gerade“ und Kommentare
  folgen mit D3.
- Entfernte Teammitglieder verlieren Team-Rolle und Sichtbarkeit, können den
  Team-Raum aber bis zu einer Schlüsselrotation weiter mitlesen (ADR 0005).
- Ein Team über das LAN-Relay ist nur erreichbar, solange Brise beim Anleger läuft.
