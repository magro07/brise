// Laufzeit für `model.js` im 3D-Modus. Wird von vite.config.ts als eigenes
// Skript gebündelt und in einem Worker innerhalb eines isolierten iframes
// ausgeführt (kein Zugriff auf die App). Baut die Szene des Agenten, exportiert
// sie als GLB und STL und schickt die Bytes zurück.

import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { ParametricGeometry } from "three/addons/geometries/ParametricGeometry.js";
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION, DIFFERENCE } from "three-bvh-csg";
import { compile, describeParams, type ParamSpec } from "./modelCode";

/** Hilfen, die `model.js` per Import aus „three/addons/…“ bzw. „three-bvh-csg“ bekommt. */
const ADDONS: Record<string, unknown> = {
  BufferGeometryUtils,
  ...BufferGeometryUtils,
  RoundedBoxGeometry,
  ConvexGeometry,
  ParametricGeometry,
  Brush,
  Evaluator,
  ADDITION,
  SUBTRACTION,
  INTERSECTION,
  DIFFERENCE,
};

/** Einfache CSG-Hilfen: `csg.subtract(a, b, …)` mit Meshes oder Geometrien. */
function makeCsg() {
  const evaluator = new Evaluator();
  evaluator.attributes = ["position", "normal"];
  const brush = (x: THREE.Mesh | THREE.BufferGeometry) => {
    const mesh = (x as THREE.Mesh).isMesh ? (x as THREE.Mesh) : new THREE.Mesh(x as THREE.BufferGeometry);
    mesh.updateMatrixWorld(true);
    const b = new Brush(mesh.geometry, mesh.material as THREE.Material);
    b.position.copy(mesh.position);
    b.quaternion.copy(mesh.quaternion);
    b.scale.copy(mesh.scale);
    b.updateMatrixWorld(true);
    return b;
  };
  const op = (kind: number) => (first: THREE.Mesh | THREE.BufferGeometry, ...rest: (THREE.Mesh | THREE.BufferGeometry)[]) => {
    let acc: THREE.Mesh = brush(first);
    for (const r of rest) acc = evaluator.evaluate(acc as Brush, brush(r), kind as typeof SUBTRACTION) as THREE.Mesh;
    const out = new THREE.Mesh(acc.geometry, (first as THREE.Mesh).isMesh ? (first as THREE.Mesh).material : new THREE.MeshStandardMaterial());
    out.name = (first as THREE.Mesh).name || "";
    return out;
  };
  return { union: op(ADDITION), subtract: op(SUBTRACTION), intersect: op(INTERSECTION) };
}

/**
 * Zahlen kommen als Number-Objekt mit `.value`, damit `params.breite` und
 * `params.breite.value` beide funktionieren (Modelle schreiben mal so, mal so).
 */
function paramValue(v: unknown): unknown {
  return typeof v === "number" ? Object.assign(new Number(v), { value: v }) : v;
}

/** NaN in der Geometrie (z. B. undefined * 2) als verständlicher Fehler statt leerem Modell. */
function checkFinite(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const pos = (o as THREE.Mesh).geometry?.getAttribute?.("position");
    if (!pos) return;
    for (let i = 0; i < pos.array.length; i++) {
      if (!Number.isFinite(pos.array[i])) {
        throw new Error(`Teil „${o.name || "ohne Namen"}“ hat ungültige Koordinaten (NaN) – meist eine Rechnung mit undefined, z. B. ein falsch geschriebener Parameter.`);
      }
    }
  });
}

interface Request {
  code: string;
  params: Record<string, number | boolean | string>;
  formats: ("glb" | "stl" | "obj")[];
}

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<Request>) => {
  const logs: string[] = [];
  const log = (...a: unknown[]) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ").slice(0, 500));
  const console = { log, info: log, warn: log, error: log, debug: log };
  try {
    const { body, exportsList } = compile(e.data.code);
    const exports: Record<string, any> = {};
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const run = new AsyncFunction("__exports", "THREE", "ADDONS", "console", `${body}\n${exportsList.map((n) => `__exports.${n} = ${n};`).join("\n")}`);
    await run(exports, THREE, ADDONS, console);
    const build = exports.default ?? exports.build;
    if (typeof build !== "function") throw new Error("model.js muss eine Funktion exportieren: export default function build({ THREE, params }) { … }");
    const specs: ParamSpec[] = describeParams(exports.params);
    const params: Record<string, unknown> = {};
    for (const s of specs) params[s.name] = paramValue(e.data.params[s.name] ?? s.value);
    let obj = await build({ THREE, params, csg: makeCsg(), utils: BufferGeometryUtils, addons: ADDONS });
    if (obj?.isBufferGeometry) obj = new THREE.Mesh(obj, new THREE.MeshStandardMaterial({ color: 0xb0b8c4 }));
    if (!obj?.isObject3D) throw new Error("build() muss ein THREE.Object3D (Mesh, Group …) oder eine BufferGeometry zurückgeben.");
    obj.updateMatrixWorld(true);
    checkFinite(obj);
    const out: Record<string, ArrayBuffer> = {};
    if (e.data.formats.includes("glb")) out.glb = (await new GLTFExporter().parseAsync(obj, { binary: true })) as ArrayBuffer;
    if (e.data.formats.includes("stl")) {
      const view = new STLExporter().parse(obj, { binary: true }) as DataView;
      out.stl = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    }
    if (e.data.formats.includes("obj")) out.obj = new TextEncoder().encode(new OBJExporter().parse(obj)).buffer as ArrayBuffer;
    post({ ok: true, out, params: specs, logs }, Object.values(out));
  } catch (err) {
    // Der Stacktrace zeigt nur in die Laufzeit (Blob), nicht in model.js – darum ohne.
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    post({ ok: false, error, logs });
  }
};
