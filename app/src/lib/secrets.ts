import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useStore } from "./store";

/** Gültigkeit eines Secrets. */
export type SecretScope = "session" | "project" | "global";

export const SCOPE_LABEL: Record<SecretScope, string> = {
  session: "Nur diese Session",
  project: "Dieses Projekt",
  global: "Dauerhaft",
};

export const SCOPE_HINT: Record<SecretScope, string> = {
  session: "Wird beim Beenden von Brise gelöscht",
  project: "Alle Sessions in diesem Projektordner",
  global: "Alle Projekte",
};

/** Eintrag aus dem Verzeichnis – nie mit Wert. */
export interface SecretMeta {
  name: string;
  scope: SecretScope;
  project?: string;
  sessionId?: string;
  purpose: string;
  created: number;
}

/** Anfrage des Agenten über `request_secret`. */
export interface SecretRequest {
  id: string;
  name: string;
  purpose: string;
  scope: SecretScope;
  sessionId?: string | null;
  cwd?: string | null;
  created: number;
}

/** Zugangsdaten im Composer-Text (Bereich in UTF-16, wie JS-Strings). */
export interface SecretFound {
  label: string;
  start: number;
  end: number;
  name: string;
  sample: string;
}

export const placeholder = (name: string) => `{{secret:${name}}}`;

/** Wie in secrets.rs: GROSS, Ziffern, Unterstrich. */
export const normalizeName = (raw: string) => raw.trim().toUpperCase().replace(/[-. ]/g, "_");
export const validName = (name: string) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name);

export const secretsApi = {
  pending: () => invoke<SecretRequest[]>("secrets_pending"),
  answer: (requestId: string, value: string | null, scope: SecretScope) =>
    invoke<{ status: string; name: string; placeholder: string }>("secret_answer", { requestId, value, scope }),
  save: (name: string, value: string, scope: SecretScope, sessionId?: string, cwd?: string, purpose?: string) =>
    invoke<string>("secret_save", { name, value, scope, sessionId, cwd, purpose }),
  list: () => invoke<SecretMeta[]>("secrets_list"),
  remove: (m: SecretMeta) => invoke<void>("secret_delete", { name: m.name, scope: m.scope, project: m.project, sessionId: m.sessionId }),
  setScope: (m: SecretMeta, newScope: SecretScope, newProject?: string) =>
    invoke<SecretMeta>("secret_set_scope", { name: m.name, scope: m.scope, project: m.project, sessionId: m.sessionId, newScope, newProject }),
  scan: (text: string) => invoke<SecretFound[]>("secret_scan", { text }),
};

interface SecretsState {
  requests: SecretRequest[];
}

export const useSecrets = create<SecretsState>(() => ({ requests: [] }));

/** Offene Anfrage für eine Session (ohne bekannte Session: nach Projekt). */
export function useSecretRequest(sessionId?: string, cwd?: string) {
  return useSecrets((s) => s.requests.find((r) => (r.sessionId ? r.sessionId === sessionId : !!cwd && r.cwd === cwd)));
}

/** Hält im Verlauf fest, was mit einer Anfrage passiert ist – ohne Wert. */
function note(sessionId: string | null | undefined, text: string, tone: "info" | "warn") {
  if (!sessionId) return;
  useStore.setState((st) => {
    const s = st.sessions[sessionId];
    if (!s) return {};
    return { sessions: { ...st.sessions, [sessionId]: { ...s, items: [...s.items, { type: "notice", id: crypto.randomUUID(), text, tone }] } } };
  });
}

export async function answerSecret(req: SecretRequest, value: string | null, scope: SecretScope) {
  try {
    await secretsApi.answer(req.id, value, scope);
    note(
      req.sessionId,
      value
        ? `Secret ${req.name} gespeichert (${SCOPE_LABEL[scope]}). Der Agent sieht nur ${placeholder(req.name)}.`
        : `Eingabe von ${req.name} abgelehnt.`,
      value ? "info" : "warn",
    );
  } finally {
    useSecrets.setState((s) => ({ requests: s.requests.filter((r) => r.id !== req.id) }));
  }
}

/** Anfragen der MCP-Server abonnieren; liefert die Abmeldung. */
export function initSecrets(): () => void {
  let off: (() => void) | undefined;
  let disposed = false;
  const add = (r: SecretRequest) => useSecrets.setState((s) => (s.requests.some((x) => x.id === r.id) ? s : { requests: [...s.requests, r] }));
  listen<SecretRequest>("secrets:request", (e) => add(e.payload)).then((fn) => (disposed ? fn() : (off = fn)));
  secretsApi.pending().then((list) => list.forEach(add)).catch(() => {});
  return () => {
    disposed = true;
    off?.();
  };
}
