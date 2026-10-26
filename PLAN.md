# Brise – Desktop-App für Mistral Vibe

> Arbeitstitel „Brise“ (der Mistral ist ein Wind). Ziel: eine schöne, plattformübergreifende
> Desktop-App (macOS, Windows, Linux) im Stil von Claude Code Desktop – nur für Mistral Vibe,
> mit Anmeldung über den **Mistral-Vibe-Plan** statt eines bezahlten La-Plateforme-API-Keys.
> Ohne Terminal und ohne CLI-Kenntnisse.

Stand der Recherche: 26.10.2026, Mistral Vibe 3.0.2.

---

## 1. Recherche-Ergebnisse

### 1.1 Mistral Vibe selbst

- Repo: <https://github.com/mistralai/mistral-vibe> – **Apache-2.0**, Python + Rust-TUI, sehr aktiv.
- Bringt bereits alles mit, was eine Coding-Agent-Engine braucht: Tools (read/write/edit,
  bash, grep, todo, ask_user_question, Subagents), Skills, MCP, Sessions, Worktrees, Approvals.
- Drei mitgelieferte Schnittstellen, die eine GUI nutzen kann:
  1. **`vibe-acp`** – Agent Client Protocol (JSON-RPC über stdin/stdout). Offizieller Weg für
     Editoren (Zed, JetBrains, Xcode, VS Code-Extension).
  2. **`vibe-app-server`** – eigenes App-Server-Protokoll „for desktop integration“
     (laut Changelog), kaum dokumentiert und nicht stabil zugesagt.
  3. `vibe -p --output streaming` – nur für Einzelläufe, für eine Chat-App ungeeignet.
- **Anmeldung über den Plan („Vibe-Key“) funktioniert über ACP.** Lokal geprüft:
  `vibe-acp` meldet beim `initialize`

  ```json
  "authMethods":[{"id":"browser-auth","name":"Sign in through Mistral AI Studio", ...}]
  ```

  Das ist die Browser-Anmeldung mit dem Mistral-Konto; Vibe Code läuft dann über das
  im Plan enthaltene Kontingent (Free/Pro/Team), nicht über Pay-per-Token-API.
  Alternativ akzeptiert Vibe den Key aus *Code › Vibe CLI* im Studio. Gespeichert wird
  im OS-Keyring (Keychain / Credential Manager / Secret Service).
  → **Die App muss Authentifizierung nicht selbst bauen**, sie ruft nur `authenticate`
  mit `browser-auth` auf.

### 1.2 Gibt es das schon?

| Projekt | Was es ist | Bewertung |
|---|---|---|
| **Mistrals eigene „Vibe Desktop“** | Taucht im Vibe-Changelog auf (Sessions-Sidebar, Worktrees, Loops, Import aus anderen Agents). | In den öffentlichen Docs nicht als Download zu finden – vermutlich Rollout/Beta. **Zuerst prüfen**, ob du im Studio unter Vibe Code einen Desktop-Download siehst. Falls ja, ist ein eigener Nachbau fragwürdig. |
| **AionUi** (iOfficeAI/AionUi) | Electron-App, Apache-2.0, ~34k Sterne, Win/macOS/Linux. GUI für 20+ CLI-Agents über ACP, **Mistral Vibe ausdrücklich unterstützt**. | Reif und sofort nutzbar – aber Multi-Agent-„Cowork“-App, nicht auf Vibe fokussiert, entsprechend überladen. |
| **VibeDeck** (Dragonk/vibedeck) | Native Rust-GUI (egui) für `vibe-acp`, Apache-2.0. Vorgänger mistral-vibe-nexus (Electron). | Genau unsere Idee, aber brandneu (0 Sterne, Stand heute). egui sieht eher nach Tool als nach „schöner App“ aus. |
| **VibeZ** (lecomputeur/vibez) | Tauri-Wrapper um die Webseite von Mistral Vibe. | Nur Web-Chat im Fenster, **kein lokaler Coding-Agent**. Passt nicht. |
| Diverse kleine Repos (mistral-vibe-desktop, Vibe-Desktop …) | Meist reine macOS-Webview-Wrapper. | Uninteressant. |

**Fazit:** Es gibt einen nutzbaren Weg (AionUi) und einen sehr jungen fokussierten Versuch
(VibeDeck), aber noch keine *polierte, Vibe-fokussierte* plattformübergreifende App.
Die Lücke ist echt – solange Mistrals eigene Desktop-App nicht öffentlich ist.

### 1.3 Warum nicht Claude Code forken?

- **Rechtlich nicht möglich.** Claude Code und die Claude-Desktop-App sind proprietär
  („All rights reserved“, Nutzung unter Anthropics kommerziellen Bedingungen). Das
  npm-Paket ist minifiziertes Bundle, kein Quellcode zum Weiterverwenden – auch geleakte
  Quellstände dürfen nicht benutzt werden.
- **Technisch unnötig.** Claude Code ist im Kern die *Agent-Engine*. Diese Engine hat
  Mistral mit Vibe bereits als Open Source gebaut. Was fehlt, ist nur die *Desktop-Hülle*
  – genau so, wie die Claude-Desktop-App eine Hülle um Claude Code ist.

Wir übernehmen also die **Ideen und UX-Muster** von Claude Code Desktop (Projekte,
Sessions-Sidebar, Diff-Ansicht, Approvals, Task-Liste, Worktrees), aber nicht den Code.

---

## 2. Strategie-Optionen

| | Option | Aufwand | Ergebnis |
|---|---|---|---|
| A | AionUi installieren und nutzen | Minuten | Funktioniert sofort, aber nicht „deine“ App. |
| B | VibeDeck oder AionUi forken | mittel | Startpunkt vorhanden, aber fremde Architektur (egui bzw. riesige Multi-Agent-Codebasis). |
| **C** | **Eigene App: Tauri 2 + React/TypeScript, Vibe über ACP** | **hoch, aber gut planbar** | **Saubere, fokussierte App nach deinen Vorstellungen.** |

**Empfehlung: C**, aber vorher 30 Minuten AionUi ausprobieren, um zu sehen, was dich
an bestehenden Lösungen stört – das ist die beste Feature-Liste.

---

## 3. Architektur (Option C)

```
┌──────────────────────────── Brise (Tauri 2) ────────────────────────────┐
│  Frontend: React + TypeScript + Tailwind + shadcn/ui                   │
│   ├─ Projekt-/Session-Sidebar      ├─ Chat mit Markdown/Code-Blöcken    │
│   ├─ Approval-Karten (Bash/Edit)   ├─ Diff-Viewer (Monaco Diff)         │
│   ├─ Task-/Todo-Panel              ├─ Datei-Baum + @-Erwähnungen         │
│   └─ Einstellungen, Onboarding     └─ eingebettetes Terminal (xterm.js)  │
│                    ▲  Tauri-Events / Commands                           │
│  Backend (Rust):                                                        │
│   ├─ ACP-Client (Crate `agent-client-protocol`)                         │
│   ├─ Prozess-Manager: startet 1× `vibe-acp` pro Projekt                │
│   ├─ fs/terminal-Handler für ACP-Rückfragen des Agents                  │
│   ├─ Git/Worktree-Helfer (git2)                                         │
│   └─ Vibe-Bootstrap: prüft/installiert uv + mistral-vibe automatisch   │
└───────────────────────────────▲─────────────────────────────────────────┘
                                │ JSON-RPC (stdio)
                       ┌────────┴────────┐
                       │    vibe-acp     │  ← Mistral Vibe (Apache-2.0)
                       │  Agent-Engine   │  ← Auth: browser-auth / Keyring
                       └────────┬────────┘
                                │ HTTPS
                         Mistral-Plan (Vibe Code)
```

Warum so:

- **Tauri 2** statt Electron: kleine Installer (~10 MB statt 150 MB), echte Installer für
  alle drei OS (DMG, MSI/NSIS, AppImage/DEB/RPM/Flatpak), Auto-Updater eingebaut.
- **ACP** statt `vibe-app-server`: offiziell, versioniert, von Zed/JetBrains genutzt →
  bricht nicht bei jedem Vibe-Update. Bonus: die App könnte später jeden ACP-Agent sprechen.
- **Vibe nicht forken**, sondern als Abhängigkeit nutzen. So bekommen wir alle
  Verbesserungen von Mistral gratis. Nur wenn ACP etwas nicht hergibt, Upstream-Issue
  stellen (Mistral nimmt keine PRs an).
- **Kein Terminal für den Nutzer:** Beim ersten Start prüft die App, ob `vibe-acp`
  vorhanden ist. Wenn nicht, installiert sie `uv` und `mistral-vibe` still im
  App-Datenverzeichnis (eigene Python-Umgebung, kein Systemeingriff). Später optional:
  Vibe direkt mitbündeln.

---

## 4. Funktionsumfang

### MVP (v0.1) – „Es funktioniert, ohne Terminal“

1. Onboarding: Vibe automatisch installieren → „Mit Mistral anmelden“ (browser-auth).
2. Projektordner wählen (Ordner-Dialog, Trust-Abfrage wie bei Vibe).
3. Chat mit Streaming, Markdown, Code-Highlighting, Abbrechen-Knopf.
4. Tool-Aufrufe als aufklappbare Karten; **Freigabe-Dialoge** für Bash/Edits
   (Modi: Fragen / Edits automatisch / Alles automatisch).
5. Diff-Anzeige für jede Dateiänderung.
6. Session-Liste pro Projekt, Sessions fortsetzen (`session/load`, `session/list`).
7. Installer für alle drei Plattformen aus GitHub Actions.

### v0.2 – „Wie Claude Code Desktop“

- Todo-/Task-Panel (Vibe-`todo`-Tool), Rückfragen (`ask_user_question`) als Buttons.
- Modell-/Agent-Auswahl (ask, accept-edits, auto-approve, eigene Agents).
- Bilder per Drag & Drop, `@`-Dateierwähnungen mit Autovervollständigung.
- Git-Panel: Änderungen, Commit, Branch, **Worktree pro Session** (parallel arbeiten).
- Eingebettetes Terminal für Befehlsausgaben.
- Verbrauchsanzeige (`/whoami`, Plan-Kontingent).

### v0.3+ – Komfort

- MCP-Server und Skills grafisch verwalten (statt `config.toml` editieren).
- Mehrere Sessions parallel in Tabs/Split-View, Benachrichtigungen bei „fertig“/„wartet“.
- Spracheingabe (Vibe hat Voice-Mode), Deutsch/Englisch-UI.
- Optional: lokale Modelle (Vibe kann offline mit lokalen Modellen).

---

## 5. Meilensteine

| # | Schritt | Ergebnis |
|---|---|---|
| 0 | Mistrals „Vibe Desktop“-Verfügbarkeit klären, AionUi kurz testen | Go/No-Go, Wunschliste |
| 1 ✅ | Spike: Rust-Konsolenprogramm spricht ACP mit `vibe-acp` (init, auth, prompt, Streaming, Permission) – siehe [spikes/acp-cli](spikes/acp-cli/README.md) | Protokoll verstanden, Risiken weg |
| 2 | Tauri-Grundgerüst + Chatfenster + Streaming | erster sichtbarer Chat |
| 3 | Approvals, Tool-Karten, Diffs | sicher benutzbar |
| 4 | Onboarding mit Auto-Installation + Login | ohne Terminal startbar |
| 5 | Sessions, Projekte, Einstellungen | MVP fertig |
| 6 | CI-Builds + Signierung (macOS-Notarisierung braucht Apple-Developer-Konto, 99 $/Jahr; Windows-Signierung optional) | Installer für alle OS |

---

## 6. Risiken und offene Fragen

- **Mistral veröffentlicht eigene Desktop-App** → Projekt wird evtl. überflüssig.
  Gegenmittel: früh klären (Meilenstein 0); die App ist ohnehin ACP-generisch.
- **ACP deckt nicht alles ab**, was Vibe Desktop über `vibe-app-server` kann
  (z. B. Worktree-Verwaltung, Loops). Gegenmittel: Git/Worktrees selbst in Rust erledigen.
- **Windows:** Vibe ist dort „unterstützt, aber nicht Ziel“. Früh testen.
- **Markenrecht:** „Mistral“/„Vibe“ nicht im App-Namen oder Logo verwenden,
  klar als inoffizielles Projekt kennzeichnen.
- **Lizenz der eigenen App:** Vorschlag Apache-2.0 (kompatibel mit Vibe).

---

## 7. Entscheidungen, die du treffen solltest

1. Option A, B oder C? (Empfehlung: C)
2. Name – „Brise“ okay?
3. Open Source auf GitHub oder erstmal privat?
4. Ist Mac-Signierung (Apple-Developer-Konto) relevant, oder reicht dir zunächst Linux/Windows?
