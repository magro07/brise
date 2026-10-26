import { build, defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { fileURLToPath } from "node:url";
const host = process.env.TAURI_DEV_HOST;

/**
 * 3D-Modus: Die Laufzeit für `model.js` (three.js, Exporter, CSG) wird als
 * eigenständiges Skript gebündelt und als Text eingebettet. Brise startet sie
 * als Worker in einem isolierten iframe (siehe src/components/model3d/sandbox.ts).
 */
function modelRuntime(): Plugin {
  const id = "virtual:model-runtime";
  // fileURLToPath statt .pathname: unter Windows wäre das „/D:/…“.
  const entry = fileURLToPath(new URL("./src/components/model3d/runtime.ts", import.meta.url));
  return {
    name: "brise-model-runtime",
    resolveId: (source) => (source === id ? "\0" + id : null),
    async load(source) {
      if (source !== "\0" + id) return null;
      this.addWatchFile(entry);
      const out: any = await build({
        configFile: false,
        logLevel: "warn",
        build: { write: false, minify: true, lib: { entry, formats: ["iife"], name: "BriseRuntime", fileName: () => "runtime.js" } },
      });
      const chunk = (Array.isArray(out) ? out[0] : out).output.find((o: any) => o.type === "chunk");
      return `export default ${JSON.stringify(chunk.code)};`;
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), modelRuntime()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
