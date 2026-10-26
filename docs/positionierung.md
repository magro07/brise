# Positionierung (Entwurf)

Woran sich README, App-Texte und Metadaten ausrichten. Brise ist ein privates
Open-Source-Projekt (Apache-2.0), kein Produkt: keine Preise, keine
Kaufaufforderungen, keine Superlative. Wir beschreiben, was die App tut.

## In einem Satz

Brise ist ein Desktop-Client für KI-Coding-Agenten, in dem kleine Teams
gemeinsam an Sessions arbeiten und Power-User Modelle, Kosten und Daten
selbst in der Hand behalten.

## Drei Kernpunkte

1. **Zusammenarbeit zuerst.** Sessions lassen sich teilen: Andere sehen live mit,
   schlagen Prompts vor oder geben Freigaben. Teams sehen, wer online ist und
   was geteilt ist. Gäste arbeiten auf dem Abo des Hosts mit Limits, die der Host
   festlegt. Alles läuft Ende-zu-Ende verschlüsselt, direkt im LAN oder über ein
   selbst gehostetes Relay.
2. **Ein Werkzeug, mehrere Agenten.** Brise spricht das Agent Client Protocol
   und arbeitet mit Mistral Vibe, Claude Code, Codex und Gemini CLI. Jede Session
   wählt ihren Agenten, das bestehende Abo bzw. die eigene Anmeldung bleibt gültig.
   Keiner davon ist Voraussetzung.
3. **Kontrolle für Power-User.** Model Council für zweite Meinungen, eigene
   Benchmarks, Secrets nur im Schlüsselbund, Auto-Modellwahl, t/s- und
   Latenz-Messung, Nutzungsjournal mit Budget, Modelle ohne Datenspeicherung über
   Cortecs und Selbst-Hosting des Relays im Homelab.

## Zielgruppe

- Entwicklerinnen und Entwickler, die mehrere Agenten und Modelle nebeneinander
  nutzen und vergleichen wollen, statt sich auf einen Anbieter festzulegen.
- Kleine Teams (zwei bis zehn Personen), Arbeitsgruppen oder Paare, die
  Sessions gemeinsam steuern, ohne eine Cloud-Plattform dazwischen.
- Leute, die ihre Infrastruktur selbst betreiben (Homelab) und wissen wollen,
  wohin ihre Daten gehen.

Nicht im Fokus: Einsteiger, die nur eine Chat-Oberfläche suchen, und große
Organisationen mit zentraler Verwaltung.

## Sprachregeln

- „Agent“ oder der Name des aktiven Backends, nicht pauschal „Vibe“. „Vibe“ nur
  dort, wo es wirklich um Vibe geht (Vibe-Anmeldung, Vibe-Einstellungen,
  Vibe-Agents & Subagents, Cortecs-Modelle in Vibes `config.toml`).
- Reihenfolge in Aufzählungen: Mistral Vibe, Claude Code, Codex, Gemini CLI.
  Das ist die Reihenfolge, in der sie dazugekommen sind, keine Wertung.
- Sachlich und konkret: Was passiert, wo liegen Daten, was ist nicht geschützt.
  Grenzen werden genannt, nicht versteckt.
- Keine Vergleiche wie „besser als“, kein „das beste“, kein „revolutionär“.

## Name

„Brise“ bleibt. Der Name hängt an keinem Backend (kein „Vibe“ im Namen), ist kurz,
deutsch und passt zu einer leichten Oberfläche. Für einen Wechsel gibt es keinen
Grund, der den Aufwand rechtfertigt (Bundle-Identifier, Datenordner, Schlüsselbund-
Dienste `dev.brise.*`, Links, Relay-Namen).
