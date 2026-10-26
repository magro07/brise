import { useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor";

// Monaco (der Editor von VS Code) wird erst geladen, wenn er gebraucht wird.
let monacoPromise: Promise<typeof Monaco> | null = null;

function loadMonaco() {
  monacoPromise ??= (async () => {
    const [monaco, editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker] = await Promise.all([
      import("monaco-editor"),
      import("monaco-editor/editor/editor.worker?worker"),
      import("monaco-editor/language/json/json.worker?worker"),
      import("monaco-editor/language/css/css.worker?worker"),
      import("monaco-editor/language/html/html.worker?worker"),
      import("monaco-editor/language/typescript/ts.worker?worker"),
    ]);
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker(_: unknown, label: string) {
        if (label === "json") return new jsonWorker.default();
        if (label === "css" || label === "scss" || label === "less") return new cssWorker.default();
        if (label === "html" || label === "handlebars") return new htmlWorker.default();
        if (label === "typescript" || label === "javascript") return new tsWorker.default();
        return new editorWorker.default();
      },
    };
    // Prüfungen von TS/JS aus: ohne Projektkonfiguration gäbe es nur Fehlalarme.
    const ts = (monaco.languages as unknown as { typescript?: { typescriptDefaults: { setDiagnosticsOptions(o: object): void }; javascriptDefaults: { setDiagnosticsOptions(o: object): void } } }).typescript;
    ts?.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    ts?.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    return monaco;
  })();
  return monacoPromise;
}

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", css: "css", scss: "scss", less: "less", html: "html", md: "markdown", py: "python", rs: "rust",
  go: "go", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  rb: "ruby", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", sql: "sql",
  swift: "swift", xml: "xml", svg: "xml", dockerfile: "dockerfile", lua: "lua", r: "r", dart: "dart", vue: "html",
};

export function languageOf(path: string) {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  return LANG[name.split(".").pop() ?? ""] ?? "plaintext";
}

function themeName() {
  return document.documentElement.dataset.theme === "dark" ? "vs-dark" : "vs";
}

const OPTIONS = {
  fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
  fontSize: 13,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: "selection" as const,
  smoothScrolling: true,
  padding: { top: 8 },
};

/** Monaco-Editor; mit `original` als Vergleichsansicht (letzter Commit ↔ jetzt). */
export function CodeEditor({
  path,
  value,
  original,
  onChange,
  onSave,
}: {
  path: string;
  value: string;
  original?: string | null;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | Monaco.editor.IStandaloneDiffEditor | null>(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    let disposed = false;
    const cleanup: (() => void)[] = [];
    loadMonaco().then((monaco) => {
      if (disposed || !host.current) return;
      const lang = languageOf(path);
      const modified = monaco.editor.createModel(value, lang);
      cleanup.push(() => modified.dispose());
      let code: Monaco.editor.IStandaloneCodeEditor;
      if (original != null) {
        const orig = monaco.editor.createModel(original, lang);
        cleanup.push(() => orig.dispose());
        const diff = monaco.editor.createDiffEditor(host.current, { ...OPTIONS, theme: themeName(), renderSideBySide: false, originalEditable: false });
        diff.setModel({ original: orig, modified });
        code = diff.getModifiedEditor();
        editor.current = diff;
      } else {
        code = monaco.editor.create(host.current, { ...OPTIONS, model: modified, theme: themeName() });
        editor.current = code;
      }
      cleanup.push(() => editor.current?.dispose());
      code.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
      const sub = modified.onDidChangeContent(() => changeRef.current(modified.getValue()));
      cleanup.push(() => sub.dispose());
      const observer = new MutationObserver(() => monaco.editor.setTheme(themeName()));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      cleanup.push(() => observer.disconnect());
    });
    return () => {
      disposed = true;
      cleanup.reverse().forEach((f) => f());
    };
    // Neu aufbauen nur bei anderer Datei oder anderem Modus.
  }, [path, original != null]);

  return <div ref={host} className="h-full w-full" />;
}
