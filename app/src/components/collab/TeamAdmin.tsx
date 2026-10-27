import { useEffect, useMemo, useState } from "react";
import { Crown, History, Lock, Shield, UserMinus, Users } from "lucide-react";
import { BACKEND_LABEL, type TeamView } from "../../lib/collab";
import { confirmAction } from "../../lib/dialogs";
import { tokens } from "../../lib/format";
import {
  EMPTY_POLICY,
  SECTION_LABELS,
  claimTeam,
  isAdmin,
  policyFor,
  removeTeamMember,
  setTeamAdmin,
  setTeamPolicy,
  teamUsage,
  type Access,
  type TeamPolicy,
  type UsageEntry,
} from "../../lib/policy";
import { Button, Switch, clsx } from "../ui";

const input = "h-8 rounded-lg border border-line bg-bg px-2.5 text-[0.92em] outline-none focus:border-accent";
const BACKENDS = ["vibe", "claude", "codex", "gemini"];
const ACCESS: [Access, string][] = [
  ["hidden", "Aus"],
  ["read", "Lesen"],
  ["edit", "Frei"],
];

function Card({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <h4 className="mb-1.5 flex items-center gap-2 text-[0.9em] font-semibold">
        {icon}
        {title}
      </h4>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-elev">{children}</div>
    </section>
  );
}

function Row({ title, description, control }: { title: React.ReactNode; description?: string; control: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[0.92em]">{title}</div>
        {description && <div className="text-[0.84em] text-muted">{description}</div>}
      </div>
      {control}
    </div>
  );
}

/** Liste mit „alle erlaubt“: leer gelassen = keine Einschränkung. */
function ListField({ value, onChange, placeholder }: { value: string[] | null; onChange: (v: string[] | null) => void; placeholder: string }) {
  const [text, setText] = useState((value ?? []).join(", "));
  useEffect(() => setText((value ?? []).join(", ")), [value]);
  return (
    <div className="flex items-center gap-2">
      <Switch checked={value !== null} onChange={(on) => onChange(on ? [] : null)} />
      <input
        disabled={value === null}
        value={value === null ? "" : text}
        placeholder={value === null ? "alle erlaubt" : placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => value !== null && onChange(text.split(",").map((s) => s.trim()).filter(Boolean))}
        className={clsx(input, "w-[260px] disabled:opacity-50")}
      />
    </div>
  );
}

const num = (v: string) => (v.trim() === "" ? null : Math.max(0, Number(v) || 0));

/** Richtlinie bearbeiten (Bereiche und fest vorgegebene Werte). */
export function PolicyEditor({ initial, onSave, onCancel, saveLabel }: { initial: TeamPolicy; onSave: (p: TeamPolicy) => Promise<void>; onCancel?: () => void; saveLabel: string }) {
  const [p, setP] = useState<TeamPolicy>({ ...EMPTY_POLICY, ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<TeamPolicy>) => setP((x) => ({ ...x, ...patch }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="policy-editor">
      <Card title="Einstellungsbereiche" icon={<Lock className="h-3.5 w-3.5" />}>
        {SECTION_LABELS.map(([id, label]) => (
          <Row
            key={id}
            title={label}
            control={
              <div className="flex rounded-lg border border-line bg-panel p-0.5 text-[0.84em]">
                {ACCESS.map(([a, l]) => (
                  <button
                    key={a}
                    data-section={id}
                    data-access={a}
                    onClick={() => set({ sections: { ...p.sections, [id]: a } })}
                    className={clsx("h-6 rounded-md px-2.5", (p.sections[id] ?? "edit") === a ? "bg-elev text-fg shadow-sm" : "text-muted hover:text-fg")}
                  >
                    {l}
                  </button>
                ))}
              </div>
            }
          />
        ))}
      </Card>
      <Card title="Fest vorgegeben">
        <Row
          title="Erlaubte Agenten"
          description="Aus = alle."
          control={
            <div className="flex flex-wrap items-center gap-2 text-[0.88em]">
              <Switch checked={p.backends !== null} onChange={(on) => set({ backends: on ? ["vibe"] : null })} />
              {p.backends !== null &&
                BACKENDS.map((b) => (
                  <label key={b} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={p.backends!.includes(b)}
                      onChange={(e) => set({ backends: e.target.checked ? [...p.backends!, b] : p.backends!.filter((x) => x !== b) })}
                      className="accent-[var(--accent)]"
                    />
                    {BACKEND_LABEL[b] ?? b}
                  </label>
                ))}
            </div>
          }
        />
        <Row title="Erlaubte Modelle" description="Aliase bzw. IDs, durch Komma getrennt." control={<ListField value={p.models} onChange={(models) => set({ models })} placeholder="z. B. devstral-2, mistral-medium-3.5" />} />
        <Row title="Keine automatischen Edits" description="Sperrt „Edits automatisch“, „Smart“, „Alles automatisch“ und das Überspringen von Freigaben." control={<Switch checked={p.noAutoEdits} onChange={(noAutoEdits) => set({ noAutoEdits })} />} />
        <Row title="Erlaubte Freigabe-Modi" description="z. B. ask, plan, default" control={<ListField value={p.modes} onChange={(modes) => set({ modes })} placeholder="ask, plan" />} />
        <Row title="Nur Cortecs (ZDR)" description="Prompts nur über Modelle ohne Datenspeicherung." control={<Switch checked={p.requireZdr} onChange={(requireZdr) => set({ requireZdr })} />} />
        <Row title="Cortecs: nur EU-Anbieter" control={<Switch checked={p.euNative} onChange={(euNative) => set({ euNative })} />} />
        <Row title="Cortecs: nur § 203-Anbieter" control={<Switch checked={p.secrecy203} onChange={(secrecy203) => set({ secrecy203 })} />} />
        <Row
          title="Budget"
          description="Euro laut Nutzungsjournal des Mitglieds, leer = ohne."
          control={
            <div className="flex gap-2">
              <input type="number" min={0} step={0.5} value={p.dailyEur ?? ""} placeholder="€/Tag" onChange={(e) => set({ dailyEur: num(e.target.value) })} className={clsx(input, "w-[90px]")} />
              <input type="number" min={0} step={1} value={p.monthlyEur ?? ""} placeholder="€/Monat" onChange={(e) => set({ monthlyEur: num(e.target.value) })} className={clsx(input, "w-[100px]")} />
            </div>
          }
        />
        <Row
          title="Websuche"
          control={
            <select
              value={p.webSearch === null ? "" : p.webSearch ? "on" : "off"}
              onChange={(e) => set({ webSearch: e.target.value === "" ? null : e.target.value === "on" })}
              className={clsx(input, "w-[160px]")}
            >
              <option value="">Mitglied entscheidet</option>
              <option value="on">immer an</option>
              <option value="off">aus</option>
            </select>
          }
        />
        <Row title="Erlaubte MCP-Server" description="Namen aus Vibes config.toml." control={<ListField value={p.mcpServers} onChange={(mcpServers) => set({ mcpServers })} placeholder="z. B. git, filesystem" />} />
        <Row title="Erlaubte Skills" control={<ListField value={p.skills} onChange={(skills) => set({ skills })} placeholder="z. B. design-mode" />} />
        <Row
          title="Master-Session"
          description="Darf eine Session weitere Sessions (Untersessions) starten? Höchstzahl gleichzeitig, leer = Einstellung des Mitglieds."
          control={
            <div className="flex gap-2">
              <select
                value={p.orchestra === false ? "off" : ""}
                onChange={(e) => set({ orchestra: e.target.value === "off" ? false : null })}
                className={clsx(input, "w-[130px]")}
                data-testid="policy-orchestra"
              >
                <option value="">erlaubt</option>
                <option value="off">gesperrt</option>
              </select>
              <input type="number" min={1} max={12} value={p.maxSubSessions ?? ""} placeholder="max." disabled={p.orchestra === false} onChange={(e) => set({ maxSubSessions: num(e.target.value) })} className={clsx(input, "w-[80px]")} />
            </div>
          }
        />
        <Row
          title="Computer Use"
          description="Dürfen Agenten den Bildschirm sehen und Maus und Tastatur bedienen? Gesperrt verschwinden die Werkzeuge in allen Sessions."
          control={
            <select
              value={p.computerUse === false ? "off" : ""}
              onChange={(e) => set({ computerUse: e.target.value === "off" ? false : null })}
              className={clsx(input, "w-[130px]")}
              data-testid="policy-computer-use"
            >
              <option value="">erlaubt</option>
              <option value="off">gesperrt</option>
            </select>
          }
        />
      </Card>
      <Card title="Geteilte Abos (wird beim Host durchgesetzt)">
        <Row
          title="Tageslimit je Mitglied"
          description="Prompts bzw. Tokens auf den Abos anderer Teammitglieder."
          control={
            <div className="flex gap-2">
              <input type="number" min={0} value={p.sharedDailyPrompts ?? ""} placeholder="Prompts" onChange={(e) => set({ sharedDailyPrompts: num(e.target.value) })} className={clsx(input, "w-[90px]")} />
              <input type="number" min={0} step={10000} value={p.sharedDailyTokens ?? ""} placeholder="Tokens" onChange={(e) => set({ sharedDailyTokens: num(e.target.value) })} className={clsx(input, "w-[110px]")} />
            </div>
          }
        />
      </Card>
      {error && <p className="mb-2 text-[0.88em] text-bad selectable">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Abbrechen
          </Button>
        )}
        <Button variant="primary" disabled={busy} onClick={save} data-testid="policy-save">
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

/** Kurzfassung einer Richtlinie für Mitglieder. */
function PolicySummary({ p }: { p: TeamPolicy }) {
  const items: string[] = [];
  const locked = SECTION_LABELS.filter(([id]) => (p.sections[id] ?? "edit") !== "edit").map(([id, l]) => `${l} (${p.sections[id] === "hidden" ? "ausgeblendet" : "nur lesen"})`);
  if (locked.length) items.push(`Gesperrte Bereiche: ${locked.join(", ")}`);
  if (p.backends) items.push(`Agenten: ${p.backends.map((b) => BACKEND_LABEL[b] ?? b).join(", ") || "keine"}`);
  if (p.models) items.push(`Modelle: ${p.models.join(", ") || "keine"}`);
  if (p.noAutoEdits) items.push("Keine automatischen Edits");
  if (p.modes) items.push(`Freigabe-Modi: ${p.modes.join(", ")}`);
  if (p.requireZdr) items.push("Nur Cortecs-Modelle ohne Datenspeicherung");
  if (p.dailyEur != null) items.push(`Budget ${p.dailyEur.toFixed(2)} € pro Tag`);
  if (p.monthlyEur != null) items.push(`Budget ${p.monthlyEur.toFixed(2)} € pro Monat`);
  if (p.webSearch != null) items.push(`Websuche ${p.webSearch ? "an" : "aus"}`);
  if (p.mcpServers) items.push(`MCP-Server: ${p.mcpServers.join(", ") || "keine"}`);
  if (p.skills) items.push(`Skills: ${p.skills.join(", ") || "keine"}`);
  if (p.computerUse === false) items.push("Computer Use gesperrt");
  if (p.orchestra === false) items.push("Master-Session gesperrt");
  else if (p.maxSubSessions != null) items.push(`Höchstens ${p.maxSubSessions} Untersessions gleichzeitig`);
  if (p.sharedDailyPrompts != null) items.push(`${p.sharedDailyPrompts} Prompts pro Tag auf geteilten Abos`);
  if (p.sharedDailyTokens != null) items.push(`${tokens(p.sharedDailyTokens)} Tokens pro Tag auf geteilten Abos`);
  return items.length ? (
    <ul className="list-disc space-y-0.5 px-8 py-3 text-[0.9em]">
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  ) : (
    <p className="px-4 py-3 text-[0.9em] text-muted">Keine Einschränkungen.</p>
  );
}

function sumUsage(days: Record<string, Record<string, UsageEntry>>, from: number) {
  const out: Record<string, UsageEntry> = {};
  for (const [day, members] of Object.entries(days)) {
    if (Number(day) < from) continue;
    for (const [id, u] of Object.entries(members)) {
      const e = (out[id] ??= { name: u.name, prompts: 0, tokens: 0 });
      e.prompts += u.prompts;
      e.tokens += u.tokens;
    }
  }
  return out;
}

/** Team-Verwaltung: Rollen, Richtlinien, Nutzung, Audit-Log. */
export function TeamAdmin({ team }: { team: TeamView }) {
  const state = team.state;
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ today: number; days: Record<string, Record<string, UsageEntry>> } | null>(null);

  useEffect(() => {
    if (team.admin) teamUsage().then(setUsage).catch(() => {});
  }, [team.admin, state?.version]);

  const members = useMemo(() => {
    const map = new Map<string, { id: string; name: string; online: boolean }>();
    for (const [id, m] of Object.entries(state?.members ?? {})) map.set(id, { id, name: m.name, online: false });
    for (const m of team.members) map.set(m.id, { id: m.id, name: m.name || map.get(m.id)?.name || "", online: m.online });
    if (!map.has(team.me)) map.set(team.me, { id: team.me, name: "Du", online: true });
    return [...map.values()].filter((m) => !state?.removed.includes(m.id));
  }, [team, state]);

  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(String(e));
    }
  };

  const role = (id: string) => (state?.owner === id || (!state && team.owner === id) ? "Besitzer" : isAdmin(state, id) ? "Admin" : "Mitglied");
  const today = usage ? sumUsage(usage.days, usage.today) : {};
  const month = usage ? sumUsage(usage.days, usage.today - (new Date().getUTCDate() - 1)) : {};

  if (!team.owner) {
    return (
      <Card title={`Verwaltung · ${team.name}`} icon={<Shield className="h-3.5 w-3.5" />}>
        <Row
          title="Dieses Team hat noch keinen Admin"
          description="Teams von vor den Admin-Rechten. Wer es angelegt hat, kann es übernehmen; danach mit dem neuen Link neu einladen."
          control={
            <Button size="sm" onClick={() => run(() => claimTeam(team.id))}>
              <Crown className="h-3.5 w-3.5" /> Übernehmen
            </Button>
          }
        />
        {error && <p className="px-4 py-2 text-[0.88em] text-bad selectable">{error}</p>}
      </Card>
    );
  }

  if (!team.admin) {
    const mine = policyFor(state, team.me);
    return (
      <Card title={`Deine Regeln im Team „${team.name}“`} icon={<Lock className="h-3.5 w-3.5" />}>
        <Row title="Deine Rolle" control={<span className="text-fg-2">{role(team.me)}</span>} />
        {mine ? <PolicySummary p={mine} /> : <p className="px-4 py-3 text-[0.9em] text-muted">Noch keine Richtlinie vom Admin angekommen.</p>}
        <p className="px-4 py-2 text-[0.82em] text-muted">
          Die Regeln setzt Brise auf diesem Rechner durch. Prompts auf geteilten Abos prüft zusätzlich der Host.
        </p>
      </Card>
    );
  }

  return (
    <div data-testid="team-admin">
      <Card title={`Mitglieder · ${team.name}`} icon={<Users className="h-3.5 w-3.5" />}>
        {members.map((m) => {
          const r = role(m.id);
          const own = state?.policies[m.id];
          return (
            <div key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-[0.92em]" data-member={m.name}>
              <span className={clsx("h-2 w-2 shrink-0 rounded-full", m.online ? "bg-ok" : "bg-line")} />
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  {m.id === team.me ? `${m.name} (du)` : m.name || `${m.id.slice(0, 6)}…`}
                  <span className="ml-2 rounded bg-panel px-1.5 py-0.5 text-[0.8em] text-muted">{r}</span>
                </div>
                <div className="text-[0.82em] text-muted">
                  {r === "Mitglied" ? (own ? "Eigene Richtlinie" : "Standard-Richtlinie") : "Keine Einschränkungen"}
                  {today[m.id] && ` · heute ${today[m.id].prompts} Prompts, ${tokens(today[m.id].tokens)} Tokens`}
                  {month[m.id] && ` · Monat ${month[m.id].prompts} Prompts, ${tokens(month[m.id].tokens)} Tokens`}
                </div>
              </div>
              {r === "Mitglied" && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(m.id)} data-testid="edit-member-policy">
                  Richtlinie
                </Button>
              )}
              {r !== "Besitzer" && m.id !== team.me && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => run(() => setTeamAdmin(team.id, m.id, r !== "Admin"))}>
                    {r === "Admin" ? "Admin entziehen" : "Zum Admin"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Entfernen"
                    onClick={() => run(async () => (await confirmAction(`${m.name || "Mitglied"} aus dem Team entfernen?`, true)) && removeTeamMember(team.id, m.id))}
                  >
                    <UserMinus className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </div>
          );
        })}
        <p className="px-4 py-2 text-[0.82em] text-muted">
          Nutzung: Prompts und Tokens von Mitgliedern auf deinem Abo (in deinen geteilten Sessions). Entfernte Mitglieder bekommen keine Team-Rolle mehr; den Team-Raum
          können sie bis zu einem neuen Team-Schlüssel noch mitlesen.
        </p>
      </Card>
      {error && <p className="mb-3 text-[0.88em] text-bad selectable">{error}</p>}

      {editing !== undefined ? (
        <section className="mb-4 rounded-xl border border-accent/40 p-4">
          <h4 className="mb-3 text-[0.95em] font-semibold">
            {editing === null ? "Standard-Richtlinie für alle Mitglieder" : `Richtlinie für ${members.find((m) => m.id === editing)?.name || "Mitglied"}`}
          </h4>
          <PolicyEditor
            key={editing ?? "default"}
            initial={editing === null ? (state?.defaultPolicy ?? EMPTY_POLICY) : (state?.policies[editing] ?? state?.defaultPolicy ?? EMPTY_POLICY)}
            saveLabel="Signieren und verteilen"
            onCancel={() => setEditing(undefined)}
            onSave={async (p) => {
              await setTeamPolicy(team.id, editing, p);
              setEditing(undefined);
            }}
          />
          {editing !== null && state?.policies[editing] && (
            <Button size="sm" variant="ghost" onClick={() => run(async () => (await setTeamPolicy(team.id, editing, null), setEditing(undefined)))}>
              Wieder Standard-Richtlinie verwenden
            </Button>
          )}
        </section>
      ) : (
        <div className="mb-4 flex justify-end">
          <Button size="sm" onClick={() => setEditing(null)} data-testid="edit-default-policy">
            <Lock className="h-3.5 w-3.5" /> Standard-Richtlinie bearbeiten
          </Button>
        </div>
      )}

      <Card title="Audit-Log" icon={<History className="h-3.5 w-3.5" />}>
        {(state?.audit ?? [])
          .slice()
          .reverse()
          .slice(0, 30)
          .map((a) => (
            <div key={`${a.at}-${a.action}`} className="px-4 py-2 text-[0.88em]">
              <div className="flex gap-2">
                <span className="text-muted">{new Date(a.at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</span>
                <span className="font-medium">{a.byName}</span>
              </div>
              <div className="text-fg-2 selectable">{a.detail}</div>
            </div>
          ))}
        {!state?.audit.length && <p className="px-4 py-3 text-[0.9em] text-muted">Noch keine Änderungen.</p>}
      </Card>
    </div>
  );
}
