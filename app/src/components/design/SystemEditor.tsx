import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Copy, Download, Plus, Trash2, X } from "lucide-react";
import { basename, useStore } from "../../lib/store";
import { newId, slug, type ColorToken, type DesignSystem, type Token } from "../../lib/design";
import { confirmAction } from "../../lib/dialogs";
import { Button, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, clsx } from "../ui";
import { useDesign } from "./designStore";

const TOKEN_GROUPS: { key: "fonts" | "fontSizes" | "spacing" | "radius" | "shadows"; title: string; prefix: string }[] = [
  { key: "fonts", title: "Schriften", prefix: "font" },
  { key: "fontSizes", title: "Schriftgrößen", prefix: "text" },
  { key: "spacing", title: "Abstände", prefix: "space" },
  { key: "radius", title: "Radien", prefix: "radius" },
  { key: "shadows", title: "Schatten", prefix: "shadow" },
];

/** Farbwert für <input type="color"> – nur bei Hex möglich. */
const hex = (v: string) => (/^#[0-9a-f]{6}$/i.test(v) ? v : /^#[0-9a-f]{3}$/i.test(v) ? `#${[...v.slice(1)].map((c) => c + c).join("")}` : null);

/** Tokens des Design-Systems pflegen. Änderungen gehen sofort in tokens.css und die Vorschau. */
export function SystemEditor() {
  const systems = useDesign((s) => s.systems);
  const meta = useDesign((s) => s.designs.find((d) => d.id === s.activeId));
  const projects = useStore((s) => s.projects);
  const { saveSystem, applySystem, removeSystem, importSystem } = useDesign.getState();
  const current = systems.find((s) => s.id === meta?.systemId) ?? systems[0];
  const [draft, setDraft] = useState<DesignSystem | undefined>(current);
  const [status, setStatus] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => setDraft(current), [current?.id]);
  if (!draft) return null;

  const update = (next: DesignSystem) => {
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => saveSystem(next), 450);
  };
  const setColor = (i: number, c: Partial<ColorToken>) => update({ ...draft, colors: draft.colors.map((x, n) => (n === i ? { ...x, ...c } : x)) });
  const setToken = (key: (typeof TOKEN_GROUPS)[number]["key"], i: number, t: Partial<Token>) =>
    update({ ...draft, [key]: draft[key].map((x, n) => (n === i ? { ...x, ...t } : x)) });

  const runImport = async (project: string) => {
    setStatus("Lese Tokens …");
    try {
      const sys = await importSystem(project);
      await applySystem(sys.id);
      setStatus(`${sys.colors.length} Farben und ${sys.fonts.length + sys.fontSizes.length + sys.spacing.length + sys.radius.length + sys.shadows.length} weitere Tokens aus ${basename(project)} übernommen.`);
    } catch (e) {
      setStatus(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[860px] px-6 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={draft.id}
            onChange={(e) => applySystem(e.target.value)}
            className="h-8 rounded-lg border border-line bg-elev px-2 text-[0.93em] outline-none focus:border-accent"
            aria-label="Design-System"
          >
            {systems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            value={draft.name}
            onChange={(e) => update({ ...draft, name: e.target.value })}
            className="h-8 w-48 rounded-lg border border-line bg-bg px-2 outline-none focus:border-accent"
            aria-label="Name des Systems"
          />
          <div className="flex-1" />
          <Button
            size="sm"
            onClick={async () => {
              const copy = { ...draft, id: newId("s"), name: `${draft.name} (Kopie)`, source: undefined };
              await saveSystem(copy);
              await applySystem(copy.id);
            }}
          >
            <Copy className="h-3.5 w-3.5" /> Duplizieren
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm">
                <Download className="h-3.5 w-3.5" /> Aus Projekt übernehmen
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLabel>Tailwind-Konfiguration und CSS-Variablen lesen</MenuLabel>
              {projects.slice(0, 8).map((p) => (
                <MenuItem key={p} onSelect={() => runImport(p)} description={<span className="block max-w-[320px] truncate">{p}</span>}>
                  {basename(p)}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem
                onSelect={async () => {
                  const p = await openDialog({ directory: true, title: "Projekt mit Design-Tokens wählen" });
                  if (typeof p === "string") runImport(p);
                }}
              >
                Anderer Ordner …
              </MenuItem>
            </MenuContent>
          </Menu>
          {systems.length > 1 && (
            <Button
              size="sm"
              variant="danger"
              onClick={async () => (await confirmAction(`Design-System „${draft.name}“ löschen?`, true)) && removeSystem(draft.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        {(status || draft.source) && <div className="mt-2 text-[0.84em] text-muted">{status ?? `Übernommen aus ${draft.source}`}</div>}

        <Section title="Farben" hint="--color-*, je ein Wert für hell und dunkel" onAdd={() => update({ ...draft, colors: [...draft.colors, { name: "neu", light: "#888888", dark: "#888888" }] })}>
          <div className="grid grid-cols-[1fr_1fr_1fr_28px] items-center gap-x-3 gap-y-1.5">
            <span className="text-[0.78em] text-muted">Name</span>
            <span className="text-[0.78em] text-muted">Hell</span>
            <span className="text-[0.78em] text-muted">Dunkel</span>
            <span />
            {draft.colors.map((c, i) => (
              <ColorRow key={i} token={c} onChange={(p) => setColor(i, p)} onRemove={() => update({ ...draft, colors: draft.colors.filter((_, n) => n !== i) })} />
            ))}
          </div>
        </Section>

        {TOKEN_GROUPS.map((g) => (
          <Section key={g.key} title={g.title} hint={`--${g.prefix}-*`} onAdd={() => update({ ...draft, [g.key]: [...draft[g.key], { name: "neu", value: "" }] })}>
            <div className="space-y-1.5">
              {draft[g.key].map((t, i) => (
                <div key={i} className="grid grid-cols-[160px_1fr_auto_28px] items-center gap-3">
                  <input value={t.name} onChange={(e) => setToken(g.key, i, { name: e.target.value })} className={INPUT} aria-label="Name" />
                  <input value={t.value} onChange={(e) => setToken(g.key, i, { value: e.target.value })} className={clsx(INPUT, "font-mono text-[0.86em]")} aria-label="Wert" />
                  <TokenSample kind={g.key} value={t.value} />
                  <RemoveButton onClick={() => update({ ...draft, [g.key]: draft[g.key].filter((_, n) => n !== i) })} />
                </div>
              ))}
            </div>
          </Section>
        ))}

        <Section title="Regeln für den Agenten" hint="z. B. „Buttons pill-förmig, Überschriften in display, viel Weißraum“">
          <textarea
            value={draft.notes}
            onChange={(e) => update({ ...draft, notes: e.target.value })}
            rows={4}
            placeholder="Gestaltungsregeln, die bei jedem Design gelten sollen …"
            className="w-full rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent"
          />
        </Section>
        <p className="mt-4 text-[0.82em] text-muted">
          Brise schreibt die Tokens als <code className="font-mono">tokens.css</code> und <code className="font-mono">tokens.json</code> in den Design-Ordner, lädt sie in jede Vorschau und
          sagt dem Agenten bei der nächsten Nachricht, dass sich etwas geändert hat.
        </p>
      </div>
    </div>
  );
}

const INPUT = "h-8 min-w-0 rounded-md border border-line bg-bg px-2 outline-none focus:border-accent";

function Section({ title, hint, onAdd, children }: { title: string; hint?: string; onAdd?: () => void; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="font-semibold">{title}</h3>
        {hint && <span className="font-mono text-[0.78em] text-muted">{hint}</span>}
        <div className="flex-1" />
        {onAdd && (
          <Button size="sm" variant="ghost" onClick={onAdd}>
            <Plus className="h-3.5 w-3.5" /> Hinzufügen
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-bad" aria-label="Entfernen">
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

function ColorField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const h = hex(value);
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-bg pl-1 focus-within:border-accent">
      <label className="relative h-6 w-6 shrink-0 overflow-hidden rounded border border-line" style={{ background: value }} title={h ? "Farbe wählen" : "Nur Hex-Werte lassen sich per Farbwähler ändern"}>
        {h && <input type="color" value={h} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label={label} />}
      </label>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="h-8 min-w-0 flex-1 bg-transparent font-mono text-[0.84em] outline-none" aria-label={`${label} (Wert)`} />
    </div>
  );
}

function ColorRow({ token, onChange, onRemove }: { token: ColorToken; onChange: (p: Partial<ColorToken>) => void; onRemove: () => void }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <input value={token.name} onChange={(e) => onChange({ name: e.target.value })} className={clsx(INPUT, "w-full")} aria-label="Farbname" />
      </div>
      <ColorField value={token.light} onChange={(light) => onChange({ light })} label={`${token.name} hell`} />
      <ColorField value={token.dark} onChange={(dark) => onChange({ dark })} label={`${token.name} dunkel`} />
      <RemoveButton onClick={onRemove} />
      <span className="col-span-4 -mt-1 truncate pl-1 font-mono text-[0.72em] text-muted">--color-{slug(token.name)}</span>
    </>
  );
}

function TokenSample({ kind, value }: { kind: string; value: string }) {
  if (kind === "fonts") return <span className="w-24 truncate" style={{ fontFamily: value }}>Aa Gg 123</span>;
  if (kind === "fontSizes") return <span className="w-24 truncate leading-none" style={{ fontSize: value }}>Aa</span>;
  if (kind === "spacing") return <span className="flex w-24 items-center"><span className="h-3 rounded-sm bg-accent" style={{ width: value }} /></span>;
  if (kind === "radius") return <span className="h-7 w-24"><span className="block h-7 w-10 border-2 border-accent" style={{ borderRadius: value }} /></span>;
  return <span className="h-7 w-24"><span className="block h-7 w-10 rounded-md border border-line bg-elev" style={{ boxShadow: value }} /></span>;
}
