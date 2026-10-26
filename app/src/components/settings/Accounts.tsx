// Einstellungen → Konto: weitere Mistral-Schlüssel mit Namen, Standard-Account,
// Zuordnung je Projekt und Reserve bei Limit (ADR 0002).

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, KeyRound, Plus, Trash2 } from "lucide-react";
import { accountsApi, KIND_LABEL, useAccounts, type AccountKind } from "../../lib/accounts";
import { basename, useStore } from "../../lib/store";
import { confirmAction } from "../../lib/dialogs";
import { Button, Switch, clsx } from "../ui";

const select = "h-8 rounded-lg border border-line bg-panel px-2 text-[0.9em] outline-none focus:border-accent";

function Line({ title, description, control }: { title: ReactNode; description?: ReactNode; control: ReactNode }) {
  return (
    <div className="flex items-center gap-6 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">{title}</div>
        {description && <div className="mt-0.5 text-[0.86em] text-muted">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

function Box({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-1 text-[0.95em] font-semibold">{title}</h3>
      {description && <p className="mb-2 text-[0.88em] text-muted">{description}</p>}
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-elev">{children}</div>
    </section>
  );
}

export function AccountsCard() {
  const list = useAccounts((s) => s.list);
  const refresh = useAccounts((s) => s.refresh);
  const projects = useStore((s) => s.projects);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(String(e));
    }
    await refresh();
  };

  if (!list) return null;
  const accounts = list.accounts;
  const multiple = accounts.length > 1;
  const abos = accounts.filter((a) => a.kind === "abo").length;
  const reserves = accounts.filter((a) => a.reserve);

  return (
    <>
      <Box
        title="Accounts"
        description="Weitere Schlüssel mit Namen, etwa für Firma oder Kunden. Jede Session bleibt bei dem Account, mit dem sie begonnen hat – so bleibt der Prompt-Cache erhalten. Schlüssel liegen nur im Schlüsselbund."
      >
        {accounts.map((a) => (
          <Line
            key={a.id}
            title={
              <>
                <input
                  defaultValue={a.name}
                  onBlur={(e) => e.target.value.trim() !== a.name && run(() => accountsApi.update(a.id, { name: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  className="w-44 rounded-md border border-transparent bg-transparent px-1 font-medium outline-none hover:border-line focus:border-accent"
                  aria-label="Name"
                />
                {list.default === a.id && multiple && <span className="rounded bg-accent-soft px-1.5 text-[0.75em] text-accent">Standard</span>}
                {a.reserve && <span className="rounded bg-hover px-1.5 text-[0.75em] text-muted">Reserve</span>}
              </>
            }
            description={
              <>
                {a.hint ? <span className="font-mono">{a.hint}</span> : "kein Schlüssel gespeichert"}
                {a.standard && " · geteilt mit Vibe-CLI und Abo-Login"}
              </>
            }
            control={
              <>
                <select value={a.kind} onChange={(e) => run(() => accountsApi.update(a.id, { kind: e.target.value as AccountKind }))} className={select}>
                  {Object.entries(KIND_LABEL).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
                {multiple && list.default !== a.id && (
                  <Button size="sm" onClick={() => run(() => accountsApi.setDefault(a.id))}>
                    Als Standard
                  </Button>
                )}
                {!a.standard && (
                  <button
                    className="text-muted hover:text-bad"
                    aria-label="Entfernen"
                    onClick={async () =>
                      (await confirmAction(`„${a.name}“ entfernen? Der Schlüssel wird aus dem Schlüsselbund gelöscht, Sessions dieses Accounts laufen danach über den Standard.`, true)) &&
                      run(() => accountsApi.remove(a.id))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </>
            }
          />
        ))}
        {adding ? (
          <AddForm onDone={() => (setAdding(false), refresh())} />
        ) : (
          <div className="px-4 py-3">
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> Schlüssel hinzufügen
            </Button>
          </div>
        )}
      </Box>

      {abos > 1 && (
        <div className="-mt-3 mb-6 flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[0.88em]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-bad" />
          <span>
            Mehrere Abo-Accounts: Mistrals Nutzungsbedingungen für Privatkunden verbieten mehrere Accounts pro Person, ausdrücklich auch um Limits zu umgehen. Brise wechselt
            deshalb nie automatisch zwischen Abo-Accounts – nutze sie nur, wenn sie verschiedenen Personen oder Firmen gehören.
          </span>
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[0.9em] text-bad">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <span className="flex-1 selectable">{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {multiple && (
        <Box title="Reserve bei Limit" description="Meldet Mistral ein Limit, kann eine Session auf einen Pay-as-you-go-Schlüssel wechseln. Der Verlauf geht dabei einmal ohne Cache raus, danach bleibt die Session dort.">
          {accounts
            .filter((a) => a.kind === "payg")
            .map((a) => (
              <Line
                key={a.id}
                title={`${a.name} als Reserve`}
                control={<Switch checked={a.reserve} onChange={(v) => run(() => accountsApi.update(a.id, { reserve: v }))} />}
              />
            ))}
          {!accounts.some((a) => a.kind === "payg") && <div className="px-4 py-3 text-[0.9em] text-muted">Als Reserve kommen nur Pay-as-you-go-Schlüssel in Frage.</div>}
          <Line
            title="Ohne Rückfrage wechseln"
            description="Sonst fragt Brise vor dem Wechsel nach."
            control={<Switch checked={list.autoSwitch} disabled={!reserves.length} onChange={(v) => run(() => accountsApi.setAutoSwitch(v))} />}
          />
        </Box>
      )}

      {multiple && projects.length > 0 && (
        <Box title="Account je Projekt" description="Gilt für neue Sessions. Laufende Sessions behalten ihren Account.">
          {projects.map((p) => (
            <Line
              key={p}
              title={basename(p)}
              description={<span className="font-mono text-[0.9em]">{p}</span>}
              control={
                <select value={list.projects[p] ?? ""} onChange={(e) => run(() => accountsApi.setProject(p, e.target.value || null))} className={select}>
                  <option value="">Standard ({accounts.find((a) => a.id === list.default)?.name})</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              }
            />
          ))}
        </Box>
      )}
    </>
  );
}

function AddForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AccountKind>("team");
  const [key, setKey] = useState("");
  const [reserve, setReserve] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, z. B. Firma" className="h-9 flex-1 rounded-lg border border-line bg-bg px-3 text-[0.9em] outline-none focus:border-accent" />
        <select value={kind} onChange={(e) => setKind(e.target.value as AccountKind)} className={clsx(select, "h-9")}>
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <input
        type="password"
        value={key}
        onChange={(e) => (setKey(e.target.value), setError(null))}
        placeholder="Schlüssel einfügen …"
        className="h-9 w-full rounded-lg border border-line bg-bg px-3 font-mono text-[0.88em] outline-none focus:border-accent"
      />
      {kind === "payg" && (
        <label className="flex items-center gap-2 text-[0.9em]">
          <Switch checked={reserve} onChange={setReserve} /> Als Reserve bei Limit erlauben
        </label>
      )}
      {kind === "abo" && <div className="text-[0.86em] text-muted">Nur für ein Abo, das nicht dir selbst gehört – mehrere eigene Abo-Accounts sind laut Mistral nicht erlaubt.</div>}
      {error && <div className="text-[0.86em] text-bad">{error}</div>}
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={!name.trim() || !key.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await accountsApi.add(name, kind, key, reserve);
              setKey("");
              onDone();
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <KeyRound className="h-3.5 w-3.5" /> Prüfen und speichern
        </Button>
        <Button size="sm" onClick={onDone}>
          Abbrechen
        </Button>
      </div>
    </div>
  );
}
