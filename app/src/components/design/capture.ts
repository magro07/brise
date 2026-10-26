// Screenshots eines Designs: rendert es in einem unsichtbaren iframe in
// Gerätegröße und lässt die Brücke darin ein PNG erzeugen (html-to-image).

import { DEVICE_HEIGHT, DEVICE_WIDTH, buildPreview, type Device } from "../../lib/design";

/** Liefert eine `data:image/png`-URL. */
export async function captureEntry(designId: string, entry: string, css: string, device: Device, theme: "light" | "dark"): Promise<string> {
  const html = await buildPreview(designId, entry, css, theme);
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${DEVICE_WIDTH[device]}px;height:${DEVICE_HEIGHT[device]}px;border:0;visibility:hidden`;
  const id = Math.random().toString(36).slice(2);
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Screenshot hat zu lange gedauert")), 30_000);
      const onMessage = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow || !e.data?.__brise) return;
        if (e.data.type === "ready") {
          // Webfonts, Tailwind-CDN und Bilder kurz fertig rendern lassen.
          setTimeout(() => frame.contentWindow?.postMessage({ __brise: 1, type: "capture", id }, "*"), 1200);
        } else if (e.data.type === "capture" && e.data.id === id) {
          clearTimeout(timer);
          window.removeEventListener("message", onMessage);
          if (e.data.url) resolve(e.data.url);
          else reject(new Error(e.data.error ?? "Screenshot fehlgeschlagen"));
        }
      };
      window.addEventListener("message", onMessage);
      frame.srcdoc = html;
      document.body.appendChild(frame);
    });
  } finally {
    frame.remove();
  }
}
