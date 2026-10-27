import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Send } from "lucide-react";
import { basename, useStore } from "../../lib/store";
import { designApi, entries } from "../../lib/design";
import { Button, Spinner, Switch } from "../ui";
import { DEFAULT_CRITERIA, criteriaFromNotes, useDesign } from "./designStore";

/** „An Session übergeben“: Projekt wählen, Auftrag ergänzen, neue Coding-Session starten. */
export function HandoffDialog() {
  const open = useDesign((s) => s.handoffOpen);
  const meta = useDesign((s) => s.designs.find((d) => d.id === s.activeId));
  const files = useDesign((s) => s.files);
  const projects = useStore((s) => s.projects);
  const [project, setProject] = useState("");
  const [notes, setNotes] = useState("");
  const [criteria, setCriteria] = useState("");
  const [withVariants, setWithVariants] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const variants = entries(files).length > 1;

  useEffect(() => {
    if (!open || !meta) return;
    setError(null);
    setBusy(false);
    const last = meta.handoffs[meta.handoffs.length - 1]?.project;
    // Standard: das zugeordnete Projekt.
    setProject(meta.project || last || useStore.getState().activeProject || projects[0] || "");
    designApi
      .read(`${meta.id}/notes.md`)
      .catch(() => "")
      .then((n) => {
        const own = criteriaFromNotes(n);
        setCriteria([...own, ...DEFAULT_CRITERIA.filter((c) => !own.includes(c))].join("\n"));
      });
  }, [open, meta?.id]);

  const close = () => useDesign.setState({ handoffOpen: false });
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await useDesign.getState().handoff({
        project,
        notes,
        withVariants,
        criteria: criteria
          .split("\n")
          .map((c) => c.trim())
          .filter(Boolean),
      });
      setNotes("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  const choices = project && !projects.includes(project) ? [project, ...projects] : projects;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !busy && useDesign.setState({ handoffOpen: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 fade-in" />
        <Dialog.Content className="fixed left-1/2 top-[10%] z-50 max-h-[80vh] w-[min(600px,92vw)] -translate-x-1/2 overflow-y-auto rounded-2xl border border-line bg-elev p-6 shadow-pop fade-in">
          <Dialog.Title className="flex items-center gap-2 text-[1.15em] font-semibold">
            <Send className="h-5 w-5 text-accent" /> An Session übergeben
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[0.9em] text-muted">
            Brise kopiert das Design mit Tokens, Notizen und Screenshots nach <code className="font-mono">.brise/design/</code> im Projekt und startet dort eine neue
            Coding-Session mit dem vollständigen Auftrag.
          </Dialog.Description>

          <label className="mt-5 block text-[0.86em] font-medium">Projekt</label>
          <div className="mt-1 flex gap-2">
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 outline-none focus:border-accent"
            >
              {!project && <option value="">Projekt wählen …</option>}
              {choices.map((p) => (
                <option key={p} value={p}>
                  {basename(p)} – {p}
                </option>
              ))}
            </select>
            <Button
              className="h-10"
              onClick={async () => {
                const p = await openDialog({ directory: true, title: "Projektordner wählen" });
                if (typeof p === "string") setProject(p);
              }}
            >
              Ordner …
            </Button>
          </div>

          <label className="mt-4 block text-[0.86em] font-medium">Hinweise für die Umsetzung</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="z. B. „Als neue Route /preise, vorhandene Button-Komponente nutzen“"
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent"
          />

          <label className="mt-4 block text-[0.86em] font-medium">Akzeptanzkriterien (eins pro Zeile)</label>
          <textarea
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            rows={6}
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-[0.92em] outline-none focus:border-accent"
          />

          {variants && (
            <label className="mt-3 flex items-center justify-between gap-4 text-[0.92em]">
              <span>
                Varianten mitgeben
                <span className="block text-[0.86em] text-muted">Sonst nur das Hauptdesign.</span>
              </span>
              <Switch checked={withVariants} onChange={setWithVariants} />
            </label>
          )}

          {error && <div className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-[0.86em] text-bad selectable">{error}</div>}

          <div className="mt-6 flex items-center justify-end gap-2">
            {busy && (
              <span className="mr-auto flex items-center gap-2 text-[0.86em] text-muted">
                <Spinner /> Screenshots und Auftrag werden erstellt …
              </span>
            )}
            <Button variant="ghost" onClick={close} disabled={busy}>
              Abbrechen
            </Button>
            <Button variant="primary" disabled={!project || busy || !meta} onClick={run}>
              Session starten
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
