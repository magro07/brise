import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, GitBranch, GitCommitHorizontal, Minus, Plus, RefreshCw, Sparkles, Undo2 } from "lucide-react";
import { api, type GitStatus } from "../../lib/acp";
import { helperProvider, useStore } from "../../lib/store";
import { relativeTime } from "../../lib/format";
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Spinner, clsx } from "../ui";
import { askText, confirmAction } from "../../lib/dialogs";
import { CouncilDiffButton } from "../settings/CouncilSettings";

const STATUS_LABEL: Record<string, [string, string]> = {
  M: ["geändert", "text-warn"],
  A: ["neu", "text-ok"],
  D: ["gelöscht", "text-bad"],
  R: ["umbenannt", "text-accent"],
  "?": ["neu", "text-ok"],
  U: ["Konflikt", "text-bad"],
};

function FileRow({ path, code, staged, onToggle, onDiscard, onOpen }: { path: string; code: string; staged: boolean; onToggle: () => void; onDiscard?: () => void; onOpen: () => void }) {
  const [label, color] = STATUS_LABEL[code] ?? [code, "text-muted"];
  const name = path.split("/").pop();
  const dir = path.slice(0, path.length - (name?.length ?? 0));
  return (
    <div className="group flex h-7 items-center gap-2 rounded-md px-2 hover:bg-hover">
      <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[0.86em]" onClick={onOpen} title="Vergleich öffnen">
        <span className="truncate">{name}</span>
        <span className="truncate text-[0.9em] text-muted">{dir}</span>
      </button>
      <span className={clsx("text-[0.75em]", color)}>{label}</span>
      <div className="hidden items-center group-hover:flex">
        {onDiscard && (
          <IconButton label="Änderung verwerfen" size="sm" onClick={onDiscard}>
            <Undo2 className="h-3.5 w-3.5" />
          </IconButton>
        )}
        <IconButton label={staged ? "Aus dem Commit nehmen" : "Für Commit vormerken"} size="sm" onClick={onToggle}>
          {staged ? <Minus className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
        </IconButton>
      </div>
    </div>
  );
}

/** Git-Ansicht: Branch, Änderungen, Commit (mit KI-Nachricht), Verlauf. */
export function GitPanel({ cwd }: { cwd: string }) {
  const running = useStore((s) => Object.values(s.sessions).some((x) => x.running && x.cwd === cwd));
  const openFile = useStore((s) => s.openFile);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [log, setLog] = useState<{ hash: string; author: string; date: string; subject: string }[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const st = await api.gitStatus(cwd);
    setStatus(st);
    if (st.isRepo) {
      api.gitBranches(cwd).then(setBranches).catch(() => {});
      api.gitLog(cwd, 15).then(setLog).catch(() => setLog([]));
    }
  }, [cwd]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, running ? 3000 : 8000);
    return () => clearInterval(t);
  }, [refresh, running]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!status) return <div className="flex items-center gap-2 p-4 text-muted"><Spinner /> Lese Git-Status …</div>;

  if (!status.available) {
    return (
      <div className="p-6 text-center">
        <p className="text-fg-2">Git ist auf diesem Rechner nicht installiert.</p>
        <Button variant="primary" className="mt-3" disabled={!!busy} onClick={() => run("install", api.installGit)}>
          {busy ? <Spinner /> : null} Git installieren
        </Button>
        {error && <p className="mt-3 text-[0.86em] text-fg-2">{error}</p>}
      </div>
    );
  }

  if (!status.isRepo) {
    return (
      <div className="p-6 text-center">
        <p className="text-fg-2">Dieser Ordner ist noch kein Git-Repository. Mit Git kannst du jede Änderung von Vibe nachvollziehen und rückgängig machen.</p>
        <Button variant="primary" className="mt-3" onClick={() => run("init", () => api.git(cwd, "init"))}>
          Repository anlegen
        </Button>
      </div>
    );
  }

  const staged = status.files.filter((f) => f.index && f.index !== "?");
  const unstaged = status.files.filter((f) => f.worktree || f.index === "?");

  const commit = () =>
    run("commit", async () => {
      if (!staged.length) await api.git(cwd, "stage_all");
      await api.git(cwd, "commit", undefined, message.trim());
      setMessage("");
    });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <Menu>
          <MenuTrigger asChild>
            <button className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[0.88em] font-medium hover:bg-hover">
              <GitBranch className="h-3.5 w-3.5 text-muted" /> {status.branch ?? "–"}
            </button>
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>Branch wechseln</MenuLabel>
            {branches.map((b) => (
              <MenuItem key={b} checked={b === status.branch} onSelect={() => run("checkout", () => api.git(cwd, "checkout", undefined, b))}>
                {b}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem
              icon={<Plus />}
              onSelect={async () => {
                const name = await askText("Neuer Branch", "z. B. feature/login");
                if (name?.trim()) run("branch", () => api.git(cwd, "create_branch", undefined, name.trim()));
              }}
            >
              Neuer Branch …
            </MenuItem>
          </MenuContent>
        </Menu>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="text-[0.8em] text-muted">
            {status.ahead > 0 && `↑${status.ahead} `}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        <div className="flex-1" />
        <IconButton label="Pull (nur Fast-Forward)" size="sm" disabled={!!busy || !status.upstream} onClick={() => run("pull", () => api.git(cwd, "pull"))}>
          <ArrowDown className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          label={status.upstream ? "Push" : "Push (Upstream anlegen)"}
          size="sm"
          disabled={!!busy}
          onClick={async () =>
            (await confirmAction(status.upstream ? `Commits nach ${status.upstream} pushen?` : "Branch nach origin pushen und als Upstream setzen?")) &&
            run("push", () => api.git(cwd, status.upstream ? "push" : "push_upstream"))
          }
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label="Aktualisieren" size="sm" onClick={refresh}>
          <RefreshCw className={clsx("h-3.5 w-3.5", busy && "animate-spin")} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error && <pre className="mb-2 whitespace-pre-wrap rounded-lg bg-bad-soft p-2 text-[0.8em] text-bad selectable">{error}</pre>}
        {status.files.length === 0 && (
          <div className="flex items-center gap-2 px-2 py-3 text-[0.9em] text-muted">
            <Check className="h-4 w-4 text-ok" /> Keine offenen Änderungen
          </div>
        )}
        {staged.length > 0 && (
          <Section title={`Vorgemerkt (${staged.length})`} action={<button onClick={() => run("unstage", () => api.git(cwd, "unstage", staged.map((f) => f.path)))}>alle zurücknehmen</button>}>
            {staged.map((f) => (
              <FileRow key={`s-${f.path}`} path={f.path} code={f.index} staged onToggle={() => run("unstage", () => api.git(cwd, "unstage", [f.path]))} onOpen={() => openFile(f.path, true)} />
            ))}
          </Section>
        )}
        {unstaged.length > 0 && (
          <Section title={`Änderungen (${unstaged.length})`} action={<button onClick={() => run("stage", () => api.git(cwd, "stage_all"))}>alle vormerken</button>}>
            {unstaged.map((f) => (
              <FileRow
                key={`u-${f.path}`}
                path={f.path}
                code={f.index === "?" ? "?" : f.worktree}
                staged={false}
                onToggle={() => run("stage", () => api.git(cwd, "stage", [f.path]))}
                onDiscard={
                  f.index === "?"
                    ? undefined
                    : async () =>
                        (await confirmAction(`Änderungen an ${f.path} verwerfen? Das lässt sich nicht rückgängig machen.`, true)) &&
                        run("discard", () => api.git(cwd, "discard", [f.path]))
                }
                onOpen={() => openFile(f.path, true)}
              />
            ))}
          </Section>
        )}

        {status.files.length > 0 && (
          <div className="mt-3 rounded-xl border border-line bg-elev p-2">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder="Commit-Nachricht …"
              className="w-full resize-none bg-transparent px-1 text-[0.9em] outline-none placeholder:text-muted"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() =>
                  run("msg", async () => {
                    if (!staged.length) await api.git(cwd, "stage_all");
                    const provider = helperProvider(cwd);
                    if (!provider) throw new Error("Dieses Projekt nutzt nur Modelle ohne Datenspeicherung – dafür fehlt der Cortecs-Key.");
                    setMessage(await api.commitMessage(cwd, useStore.getState().prefs.assistModel, provider));
                  })
                }
              >
                {busy === "msg" ? <Spinner /> : <Sparkles className="h-3.5 w-3.5" />} Nachricht vorschlagen
              </Button>
              <div className="flex-1" />
              <Button size="sm" variant="primary" disabled={!message.trim() || !!busy} onClick={commit}>
                <GitCommitHorizontal className="h-3.5 w-3.5" /> {staged.length ? "Commit" : "Alles committen"}
              </Button>
            </div>
          </div>
        )}
        {status.files.length > 0 && <CouncilDiffButton cwd={cwd} />}

        {log.length > 0 && (
          <Section title="Verlauf">
            {log.map((c) => (
              <div key={c.hash} className="flex items-baseline gap-2 px-2 py-1 text-[0.84em]">
                <span className="font-mono text-[0.9em] text-muted">{c.hash}</span>
                <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                <span className="shrink-0 text-[0.85em] text-muted">{relativeTime(c.date)}</span>
              </div>
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="flex items-center px-2 py-1 text-[0.75em] font-medium uppercase tracking-wide text-muted">
        <span className="flex-1">{title}</span>
        {action && <span className="normal-case tracking-normal text-accent hover:underline">{action}</span>}
      </div>
      {children}
    </div>
  );
}
