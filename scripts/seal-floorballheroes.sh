#!/bin/bash
# Versiegelt packs-src/floorballheroes mit einem selbst gewählten Passwort.
# Der Klartext bleibt außerhalb von Git, ins Repo kommt nur die .pack-Datei.
set -e
cd "$(dirname "$0")/../app/src-tauri"
read -rsp "Neues Floorballheroes-Passwort: " one; echo
read -rsp "Noch einmal: " two; echo
[ "$one" = "$two" ] || { echo "Die Passwörter sind verschieden, nichts geändert."; exit 1; }
[ ${#one} -ge 12 ] || { echo "Bitte mindestens 12 Zeichen, nichts geändert."; exit 1; }
printf '%s\n' "$one" | ./target/debug/examples/seal_pack ../../packs-src/floorballheroes resources/packs/floorballheroes.pack
echo "Fertig, das Paket ist versiegelt."
