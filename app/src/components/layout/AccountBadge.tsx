// Welcher Mistral-Account eine Session nutzt – nur sichtbar, wenn mehrere eingetragen sind.

import { useEffect } from "react";
import { KeyRound } from "lucide-react";
import { accountForProject, accountsApi, useAccounts } from "../../lib/accounts";
import { useStore } from "../../lib/store";
import { Tip } from "../ui";

export function AccountBadge({ sessionId }: { sessionId?: string }) {
  const list = useAccounts((s) => s.list);
  const bound = useAccounts((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const project = useStore((s) => s.activeProject);

  useEffect(() => {
    if (!list) useAccounts.getState().refresh();
  }, [list]);
  useEffect(() => {
    if (sessionId && !bound)
      accountsApi
        .sessionAccount(sessionId)
        .then((a) => useAccounts.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: a } })))
        .catch(() => {});
  }, [sessionId, bound]);

  if (!list || list.accounts.length < 2) return null;
  const name = sessionId ? bound?.name : accountForProject(list, project)?.name;
  if (!name) return null;
  return (
    <Tip label={sessionId ? "Mistral-Account dieser Session" : "Account für die neue Session (Einstellungen → Konto)"}>
      <span className="flex shrink-0 items-center gap-1 rounded bg-hover px-1.5 text-[0.75em] text-muted">
        <KeyRound className="h-3 w-3" />
        {name}
      </span>
    </Tip>
  );
}
