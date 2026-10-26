// Team-Richtlinien (siehe docs/adr/0005-team-workspaces.md und policy.rs).
// Die Oberfläche blendet gesperrte Bereiche aus oder sperrt sie zum Lesen;
// durchgesetzt wird zusätzlich in den Commands des Backends.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Access = "hidden" | "read" | "edit";

export interface TeamPolicy {
  sections: Record<string, Access>;
  backends: string[] | null;
  models: string[] | null;
  requireZdr: boolean;
  euNative: boolean;
  secrecy203: boolean;
  modes: string[] | null;
  noAutoEdits: boolean;
  dailyEur: number | null;
  monthlyEur: number | null;
  webSearch: boolean | null;
  mcpServers: string[] | null;
  skills: string[] | null;
  sharedDailyPrompts: number | null;
  sharedDailyTokens: number | null;
  /** Master-Session: false = Untersessions gesperrt. */
  orchestra: boolean | null;
  maxSubSessions: number | null;
}

export const EMPTY_POLICY: TeamPolicy = {
  sections: {},
  backends: null,
  models: null,
  requireZdr: false,
  euNative: false,
  secrecy203: false,
  modes: null,
  noAutoEdits: false,
  dailyEur: null,
  monthlyEur: null,
  webSearch: null,
  mcpServers: null,
  skills: null,
  sharedDailyPrompts: null,
  sharedDailyTokens: null,
  orchestra: null,
  maxSubSessions: null,
};

export interface AuditEntry {
  at: number;
  by: string;
  byName: string;
  action: string;
  detail: string;
}

export interface TeamState {
  team: string;
  version: number;
  owner: string;
  admins: string[];
  members: Record<string, { name: string }>;
  removed: string[];
  defaultPolicy: TeamPolicy;
  policies: Record<string, TeamPolicy>;
  audit: AuditEntry[];
}

export interface Effective {
  managed: boolean;
  policy: TeamPolicy;
  teams: string[];
}

/** Modi, die Änderungen ohne Rückfrage ausführen (wie AUTO_EDIT_MODES in policy.rs). */
export const AUTO_EDIT_MODES = ["accept-edits", "smart-approve", "auto-approve", "acceptEdits", "bypassPermissions", "auto"];

/** Einstellungen der Oberfläche → Bereich (wie pref_section in customize.rs). */
const PREF_SECTION: Record<string, string> = {
  theme: "general",
  fontSize: "general",
  notify: "general",
  accent: "general",
  sttLanguage: "voice",
  autoNarrate: "voice",
  embedModel: "embeddings",
  agentSearch: "embeddings",
  rea: "agents",
  autoModel: "models",
  routing: "models",
  assistModel: "models",
  autoStrategy: "models",
  autoBaseModel: "models",
  fim: "models",
  council: "council",
  decisionProvider: "cortecs",
  sensitivityCheck: "cortecs",
  zdrProjects: "cortecs",
  zdrModel: "cortecs",
  defaultBackend: "backends",
  orchestra: "orchestra",
};

export const usePolicy = create<{ effective: Effective }>(() => ({
  effective: { managed: false, policy: EMPTY_POLICY, teams: [] },
}));

export function sectionAccess(section: string, e: Effective = usePolicy.getState().effective): Access {
  return e.managed ? (e.policy.sections[section] ?? "edit") : "edit";
}

export function useAccess(section: string): Access {
  return usePolicy((s) => sectionAccess(section, s.effective));
}

/** „vom Admin des Teams „X““ – für Hinweise. */
export function managedBy(e: Effective = usePolicy.getState().effective) {
  return e.teams.length === 1 ? `vom Admin des Teams „${e.teams[0]}“` : "von deinem Team-Admin";
}

/** Oberflächen-Einstellungen ohne die, deren Bereich gesperrt ist. */
export function allowedPrefs<T extends Record<string, unknown>>(p: T): T {
  const e = usePolicy.getState().effective;
  if (!e.managed) return p;
  return Object.fromEntries(Object.entries(p).filter(([k]) => !PREF_SECTION[k] || sectionAccess(PREF_SECTION[k], e) === "edit")) as T;
}

export function modeAllowed(mode: string, e: Effective = usePolicy.getState().effective) {
  if (!e.managed) return true;
  if (e.policy.noAutoEdits && AUTO_EDIT_MODES.includes(mode)) return false;
  return !e.policy.modes || e.policy.modes.includes(mode);
}

export function modelAllowed(model: string, e: Effective = usePolicy.getState().effective) {
  return !e.managed || !e.policy.models || e.policy.models.includes(model);
}

export function backendAllowed(backend: string, e: Effective = usePolicy.getState().effective) {
  return !e.managed || !e.policy.backends || e.policy.backends.includes(backend);
}

export async function refreshPolicy() {
  const effective = await invoke<Effective>("policy_effective").catch(() => null);
  if (effective) usePolicy.setState({ effective });
}

export function initPolicy() {
  refreshPolicy();
  const un = listen<Effective>("policy:changed", (e) => usePolicy.setState({ effective: e.payload }));
  return () => {
    un.then((f) => f());
  };
}

// ---------- Admin ----------

export const setTeamAdmin = (teamId: string, member: string, admin: boolean) => invoke("collab_team_set_admin", { teamId, member, admin });
export const removeTeamMember = (teamId: string, member: string) => invoke("collab_team_remove_member", { teamId, member });
/** `member` null = Standard-Richtlinie; `policy` null = eigene Richtlinie aufheben. */
export const setTeamPolicy = (teamId: string, member: string | null, policy: TeamPolicy | null) => invoke("collab_team_set_policy", { teamId, member, policy });
export const claimTeam = (teamId: string) => invoke("collab_team_claim", { teamId });

export interface UsageEntry {
  name: string;
  prompts: number;
  tokens: number;
}
export const teamUsage = () => invoke<{ today: number; days: Record<string, Record<string, UsageEntry>> }>("collab_team_usage");

/** Einstellungsbereiche (wie SECTIONS in Settings.tsx und SECTION_LABELS in policy.rs). */
export const SECTION_LABELS: [string, string][] = [
  ["general", "Allgemein"],
  ["backends", "Agenten"],
  ["account", "Konto"],
  ["usage", "Nutzung"],
  ["bench", "Benchmarks"],
  ["models", "Modelle & Kontext"],
  ["permissions", "Freigaben & Sicherheit"],
  ["cortecs", "Cortecs & Datenschutz"],
  ["agents", "Vibe-Agents & Subagents"],
  ["skills", "Skills"],
  ["web", "Websuche & Recherche"],
  ["voice", "Sprache"],
  ["embeddings", "Embeddings & Suche"],
  ["council", "Council"],
  ["tools", "Werkzeuge & MCP"],
  ["collab", "Zusammenarbeit"],
  ["orchestra", "Master-Session"],
  ["advanced", "Erweitert"],
];

export function isAdmin(state: TeamState | null, id: string) {
  return !!state && (state.owner === id || state.admins.includes(id));
}

/** Richtlinie für ein Mitglied; Admins haben keine. */
export function policyFor(state: TeamState | null, id: string): TeamPolicy | null {
  if (!state || isAdmin(state, id)) return null;
  return { ...EMPTY_POLICY, ...(state.policies[id] ?? state.defaultPolicy) };
}
