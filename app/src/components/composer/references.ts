// @-Referenzen im Composer, die keine Datei des Projekts sind: andere Projekte
// (auch aus Team-Workspaces), Designs, 3D-Modelle, Code-Sessions und Bilder.
// Sie gelten in allen Modi gleich; beim Senden werden sie in Kontext für den
// Agenten (Text vor der Nachricht) und Bild-Anhänge aufgelöst.

import { useEffect, useMemo } from "react";
import { basename, useStore, type Attachment } from "../../lib/store";
import { useCollab } from "../../lib/collab";
import { absPath, designApi, isDesignPath } from "../../lib/design";
import { isModelPath, modelAbs, modelApi } from "../../lib/model3d";
import { isBenchPath } from "../../lib/bench";
import { useDesign } from "../design/designStore";
import { useModel } from "../model3d/modelStore";

export type RefKind = "project" | "design" | "model" | "session" | "image";

export interface ComposerRef {
  kind: RefKind;
  /** Projektpfad, Design-/Modell-ID, Session-ID oder absoluter Bildpfad. */
  id: string;
  label: string;
  detail: string;
}

export const REF_LABEL: Record<RefKind, string> = { project: "Projekt", design: "Design", model: "3D-Modell", session: "Session", image: "Bild" };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const join = (dir: string, rel: string) => `${dir.replace(/[\\/]+$/, "")}/${rel}`;

/** Alle Ziele außer Dateien; `exclude` blendet das gerade bearbeitete Design/Modell aus. */
export function useReferences(project: string, files: string[], exclude?: string): ComposerRef[] {
  const projects = useStore((s) => s.projects);
  const index = useStore((s) => s.index);
  const sessions = useStore((s) => s.sessions);
  const teams = useCollab((s) => s.teams);
  const designs = useDesign((s) => s.designs);
  const models = useModel((s) => s.models);
  useEffect(() => {
    useDesign.getState().init().catch(() => {});
    useModel.getState().init().catch(() => {});
  }, []);
  return useMemo(() => {
    const out: ComposerRef[] = [];
    const team = new Map<string, string>();
    for (const t of Object.values(teams)) for (const p of t.projects) team.set(p.name, t.name);
    for (const p of projects) {
      const t = team.get(basename(p));
      out.push({ kind: "project", id: p, label: basename(p), detail: t ? `Team ${t} · ${p}` : p });
    }
    for (const d of designs) if (d.id !== exclude) out.push({ kind: "design", id: d.id, label: d.name, detail: d.project ? `Design · ${basename(d.project)}` : "Design" });
    for (const m of models) if (m.id !== exclude) out.push({ kind: "model", id: m.id, label: m.name, detail: m.project ? `3D-Modell · ${basename(m.project)}` : "3D-Modell" });
    const seen = new Set<string>();
    for (const s of index) {
      if (!s.title || seen.has(s.sessionId)) continue;
      seen.add(s.sessionId);
      out.push({ kind: "session", id: s.sessionId, label: s.title, detail: `Session · ${basename(s.cwd)}` });
    }
    for (const s of Object.values(sessions)) {
      if (seen.has(s.id) || s.readOnly || !s.title || !s.items.length || isDesignPath(s.cwd) || isModelPath(s.cwd) || isBenchPath(s.cwd)) continue;
      out.push({ kind: "session", id: s.id, label: s.title, detail: `Session · ${basename(s.cwd)}` });
    }
    for (const f of files) if (IMAGE_EXT.test(f)) out.push({ kind: "image", id: join(project, f), label: basename(f), detail: f });
    return out;
  }, [projects, index, sessions, teams, designs, models, files, project, exclude]);
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)} …` : s);

/** Letzte Nachrichten einer geladenen Session als kurzer Auszug. */
function excerpt(id: string): string {
  const items = useStore.getState().sessions[id]?.items ?? [];
  const msgs = items.filter((i) => i.type === "user" || i.type === "assistant").slice(-6);
  return msgs.map((i) => `${i.type === "user" ? "Nutzer:in" : "Agent"}: ${clip((i as { text: string }).text.trim(), 600)}`).join("\n");
}

/** Referenzen in Kontext-Text und Bild-Anhänge übersetzen. */
export async function resolveReferences(refs: ComposerRef[]): Promise<{ context: string; images: Attachment[] }> {
  const parts: string[] = [];
  const images: Attachment[] = [];
  for (const r of refs) {
    if (r.kind === "image") {
      images.push({ kind: "image", path: r.id, name: r.label });
      continue;
    }
    if (r.kind === "project") {
      parts.push(`[Referenz: Projekt „${r.label}“] Ordner: ${r.id}\nLies dort bei Bedarf Dateien (README, Konfiguration, vorhandene Komponenten und Styles), um dich am bestehenden Code zu orientieren.`);
      continue;
    }
    if (r.kind === "session") {
      const st = useStore.getState();
      const s = st.sessions[r.id];
      const cwd = s?.cwd ?? st.index.find((x) => x.sessionId === r.id)?.cwd ?? "";
      const text = excerpt(r.id);
      parts.push(`[Referenz: Session „${r.label}“] Projekt: ${cwd || "unbekannt"}, Session-ID ${r.id}${text ? `\nLetzte Nachrichten:\n${text}` : "\n(Verlauf nicht geladen – nur Titel und Projekt bekannt.)"}`);
      continue;
    }
    const design = r.kind === "design";
    const api = design ? designApi : modelApi;
    const dir = design ? absPath(r.id) : modelAbs(r.id);
    const list = await api.list(r.id).catch(() => []);
    const notes = await api.read(`${r.id}/notes.md`).catch(() => "");
    const files = list.map((f) => f.path).filter((p) => !p.startsWith(".") && !p.startsWith("refs/") && !p.startsWith("handoff/"));
    parts.push(
      [
        `[Referenz: ${REF_LABEL[r.kind]} „${r.label}“] Ordner: ${dir}`,
        files.length ? `Dateien: ${files.slice(0, 40).join(", ")}` : "",
        notes.trim() ? `notes.md:\n${clip(notes.trim(), 3000)}` : "",
        list.some((f) => f.path === "preview.png") ? "Das Vorschaubild hängt an dieser Nachricht." : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    if (list.some((f) => f.path === "preview.png")) images.push({ kind: "image", path: `${dir}/preview.png`, name: `${r.label}.png` });
  }
  return { context: parts.join("\n\n"), images };
}
