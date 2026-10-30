# Roadmap

## Tastenkürzel für wirklich alles

- Jede Aktion der App ist per Tastatur erreichbar: Modi, Tabs, Panels, Picker für Modell und Denkstufe, Freigaben, Sessions, Design und 3D.
- Alle Kürzel frei belegbar, mit Konflikterkennung, Import und Export.
- Fortgeschrittene Kürzel: Tastenfolgen (Chords) und kontextabhängige Belegungen je Modus oder Panel.
- Befehlspalette, die zu jeder Aktion ihr Kürzel zeigt, dazu eine durchsuchbare Übersicht aller Kürzel.

## Lokale Transkription, angelehnt an Blitztext

Blitztext (blitztext.de, MIT) ist eine macOS-App mit lokalem Parakeet und Whisper, aber laut Website ohne API oder CLI. Community-Forks gibt es für Linux und Windows. Eine direkte Anbindung ist deshalb nicht möglich. Geplant ist:

- Lokale Transkription als weitere STT-Quelle neben Voxtral, wählbar in den Einstellungen und überall im Composer. Der Modell-Download erfolgt in der App, das Audio bleibt auf dem Gerät.
- Modelle: Whisper auf allen Plattformen, Parakeet wo möglich. Sinnvoll auch für ZDR-Projekte.
- Vorbilder aus Blitztext: Taste halten und sprechen, Schreibmodi zum Umformulieren mit frei wählbarem Modell.
- Vor der Umsetzung prüfen: Code und Lizenz von Blitztext und Forks sowie die passende Engine je Plattform.
