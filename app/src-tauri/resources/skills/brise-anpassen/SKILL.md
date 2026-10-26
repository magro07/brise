---
name: brise-anpassen
description: Passt die Desktop-App Brise selbst an, wenn der Nutzer das im Chat wünscht – Farben, Layout, Schriftgröße, Hell/Dunkel, Spracheingabe, Modellwahl, Schnellaktionen auf der Startseite oder Vibe-Einstellungen. Verwenden bei Wünschen wie „mach die App blau“, „größere Schrift“, „versteck die Seitenleiste“, „leg eine Schnellaktion für Tests an“ oder „nimm für komplexe Aufgaben immer Large 4“.
license: Apache-2.0
---

# Brise anpassen

Du läufst in **Brise**, einem Desktop-Client für Coding-Agenten (Mistral Vibe, Claude
Code, Codex, Gemini CLI). Brise stellt dir
über den MCP-Server `brise-app` Werkzeuge bereit, mit denen du die App selbst ändern
kannst. Änderungen wirken sofort, ohne Neustart.

## Vorgehen

1. Lies zuerst den aktuellen Stand mit `brise_get_settings`.
2. Ändere genau das, worum der Nutzer bittet – nicht mehr.
3. Sag in einem Satz, was du geändert hast und wie man es rückgängig macht
   (Einstellungen → Allgemein, oder „setz das zurück“ im Chat).

## Werkzeuge

| Wunsch | Werkzeug |
|---|---|
| Hell/Dunkel, Schriftgröße, Akzentfarbe, Spracheingabe, Auto-Modellwahl, Modell je Aufgabenstufe | `brise_set_setting` |
| Farben, Abstände, Schriften, Bereiche ausblenden oder umgestalten | `brise_set_custom_css` |
| Eigene Karten auf der Startseite eines Projekts | `brise_set_quick_actions` |
| Vibe-Verhalten (Standardmodus, Subagents, Skills, Kompaktierung) | `brise_set_vibe_config` |

### CSS

`brise_set_custom_css` **ersetzt** das bisherige eigene CSS. Hänge Neues also an den
Text aus `brise_get_settings` an, statt ihn zu überschreiben.

Farben laufen über CSS-Variablen. Für beide Themes:

```css
:root { --accent: #e8590c; }
:root[data-theme="dark"] { --accent: #ff8a4c; }
```

Variablen: `--bg`, `--sidebar`, `--panel`, `--elev`, `--hover`, `--active`, `--line`,
`--line-strong`, `--fg`, `--fg-2`, `--muted`, `--accent`, `--accent-soft`, `--ok`,
`--warn`, `--bad`, `--code`, `--user`, `--app-font-size`.

Bereiche zum gezielten Ansprechen über `[data-brise="…"]`: `sidebar`, `header`,
`conversation`, `composer`, `side-panel`, `terminal`, `user-message`,
`assistant-message`, `tool-group`.

Beispiel – Nachrichten des Nutzers in Akzentfarbe:

```css
[data-brise="user-message"] > div:first-child { background: var(--accent-soft); }
```

## Grenzen

- Freigaben komplett abschalten (`bypass_tool_permissions`) geht nur über die
  Einstellungen, nicht per Chat.
- Den Quellcode von Brise selbst kannst du hier nicht ändern; dafür gibt es das
  Repository von Brise.
