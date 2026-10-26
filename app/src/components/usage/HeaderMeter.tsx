import { AlertTriangle, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { Tip, clsx } from "../ui";
import { eur, useUsage } from "./usage";

export function barTone(percent: number) {
  return percent >= 90 ? "bg-bad" : percent >= 75 ? "bg-warn" : "bg-accent";
}

/** Kleiner Balken „62 € / 255 €“ in der Kopfzeile, Klick öffnet „Nutzung“. */
export function HeaderMeter() {
  const settings = useUsage((s) => s.settings);
  const spent = useUsage((s) => s.spent);
  const percent = useUsage((s) => s.percent);
  const warning = useUsage((s) => s.warning);
  const setView = useStore((s) => s.setView);
  if (!settings) return null;
  const consoleBased = settings.consoleEur != null;

  return (
    <>
      <Tip label={`Verbrauch diesen Monat, ${consoleBased ? "Console-Stand plus Schätzung" : "geschätzt"} – Details unter „Nutzung“`}>
        <button
          data-brise="usage-meter"
          onClick={() => setView("settings", "usage")}
          className="flex h-8 items-center gap-2 rounded-md px-2 text-[0.8em] text-muted hover:bg-hover hover:text-fg"
          aria-label="Nutzung"
        >
          <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-active">
            <span className={clsx("absolute inset-y-0 left-0 rounded-full", barTone(percent))} style={{ width: `${Math.min(100, percent)}%` }} />
          </span>
          <span className={clsx("tabular-nums", percent >= 90 ? "text-bad" : percent >= 75 ? "text-warn" : "")}>
            {consoleBased ? "" : "≈"}
            {eur(spent, 0)} / {eur(settings.budgetEur, 0)}
          </span>
        </button>
      </Tip>
      {warning && (
        <div className="fixed right-4 top-14 z-50 flex max-w-sm items-start gap-2.5 rounded-xl border border-line bg-elev px-3.5 py-3 text-[0.88em] shadow-[var(--shadow-lg)]">
          <AlertTriangle className={clsx("mt-0.5 h-4 w-4 shrink-0", warning.level >= 95 ? "text-bad" : "text-warn")} />
          <div className="flex-1">
            <div className="font-medium">{warning.level} % des Monatsbudgets erreicht</div>
            <div className="mt-0.5 text-muted">
              {eur(warning.spent)} von {eur(warning.budget)} (geschätzt).
              {settings.avoidExpensive && warning.level >= settings.avoidAt && " Auto weicht jetzt auf günstigere Modelle aus."}
            </div>
            <button className="mt-1.5 text-accent hover:underline" onClick={() => (useUsage.setState({ warning: null }), setView("settings", "usage"))}>
              Nutzung ansehen
            </button>
          </div>
          <button className="text-muted hover:text-fg" onClick={() => useUsage.setState({ warning: null })} aria-label="Schließen">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </>
  );
}
