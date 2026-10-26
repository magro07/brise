// Mehrere Mistral-Schlüssel (src-tauri/src/accounts.rs, ADR 0002): Liste,
// Zuordnung von Sessions zu Accounts und Wechsel auf die Reserve bei Limit.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, type ContentBlock, type PromptResult } from "./acp";
import { confirmAction } from "./dialogs";

export type AccountKind = "abo" | "team" | "payg";

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  reserve: boolean;
  standard: boolean;
  present: boolean;
  /** Nur Anfang und Ende des Schlüssels. */
  hint: string | null;
}

export interface AccountList {
  accounts: Account[];
  default: string;
  projects: Record<string, string>;
  autoSwitch: boolean;
}

export const KIND_LABEL: Record<AccountKind, string> = {
  abo: "Abo (Le Chat/Vibe)",
  team: "Team/Firma",
  payg: "Pay-as-you-go",
};

export const accountsApi = {
  list: () => invoke<AccountList>("list_accounts"),
  add: (name: string, kind: AccountKind, key: string, reserve: boolean) => invoke<Account>("add_account", { name, kind, key, reserve }),
  update: (id: string, patch: { name?: string; kind?: AccountKind; reserve?: boolean }) =>
    invoke<void>("update_account", { id, name: patch.name ?? null, kind: patch.kind ?? null, reserve: patch.reserve ?? null }),
  remove: (id: string) => invoke<void>("remove_account", { id }),
  setDefault: (id: string) => invoke<void>("set_default_account", { id }),
  setProject: (cwd: string, id: string | null) => invoke<void>("set_project_account", { cwd, id }),
  setAutoSwitch: (enabled: boolean) => invoke<void>("set_auto_switch", { enabled }),
  sessionAccount: (sessionId: string) => invoke<{ id: string; name: string }>("session_account", { sessionId }),
  reserve: (sessionId: string) =>
    invoke<{ id: string; name: string; from: string; auto: boolean } | null>("reserve_account", { sessionId }),
  switchTo: (cwd: string, sessionId: string, account: string, search: boolean, rea: boolean) =>
    invoke<{ id: string; name: string; lastUserText: string }>("switch_account", { cwd, sessionId, account, search, rea }),
};

interface AccountsState {
  list: AccountList | null;
  /** Account je Session, wie das Backend ihn zugeordnet hat. */
  bySession: Record<string, { id: string; name: string }>;
  refresh(): Promise<void>;
}

export const useAccounts = create<AccountsState>((set) => ({
  list: null,
  bySession: {},
  async refresh() {
    try {
      set({ list: await accountsApi.list() });
    } catch {
      /* ohne Backend (Vorschau) bleibt die Liste leer */
    }
  },
}));

try {
  listen<{ sessionId: string; id: string; name: string }>("accounts:session", (e) =>
    useAccounts.setState((s) => ({ bySession: { ...s.bySession, [e.payload.sessionId]: { id: e.payload.id, name: e.payload.name } } })),
  );
} catch {
  /* außerhalb von Tauri */
}

/** Account, den eine neue Session in `cwd` bekäme. */
export function accountForProject(list: AccountList | null, cwd: string | null): Account | undefined {
  if (!list) return undefined;
  const id = (cwd && list.projects[cwd]) || list.default;
  return list.accounts.find((a) => a.id === id) ?? list.accounts[0];
}

const CONTINUE = "Das Limit des vorigen Accounts war erreicht. Bitte mach genau dort weiter, wo du unterbrochen wurdest.";

/**
 * `session/prompt` mit Wechsel auf den Reserve-Account, wenn Vibe ein Limit
 * meldet. Die Session bleibt danach beim neuen Account (sticky).
 */
export async function promptWithReserve(
  session: { id: string; cwd: string },
  blocks: ContentBlock[],
  opts: { search: boolean; rea: boolean; notice: (text: string, tone: "warn" | "error") => void },
): Promise<PromptResult> {
  try {
    return await api.prompt(session.id, blocks);
  } catch (e) {
    if (!String(e).startsWith("RATE_LIMIT")) throw e;
    const reserve = await accountsApi.reserve(session.id).catch(() => null);
    if (!reserve) throw new Error("Limit erreicht. Mistral lässt erst nach dem Zurücksetzen des Kontingents weitere Anfragen zu.");
    const ok =
      reserve.auto ||
      (await confirmAction(
        `Limit von „${reserve.from}“ erreicht. Mit „${reserve.name}“ fortsetzen?\n\nDer Verlauf wird dabei einmal ohne Cache gesendet und kostet entsprechend mehr. Die Session bleibt danach bei „${reserve.name}“.`,
      ));
    if (!ok) throw new Error(`Limit von „${reserve.from}“ erreicht.`);
    const moved = await accountsApi.switchTo(session.cwd, session.id, reserve.id, opts.search, opts.rea);
    opts.notice(`Limit von „${reserve.from}“ erreicht – diese Session läuft jetzt über „${moved.name}“.`, "warn");
    // Hat Vibe die Nachricht schon im Verlauf, nur um Fortsetzung bitten statt sie doppelt zu senden.
    const text = blocks.find((b) => b.type === "text");
    const stored = text?.type === "text" && moved.lastUserText.trim() === text.text.trim();
    return api.prompt(session.id, stored ? [{ type: "text", text: CONTINUE }] : blocks);
  }
}
