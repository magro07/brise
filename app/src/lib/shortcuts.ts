import { newDesign } from "../components/design/DesignView";
import { newModel } from "../components/model3d/Sidebar";
import { IS_MAC } from "./platform";
import { useStore } from "./store";
import { useDesign } from "../components/design/designStore";
import { useModel } from "../components/model3d/modelStore";

/** Tastenkürzel: eine Liste aller Aktionen, frei belegbar (prefs.shortcuts). */
export type ShortcutAction = { id: string; label: string; group: string; keys: string[]; run: () => void };

const st = () => useStore.getState();
/** Aktionen, die es nur als Knopf gibt, lösen genau diesen Knopf aus. */
const press = (selector: string) => document.querySelector<HTMLElement>(selector)?.click();
const pressText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)?.click();
const stepThinking = (dir: number) => {
  const s = st().activeSessionId ? st().sessions[st().activeSessionId!] : undefined;
  const opt = s?.config.find((o) => o.id === "thinking");
  const levels = (opt?.options ?? []).map((o) => o.value);
  const next = levels[levels.indexOf(String(opt?.currentValue)) + dir];
  if (s && next) void st().setOption("thinking", next, s.id).catch(() => {});
};
const openTabAt = (n: number) => {
  const pane = st().panes[st().focusedPane];
  if (pane?.tabs[n]) st().openTab(pane.tabs[n], st().focusedPane);
};
const work = () => (st().view === "design" ? useDesign : st().view === "3d" ? useModel : null);
const cycle = (dir: number) => {
  const w = work()?.getState();
  if (w) {
    if (w.tabs.length > 1) void w.open(w.tabs[((w.activeId ? w.tabs.indexOf(w.activeId) : -1) + dir + w.tabs.length) % w.tabs.length]);
    return;
  }
  const pane = st().panes[st().focusedPane];
  if (!pane?.tabs.length) return;
  const i = pane.active ? pane.tabs.indexOf(pane.active) : -1;
  st().openTab(pane.tabs[(i + dir + pane.tabs.length) % pane.tabs.length], st().focusedPane);
};

export const ACTIONS: ShortcutAction[] = [
  { id: "new", label: "Neu (Session, Design oder Modell)", group: "Allgemein", keys: ["mod+n"], run: () => (st().view === "design" ? void newDesign() : st().view === "3d" ? void newModel() : st().newDraft()) },
  { id: "palette", label: "Suchen und Befehle", group: "Allgemein", keys: ["mod+k"], run: () => st().set({ paletteOpen: !st().paletteOpen }) },
  { id: "settings", label: "Einstellungen", group: "Allgemein", keys: ["mod+,"], run: () => st().setView(st().view === "settings" ? "chat" : "settings") },
  { id: "project", label: "Neues Projekt", group: "Allgemein", keys: ["mod+shift+o"], run: () => st().set({ newProjectOpen: true }) },
  { id: "simple", label: "Einfachen Modus umschalten", group: "Allgemein", keys: ["mod+shift+e"], run: () => st().setPrefs({ simpleMode: !st().prefs.simpleMode }) },
  { id: "theme", label: "Hell oder dunkel", group: "Allgemein", keys: ["mod+shift+l"], run: () => st().setPrefs({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" }) },
  { id: "code", label: "Zu Code", group: "Ansicht", keys: ["mod+1"], run: () => st().setView("chat") },
  { id: "design", label: "Zu Design", group: "Ansicht", keys: ["mod+2"], run: () => st().setView("design") },
  { id: "3d", label: "Zu 3D", group: "Ansicht", keys: ["mod+3"], run: () => st().setView("3d") },
  { id: "sidebar", label: "Seitenleiste", group: "Ansicht", keys: ["mod+b"], run: () => st().set({ sidebarOpen: !st().sidebarOpen }) },
  { id: "panel", label: "Detailpanel", group: "Ansicht", keys: ["mod+j"], run: () => st().togglePanel() },
  { id: "terminal", label: "Terminal", group: "Ansicht", keys: ["mod+ö", "mod+`", "mod+dead"], run: () => st().set({ terminalOpen: !st().terminalOpen }) },
  { id: "split", label: "Geteilte Ansicht", group: "Ansicht", keys: ["mod+\\"], run: () => st().splitWith(st().activeSessionId) },
  { id: "close", label: "Tab schließen", group: "Tabs", keys: ["mod+w"], run: () => {
    const w = work()?.getState();
    if (w) { if (w.activeId) w.closeTab(w.activeId); }
    else if (st().activeSessionId) st().closeTab(st().focusedPane, st().activeSessionId!);
  } },
  { id: "next", label: "Nächster Tab", group: "Tabs", keys: ["mod+tab"], run: () => cycle(1) },
  { id: "prev", label: "Vorheriger Tab", group: "Tabs", keys: ["mod+shift+tab"], run: () => cycle(-1) },
  { id: "focus", label: "Ins Eingabefeld", group: "Eingabe", keys: ["mod+l"], run: () => document.querySelector<HTMLElement>("textarea")?.focus() },
  { id: "model", label: "Modell wählen", group: "Eingabe", keys: ["mod+m"], run: () => press('[aria-label="Modell"]') },
  { id: "thinking", label: "Denkstufe wählen", group: "Eingabe", keys: ["mod+shift+t"], run: () => press('[aria-label="Modell"]') },
  { id: "thinkUp", label: "Denkstufe erhöhen", group: "Eingabe", keys: ["mod+alt+arrowup"], run: () => stepThinking(1) },
  { id: "thinkDown", label: "Denkstufe senken", group: "Eingabe", keys: ["mod+alt+arrowdown"], run: () => stepThinking(-1) },
  { id: "voice", label: "Spracheingabe", group: "Eingabe", keys: ["mod+shift+m"], run: () => press('[aria-label="Spracheingabe"]') },
  { id: "attach", label: "Datei anhängen", group: "Eingabe", keys: ["mod+shift+a"], run: () => press('[aria-label="Dateien oder Bilder anhängen"]') },
  { id: "stop", label: "Antwort stoppen", group: "Eingabe", keys: ["mod+."], run: () => press('[aria-label^="Stopp"]') },
  { id: "allow", label: "Freigabe erlauben", group: "Freigaben", keys: ["mod+shift+y"], run: () => pressText("Erlauben") },
  { id: "deny", label: "Freigabe ablehnen", group: "Freigaben", keys: ["mod+shift+n"], run: () => pressText("Ablehnen") },
  ...[1, 2, 3, 4, 5].map((n) => ({ id: `tab${n}`, label: `Tab ${n}`, group: "Tabs", keys: [`mod+alt+${n}`], run: () => openTabAt(n - 1) })),
  { id: "changes", label: "Änderungen", group: "Panels", keys: ["mod+g c"], run: () => st().togglePanel("changes") },
];

export const keysOf = (a: ShortcutAction, custom: Record<string, string>) => (custom[a.id] ? [custom[a.id]] : a.keys);

/** „mod+shift+k“ aus einem Tastendruck; reine Umschalttasten ergeben nichts. */
export function comboOf(e: KeyboardEvent): string | null {
  if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return null;
  const digit = /^Digit(\d)$/.exec(e.code)?.[1];
  const key = digit ?? e.key.toLowerCase();
  return [e.ctrlKey || e.metaKey ? "mod" : "", e.shiftKey ? "shift" : "", e.altKey ? "alt" : "", key].filter(Boolean).join("+");
}

const WORD: Record<string, string> = { mod: IS_MAC ? "⌘" : "Strg", shift: IS_MAC ? "⇧" : "Umschalt", alt: IS_MAC ? "⌥" : "Alt", tab: "Tab" };
export const showCombo = (combo: string) =>
  combo.split(" ").map((p) => p.split("+").map((k) => WORD[k] ?? k.toUpperCase()).join(IS_MAC ? "" : "+")).join(" dann ");

/** Doppelt belegte Kürzel, je Tastenfolge die Aktionen. */
export function conflicts(custom: Record<string, string>) {
  const seen: Record<string, string[]> = {};
  for (const a of ACTIONS) for (const k of keysOf(a, custom)) (seen[k] ??= []).push(a.label);
  return Object.fromEntries(Object.entries(seen).filter(([, v]) => v.length > 1));
}

let pending = "";
let pendingAt = 0;

export function handleShortcut(e: KeyboardEvent) {
  const combo = comboOf(e);
  if (!combo) return;
  const chord = pending && Date.now() - pendingAt < 1500;
  if (!chord && !combo.startsWith("mod")) return;
  const full = chord ? `${pending} ${combo}` : combo;
  const custom = st().prefs.shortcuts ?? {};
  const hit = ACTIONS.find((a) => keysOf(a, custom).includes(full));
  pending = "";
  if (hit) {
    e.preventDefault();
    if (e.repeat) return;
    hit.run();
    // Spracheingabe: Taste gehalten = beim Loslassen fertig, kurz gedrückt = umschalten.
    if (hit.id === "voice") {
      const started = Date.now();
      window.addEventListener("keyup", () => {
        if (Date.now() - started > 400) hit.run();
      }, { once: true });
    }
  } else if (!chord && ACTIONS.some((a) => keysOf(a, custom).some((k) => k.startsWith(`${combo} `)))) {
    e.preventDefault();
    pending = combo;
    pendingAt = Date.now();
  }
}
