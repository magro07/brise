// Aufbereitung von `model.js` für die Laufzeit (runtime.ts): Importe aus
// three.js werden zu Variablen, Exporte zu Zuweisungen. Dazu die Regler
// (`export const params`). Reine Funktionen, damit Laufzeit und Oberfläche
// sie gemeinsam nutzen.

export interface ParamSpec {
  name: string;
  label: string;
  type: "number" | "boolean" | "select";
  value: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

const IMPORT = /^[ \t]*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'][ \t]*;?/gm;
const BARE_IMPORT = /^[ \t]*import\s+["']([^"']+)["'][ \t]*;?/gm;

function named(list: string): string[][] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+as\s+/).map((x) => x.trim()));
}

function importLine(clause: string, source: string): string {
  const fromThree = source === "three";
  const addon = source.startsWith("three/") || source.startsWith("three-bvh-csg");
  if (!fromThree && !addon) {
    throw new Error(`Import „${source}“ wird nicht unterstützt. Erlaubt sind „three“, „three/addons/…“ und „three-bvh-csg“; alles andere bitte selbst schreiben.`);
  }
  const target = fromThree ? "THREE" : "ADDONS";
  const out: string[] = [];
  let rest = clause.trim();
  // Default-Import („import X from …“ bzw. „import X, { … } from …“).
  const def = /^([A-Za-z_$][\w$]*)\s*(,|$)/.exec(rest);
  if (def) {
    if (!(fromThree && def[1] === "THREE")) out.push(`const ${def[1]} = ${target};`);
    rest = rest.slice(def[0].length).trim();
  }
  const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(rest);
  if (ns) {
    const base = source.split("/").pop()!.replace(/\.js$/, "");
    if (!(fromThree && ns[1] === "THREE")) out.push(fromThree ? `const ${ns[1]} = THREE;` : `const ${ns[1]} = ADDONS[${JSON.stringify(base)}] ?? ADDONS;`);
  } else if (rest.startsWith("{")) {
    const pairs = named(rest.replace(/^\{|\}$/g, ""));
    const names = pairs.map((p) => p[0]);
    if (addon) out.push(`for (const n of ${JSON.stringify(names)}) if (!(n in ADDONS)) throw new Error("„" + n + "“ aus ${source} ist in Brise nicht verfügbar.");`);
    out.push(`const { ${pairs.map((p) => (p[1] ? `${p[0]}: ${p[1]}` : p[0])).join(", ")} } = ${target};`);
  } else if (rest) {
    throw new Error(`Import nicht verstanden: import ${clause} from "${source}"`);
  }
  return out.join(" ");
}

/** Wandelt das ES-Modul in einen Funktionsrumpf; `exportsList` sind die Namen, die am Ende zugewiesen werden. */
export function compile(code: string): { body: string; exportsList: string[] } {
  const exportsList: string[] = [];
  let body = code.replace(IMPORT, (_m, clause: string, source: string) => importLine(clause, source));
  body = body.replace(BARE_IMPORT, (_m, source: string) => importLine("", source));
  body = body.replace(/^([ \t]*)export\s+default\s+/gm, "$1__exports.default = ");
  body = body.replace(/^([ \t]*)export\s+((?:async\s+)?function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm, (_m, ws: string, kind: string, name: string) => {
    exportsList.push(name);
    return `${ws}${kind} ${name}`;
  });
  body = body.replace(/^[ \t]*export\s*\{([^}]*)\}[ \t]*;?/gm, (_m, list: string) =>
    named(list)
      .map(([local, as]) => `__exports.${as ?? local} = ${local};`)
      .join(" "),
  );
  return { body, exportsList };
}

const label = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");

/** Regler aus `export const params = { breite: 40, … }` bzw. `{ breite: { value, min, max, step, label } }`. */
export function describeParams(params: unknown): ParamSpec[] {
  if (!params || typeof params !== "object") return [];
  const out: ParamSpec[] = [];
  for (const [name, raw] of Object.entries(params as Record<string, unknown>).slice(0, 40)) {
    const spec = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { value: raw };
    const value = spec.value;
    const lbl = typeof spec.label === "string" ? spec.label : label(name);
    if (Array.isArray(spec.options) && spec.options.length) {
      const options = spec.options.map(String);
      out.push({ name, label: lbl, type: "select", value: String(value ?? options[0]), options });
    } else if (typeof value === "boolean") {
      out.push({ name, label: lbl, type: "boolean", value });
    } else if (typeof value === "number" && Number.isFinite(value)) {
      const int = Number.isInteger(value);
      const min = typeof spec.min === "number" ? spec.min : value >= 0 ? 0 : value * 3;
      const max = typeof spec.max === "number" ? spec.max : value === 0 ? 100 : Math.abs(value) * 3;
      const step = typeof spec.step === "number" ? spec.step : int ? 1 : Math.max(0.01, Math.abs(value) / 100);
      out.push({ name, label: lbl, type: "number", value, min, max, step });
    }
  }
  return out;
}
