// Typen und Aufrufe für die Rust-Commands (src-tauri/src/agent.rs, config.rs).

import { invoke } from "@tauri-apps/api/core";

export interface AuthStatus {
  authenticated: boolean;
  /** Nur Vibe (`_auth/status`). */
  authState?: string;
  signOutAvailable?: boolean;
  customDomain?: string | null;
  /** Andere Backends: z. B. „Claude Max“ und woher die Anmeldung stammt. */
  label?: string;
  detail?: string | null;
  /** Zugangsdaten vorhanden, aber nicht geprüft (Variablen, settings.json). */
  unverified?: boolean;
}

/** Was ein Backend über Standard-ACP hinaus kann (backends.rs). */
export interface BackendCaps {
  vibeExtensions: boolean;
  voice: boolean;
  settingsSchema: boolean;
  skills: boolean;
  models: boolean;
  autoModel: boolean;
}

export interface BackendInfo {
  id: string;
  title: string;
  description: string;
  caps: BackendCaps;
  installed: boolean;
  managed: boolean;
  command: string | null;
  installBlocker: string | null;
  loginAvailable: boolean;
  loginHint: string | null;
}

export interface ConnectInfo {
  generation: number;
  backend: string;
  title: string;
  caps: BackendCaps;
  newModels?: CatalogModel[] | null;
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
  backend?: string;
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
  | { type: "resource"; resource: { uri: string; mimeType: string; text: string } }
  | { type: "resource_link"; uri: string; name: string }
  | { type: "image"; mimeType: string; data: string };

export interface ConfigFile {
  path: string;
  exists: boolean;
  values: Record<string, unknown>;
}

export const api = {
  connect: (reuse: boolean, backend?: string) => invoke<ConnectInfo>("agent_connect", { reuse, backend: backend ?? null }),
  disconnectBackend: (backend: string) => invoke<void>("disconnect_backend", { backend }),
  backends: () => invoke<BackendInfo[]>("backends_list"),
  backendAuth: (backend: string) => invoke<AuthStatus | null>("backend_auth", { backend }),
  backendLoginCommand: (backend: string) => invoke<string | null>("backend_login_command", { backend }),
  installBackend: (backend: string) => invoke<string>("install_backend", { backend }),
  decisionProviders: () => invoke<{ id: string; title: string; available: boolean }[]>("decision_providers"),
  startupProject: () => invoke<string | null>("startup_project"),
  authStatus: () => invoke<AuthStatus>("auth_status"),
  login: () => invoke<AuthStatus>("login"),
  signOut: () => invoke<AuthStatus>("sign_out"),
  newSession: (cwd: string, search: boolean, rea: boolean, backend?: string) =>
    invoke<SessionSetup & { sessionId: string; backend: string }>("new_session", { cwd, search, rea, backend: backend ?? null }),
  loadSession: (cwd: string, sessionId: string, search: boolean, rea: boolean, backend?: string) =>
    invoke<SessionSetup>("load_session", { cwd, sessionId, search, rea, backend: backend ?? null }),
  listSessions: (cwd?: string, backend?: string) => invoke<{ sessions?: SessionSummary[] }>("list_sessions", { cwd: cwd ?? null, backend: backend ?? null }),
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
  saveApiKey: (key: string) => invoke<{ valid: boolean; message: string; models: number }>("save_api_key", { key }),
  apiKeyInfo: () => invoke<{ present: boolean; hint: string | null }>("api_key_info"),
  installVibe: () => invoke<string>("install_vibe"),
  upgradeVibe: () => invoke<void>("upgrade_vibe"),
  installInfo: () => invoke<{ path: string | null; managed: boolean; dataDir: string }>("install_info"),
  indexProject: (cwd: string, model: string) => invoke<IndexStatus>("index_project", { cwd, model }),
  indexStatus: (cwd: string) => invoke<IndexStatus>("index_status", { cwd }),
  deleteIndex: (cwd: string) => invoke<void>("delete_index", { cwd }),
  semanticSearch: (cwd: string, query: string, limit?: number) => invoke<SearchHit[]>("semantic_search", { cwd, query, limit: limit ?? null }),
  modelCatalog: () => invoke<CatalogModel[]>("model_catalog"),
  configuredModels: () => invoke<{ alias: string; name: string; provider: string; displayName: string | null }[]>("configured_models"),
  addModel: (name: string, alias?: string, displayName?: string) => invoke<void>("add_model", { name, alias: alias ?? null, displayName: displayName ?? null }),
  removeModel: (alias: string) => invoke<void>("remove_model", { alias }),
  startupCheck: () => invoke<{ changed: boolean; newModels: CatalogModel[] }>("startup_check"),
  listSkills: (cwd?: string) => invoke<SkillInfo[]>("list_skills", { cwd: cwd ?? null }),
  npxAvailable: () => invoke<boolean>("npx_available"),
  /** `provider`: "mistral" (Task-Modell) oder "cortecs" (Decision-Modelle mit ZDR). */
  classifyTask: (text: string, history: string | undefined, model: string, provider?: string) =>
    invoke<Decision<"simple" | "standard" | "complex">>("classify_task", { text, history: history ?? null, model, provider: provider ?? null }),
  projectSuggestions: (cwd: string, recent: string[], model: string, refresh = false, provider?: string) =>
    invoke<Suggestion[]>("project_suggestions", { cwd, recent, refresh, model, provider: provider ?? null }),
  adjustReasoning: (task: string, progress: string, current: string, model: string, provider?: string) =>
    invoke<Decision<string>>("adjust_reasoning", { task, progress, current, model, provider: provider ?? null }),
  commitMessage: (cwd: string, model: string, provider?: string) => invoke<string>("commit_message", { cwd, model, provider: provider ?? null }),
  gitStatus: (cwd: string) => invoke<GitStatus>("git_status", { cwd }),
  gitDiff: (cwd: string, path: string, staged: boolean) => invoke<string>("git_diff", { cwd, path, staged }),
  gitShowHead: (cwd: string, path: string) => invoke<string>("git_show_head", { cwd, path }),
  git: (cwd: string, action: string, paths?: string[], arg?: string) => invoke<string>("git_run", { cwd, action, paths: paths ?? null, arg: arg ?? null }),
  gitLog: (cwd: string, limit = 30) => invoke<{ hash: string; author: string; date: string; subject: string }[]>("git_log", { cwd, limit }),
  gitBranches: (cwd: string) => invoke<string[]>("git_branches", { cwd }),
  installGit: () => invoke<void>("install_git"),
  gitAvailable: () => invoke<boolean>("git_available"),
  termOpen: (cwd: string, cols: number, rows: number) => invoke<number>("term_open", { cwd, cols, rows }),
  termWrite: (id: number, data: string) => invoke<void>("term_write", { id, data }),
  termResize: (id: number, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows }),
  termClose: (id: number) => invoke<void>("term_close", { id }),
  readFile: (cwd: string, path: string) => invoke<string>("read_project_file", { cwd, path }),
  writeFile: (cwd: string, path: string, content: string) => invoke<void>("write_project_file", { cwd, path, content }),
  externalEditors: () => invoke<{ id: string; name: string }[]>("external_editors"),
  openExternal: (editor: string, cwd: string, path?: string, line?: number) =>
    invoke<void>("open_in_external", { editor, cwd, path: path ?? null, line: line ?? null }),
  fimComplete: (prefix: string, suffix: string, cwd?: string) => invoke<string>("fim_complete", { prefix, suffix, model: null, cwd: cwd ?? null }),
  ocrDocument: (path: string, cwd?: string) => invoke<string>("ocr_document", { path, cwd: cwd ?? null }),
  createProject: (parent: string, name: string, git: boolean, readme: boolean) => invoke<string>("create_project", { parent, name, git, readme }),
  createPath: (cwd: string, path: string, dir: boolean) => invoke<void>("create_path", { cwd, path, dir }),
  defaultProjectsDir: () => invoke<string>("default_projects_dir"),
  meterStart: () => invoke<void>("meter_start"),
  meterStop: () => invoke<void>("meter_stop"),
  readCustomization: () => invoke<{ settings: Record<string, unknown>; css: string }>("read_customization"),
  syncPrefs: (prefs: unknown) => invoke<void>("sync_prefs", { prefs }),
  /** Vibe-Erweiterungen (`_voice/…`); andere Backends können sie nicht. */
  ext: <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => invoke<T>("ext", { method, params, backend: null }),
};

/** Antwort einer Entscheidung; Cortecs liefert zusätzlich Wahrscheinlichkeiten. */
export interface Decision<L extends string> {
  level: L;
  reason: string;
  probabilities?: Record<string, number>;
  provider?: string;
  model?: string;
  ms?: number;
  costEur?: number;
}

export interface IndexStatus {
  indexed: boolean;
  model: string | null;
  files: number;
  chunks: number;
  updatedAt: number | null;
}

export interface SearchHit {
  path: string;
  start: number;
  end: number;
  score: number;
  snippet: string;
}

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

export interface CatalogModel {
  id: string;
  description: string;
  context: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  aliases: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: "brise" | "user" | "project";
  license: string | null;
}

export interface Suggestion {
  title: string;
  description: string;
  prompt: string;
  icon: string;
}

export interface GitStatus {
  available: boolean;
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: { path: string; index: string; worktree: string }[];
}
