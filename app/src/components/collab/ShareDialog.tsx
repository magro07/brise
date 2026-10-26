import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, Crown, Play, Share2, ShieldAlert, Trash2, UserMinus, Users, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { tokens as fmtTokens } from "../../lib/format";
import {
  BACKEND_LABEL,
  planLabel,
  policyFromPrefs,
  setPolicy,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  dropQueued,
  removeParticipant,
  runQueued,
  setDefaultRole,
  setRole,
  share,
  unshare,
  useCollab,
  type CollabRole,
  type HostView,
  type Policy,
} from "../../lib/collab";
import { Button, Menu, MenuContent, MenuItem, MenuTrigger, Switch, clsx } from "../ui";

const ROLES: CollabRole[] = ["viewer", "collaborator", "approver"];

const EXPIRY: { minutes: number; label: string }[] = [
  { minutes: 60, label: "1 Stunde" },
  { minutes: 8 * 60, label: "8 Stunden" },
  { minutes: 24 * 60, label: "24 Stunden" },
  { minutes: 7 * 24 * 60, label: "7 Tage" },
  { minutes: 0, label: "nie" },
];

export function RolePicker({ value, onChange }: { value: CollabRole; onChange: (r: CollabRole) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="h-7 rounded-md border border-line bg-bg px-2 text-[0.86em] hover:bg-hover">{ROLE_LABEL[value]}</button>
      </MenuTrigger>
      <MenuContent align="end" className="w-64">
        {ROLES.map((r) => (
          <MenuItem key={r} checked={r === value} description={ROLE_DESCRIPTION[r]} onSelect={() => onChange(r)}>
            {ROLE_LABEL[r]}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Was Gäste auf dem eigenen Abo dürfen: Prompts ja/nein, Tageslimits. */
function PolicyEditor({ policy, onChange }: { policy: Policy; onChange: (p: Policy) => void }) {
  const num = (v: string) => (Number(v) > 0 ? Math.floor(Number(v)) : null);
  return (
    <div className="rounded-xl border border-line px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="flex-1 text-[0.9em]">
          Gäste dürfen Prompts auf dein Abo schicken
          <span className="block text-[0.86em] text-muted">Gilt für Mitarbeiter und Freigeber. Aus: alle schauen nur zu.</span>
        </span>
        <Switch checked={policy.guestPrompts} onChange={(v) => onChange({ ...policy, guestPrompts: v })} />
      </div>
      {policy.guestPrompts && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[0.88em] text-fg-2">
          <label className="flex items-center gap-1.5">
            Je Gast höchstens
            <input
              type="number"
              min={0}
              value={policy.dailyPrompts ?? ""}
              placeholder="∞"
              onChange={(e) => onChange({ ...policy, dailyPrompts: num(e.target.value) })}
              className="h-7 w-16 rounded-md border border-line bg-bg px-1.5 text-right"
            />
            Prompts
          </label>
          <label className="flex items-center gap-1.5">
            und
            <input
              type="number"
              min={0}
              step={10000}
              value={policy.dailyTokens ?? ""}
              placeholder="∞"
              onChange={(e) => onChange({ ...policy, dailyTokens: num(e.target.value) })}
              className="h-7 w-24 rounded-md border border-line bg-bg px-1.5 text-right"
            />
            Tokens pro Tag
          </label>
        </div>
      )}
    </div>
  );
}

function Setup({ sessionId }: { sessionId: string }) {
  const prefs = useCollab((s) => s.prefs);
  const setPrefs = useCollab((s) => s.setPrefs);
  const teams = Object.values(useCollab((s) => s.teams));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const relayMissing = prefs.mode === "relay" && !prefs.relayUrl.trim();

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await share(sessionId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label className="mt-5 block text-[0.86em] font-medium">Dein Name für die anderen</label>
      <input
        value={prefs.name}
        onChange={(e) => setPrefs({ name: e.target.value })}
        placeholder="z. B. Max"
        className="mt-1 h-9 w-full rounded-lg border border-line bg-bg px-3 outline-none focus:border-accent"
      />

      <label className="mt-4 block text-[0.86em] font-medium">Verbindung</label>
      <div className="mt-1 flex rounded-lg border border-line bg-panel p-0.5 text-[0.9em]">
        {(["lan", "relay"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setPrefs({ mode: m })}
            className={clsx("h-8 flex-1 rounded-md", prefs.mode === m ? "bg-elev text-fg shadow-sm" : "text-muted hover:text-fg")}
          >
            {m === "lan" ? "Direkt im LAN" : "Über Relay"}
          </button>
        ))}
      </div>
      {prefs.mode === "relay" ? (
        <input
          value={prefs.relayUrl}
          onChange={(e) => setPrefs({ relayUrl: e.target.value })}
          placeholder="wss://relay.example.org"
          className="mt-2 h-9 w-full rounded-lg border border-line bg-bg px-3 font-mono text-[0.9em] outline-none focus:border-accent"
        />
      ) : (
        <p className="mt-1.5 text-[0.84em] text-muted">Brise öffnet Port {prefs.lanPort} für Gäste im selben Netz. Inhalte bleiben verschlüsselt.</p>
      )}

      {teams.length > 0 && (
        <>
          <div className="mt-4 flex items-center gap-3">
            <span className="flex-1 text-[0.9em]">Im Team zeigen</span>
            <select
              value={teams.some((t) => t.id === prefs.shareTeam) ? prefs.shareTeam : ""}
              onChange={(e) => setPrefs({ shareTeam: e.target.value })}
              className="h-7 rounded-md border border-line bg-bg px-1.5 text-[0.86em]"
            >
              <option value="">keinem Team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="flex-1 text-[0.9em]">Rolle für Teammitglieder</span>
            <RolePicker value={prefs.teamRole} onChange={(r) => setPrefs({ teamRole: r })} />
          </div>
        </>
      )}
      <div className="mt-3 flex items-center gap-3">
        <span className="flex-1 text-[0.9em]">Rolle anderer Gäste</span>
        <RolePicker value={prefs.defaultRole} onChange={(r) => setPrefs({ defaultRole: r })} />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <span className="flex-1 text-[0.9em]">Link läuft ab nach</span>
        <select
          value={prefs.expiresMinutes}
          onChange={(e) => setPrefs({ expiresMinutes: Number(e.target.value) })}
          className="h-7 rounded-md border border-line bg-bg px-1.5 text-[0.86em]"
        >
          {EXPIRY.map((x) => (
            <option key={x.minutes} value={x.minutes}>
              {x.label}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <span className="flex-1 text-[0.9em]">
          Werkzeug-Ausgaben zeigen
          <span className="block text-[0.86em] text-muted">Aus: Gäste sehen nur Konversation und Diffs, keine gelesenen Dateien.</span>
        </span>
        <Switch checked={prefs.showOutputs} onChange={(v) => setPrefs({ showOutputs: v })} />
      </div>

      <div className="mt-4 text-[0.86em] font-medium">Dein Abo ({BACKEND_LABEL.vibe}: {planLabel()})</div>
      <div className="mt-1">
        <PolicyEditor
          policy={policyFromPrefs(prefs)}
          onChange={(p) => setPrefs({ guestPrompts: p.guestPrompts, dailyPrompts: p.dailyPrompts ?? 0, dailyTokens: p.dailyTokens ?? 0 })}
        />
      </div>

      <div className="mt-4 flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[0.84em] text-warn">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Prompts von Gästen laufen mit deinen Rechten und auf deinem Abo. Die Session wechselt deshalb auf „Alles fragen“.</span>
      </div>
      {error && <p className="mt-3 text-[0.88em] text-bad selectable">{error}</p>}
      <div className="mt-5 flex justify-end">
        <Button variant="primary" disabled={busy || relayMissing} onClick={start}>
          <Share2 className="h-4 w-4" /> Link erzeugen
        </Button>
      </div>
    </>
  );
}

function Shared({ host }: { host: HostView }) {
  const [copied, setCopied] = useState(false);
  const autoRun = useCollab((s) => s.prefs.autoRun);
  const setPrefs = useCollab((s) => s.setPrefs);
  const running = useStore((s) => !!s.sessions[host.sessionId]?.running);
  const sid = host.sessionId;
  const copy = async () => {
    await navigator.clipboard.writeText(host.link).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const online = host.participants.filter((p) => p.online).length;

  return (
    <>
      <div className="mt-4 flex gap-2">
        <input readOnly value={host.link} onFocus={(e) => e.currentTarget.select()} data-collab="link" className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 font-mono text-[0.8em] outline-none selectable" />
        <Button onClick={copy}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} Kopieren</Button>
      </div>
      <p className="mt-1.5 flex items-center gap-1.5 text-[0.82em] text-muted">
        <span className={clsx("h-2 w-2 rounded-full", host.connected ? "bg-ok" : "bg-warn")} />
        {host.connected ? (host.lan ? `Direkt im LAN über ${host.relay}` : `Über Relay ${host.relay}`) : (host.error ?? "Verbinde …")}
        {host.expires && <span>· gültig bis {new Date(host.expires * 1000).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</span>}
      </p>

      <p className="mt-1 text-[0.82em] text-muted">
        {BACKEND_LABEL[host.backend] ?? host.backend} auf deinem Abo ({host.billedTo.plan ?? "ohne Angabe"})
        {host.team && <> · im Team sichtbar</>}
      </p>
      <div className="mt-3">
        <PolicyEditor policy={host.policy} onChange={(p) => setPolicy(sid, p)} />
      </div>

      <div className="mt-5 flex items-center gap-2 text-[0.86em] font-medium">
        <Users className="h-4 w-4 text-muted" /> Teilnehmer <span className="text-muted">{online} online</span>
        <span className="flex-1" />
        <span className="font-normal text-muted">Neue Gäste:</span>
        <RolePicker value={host.defaultRole} onChange={(r) => setDefaultRole(sid, r)} />
      </div>
      <div className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
        <div className="flex items-center gap-2 px-3 py-2 text-[0.9em]">
          <Crown className="h-4 w-4 text-accent" /> <span className="flex-1">Du (Host)</span>
        </div>
        {host.participants.length === 0 && <div className="px-3 py-3 text-[0.88em] text-muted">Noch niemand beigetreten. Schick den Link an dein Team.</div>}
        {host.participants.map((p) => (
          <div key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-[0.9em]" data-collab="participant">
            <span className={clsx("h-2 w-2 rounded-full", p.online ? "bg-ok" : "bg-line-strong")} title={p.online ? "online" : "abwesend"} />
            <span className="min-w-0 flex-1 truncate">
              {p.name}
              {p.team && <span className="ml-1.5 text-[0.82em] text-muted">Team</span>}
            </span>
            {(p.prompts ?? 0) > 0 && (
              <span className="shrink-0 text-[0.8em] text-muted" title="heute auf deinem Abo">
                {p.prompts} Prompts · {fmtTokens(p.tokens ?? 0)}
              </span>
            )}
            <RolePicker value={p.role} onChange={(r) => setRole(sid, p.id, r)} />
            <button
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-bad"
              title="Freigabe entziehen"
              onClick={() => removeParticipant(sid, p.id)}
            >
              <UserMinus className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center gap-2 text-[0.86em] font-medium">
        Warteschlange <span className="text-muted">{host.queue.length}</span>
        <span className="flex-1" />
        <span className="font-normal text-muted">automatisch ausführen</span>
        <Switch checked={autoRun} onChange={(v) => setPrefs({ autoRun: v })} />
      </div>
      {host.queue.length === 0 ? (
        <p className="mt-1 text-[0.86em] text-muted">Prompts von Mitarbeitern landen hier, bevor der Agent sie bekommt.</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {host.queue.map((q) => (
            <div key={q.id} className="flex items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-[0.9em]" data-collab="queued">
              <div className="min-w-0 flex-1">
                <div className="text-[0.82em] text-muted">{q.author}</div>
                <div className="line-clamp-3 whitespace-pre-wrap selectable">{q.text}</div>
              </div>
              <Button size="sm" variant="primary" disabled={running} onClick={() => runQueued(sid, q.id)} title={running ? "Der Agent arbeitet gerade" : "Jetzt ausführen"}>
                <Play className="h-3.5 w-3.5" /> Ausführen
              </Button>
              <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-bad" title="Verwerfen" onClick={() => dropQueued(sid, q.id)}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="mt-4 text-[0.8em] text-muted">
        Entzogene Gäste können nichts mehr beitragen. Wer den Link kennt, kann aber weiter mitlesen – für einen vollständigen Ausschluss die Freigabe beenden und neu teilen.
      </p>
      <div className="mt-4 flex justify-end">
        <Button variant="danger" onClick={() => unshare(sid).then(() => useCollab.setState({ shareFor: null }))}>
          Freigabe beenden
        </Button>
      </div>
    </>
  );
}

/** „Session teilen“: Link erzeugen, Teilnehmer und Warteschlange verwalten. */
export function ShareDialog() {
  const sessionId = useCollab((s) => s.shareFor);
  const host = useCollab((s) => (sessionId ? s.hosts[sessionId] : undefined));
  const title = useStore((s) => (sessionId ? s.sessions[sessionId]?.title : undefined));
  const close = () => useCollab.setState({ shareFor: null });

  return (
    <Dialog.Root open={!!sessionId} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 fade-in" />
        <Dialog.Content className="fixed left-1/2 top-[8%] z-50 max-h-[84vh] w-[min(600px,94vw)] -translate-x-1/2 overflow-y-auto rounded-2xl border border-line bg-elev p-6 shadow-pop fade-in">
          <Dialog.Title className="flex items-center gap-2 text-[1.15em] font-semibold">
            <Share2 className="h-5 w-5 text-accent" /> Session teilen
            <span className="flex-1" />
            <button onClick={close} className="text-muted hover:text-fg" aria-label="Schließen">
              <X className="h-4 w-4" />
            </button>
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[0.9em] text-muted">
            {title ?? "Neue Session"} – der Agent läuft weiter nur auf diesem Rechner. Gäste bekommen Konversation, Diffs und Freigabe-Anfragen, Ende-zu-Ende verschlüsselt.
          </Dialog.Description>
          {sessionId && (host ? <Shared host={host} /> : <Setup sessionId={sessionId} />)}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
