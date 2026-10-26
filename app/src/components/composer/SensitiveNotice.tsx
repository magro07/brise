import { ShieldAlert, ShieldCheck, X } from "lucide-react";
import type { SensitiveVerdict } from "../../lib/cortecs";
import { useStore } from "../../lib/store";
import { Button, Tip, clsx } from "../ui";

const euro = (v: number) => (v < 0.01 ? `${(v * 100).toLocaleString("de-DE", { maximumFractionDigits: 4 })} ct` : v.toLocaleString("de-DE", { style: "currency", currency: "EUR" }));

/**
 * „Achtung, sensible Daten“ über dem Composer: Kategorien mit
 * Wahrscheinlichkeit, Fundstellen (maskiert) und die Wahl, wie es weitergeht.
 */
export function SensitiveNotice({
  verdict,
  project,
  onZdr,
  onSend,
  onAlways,
  onClose,
}: {
  verdict: SensitiveVerdict;
  project: string;
  onZdr: () => void;
  onSend: () => void;
  onAlways: () => void;
  onClose: () => void;
}) {
  const ready = useStore((s) => s.cortecs.key && s.cortecs.models.length > 0);
  const setView = useStore((s) => s.setView);
  const projectName = project.split(/[\\/]/).filter(Boolean).pop() ?? project;
  return (
    <div data-brise="sensitive-notice" role="alert" className="mb-2 rounded-2xl border border-warn/40 bg-warn-soft p-3 shadow-soft fade-in">
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Achtung, sensible Daten</span>
            <span className="text-[0.8em] text-muted">
              {verdict.checkedBy === "cortecs"
                ? `geprüft mit Cortecs ${verdict.model ?? ""} (ohne Datenspeicherung) · ${verdict.ms} ms · ${euro(verdict.costEur)}`
                : "lokal geprüft"}
            </span>
          </div>
          <p className="mt-0.5 text-[0.88em] text-fg-2">
            Der Prompt geht sonst an ein Modell, bei dem Zero Data Retention nicht zugesichert ist.
          </p>
          <ul className="mt-2 space-y-1.5">
            {verdict.categories.map((c) => (
              <li key={c.id} className="text-[0.88em]">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.label}</span>
                  <span className="h-1.5 w-20 overflow-hidden rounded bg-hover" aria-hidden>
                    <span className={clsx("block h-full rounded", c.probability >= 0.8 ? "bg-bad" : "bg-warn")} style={{ width: `${Math.round(c.probability * 100)}%` }} />
                  </span>
                  <span className="tabular-nums text-muted">{Math.round(c.probability * 100)} %</span>
                </div>
                {c.hits.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {c.hits.slice(0, 6).map((h, n) => (
                      <span key={n} className="rounded border border-line bg-elev px-1.5 text-[0.86em] text-fg-2" title={h.strong ? "eindeutig erkannt" : "Verdacht"}>
                        {h.label}: <span className="font-mono">{h.sample}</span>
                        {h.source !== "Prompt" && <span className="text-muted"> · {h.source}</span>}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {verdict.unreadable.length > 0 && (
            <p className="mt-1.5 text-[0.82em] text-muted">Nicht lokal prüfbar: {verdict.unreadable.join(", ")}</p>
          )}
          {verdict.error && <p className="mt-1.5 text-[0.82em] text-muted">Cortecs-Prüfung nicht möglich ({verdict.error}) – Ergebnis nur vom lokalen Filter.</p>}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {ready ? (
              <Button size="sm" variant="primary" onClick={onZdr} autoFocus>
                <ShieldCheck className="h-3.5 w-3.5" /> Auf sicheres Cortecs-Modell (ZDR) wechseln
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => setView("settings", "cortecs")}>
                <ShieldCheck className="h-3.5 w-3.5" /> Cortecs einrichten
              </Button>
            )}
            <Button size="sm" onClick={onSend}>
              Trotzdem senden
            </Button>
            {ready && (
              <Tip label={`Alle Sessions in ${projectName} nutzen nur noch Modelle ohne Datenspeicherung`} side="top">
                <Button size="sm" variant="ghost" onClick={onAlways}>
                  Immer für dieses Projekt ZDR
                </Button>
              </Tip>
            )}
          </div>
        </div>
        <button className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg" onClick={onClose} aria-label="Zurück zum Bearbeiten">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
