// three.js-Viewer des 3D-Modus: lädt glTF/GLB, STL, OBJ und 3MF aus Bytes,
// Orbit, Drahtgitter, Raster, Bounding Box mit Maßen, Auswahl per Klick und
// Screenshot. Führt keinen Agenten-Code aus – nur Daten.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { ModelInfo, PickedPart } from "../../lib/model3d";

export interface ViewOptions {
  wireframe: boolean;
  bbox: boolean;
  grid: boolean;
  /** Modell ist Z-oben (CAD, 3D-Druck) und wird für die Anzeige gedreht. */
  zUp: boolean;
  dark: boolean;
}

const vec = (v: THREE.Vector3): [number, number, number] => [round(v.x), round(v.y), round(v.z)];
const round = (n: number) => Math.round(n * 100) / 100;

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Liest eine Modelldatei in ein Object3D. */
export async function parseModel(bytes: ArrayBuffer, ext: string): Promise<THREE.Object3D> {
  switch (ext.toLowerCase()) {
    case "glb":
    case "gltf": {
      const data = ext === "gltf" ? new TextDecoder().decode(bytes) : bytes;
      const gltf = await new GLTFLoader().parseAsync(data, "");
      return gltf.scene;
    }
    case "stl": {
      const geo = new STLLoader().parse(bytes);
      const colored = !!geo.getAttribute("color");
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: colored ? 0xffffff : 0xb7bec9, vertexColors: colored, metalness: 0.1, roughness: 0.55 }));
      mesh.name = "STL";
      return mesh;
    }
    case "obj":
      return new OBJLoader().parse(new TextDecoder().decode(bytes));
    case "3mf":
      return new ThreeMFLoader().parse(bytes);
    default:
      throw new Error(`Dateityp .${ext} wird nicht unterstützt`);
  }
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
  private controls: OrbitControls;
  private holder = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private grid: THREE.GridHelper | null = null;
  private box: THREE.Box3Helper | null = null;
  private highlight: THREE.BoxHelper | null = null;
  private resize: ResizeObserver;
  private opts: ViewOptions = { wireframe: false, bbox: false, grid: true, zUp: false, dark: false };
  private down: { x: number; y: number } | null = null;
  picking = false;
  onPick: (p: PickedPart | null) => void = () => {};
  entry = "";

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 1.5);
    this.scene.add(sun);
    this.scene.add(this.holder);
    this.camera.position.set(120, 90, 150);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.render());
    this.resize = new ResizeObserver(() => this.fitSize());
    this.resize.observe(host);
    this.renderer.domElement.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY }));
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      const d = this.down;
      this.down = null;
      if (this.picking && d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) this.pick(e);
    });
    this.fitSize();
  }

  private fitSize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Neues Modell anzeigen; `keepView` behält die Kamera (Neuladen derselben Datei). */
  show(model: THREE.Object3D, keepView: boolean) {
    this.clearModel();
    this.model = model;
    this.holder.add(model);
    this.applyOptions(this.opts, !keepView);
  }

  private clearModel() {
    if (!this.model) return;
    this.holder.remove(this.model);
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x?.dispose());
      }
    });
    this.model = null;
    this.setHighlight(null);
  }

  setOptions(opts: Partial<ViewOptions>) {
    const fit = opts.zUp !== undefined && opts.zUp !== this.opts.zUp;
    this.applyOptions({ ...this.opts, ...opts }, fit);
  }

  private applyOptions(opts: ViewOptions, fit: boolean) {
    this.opts = opts;
    this.holder.rotation.x = opts.zUp ? -Math.PI / 2 : 0;
    this.holder.updateMatrixWorld(true);
    this.model?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => ((x as THREE.MeshStandardMaterial).wireframe = opts.wireframe));
    });
    const bounds = this.bounds();
    if (this.grid) this.scene.remove(this.grid), this.grid.dispose();
    this.grid = null;
    if (opts.grid) {
      const size = bounds.isEmpty() ? 200 : Math.max(bounds.getSize(new THREE.Vector3()).length() * 2, 20);
      const cell = size > 2000 ? 100 : size > 200 ? 10 : 1;
      const extent = Math.ceil(size / cell / 2) * cell * 2;
      this.grid = new THREE.GridHelper(extent, Math.min(400, extent / cell), opts.dark ? 0x4a5160 : 0xb8bfca, opts.dark ? 0x2a2f3a : 0xe1e5ea);
      this.grid.position.set(bounds.isEmpty() ? 0 : (bounds.min.x + bounds.max.x) / 2, bounds.isEmpty() ? 0 : bounds.min.y, bounds.isEmpty() ? 0 : (bounds.min.z + bounds.max.z) / 2);
      this.scene.add(this.grid);
    }
    if (this.box) this.scene.remove(this.box), this.box.dispose();
    this.box = null;
    if (opts.bbox && !bounds.isEmpty()) {
      this.box = new THREE.Box3Helper(bounds, new THREE.Color(0xe8590c));
      this.scene.add(this.box);
    }
    if (fit) this.frame();
    this.render();
  }

  bounds(): THREE.Box3 {
    return this.model ? new THREE.Box3().setFromObject(this.model) : new THREE.Box3();
  }

  /** Kamera auf das Modell ausrichten. */
  frame() {
    const b = this.bounds();
    if (b.isEmpty()) return;
    const center = b.getCenter(new THREE.Vector3());
    const radius = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 1);
    // Schmaler Viewer: der horizontale Bildwinkel ist kleiner als der vertikale.
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.1;
    this.camera.position.copy(center).add(new THREE.Vector3(0.9, 0.65, 1.1).normalize().multiplyScalar(dist));
    this.camera.near = dist / 1000;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.render();
  }

  /** Ansicht von vorn, oben, rechts oder schräg. */
  view(dir: "front" | "top" | "right" | "iso") {
    const b = this.bounds();
    if (b.isEmpty()) return;
    const center = b.getCenter(new THREE.Vector3());
    const dist = this.camera.position.distanceTo(this.controls.target);
    const v = { front: [0, 0, 1], top: [0, 1, 0.0001], right: [1, 0, 0], iso: [0.9, 0.65, 1.1] }[dir];
    this.camera.position.copy(center).add(new THREE.Vector3(...(v as [number, number, number])).normalize().multiplyScalar(dist));
    this.controls.target.copy(center);
    this.controls.update();
    this.render();
  }

  info(): ModelInfo | null {
    if (!this.model) return null;
    const b = this.bounds();
    const parts: ModelInfo["parts"] = [];
    let triangles = 0;
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      const t = (m.geometry.index ? m.geometry.index.count : (m.geometry.getAttribute("position")?.count ?? 0)) / 3;
      triangles += t;
      if (parts.length < 60) parts.push({ name: partName(m, parts.length), triangles: t, size: vec(new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3())) });
    });
    return { size: vec(b.getSize(new THREE.Vector3())), min: vec(b.min), max: vec(b.max), triangles, parts };
  }

  private pick(e: PointerEvent) {
    if (!this.model) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.model, true).find((h) => (h.object as THREE.Mesh).isMesh);
    if (!hit) {
      this.setHighlight(null);
      this.onPick(null);
      return;
    }
    const mesh = hit.object as THREE.Mesh;
    this.setHighlight(mesh);
    const box = new THREE.Box3().setFromObject(mesh);
    const path: string[] = [];
    // Szenen-Hüllen aus dem glTF-Export („AuxScene“, „Scene“) gehören nicht zum Pfad.
    for (let o: THREE.Object3D | null = mesh; o && o !== this.model?.parent; o = o.parent) if (o.name && !/^(Aux)?Scene$/.test(o.name)) path.unshift(o.name);
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const t = (mesh.geometry.index ? mesh.geometry.index.count : (mesh.geometry.getAttribute("position")?.count ?? 0)) / 3;
    this.onPick({
      entry: this.entry,
      name: partName(mesh, 0),
      path: path.join(" › ") || partName(mesh, 0),
      center: vec(box.getCenter(new THREE.Vector3())),
      size: vec(box.getSize(new THREE.Vector3())),
      triangles: t,
      material: material?.name || ((material as THREE.MeshStandardMaterial)?.color ? `#${(material as THREE.MeshStandardMaterial).color.getHexString()}` : undefined),
    });
  }

  setHighlight(mesh: THREE.Object3D | null) {
    if (this.highlight) this.scene.remove(this.highlight), this.highlight.dispose();
    this.highlight = mesh ? new THREE.BoxHelper(mesh, 0x3d6ef0) : null;
    if (this.highlight) this.scene.add(this.highlight);
    this.render();
  }

  /** PNG als data:-URL; ohne Raster und Auswahl, optional in fester Größe. */
  screenshot(width?: number, height?: number): string {
    const hidden = [this.grid, this.highlight, this.box].filter(Boolean) as THREE.Object3D[];
    hidden.forEach((o) => (o.visible = false));
    let url: string;
    if (width && height) {
      const size = this.renderer.getSize(new THREE.Vector2());
      const aspect = this.camera.aspect;
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.render();
      url = this.renderer.domElement.toDataURL("image/png");
      this.renderer.setSize(size.x, size.y, false);
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    } else {
      this.render();
      url = this.renderer.domElement.toDataURL("image/png");
    }
    hidden.forEach((o) => (o.visible = true));
    this.render();
    return url;
  }

  dispose() {
    this.resize.disconnect();
    this.controls.dispose();
    this.clearModel();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

function partName(m: THREE.Object3D, i: number): string {
  return m.name || m.parent?.name || `Teil ${i + 1}`;
}

/** Modell ohne sichtbaren Viewer rendern (Delegation im Hintergrund): Screenshot und Maße. */
export async function renderOffscreen(bytes: ArrayBuffer, ext: string, zUp: boolean): Promise<{ png: string; info: ModelInfo | null }> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:960px;height:720px;pointer-events:none";
  document.body.appendChild(host);
  const v = new Viewer(host);
  try {
    v.show(await parseModel(bytes.slice(0), ext), false);
    v.setOptions({ zUp, grid: false });
    return { png: v.screenshot(960, 720), info: v.info() };
  } finally {
    v.dispose();
    host.remove();
  }
}
