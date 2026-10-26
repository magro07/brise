// Design-Modus: Typen, Rust-Aufrufe (src-tauri/src/design.rs), Design-Tokens
// und der Vorschau-Bundler, der ein Design zu einem einzigen HTML-Dokument
// für das isolierte iframe zusammensetzt.

import { invoke } from "@tauri-apps/api/core";

// ---------- Typen ----------

export interface ColorToken {
  name: string;
  light: string;
  dark: string;
}

export interface Token {
  name: string;
  value: string;
}

export interface DesignSystem {
  id: string;
  name: string;
  colors: ColorToken[];
  fonts: Token[];
  fontSizes: Token[];
  spacing: Token[];
  radius: Token[];
  shadows: Token[];
  /** Freie Regeln für den Agenten („Buttons immer pill-förmig“). */
  notes: string;
  /** Woher die Tokens stammen (Projektpfad), falls übernommen. */
  source?: string;
  updated: number;
}

export interface DesignVersion {
  n: number;
  label: string;
  at: number;
  sig: string;
}

export interface HandoffRecord {
  project: string;
  sessionId?: string;
  at: number;
  path: string;
}

export interface DesignMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
  systemId: string;
  sessionId?: string;
  versions: DesignVersion[];
  handoffs: HandoffRecord[];
}

export interface DesignFile {
  path: string;
  size: number;
  modified: number;
}

export interface PickedElement {
  /** Datei, in der das Element steckt, relativ zum Design. */
  entry: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
}

export const designApi = {
  root: () => invoke<string>("design_root"),
  read: (path: string) => invoke<string>("design_read", { path }),
  write: (path: string, content: string) => invoke<void>("design_write", { path, content }),
  writeBase64: (path: string, data: string) => invoke<string>("design_write_base64", { path, data }),
  dataUrl: (path: string) => invoke<string>("design_data_url", { path }),
  list: (path: string) => invoke<DesignFile[]>("design_list", { path }),
  dirs: (path: string) => invoke<string[]>("design_dirs", { path }),
  copy: (from: string, to: string, skip: string[], replace: boolean) => invoke<void>("design_copy", { from, to, skip, replace }),
  remove: (path: string) => invoke<void>("design_remove", { path }),
  exportTo: (path: string, project: string, target: string, skip: string[]) => invoke<string>("design_export", { path, project, target, skip }),
  importTokens: (project: string) =>
    invoke<{ sources: string[]; vars: [string, string][]; dark: [string, string][]; tailwind: [string, string][] }>("design_import_tokens", { project }),
};

// ---------- Ordner ----------

let root: string | null = null;

export async function designRoot(): Promise<string> {
  if (!root) root = await designApi.root();
  return root;
}

/** Gehört der Ordner zum Design-Modus? Solche Sessions erscheinen nicht bei den Projekten. */
export function isDesignPath(p: string): boolean {
  if (root && (p === root || p.startsWith(root + "/") || p.startsWith(root + "\\"))) return true;
  return /[\\/]design[\\/]d-[\w-]+[\\/]?$/.test(p);
}

export const absPath = (rel: string) => `${root ?? ""}/${rel}`.replace(/\\/g, "/");

/** Dateien, die Brise im Design-Ordner selbst verwaltet. */
export const MANAGED = [".versions", "design.json", "refs", "handoff", "preview.png"];

/** Verbindet `base` und `rel` und löst `.`/`..` auf. Liefert null bei Ausbruch über `limit`. */
export function joinPath(base: string, rel: string, limit: string): string | null {
  const parts = (base ? base.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(p);
  }
  const joined = out.join("/");
  return joined === limit || joined.startsWith(limit + "/") ? joined : null;
}

export const dirname = (p: string) => p.split("/").slice(0, -1).join("/");

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------- Tokens ----------

export function defaultSystem(): DesignSystem {
  return {
    id: "s-standard",
    name: "Standard",
    colors: [
      { name: "background", light: "#ffffff", dark: "#0f1115" },
      { name: "surface", light: "#f6f7f9", dark: "#171a21" },
      { name: "foreground", light: "#14161a", dark: "#eceef2" },
      { name: "muted", light: "#667085", dark: "#98a2b3" },
      { name: "border", light: "#e4e7ec", dark: "#2a2f3a" },
      { name: "primary", light: "#3d6ef0", dark: "#6d93ff" },
      { name: "primary-foreground", light: "#ffffff", dark: "#0d1430" },
      { name: "accent", light: "#f2994a", dark: "#f5ad6b" },
      { name: "success", light: "#17803d", dark: "#5ad083" },
      { name: "danger", light: "#c4352b", dark: "#ff7b70" },
    ],
    fonts: [
      { name: "sans", value: "'Inter', ui-sans-serif, system-ui, sans-serif" },
      { name: "display", value: "'Inter', ui-sans-serif, system-ui, sans-serif" },
      { name: "mono", value: "'JetBrains Mono', ui-monospace, monospace" },
    ],
    fontSizes: [
      { name: "xs", value: "0.75rem" },
      { name: "sm", value: "0.875rem" },
      { name: "base", value: "1rem" },
      { name: "lg", value: "1.125rem" },
      { name: "xl", value: "1.25rem" },
      { name: "2xl", value: "1.5rem" },
      { name: "3xl", value: "1.875rem" },
      { name: "4xl", value: "2.5rem" },
      { name: "5xl", value: "3.5rem" },
    ],
    spacing: [
      { name: "1", value: "4px" },
      { name: "2", value: "8px" },
      { name: "3", value: "12px" },
      { name: "4", value: "16px" },
      { name: "6", value: "24px" },
      { name: "8", value: "32px" },
      { name: "12", value: "48px" },
      { name: "16", value: "64px" },
    ],
    radius: [
      { name: "sm", value: "6px" },
      { name: "md", value: "10px" },
      { name: "lg", value: "16px" },
      { name: "full", value: "9999px" },
    ],
    shadows: [
      { name: "sm", value: "0 1px 2px rgb(16 24 40 / 0.06)" },
      { name: "md", value: "0 4px 12px rgb(16 24 40 / 0.08)" },
      { name: "lg", value: "0 12px 32px rgb(16 24 40 / 0.14)" },
    ],
    notes: "",
    updated: Date.now(),
  };
}

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";

export { slug };

/** CSS-Variablen aus dem System: `--color-*`, `--font-*`, `--text-*`, `--space-*`, `--radius-*`, `--shadow-*`. */
export function tokensCss(sys: DesignSystem): string {
  const line = (k: string, v: string) => `  --${k}: ${v};`;
  const light = [
    ...sys.colors.map((c) => line(`color-${slug(c.name)}`, c.light)),
    ...sys.fonts.map((t) => line(`font-${slug(t.name)}`, t.value)),
    ...sys.fontSizes.map((t) => line(`text-${slug(t.name)}`, t.value)),
    ...sys.spacing.map((t) => line(`space-${slug(t.name)}`, t.value)),
    ...sys.radius.map((t) => line(`radius-${slug(t.name)}`, t.value)),
    ...sys.shadows.map((t) => line(`shadow-${slug(t.name)}`, t.value)),
  ];
  const dark = sys.colors.filter((c) => c.dark && c.dark !== c.light).map((c) => line(`color-${slug(c.name)}`, c.dark));
  return [
    `/* Von Brise erzeugt aus dem Design-System „${sys.name}“ – nicht von Hand ändern. */`,
    `:root {\n${light.join("\n")}\n  color-scheme: light;\n}`,
    `:root[data-theme="dark"], .dark {\n${dark.join("\n")}\n  color-scheme: dark;\n}`,
    `body { font-family: var(--font-sans); background: var(--color-background); color: var(--color-foreground); }`,
  ].join("\n\n");
}

/** Kurzfassung für Prompts und den Übergabe-Auftrag. */
export function tokensSummary(sys: DesignSystem): string {
  const list = (title: string, items: Token[], prefix: string) =>
    items.length ? `- ${title}: ${items.map((t) => `--${prefix}-${slug(t.name)} (${t.value})`).join(", ")}` : "";
  return [
    `Design-System „${sys.name}“${sys.source ? ` (übernommen aus ${sys.source})` : ""}:`,
    `- Farben (hell / dunkel): ${sys.colors.map((c) => `--color-${slug(c.name)} (${c.light} / ${c.dark})`).join(", ")}`,
    list("Schriften", sys.fonts, "font"),
    list("Schriftgrößen", sys.fontSizes, "text"),
    list("Abstände", sys.spacing, "space"),
    list("Radien", sys.radius, "radius"),
    list("Schatten", sys.shadows, "shadow"),
    sys.notes.trim() ? `- Regeln: ${sys.notes.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/i;

/** Tokens aus einem Projekt (CSS-Variablen, Tailwind) in ein System übertragen. */
export function systemFromImport(
  base: DesignSystem,
  name: string,
  project: string,
  imp: { vars: [string, string][]; dark: [string, string][]; tailwind: [string, string][] },
): DesignSystem {
  const all = [...imp.vars, ...imp.tailwind];
  const dark = new Map(imp.dark);
  const colors: ColorToken[] = [];
  const fonts: Token[] = [];
  const fontSizes: Token[] = [];
  const spacing: Token[] = [];
  const radius: Token[] = [];
  const shadows: Token[] = [];
  const strip = (n: string, ...prefixes: string[]) => prefixes.reduce((s, p) => (s.startsWith(p) ? s.slice(p.length) : s), n);
  for (const [n, v] of all) {
    if (v.includes("var(") && !COLOR_RE.test(v)) continue;
    if (COLOR_RE.test(v)) {
      const key = strip(n, "color-", "colors-");
      if (!colors.some((c) => c.name === key)) colors.push({ name: key, light: v, dark: dark.get(n) ?? v });
    } else if (/^font(-family)?-/.test(n) && !/size|weight/.test(n)) fonts.push({ name: strip(n, "font-family-", "font-"), value: v });
    else if (/^(text|font-size)-/.test(n)) fontSizes.push({ name: strip(n, "font-size-", "text-"), value: v });
    else if (/^(space|spacing|gap)-?/.test(n)) spacing.push({ name: strip(n, "spacing-", "space-", "gap-") || n, value: v });
    else if (/^(radius|rounded)/.test(n)) radius.push({ name: strip(n, "radius-", "rounded-") || "base", value: v });
    else if (/^shadow/.test(n)) shadows.push({ name: strip(n, "shadow-") || "base", value: v });
  }
  return {
    ...base,
    id: newId("s"),
    name,
    colors: colors.length ? colors.slice(0, 60) : base.colors,
    fonts: fonts.length ? fonts : base.fonts,
    fontSizes: fontSizes.length ? fontSizes : base.fontSizes,
    spacing: spacing.length ? spacing : base.spacing,
    radius: radius.length ? radius : base.radius,
    shadows: shadows.length ? shadows : base.shadows,
    source: project,
    updated: Date.now(),
  };
}

// ---------- Vorschau ----------

export type Device = "mobile" | "tablet" | "desktop";
export const DEVICE_WIDTH: Record<Device, number> = { mobile: 390, tablet: 820, desktop: 1280 };
export const DEVICE_HEIGHT: Record<Device, number> = { mobile: 844, tablet: 1100, desktop: 800 };

/** Einstiegsdateien eines Designs: Hauptdesign und Varianten (`variants/<name>/`). */
export function entries(files: DesignFile[]): { name: string; entry: string }[] {
  const has = (p: string) => files.some((f) => f.path === p);
  const pick = (dir: string) => ["index.html", "App.jsx", "App.tsx"].map((f) => (dir ? `${dir}/${f}` : f)).find(has);
  const out: { name: string; entry: string }[] = [];
  const main = pick("");
  if (main) out.push({ name: "Hauptdesign", entry: main });
  const variants = [...new Set(files.map((f) => /^variants\/([^/]+)\//.exec(f.path)?.[1]).filter((v): v is string => !!v))].sort();
  for (const v of variants) {
    const e = pick(`variants/${v}`);
    if (e) out.push({ name: `Variante ${v.toUpperCase()}`, entry: e });
  }
  return out;
}

/** Skript im iframe: Theme, Elementauswahl, Screenshot, Fehler. Kommuniziert nur per postMessage. */
function bridge(theme: "light" | "dark", entry: string): string {
  return `<script>(function(){
var send=function(m){m.__brise=1;m.entry=${JSON.stringify(entry)};parent.postMessage(m,"*");};
function setTheme(t){var r=document.documentElement;r.setAttribute("data-theme",t);r.classList.toggle("dark",t==="dark");r.style.colorScheme=t;}
setTheme(${JSON.stringify(theme)});
window.addEventListener("error",function(e){send({type:"error",message:String(e.message||e)});});
window.addEventListener("unhandledrejection",function(e){send({type:"error",message:String(e.reason&&e.reason.message||e.reason)});});
var picking=false,box=null,sel=null;
function overlay(color){var b=document.createElement("div");b.setAttribute("data-brise-overlay","");b.style.cssText="position:fixed;pointer-events:none;z-index:2147483647;border:2px solid "+color+";border-radius:3px;background:"+color+"22;transition:all .06s";document.documentElement.appendChild(b);return b;}
function place(b,el){var r=el.getBoundingClientRect();b.style.left=r.left+"px";b.style.top=r.top+"px";b.style.width=r.width+"px";b.style.height=r.height+"px";}
function selector(el){var parts=[];while(el&&el.nodeType===1&&el!==document.documentElement&&parts.length<5){var s=el.tagName.toLowerCase();if(el.id){parts.unshift(s+"#"+el.id);break;}var cls=[].slice.call(el.classList).filter(function(c){return c.length<30&&!/[:\\[\\]\\/]/.test(c);}).slice(0,2);if(cls.length)s+="."+cls.join(".");var p=el.parentElement;if(p){var same=[].filter.call(p.children,function(c){return c.tagName===el.tagName;});if(same.length>1)s+=":nth-of-type("+(same.indexOf(el)+1)+")";}parts.unshift(s);el=p;}return parts.join(" > ");}
document.addEventListener("mousemove",function(e){if(!picking)return;var el=e.target;if(!el||el.hasAttribute&&el.hasAttribute("data-brise-overlay"))return;if(!box)box=overlay("#3d6ef0");place(box,el);},true);
document.addEventListener("click",function(e){if(!picking)return;e.preventDefault();e.stopPropagation();var el=e.target;var html=el.outerHTML;if(html.length>1200)html=html.slice(0,1200)+" …";if(!sel)sel=overlay("#f2994a");place(sel,el);sel._el=el;send({type:"pick",selector:selector(el),tag:el.tagName.toLowerCase(),text:(el.innerText||"").trim().slice(0,120),html:html});},true);
window.addEventListener("scroll",function(){if(sel&&sel._el)place(sel,sel._el);},true);
window.addEventListener("message",function(e){var d=e.data||{};if(!d.__brise)return;
if(d.type==="theme")setTheme(d.theme);
if(d.type==="pick"){picking=!!d.on;document.documentElement.style.cursor=picking?"crosshair":"";if(!picking&&box){box.remove();box=null;}}
if(d.type==="clear"&&sel){sel.remove();sel=null;}
if(d.type==="capture"){[box,sel].forEach(function(b){if(b)b.style.display="none";});import("https://esm.sh/html-to-image@1.11.13").then(function(m){var h=Math.min(document.documentElement.scrollHeight,6000);var bg=getComputedStyle(document.body).backgroundColor;return m.toPng(document.documentElement,{width:innerWidth,height:h,pixelRatio:1,backgroundColor:bg&&bg!=="rgba(0, 0, 0, 0)"?bg:"#ffffff",filter:function(n){return !(n.hasAttribute&&n.hasAttribute("data-brise-overlay"));}});}).then(function(url){send({type:"capture",id:d.id,url:url});},function(err){send({type:"capture",id:d.id,error:String(err&&err.message||err)});}).finally(function(){[box,sel].forEach(function(b){if(b)b.style.display="";});});}
});
if(document.readyState==="complete")send({type:"ready"});else addEventListener("load",function(){send({type:"ready"});});
})();</script>`;
}

const reactShell = (code: string) => `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script type="importmap">{"imports":{"react":"https://esm.sh/react@19.1.0","react/":"https://esm.sh/react@19.1.0/","react-dom/client":"https://esm.sh/react-dom@19.1.0/client","lucide-react":"https://esm.sh/lucide-react@0.468.0?external=react"}}</script>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/@babel/standalone@7.26.4/babel.min.js"></script>
</head><body><div id="root"></div>
<script type="text/babel" data-type="module" data-presets="react,typescript" data-filename="App.tsx">
${code.replace(/<\/script/gi, "<\\/script")}
;import { createRoot as __briseRoot } from "react-dom/client";
__briseRoot(document.getElementById("root")).render(<BriseRoot />);
</script></body></html>`;

const isRemote = (u: string) => /^(https?:|data:|blob:|\/\/|#|mailto:|javascript:)/i.test(u);

/**
 * Setzt ein Design zu einem HTML-Dokument zusammen: relative Stylesheets,
 * Skripte und Bilder werden eingebettet, Tokens und die Brücke vorangestellt.
 * `base` ist der Design-Ordner (relativ zum Design-Root), `entry` relativ zu `base`.
 */
export async function buildPreview(base: string, entry: string, css: string, theme: "light" | "dark"): Promise<string> {
  const entryPath = `${base}/${entry}`;
  let html = await designApi.read(entryPath);
  // `export default …` wird zu `const BriseRoot = …` – gilt für Funktionen, Pfeile und Namen.
  if (/\.(jsx|tsx)$/.test(entry)) html = reactShell(html.replace(/export\s+default\s+/, "const BriseRoot = "));
  const dir = dirname(entryPath);
  const resolve = (u: string) => (isRemote(u) ? null : joinPath(dir, u.split(/[?#]/)[0], base));

  // <link rel="stylesheet" href="…">
  const links = [...html.matchAll(/<link\b[^>]*>/gi)];
  for (const m of links) {
    const tag = m[0];
    if (!/rel=["']?stylesheet/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    const p = href && resolve(href);
    if (!p) continue;
    // tokens.css kommt ohnehin immer aktuell aus dem System.
    if (p === `${base}/tokens.css`) {
      html = html.replace(tag, "");
      continue;
    }
    const content = await designApi.read(p).catch(() => `/* ${href} fehlt */`);
    html = html.replace(tag, () => `<style data-file="${href}">\n${content}\n</style>`);
  }
  // <script src="…"></script>
  const scripts = [...html.matchAll(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi)];
  for (const m of scripts) {
    const p = resolve(m[2]);
    if (!p) continue;
    const content = await designApi.read(p).catch(() => `console.error(${JSON.stringify(`${m[2]} fehlt`)})`);
    html = html.replace(m[0], () => `<script${m[1]}${m[3]} data-file="${m[2]}">\n${content.replace(/<\/script/gi, "<\\/script")}\n</script>`);
  }
  // Bilder und andere Medien (src="…", url(…))
  const media = new Map<string, string>();
  for (const m of html.matchAll(/\b(?:src|href|poster)=["']([^"']+\.(?:png|jpe?g|gif|webp|svg|avif))["']/gi)) media.set(m[1], "");
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+\.(?:png|jpe?g|gif|webp|svg|avif|woff2?|ttf))["']?\s*\)/gi)) media.set(m[1], "");
  for (const u of media.keys()) {
    const p = resolve(u);
    if (!p) continue;
    const url = await designApi.dataUrl(p).catch(() => "");
    if (url) html = html.split(u).join(url);
  }

  const head = `<style id="brise-tokens">\n${css}\n</style>${bridge(theme, entry)}`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (h) => `${h}${head}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (h) => `${h}<head>${head}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`;
}
