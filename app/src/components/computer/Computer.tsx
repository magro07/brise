// Oberfläche für Computer Use (lib/computer.ts): Hinweis mit Not-Aus, solange
// ein Agent steuert, Bildvorschau mit Klickpunkt in Freigabekarte und Chat,
// Einstellungskarte unter „Werkzeuge & MCP“.
import { useEffect, useMemo, useState } from "react";
import { MonitorCog, MonitorPlay, OctagonX, Trash2 } from "lucide-react";
import { basename, useStore } from "../../lib/store";
import { computerApi, useComputer, type ComputerShot, type ComputerStatus } from "../../lib/computer";
import { Button, Kbd, Switch, clsx } from "../ui";
import { Card, Row } from "../settings/Settings";

/** Screenshot mit markiertem Zielpunkt. */
export function ShotImage({ image, point, className }: { image: string; point?: [number, number] | null; className?: string }) {
  return (
    <div className={clsx("relative overflow-hidden rounded-lg border border-line bg-code", className)}>
      <img src={image} alt="Bildschirm" className="block w-full" draggable={false} />
      {point && (
        <span
          className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-accent/25 shadow-[0_0_0_3px_rgba(0,0,0,0.25)]"
          style={{ left: `${point[0] * 100}%`, top: `${point[1] * 100}%` }}
        />
      )}
    </div>
  );
}

/** Leiste oben, solange ein Agent den Computer steuert – mit Not-Aus. */
export function ComputerBanner() {
  const active = useComputer((s) => s.active);
  const title = useStore((s) => (active ? (s.sessions[active.sessionId]?.title ?? "Eine Session") : ""));
  if (!active) return null;
  return (
    <div data-brise="computer-banner" className="flex items-center gap-3 border-b border-accent/40 bg-accent-soft px-4 py-1.5 text-[0.88em]">
      <MonitorPlay className="h-4 w-4 shrink-0 animate-pulse text-accent" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{title} steuert den Computer</span>
        {active.summary && <span className="text-fg-2"> · {active.summary}</span>}
      </span>
      {active.shortcut && (
        <span className="hidden items-center gap-1 text-muted sm:flex">
          Not-Aus <Kbd>{active.shortcut}</Kbd>
        </span>
      )}
      <Button variant="danger" size="sm" onClick={() => computerApi.stop()} data-testid="computer-stop">
        <OctagonX className="h-3.5 w-3.5" /> Stopp
      </Button>
    </div>
  );
}

/** Vorschau in der Freigabekarte. */
export function ComputerAskPreview({ image, point, activate }: { image?: string | null; point?: [number, number] | null; activate: boolean }) {
  return (
    <div className="mt-2 space-y-2">
      {activate && (
        <p className="text-[0.86em] text-muted">
          Computer Use ist in dieser Session noch aus. Eingeschaltet sieht der Agent den Bildschirm und kann Maus und Tastatur bedienen; jede Aktion fragt
          trotzdem nach, bis du sie für die Session erlaubst.
        </p>
      )}
      {image && <ShotImage image={image} point={point} className="max-h-56 max-w-[420px]" />}
    </div>
  );
}

/** Live-Vorschau unter den Werkzeugaufrufen: letzter Screenshot bzw. Klickpunkt. */
export function ComputerShots({ toolCallIds }: { toolCallIds: string[] }) {
  // Nur die stabile Map auswählen – ein neues Array je Aufruf würde endlos neu rendern.
  const all = useComputer((s) => s.shots);
  const [picked, setPicked] = useState<number | null>(null);
  const key = toolCallIds.join(",");
  const list = useMemo(
    () => key.split(",").flatMap((id) => all[id] ?? []).filter((s) => s.image || s.error).sort((a, b) => a.at - b.at),
    [all, key],
  );
  if (!list.length) return null;
  const current: ComputerShot = list[picked != null && picked < list.length ? picked : list.length - 1];
  return (
    <div className="my-1 overflow-hidden rounded-xl border border-line bg-elev" data-brise="computer-shots">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[0.84em] text-fg-2">
        <MonitorCog className="h-3.5 w-3.5 text-muted" />
        <span className="min-w-0 flex-1 truncate">{current.error ? `Fehlgeschlagen: ${current.summary}` : current.summary}</span>
        {list.length > 1 && (
          <span className="flex gap-1">
            {list.map((s, n) => (
              <button
                key={s.at}
                title={s.summary}
                onClick={() => setPicked(n)}
                className={clsx("h-1.5 w-3 rounded-full", s === current ? "bg-accent" : s.error ? "bg-bad/60" : "bg-line hover:bg-muted")}
              />
            ))}
          </span>
        )}
      </div>
      {current.error ? (
        <div className="px-3 py-2 text-[0.86em] text-bad selectable">{current.error}</div>
      ) : (
        current.image && <ShotImage image={current.image} point={current.point} className="m-2 max-w-[560px] border-0" />
      )}
    </div>
  );
}

/** Einstellungen → Werkzeuge & MCP: Computer Use. */
export function ComputerSettings() {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeProject = useStore((s) => s.activeProject);
  const reload = () => computerApi.status().then(setStatus).catch((e) => setNote(String(e)));
  useEffect(() => {
    reload();
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fn();
      if (typeof r === "string") setNote(r);
    } catch (e) {
      setNote(String(e));
    }
    setBusy(false);
    reload();
  };
  if (!status) return null;
  const p = status.platform;
  const locked = !!status.locked;
  const inList = activeProject ? status.projects.some((x) => x.replace(/[\\/]+$/, "") === activeProject.replace(/[\\/]+$/, "")) : false;
  return (
    <Card
      title="Computer Use"
      description={
        <>
          Agenten sehen den Bildschirm und bedienen Maus und Tastatur – für Programme ohne Schnittstelle. Jede Aktion erscheint als Freigabekarte mit
          Vorschau; Passwortfelder füllt Brise nicht aus, Brises eigenes Fenster bleibt verborgen. Not-Aus:{" "}
          {status.shortcut ? <Kbd>{status.shortcut}</Kbd> : "das Fernsteuerungs-Symbol des Systems (GNOME: oben rechts)"} oder der Stopp-Knopf in der
          Leiste oben.
        </>
      }
    >
      <Row
        title="Computer Use anbieten"
        description={
          locked
            ? status.locked
            : "Standardmäßig aus. Eingeschaltet bekommt jede neue Session die Werkzeuge; aktiv werden sie erst, wenn du sie für die Session oder das Projekt einschaltest."
        }
        control={<Switch checked={status.enabled && !locked} disabled={locked || busy} onChange={(v) => act(() => computerApi.setEnabled(v))} />}
      />
      <Row
        title="System"
        description={
          <span className="block space-y-0.5">
            <span className={clsx("block", p.screenshot ? "text-ok" : "text-bad")}>Bildschirm: {p.screenshotDetail}</span>
            <span className={clsx("block", p.input ? "text-ok" : "text-bad")}>Eingabe: {p.inputDetail}</span>
            {p.notes.map((n) => (
              <span key={n} className="block">
                {n}
              </span>
            ))}
          </span>
        }
        control={
          p.backend === "macos" && (!p.screenshot || !p.input) ? (
            <Button variant="secondary" disabled={busy} onClick={() => act(computerApi.requestAccess)}>
              Rechte anfragen
            </Button>
          ) : p.backend === "wayland-portal" ? (
            <Button variant="secondary" disabled={busy || !status.enabled} onClick={() => act(computerApi.prepare)}>
              Freigabe einholen
            </Button>
          ) : (
            <span className="font-mono text-[0.84em] text-muted">{p.backend}</span>
          )
        }
      />
      {status.enabled && activeProject && (
        <Row
          title={`Im Projekt „${basename(activeProject)}“ immer eingeschaltet`}
          description="Sessions in diesem Projekt fragen nicht mehr, ob Computer Use eingeschaltet werden soll. Jede Aktion braucht weiterhin ihre Freigabe."
          control={<Switch checked={inList} disabled={busy} onChange={(v) => act(() => computerApi.setProject(activeProject, v))} />}
        />
      )}
      {status.projects
        .filter((x) => x !== activeProject)
        .map((x) => (
          <Row
            key={x}
            title={basename(x)}
            description={<span className="font-mono text-[0.92em]">{x}</span>}
            control={
              <Button variant="ghost" title="Aus der Liste nehmen" onClick={() => act(() => computerApi.setProject(x, false))}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            }
          />
        ))}
      {note && <div className="px-4 py-2.5 text-[0.88em] text-fg-2 selectable">{note}</div>}
    </Card>
  );
}
