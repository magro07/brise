import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ExternalLink, File, FilePlus, Folder, FolderPlus, RefreshCw, Save, X } from "lucide-react";
import { api } from "../../lib/acp";
import { useStore } from "../../lib/store";
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, clsx } from "../ui";
import { CodeEditor } from "../tools/CodeEditor";
import { askText, showError } from "../../lib/dialogs";

interface Node {
  name: string;
  path: string;
  children?: Map<string, Node>;
}

function buildTree(files: string[]): Node {
  const root: Node = { name: "", path: "", children: new Map() };
  for (const f of files) {
    let node = root;
    const parts = f.split("/");
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      if (!node.children!.has(part)) {
        node.children!.set(part, { name: part, path: parts.slice(0, i + 1).join("/"), children: isFile ? undefined : new Map() });
      }
      node = node.children!.get(part)!;
    });
  }
  return root;
}

function sorted(node: Node) {
  return [...(node.children?.values() ?? [])].sort((a, b) => (a.children ? 0 : 1) - (b.children ? 0 : 1) || a.name.localeCompare(b.name));
}

function TreeNode({ node, depth, open, toggle, active, onOpen }: { node: Node; depth: number; open: Set<string>; toggle: (p: string) => void; active: string | null; onOpen: (p: string) => void }) {
  const isDir = !!node.children;
  const expanded = open.has(node.path);
  return (
    <>
      <button
        className={clsx("flex h-6 w-full items-center gap-1.5 rounded px-1 text-left text-[0.86em] hover:bg-hover", active === node.path && "bg-active text-fg", !isDir && "text-fg-2")}
        style={{ paddingLeft: depth * 12 + 4 }}
        onClick={() => (isDir ? toggle(node.path) : onOpen(node.path))}
        title={node.path}
      >
        {isDir ? <ChevronRight className={clsx("h-3 w-3 shrink-0 text-muted transition-transform", expanded && "rotate-90")} /> : <span className="w-3 shrink-0" />}
        {isDir ? <Folder className="h-3.5 w-3.5 shrink-0 text-muted" /> : <File className="h-3.5 w-3.5 shrink-0 text-muted" />}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && expanded && sorted(node).map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} active={active} onOpen={onOpen} />)}
    </>
  );
}

/** Datei-Explorer mit Monaco-Editor (Strg+S speichert). */
export function FilesPanel({ cwd }: { cwd: string }) {
  const editor = useStore((s) => s.editor);
  const { openFile, closeFile, saveFile, loadFiles } = useStore.getState();
  const [files, setFiles] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [externals, setExternals] = useState<{ id: string; name: string }[]>([]);

  const reload = () => {
    useStore.setState((s) => {
      const f = { ...s.files };
      delete f[cwd];
      return { files: f };
    });
    loadFiles(cwd).then(setFiles);
  };
  useEffect(() => {
    loadFiles(cwd).then(setFiles);
    api.externalEditors().then(setExternals);
  }, [cwd]);

  const tree = useMemo(() => buildTree(filter ? files.filter((f) => f.toLowerCase().includes(filter.toLowerCase())) : files), [files, filter]);
  const expanded = filter ? new Set(files.flatMap((f) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/")))) : open;
  const current = editor.files.find((f) => f.path === editor.active);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-48 shrink-0 flex-col border-r border-line">
        <div className="flex items-center gap-1 p-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Dateien filtern …"
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-[0.84em] outline-none focus:border-accent"
          />
          <IconButton
            label="Neue Datei"
            size="sm"
            onClick={async () => {
              const name = await askText("Neue Datei", "z. B. src/neu.ts");
              if (!name?.trim()) return;
              try {
                await api.createPath(cwd, name.trim(), false);
                reload();
                openFile(name.trim());
              } catch (e) {
                showError(String(e));
              }
            }}
          >
            <FilePlus className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            label="Neuer Ordner"
            size="sm"
            onClick={async () => {
              const name = await askText("Neuer Ordner", "z. B. docs");
              if (!name?.trim()) return;
              try {
                await api.createPath(cwd, name.trim(), true);
                setOpen((s) => new Set([...s, name.trim()]));
                reload();
              } catch (e) {
                showError(String(e));
              }
            }}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Neu laden" size="sm" onClick={reload}>
            <RefreshCw className="h-3.5 w-3.5" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {sorted(tree).map((n) => (
            <TreeNode
              key={n.path}
              node={n}
              depth={0}
              open={expanded}
              active={editor.active}
              toggle={(p) => setOpen((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set([...s, p])))}
              onOpen={(p) => openFile(p)}
            />
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 items-center gap-0.5 overflow-x-auto border-b border-line px-1">
          {editor.files.map((f) => (
            <div
              key={f.path}
              className={clsx("group flex h-7 shrink-0 items-center gap-1 rounded-md pl-2 pr-1 text-[0.82em]", f.path === editor.active ? "bg-active text-fg" : "text-muted hover:bg-hover")}
            >
              <button onClick={() => useStore.setState((s) => ({ editor: { ...s.editor, active: f.path } }))} title={f.path}>
                {f.path.split("/").pop()}
                {f.diff != null && <span className="ml-1 text-accent">Δ</span>}
                {f.content !== f.saved && <span className="ml-1 text-warn">●</span>}
              </button>
              <button className="opacity-50 hover:opacity-100" onClick={() => closeFile(f.path)} aria-label="Schließen">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <div className="flex-1" />
          {current && current.content !== current.saved && (
            <Button size="sm" variant="primary" onClick={() => saveFile(current.path)}>
              <Save className="h-3.5 w-3.5" /> Speichern
            </Button>
          )}
          {externals.length > 0 && (
            <Menu>
              <MenuTrigger asChild>
                <button className="flex h-7 items-center gap-1 rounded-md px-2 text-[0.82em] text-muted hover:bg-hover hover:text-fg">
                  <ExternalLink className="h-3.5 w-3.5" /> Öffnen in
                </button>
              </MenuTrigger>
              <MenuContent align="end">
                {externals.map((e) => (
                  <MenuItem key={e.id} onSelect={() => api.openExternal(e.id, cwd, current?.path)}>
                    {e.name}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {current ? (
            <CodeEditor
              key={`${current.path}-${current.diff != null}`}
              path={current.path}
              value={current.content}
              original={current.diff}
              onChange={(v) =>
                useStore.setState((s) => ({ editor: { ...s.editor, files: s.editor.files.map((f) => (f.path === current.path ? { ...f, content: v } : f)) } }))
              }
              onSave={() => saveFile(current.path)}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-8 text-center text-[0.9em] text-muted">
              Datei links auswählen. Änderungen von Vibe siehst du im Git-Reiter als Vergleich.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
