// Typen und Aufrufe für die ACP-Brücke im Rust-Backend (src-tauri/src/agent.rs).

import { invoke } from "@tauri-apps/api/core";

export interface AuthStatus {
  authenticated: boolean;
  authState: string;
  signOutAvailable: boolean;
  customDomain: string | null;
}

export interface Mode {
  id: string;
  name: string;
  description?: string;
}

export interface ConnectInfo {
  generation: number;
  agentPath: string;
  init: {
    agentInfo?: { title?: string; version?: string };
    authMethods?: { id: string; name: string }[];
  };
  auth: AuthStatus | null;
}

export interface NewSessionResult {
  sessionId: string;
  modes?: { currentModeId: string; availableModes: Mode[] };
  configOptions?: ConfigOption[];
}

export interface ConfigOption {
  id: string;
  name: string;
  currentValue: string;
  options?: { value: string; name: string }[];
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
  _meta?: { required_permissions?: { label?: string }[] };
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string; rawInput?: unknown };
  options: PermissionOption[];
}

export interface PromptResult {
  stopReason: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
}

export const api = {
  connect: () => invoke<ConnectInfo>("agent_connect"),
  startupProject: () => invoke<string | null>("startup_project"),
  authStatus: () => invoke<AuthStatus>("auth_status"),
  login: () => invoke<AuthStatus>("login"),
  signOut: () => invoke<AuthStatus>("sign_out"),
  newSession: (cwd: string) => invoke<NewSessionResult>("new_session", { cwd }),
  loadSession: (cwd: string, sessionId: string) =>
    invoke<Omit<NewSessionResult, "sessionId">>("load_session", { cwd, sessionId }),
  listSessions: (cwd: string) => invoke<{ sessions?: SessionSummary[] }>("list_sessions", { cwd }),
  prompt: (sessionId: string, text: string) => invoke<PromptResult>("prompt", { sessionId, text }),
  cancel: (sessionId: string) => invoke<void>("cancel", { sessionId }),
  setMode: (sessionId: string, modeId: string) => invoke("set_mode", { sessionId, modeId }),
  respondPermission: (key: string, optionId: string | null) =>
    invoke<void>("respond_permission", { key, optionId }),
};
