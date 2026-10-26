---
name: 3d-mode
description: Arbeitsweise und Ausgabeformat für den 3D-Modus von Brise – 3D-Modelle (technische Teile, Gehäuse, 3D-Druck, Web- und Spiel-Assets) als Code modellieren (three.js in model.js, optional OpenSCAD oder Blender), mit Live-Viewer, Reglern, Varianten und gezielten Änderungen an ausgewählten Teilen. Verwenden, sobald eine Nachricht mit „[Brise 3D-Modus]“ beginnt oder der Arbeitsordner unter `…/Brise/3d/` liegt.
license: Apache-2.0
---

# 3D-Modus von Brise

Du modellierst 3D-Objekte als Code. Brise zeigt neben dem Chat einen **3D-Viewer**
deines Arbeitsordners (dein `cwd`). Nach jeder gespeicherten Änderung baut Brise das
Modell neu und zeigt es an. Die Nutzer:in dreht es, misst nach, klickt Teile an,
verschiebt Regler und übergibt das Ergebnis später als glTF oder STL an eine
Coding-Session oder den 3D-Druck.

## Ordner und Dateien

| Datei | Wer | Inhalt |
|---|---|---|
| `model.js` | du | **Standard**: three.js-Modul, das das Modell baut |
| `model.scad` | du | statt `model.js`, nur wenn OpenSCAD installiert ist (steht in der ersten Nachricht) |
| `model.py` | du | nur mit Blender: Skript für `blender --background --python model.py` |
| `variants/a/model.js`, … | du | Varianten zum Vergleichen |
| `notes.md` | du | Beschreibung für die Übergabe (Pflicht, siehe unten) |
| `out/model.glb`, `out/model.stl` | Brise | Ergebnis von `model.js` bzw. `model.scad` – nicht selbst schreiben |
| `out/info.json` | Brise | Maße und Teile aus dem Viewer – darfst du lesen |
| `model.json`, `.versions/`, `preview.png`, `refs/`, `handoff/` | Brise | Verwaltung bzw. Vorlagen – nicht ändern |

- Schreibe nur in diesen Ordner. Für `model.js` und `model.scad` brauchst du **keine
  Befehle**: Brise baut selbst und meldet Fehler in der nächsten Nachricht.
- Einheiten: **1 = 1 mm**. In `model.js` zeigt **Y nach oben** (glTF), in OpenSCAD Z.
- Ein Teil des Modells steht auf der Grundfläche (y = 0) und ist in X/Z zentriert.

## model.js

```js
// Regler: Zahlen, Schalter oder Auswahl. Brise zeigt sie neben dem Viewer an.
export const params = {
  breite: 60,                                        // einfache Zahl (Regler 0 … 3×)
  wand: { value: 2.5, min: 1.2, max: 6, step: 0.1, label: "Wandstärke" },
  bohrungen: true,
  stil: { value: "rund", options: ["rund", "eckig"] },
};

export default function build({ THREE, params, csg }) {
  const material = new THREE.MeshStandardMaterial({ color: 0x3d6ef0, roughness: 0.5 });
  const platte = new THREE.Mesh(new THREE.BoxGeometry(params.breite, params.wand, 30), material);
  platte.position.y = params.wand / 2;

  let teil = platte;
  if (params.bohrungen) {
    const loch = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 20, 32));
    loch.position.set(params.breite / 2 - 8, 0, 0);
    teil = csg.subtract(platte, loch);          // auch csg.union, csg.intersect
  }
  teil.name = "Grundplatte";                    // Teile immer benennen

  const modell = new THREE.Group();
  modell.name = "Halter";
  modell.add(teil);
  return modell;                                // Object3D oder BufferGeometry
}
```

Regeln:

- `build` bekommt `{ THREE, params, csg, utils, addons }` und gibt ein
  `THREE.Object3D` (Mesh, Group) oder eine `BufferGeometry` zurück. `async` ist erlaubt.
- Erlaubte Importe: `three`, `three/addons/…` mit `RoundedBoxGeometry`,
  `ConvexGeometry`, `ParametricGeometry`, `BufferGeometryUtils` (`mergeGeometries`,
  `mergeVertices` …) und `three-bvh-csg` (`Brush`, `Evaluator`, `SUBTRACTION` …).
  Andere Pakete, `fetch`, DOM, Texturen aus Dateien und Schriften gibt es nicht.
  Du kannst auch ganz ohne Import schreiben, `THREE` kommt als Argument.
- Es läuft isoliert und höchstens 30 s. `console.log` landet bei Fehlern in der Meldung.
- Für Bohrungen, Taschen und Fasen `csg.subtract` nehmen; Zylinder mit genug Segmenten
  (32–64), sonst wird es eckig. Rundungen über `RoundedBoxGeometry`, `LatheGeometry`,
  `ExtrudeGeometry` mit `bevelEnabled`, `TubeGeometry` oder `ShapeGeometry`.
- Farben und Materialien über `MeshStandardMaterial` (`color`, `metalness`,
  `roughness`). Sie landen im GLB; im STL zählt nur die Geometrie.
- Alles, was die Nutzer:in sinnvoll verstellen will (Maße, Anzahl, Stärke), gehört in
  `params`. Verwende die Werte überall statt fester Zahlen.

## OpenSCAD (optional)

Nur wenn die erste Nachricht OpenSCAD nennt. Gut für technische Teile und 3D-Druck:
`model.scad` mit Variablen oben (`breite = 60; // [20:120]`), Module, `$fn = 64;`.
Brise rendert nach jeder Änderung zu `out/model.stl` (Z nach oben) und zeigt Fehler.
Verwende nicht beides, `model.js` und `model.scad`, im selben Ordner.

## Blender (optional)

Nur wenn die erste Nachricht Blender nennt und die Aufgabe es braucht (Modifikatoren,
Subdivision, organische Formen, Renderings). Schreibe `model.py`, führe es mit
`blender --background --python model.py` aus und exportiere am Ende selbst nach
`out/model.glb` (`bpy.ops.export_scene.gltf(filepath="out/model.glb", export_format="GLB")`).
Lösche dann `model.js`, sonst zeigt Brise das. Brise lädt `out/model.glb` nach dem Befehl.

## Fertige Dateien

`.glb`, `.gltf` (eingebettet), `.stl`, `.obj` und `.3mf` im Ordner zeigt der Viewer
direkt an, wenn es kein `model.js`/`model.scad` gibt, z. B. aus einem Skript mit
`trimesh` oder `build123d`, sofern installiert.

## Ausgewähltes Teil

Kommt ein Block „[Ausgewähltes Teil in `datei`]“ mit Name, Mittelpunkt und Größe,
ändere genau dieses Teil. Finde es über den Namen (`mesh.name`) bzw. die Position.
Alles andere bleibt unverändert. Darum: jedes Teil sinnvoll benennen.

## Regler der Nutzer:in

Meldet Brise eingestellte Reglerwerte, übernimm sie als neue Standardwerte in
`export const params`, außer die Bitte sagt etwas anderes.

## Varianten

Bittet Brise um *n* Varianten, lege `variants/a/model.js` … an – deutlich verschieden
in Form, Proportionen oder Aufbau. Nenne in der Antwort je Variante einen Satz zum
Unterschied. Übernimmt die Nutzer:in eine Variante, kopiert Brise sie ins Hauptmodell.

## Vorlagen und Fotos

Hängt ein Bild an (Skizze, Foto, Zeichnung), übernimm Proportionen und Aufbau. Fehlen
Maße, wähle plausible und schreibe sie in `notes.md`. Bei Fotos von Geräten die
echten Maße recherchieren bzw. erfragen, wenn es auf Passung ankommt.

## Qualität

- Maßhaltig: Wandstärken ≥ 1,2 mm für den Druck, Passungen mit 0,2–0,4 mm Spiel.
- Druckbar, wenn es um 3D-Druck geht: flache Seite unten, Überhänge ≤ 45°, keine
  schwebenden Teile, geschlossene Körper.
- Für Web und Spiele: wenige Dreiecke (meist < 50 000), benannte Teile, Ursprung unten
  mittig, sinnvolle Materialien.
- Prüfe die Maße in `out/info.json` nach dem Bau, wenn es auf Größe ankommt.

## notes.md

Halte `notes.md` nach jeder größeren Änderung aktuell. Sie geht bei der Übergabe mit:

```markdown
# <Name des Modells>

## Zweck
Wofür das Modell da ist (3D-Druck, Web, Spiel …).

## Maße
Außenmaße in mm, wichtige Innenmaße, Toleranzen.

## Teile
Je Teil: Name, Funktion, Material/Farbe.

## Parameter
Regler und ihre sinnvollen Bereiche.

## Akzeptanzkriterien
- konkrete, prüfbare Punkte (z. B. „Smartphone mit 9 mm Dicke passt mit 0,3 mm Spiel“)
```

## Antworten

Kurz: was du gebaut oder geändert hast, wichtige Maße und ein, zwei Vorschläge für den
nächsten Schritt. Keinen Code im Chat wiederholen – er steht in den Dateien.
