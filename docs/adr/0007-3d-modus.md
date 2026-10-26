# ADR 0007: 3D-Modus und Vernetzung von Code, Design und 3D

- Status: angenommen
- Datum: 2026-10-26

## Kontext

Brise kennt bisher zwei Arbeitsweisen: **Code** (Sessions in Projekten) und
**Design** (HTML-Entwürfe mit Live-Vorschau, siehe `design.rs`,
`components/design/`). Dazu kommt ein dritter Modus **3D** für das Modellieren
und Bearbeiten von 3D-Modellen: Bauteile für den 3D-Druck, Assets für Web-Apps
und Spiele, einfache Szenen.

Wichtiger als der Modus selbst ist die **Vernetzung**:

- Eine Code-Session soll Designs und 3D-Modelle lesen, sehen (Screenshot) und
  ins Projekt übernehmen können.
- Sie soll Arbeit an eine Design- bzw. 3D-Session **delegieren** und das
  Ergebnis zurückbekommen.
- Design und 3D übergeben Ergebnisse an Code-Sessions, z. B. ein Modell als
  glTF ins Projekt, zusammen mit dem Auftrag, es einzubinden.

Brise läuft auf Linux (WebKitGTK), Windows (WebView2) und macOS (WKWebView).
Auf keinem dieser Systeme kann Brise Blender, OpenSCAD oder Python mit
CAD-Bibliotheken voraussetzen. Auf dem Entwicklungsrechner ist keines davon
installiert.

## Untersuchte Wege zum Modellieren

| Weg | Stärken | Schwächen |
|---|---|---|
| **Blender** headless (`blender --background --python skript.py`) | echtes Modellieren, Modifikatoren, Materialien, UV, Rendern; Export nach glTF, STL, OBJ, 3MF (Add-on) | rund 1 GB, Installation durch den Nutzer; die Python-API ist groß und LLMs schreiben sie fehleranfällig; ohne Blender nichts |
| **blender-mcp** (MCP-Server und Blender-Add-on, Socket auf Port 9876) | Agent steuert ein laufendes Blender interaktiv, kann Poly Haven und Sketchfab nutzen | Blender muss mit Add-on **offen** laufen; das Add-on führt beliebiges Python aus; nur ein Blender je Port; passt nicht zu headless und parallelen Sessions |
| **Eigenes Blender-Bridge-Add-on** | volle Kontrolle | dieselbe schwere Abhängigkeit und eigener Pflegeaufwand für jede Blender-Version |
| **OpenSCAD** (`openscad -o teil.stl teil.scad`) | kleine, verbreitete CLI; LLMs schreiben SCAD gut; parametrisch; ideal für 3D-Druck; Export nach STL, 3MF, OFF, AMF | nur CSG, keine Farben oder Materialien in STL; muss installiert sein |
| **build123d / CadQuery** (Python, OpenCascade) | echtes B-Rep-CAD, Fasen, Rundungen, STEP-Export | Python plus OCP (rund 200 MB, Wheels nicht für jede Plattform); LLM-Code bricht oft an der API |
| **three.js als Code** (Modul, das eine Szene baut) | läuft **in Brise selbst**, ohne jede Installation und auf allen drei Plattformen; LLMs kennen three.js sehr gut; Farben, Materialien, Gruppen, Animationen; Export nach GLB und STL mit three.js-Exportern | kein B-Rep (Rundungen und Bohrungen nur über Geometrie bzw. CSG-Tricks); für präzise technische Teile schwächer als CAD |

Für die **Vorschau**:

| Viewer | Bewertung |
|---|---|
| `<model-viewer>` | schön, aber nur glTF/GLB; Drahtgitter, Maße und eigene Auswahl sind schwer umzusetzen |
| **three.js** mit `GLTFLoader`, `STLLoader`, `OBJLoader`, `3MFLoader` und `OrbitControls` | alle vier Formate, Drahtgitter, Bounding Box mit Maßen, Klick-Auswahl per Raycaster, Screenshot per `toDataURL`; WebGL 2 läuft in WebKitGTK, WebView2 und WKWebView |

## Entscheidung

Eine Kombination, mit Brise als einziger fester Abhängigkeit:

1. **Viewer immer**: eigener three.js-Viewer in der Oberfläche, gebündelt und
   ohne CDN, also auch offline. Er unterstützt glTF/GLB, STL, OBJ und 3MF, hat
   Orbit, Drahtgitter, Achsen bzw. Raster, die Bounding Box mit Maßen in mm und
   einen Screenshot. Ein Klick wählt ein Teil (Mesh) aus; Name, Position und
   Maße gehen mit der nächsten Nachricht an den Agenten.
2. **Standardweg „Szene als Code“ (three.js)**: Der Agent schreibt `model.js`,
   ein ES-Modul mit `export default function build({ THREE, params })`, das ein
   `THREE.Object3D` zurückgibt, sowie optional `export const params = {…}`
   (Zahlen, die Brise als Regler anzeigt). Brise führt das Modul in einem
   **isolierten iframe** aus (`sandbox="allow-scripts"`, ohne Same-Origin und
   ohne Zugriff auf Tauri). three.js wird per Import-Map als `data:`-URL
   eingebettet, damit das iframe weder Netz noch App-Dateien braucht. Das
   iframe exportiert das Ergebnis als GLB und schickt die Bytes per
   `postMessage`. Brise speichert sie als `out/model.glb` (bzw. `out/model.stl`
   für den Druck) und zeigt sie im Viewer, der selbst keinen Agenten-Code
   ausführt.
3. **OpenSCAD optional**: Findet Brise `openscad` (im `PATH` oder an den
   üblichen Orten), darf der Agent statt `model.js` auch `model.scad`
   schreiben. Brise rendert sie nach jeder Änderung selbst zu `out/model.stl`.
   Das ist der parametrische CAD-Weg für technische Teile und den 3D-Druck.
4. **Blender optional**: Findet Brise `blender`, nennt die erste Nachricht der
   3D-Session den Pfad. Der Agent darf dann `blender --background --python`
   ausführen, um z. B. Modifikatoren, Rundungen oder Renderings zu nutzen.
   Er schreibt das Ergebnis selbst als GLB nach `out/`. Ein laufendes Blender
   mit **blender-mcp** kann der Nutzer wie jeden anderen MCP-Server in den
   Einstellungen eintragen; Brise bündelt ihn nicht.
5. **Fertige Dateien**: Legt der Agent oder der Nutzer `.glb`, `.gltf`,
   `.stl`, `.obj` oder `.3mf` ins Modell (z. B. aus build123d, trimesh oder
   einem Download), zeigt der Viewer sie direkt an.

Begründung: Nur der three.js-Weg funktioniert sofort für jeden Nutzer und auf
jedem System. OpenSCAD und Blender sind stark, aber Installationen, die Brise
nicht erzwingen will; sie werden genutzt, wenn sie da sind. build123d und
CadQuery sind für eine Desktop-App ohne festes Python zu schwer. Der Agent
kann sie trotzdem nutzen (Weg 5), wenn der Nutzer sie installiert hat.

### Ablage

Wie beim Design-Modus liegt jedes Modell als Ordner im Datenordner:

```
<Datenordner>/3d/m-<id>/
  model.json        Verwaltung (Name, Session, Versionen, Übergaben) – Brise
  model.js          Szene als Code (Standard)      – Agent
  model.scad        alternativ OpenSCAD            – Agent
  variants/a/…      Varianten                      – Agent
  notes.md          Zweck, Maße, Teile, Akzeptanzkriterien – Agent
  out/model.glb     erzeugtes Modell               – Brise bzw. Agent
  out/model.stl     für den Druck (nur Geometrie)  – Brise bzw. Agent
  preview.png       letzter Screenshot des Viewers – Brise
  refs/             Vorlagen und Fotos             – Brise
  .versions/<n>/    Versionen nach jedem Turn      – Brise
```

Einheiten: **1 Einheit = 1 mm**; Y zeigt nach oben (glTF-Konvention).

### Vernetzung über `brise --mcp-app`

Jede Session hat den MCP-Server `brise-app` (siehe `customize.rs`). Er
bekommt Werkzeuge, die **ohne laufende Oberfläche** direkt auf den Datenordner
zugreifen:

| Werkzeug | Zweck |
|---|---|
| `list_designs()` / `list_models()` | ID, Name, Stand, Versionen, vorhandene Dateien |
| `read_design(id)` | `notes.md`, Dateiliste, Haupt-HTML (gekürzt) **und `preview.png` als Bild** |
| `read_model(id)` | `notes.md`, Maße (Bounding Box), Teile, Quellcode (gekürzt) **und `preview.png` als Bild** |
| `export_model(id, ziel?, format?)` | kopiert `out/model.glb` (bzw. `.stl`, `.3mf`, `.obj`) ins Projekt der Session (Standard `public/models/<name>.glb`) |
| `export_design(id, ziel?)` | kopiert ein Design (ohne Versionen) ins Projekt (Standard `.brise/design/<name>/`) |

Damit die Werkzeuge Bilder liefern können, gibt `customize::call_tool`
statt reinem Text eine Liste von MCP-Inhalten zurück (`text` und `image`).

**Delegieren** läuft über **denselben Weg wie die Master-Session** (ADR 0006):
`start_session` bekommt den optionalen Parameter
`mode: "code" | "design" | "3d"`. Bei `design` bzw. `3d`:

- legt die Oberfläche statt eines Worktrees ein neues Design bzw. Modell an
  (Name = `title`) und startet dessen Session mit `task` als erster Nachricht;
- gelten dieselben Grenzen (Bestätigung durch den Nutzer, Höchstzahl
  gleichzeitiger Untersessions, Budget, Team-Richtlinie);
- kommt die Rückmeldung als normale Notiz, ergänzt um die ID des Designs bzw.
  Modells und den Hinweis auf `read_model`/`export_model`;
- gibt es kein `merge_session`, denn das Ergebnis liegt nicht in Git. Die
  Master-Session übernimmt es mit `export_model` bzw. `export_design`.

`delegate_design` und `delegate_3d` sind keine eigenen Werkzeuge: zwei Wege
für dasselbe würden Modelle nur verwirren.

**Übergeben** aus Design bzw. 3D an eine Code-Session ist ein gemeinsamer
Mechanismus (`lib/handoff.ts`): Dateien ins Projekt kopieren, Auftrag mit
Screenshots bauen, im Projekt eine neue Session öffnen und den Auftrag
senden, die Übergabe am Design bzw. Modell vermerken. Der 3D-Modus kopiert das
Modell nach `public/models/<name>.glb` (Ziel wählbar), legt Quellcode und
Notizen nach `.brise/3d/<name>/` und schreibt den Einbindungsauftrag (Lader
des Projekts, z. B. `useGLTF` bei react-three-fiber, `GLTFLoader` oder
`<model-viewer>`, Maßstab in mm).

## Folgen

- Neue Rust-Datei `model3d.rs` (Ablage, OpenSCAD und Blender finden, OpenSCAD
  rendern, Export ins Projekt, MCP-Werkzeuge für Designs und Modelle).
- Neue Abhängigkeit `three` im Frontend (MIT, rund 700 kB im Bundle; der
  Viewer wird erst im 3D-Modus nachgeladen).
- Skill `3d-mode` beschreibt die Arbeitsweise; die erste Nachricht nennt die
  gefundenen Werkzeuge.
- Der Design-Modus speichert nach jeder Version `preview.png`, damit
  `read_design` ein Bild liefern kann.

## Risiken

- **WebGL unter WebKitGTK**: Auf manchen Linux-Systemen mit
  `WEBKIT_DISABLE_COMPOSITING_MODE` oder ohne GPU-Treiber fehlt WebGL. Der
  Viewer zeigt dann einen Hinweis; Dateien und Export funktionieren weiter.
- **Agenten-Code**: `model.js` läuft nur im isolierten iframe, nie im Fenster
  der App. Endlosschleifen fängt eine Zeitgrenze ab (iframe wird verworfen).
- **Große Modelle**: Dateien über 64 MB zeigt der Viewer nicht an.
