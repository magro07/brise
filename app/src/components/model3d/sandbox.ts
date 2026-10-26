// Führt `model.js` isoliert aus: ein unsichtbares iframe mit
// `sandbox="allow-scripts"` (eigener, leerer Ursprung, kein Tauri) startet die
// gebündelte Laufzeit als Worker. Endlosschleifen beendet eine Zeitgrenze
// (Worker wird verworfen). Zurück kommen nur Bytes und Meldungen.

import runtime from "virtual:model-runtime";
import type { ParamSpec } from "./modelCode";

export interface BuildResult {
  out: { glb?: ArrayBuffer; stl?: ArrayBuffer; obj?: ArrayBuffer };
  params: ParamSpec[];
  logs: string[];
}

const TIMEOUT_MS = 30_000;

const HOST = `<!doctype html><meta charset="utf-8"><script>
var url = URL.createObjectURL(new Blob([RUNTIME], { type: "text/javascript" }));
var jobs = {};
addEventListener("message", function (e) {
  var job = e.data;
  if (!job || !job.__brise3d) return;
  var w;
  try { w = new Worker(url); } catch (err) { parent.postMessage({ __brise3d: 1, id: job.id, ok: false, error: "Worker: " + err }, "*"); return; }
  var timer = setTimeout(function () { w.terminate(); parent.postMessage({ __brise3d: 1, id: job.id, ok: false, error: "model.js lief länger als ${TIMEOUT_MS / 1000} s und wurde abgebrochen (Endlosschleife?)." }, "*"); }, ${TIMEOUT_MS});
  w.onmessage = function (m) { clearTimeout(timer); w.terminate(); var r = m.data; r.__brise3d = 1; r.id = job.id; parent.postMessage(r, "*", Object.values(r.out || {})); };
  w.onerror = function (ev) { clearTimeout(timer); w.terminate(); parent.postMessage({ __brise3d: 1, id: job.id, ok: false, error: ev.message || "Fehler in model.js" }, "*"); ev.preventDefault(); };
  w.postMessage({ code: job.code, params: job.params, formats: job.formats });
});
parent.postMessage({ __brise3d: 1, ready: true }, "*");
</script>`;

let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
let next = 1;
const waiting = new Map<number, { resolve: (r: BuildResult) => void; reject: (e: Error) => void }>();

function ensureFrame(): Promise<void> {
  if (ready && frame?.isConnected) return ready;
  ready = new Promise((resolve) => {
    const onReady = (e: MessageEvent) => {
      if (e.source === frame?.contentWindow && e.data?.__brise3d && e.data.ready) {
        window.removeEventListener("message", onReady);
        resolve();
      }
    };
    window.addEventListener("message", onReady);
    frame?.remove();
    frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none";
    // Die Laufzeit als JS-Zeichenkette einsetzen; „</script“ darf darin nicht vorkommen.
    frame.srcdoc = HOST.replace("RUNTIME", () => JSON.stringify(runtime).replace(/<\/script/gi, "<\\/script"));
    document.body.appendChild(frame);
  });
  return ready;
}

window.addEventListener("message", (e) => {
  const d = e.data;
  if (!frame || e.source !== frame.contentWindow || !d?.__brise3d || d.ready) return;
  const job = waiting.get(d.id);
  if (!job) return;
  waiting.delete(d.id);
  if (d.ok) job.resolve({ out: d.out ?? {}, params: d.params ?? [], logs: d.logs ?? [] });
  else job.reject(Object.assign(new Error(d.error || "Fehler in model.js"), { logs: d.logs ?? [] }));
});

/** Baut `model.js` und liefert die exportierten Dateien. */
export async function buildModel(code: string, params: Record<string, unknown>, formats: ("glb" | "stl" | "obj")[] = ["glb", "stl"]): Promise<BuildResult> {
  await ensureFrame();
  const id = next++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    frame!.contentWindow!.postMessage({ __brise3d: 1, id, code, params, formats }, "*");
  });
}
