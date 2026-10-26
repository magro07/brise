// Typen und Aufrufe für die Rust-Commands (src-tauri/src/agent.rs, config.rs).

import { invoke } from "@tauri-apps/api/core";

export interface AuthStatus {
  authenticated: boolean;
  authState: string;
  signOutAvailable: boolean;
  customDomain: string | null;
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

export interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type?: string;
  currentValue: string | boolean;
  options?: { value: string; name: string; description?: string }[];
}

export interface SessionSetup {
  sessionId?: string;
  modes?: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] };
  configOptions?: ConfigOption[];
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
  kind: string;
  _meta?: { required_permissions?: { label?: string }[] };
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string; rawInput?: unknown };
  options: PermissionOption[];
}

export interface PromptResult {
  stopReason: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedReadTokens?: number } | null;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string }
  | { type: "image"; mimeType: string; data: string };

export interface ConfigFile {
  path: string;
  exists: boolean;
  values: Record<string, unknown>;
}

export const api = {
  connect: (reuse: boolean) => invoke<ConnectInfo>("agent_connect", { reuse }),
  startupProject: () => invoke<string | null>("startup_project"),
  authStatus: () => invoke<AuthStatus>("auth_status"),
  login: () => invoke<AuthStatus>("login"),
  signOut: () => invoke<AuthStatus>("sign_out"),
  newSession: (cwd: string) => invoke<SessionSetup & { sessionId: string }>("new_session", { cwd }),
  loadSession: (cwd: string, sessionId: string) => invoke<SessionSetup>("load_session", { cwd, sessionId }),
  listSessions: (cwd?: string) => invoke<{ sessions?: SessionSummary[] }>("list_sessions", { cwd: cwd ?? null }),
  deleteSession: (sessionId: string) => invoke("delete_session", { sessionId }),
  prompt: (sessionId: string, prompt: ContentBlock[]) => invoke<PromptResult>("prompt", { sessionId, prompt }),
  cancel: (sessionId: string) => invoke<void>("cancel", { sessionId }),
  setMode: (sessionId: string, modeId: string) => invoke("set_mode", { sessionId, modeId }),
  setConfigOption: (sessionId: string, configId: string, value: unknown) =>
    invoke("set_config_option", { sessionId, configId, value }),
  respondPermission: (key: string, optionId: string | null) => invoke<void>("respond_permission", { key, optionId }),
  configSchema: () => invoke<{ version: string; schema: JsonSchema }>("config_schema"),
  readConfig: () => invoke<ConfigFile>("read_config"),
  writeConfig: (key: string[], value: unknown) => invoke<void>("write_config_value", { key, value }),
  listFiles: (cwd: string) => invoke<string[]>("list_project_files", { cwd }),
  readImage: (path: string) => invoke<[string, string]>("read_image", { path }),
};

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
}
