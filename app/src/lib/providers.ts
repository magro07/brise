import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * Anbieter für Brises eigene Modellaufrufe (siehe providers.rs): Mistral,
 * Anthropic, OpenAI, Google Gemini, Cortecs und beliebig viele
 * OpenAI-kompatible Endpunkte. Modelle heißen `anbieter/modell`; ohne
 * bekanntes Präfix ist es ein Mistral-Modell (so stehen sie in alten Einstellungen).
 */

export interface Provider {
  id: string;
  kind: "mistral" | "anthropic" | "openai" | "gemini" | "cortecs" | "compatible";
  name: string;
  baseUrl: string;
  template: string | null;
  /** Kopfzeile für den Schlüssel; leer = Authorization: Bearer. */
  authHeader: string;
  headers: Record<string, string>;
  zdr: boolean;
  vibeExport: boolean;
  vibeModels: string[];
  /** € je Million Tokens; null = Preistabelle. */
  inputPrice: number | null;
  outputPrice: number | null;
  testModel: string;
}

export interface ProviderView extends Provider {
  builtin: boolean;
  hasKey: boolean;
  keyHint: string | null;
  keySource: "vibe" | "keyring" | "env" | null;
  local: boolean;
  keyOptional: boolean;
  usable: boolean;
  exportable: boolean;
  models: string[];
  modelsAt: number;
}

export interface KeyCheck {
  valid: boolean;
  message: string;
  models: string[];
  testedWith: string | null;
}

export const providersApi = {
  list: () => invoke<ProviderView[]>("providers_list"),
  save: (provider: Provider) => invoke<ProviderView>("provider_save", { provider }),
  remove: (id: string) => invoke<void>("provider_delete", { id }),
  setKey: (id: string, key: string) => invoke<KeyCheck>("provider_set_key", { id, key }),
  deleteKey: (id: string) => invoke<void>("provider_delete_key", { id }),
  check: (id: string) => invoke<KeyCheck>("provider_check", { id }),
  models: (id: string, refresh = false) => invoke<string[]>("provider_models", { id, refresh }),
  testModel: (model: string) => invoke<{ text: string; ms: number; costEur: number; model: string; provider: string }>("provider_test_model", { model }),
  functionModel: (purpose: Purpose) => invoke<string | null>("provider_function_model", { purpose }),
};

/** Funktionen von Brise, die ein eigenes Modell bekommen. */
export type Purpose = "decide" | "helper" | "sensitivity" | "judge";

export interface Template {
  id: string;
  name: string;
  baseUrl: string;
  /** Kurzer Hinweis unter der Vorlage. */
  hint: string;
  authHeader?: string;
  headers?: Record<string, string>;
  zdr?: boolean;
  testModel?: string;
  /** Kein Schlüssel nötig (lokaler Server). */
  keyless?: boolean;
}

/** Typische OpenAI-kompatible Anbieter. Basis-URL immer mit /v1 o. Ä. */
export const TEMPLATES: Template[] = [
  { id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", hint: "Lokal, ohne Schlüssel. Modelle mit „ollama pull“ laden.", keyless: true, zdr: true },
  { id: "lmstudio", name: "LM Studio", baseUrl: "http://localhost:1234/v1", hint: "Lokal, ohne Schlüssel. In LM Studio den Server starten.", keyless: true, zdr: true },
  { id: "vllm", name: "vLLM", baseUrl: "http://localhost:8000/v1", hint: "Eigener Server; Schlüssel nur, wenn mit --api-key gestartet.", keyless: true, zdr: true },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", hint: "Viele Modelle über einen Schlüssel. Modelle heißen z. B. anthropic/claude-sonnet-4.", headers: { "HTTP-Referer": "https://github.com/magro07/brise", "X-Title": "Brise" } },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", hint: "Sehr schnelle Inferenz offener Modelle." },
  { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", hint: "Offene Modelle in der Cloud." },
  { id: "azure", name: "Azure OpenAI", baseUrl: "https://<ressource>.openai.azure.com/openai/v1", hint: "Ressourcenname einsetzen; Schlüssel steht im Azure-Portal. Modellname = Deployment-Name.", authHeader: "api-key" },
  { id: "custom", name: "Eigener Endpunkt", baseUrl: "https://", hint: "Jeder Dienst mit OpenAI-kompatibler Chat-API (/chat/completions)." },
];

export const EMPTY_PROVIDER: Provider = {
  id: "",
  kind: "compatible",
  name: "",
  baseUrl: "",
  template: null,
  authHeader: "",
  headers: {},
  zdr: false,
  vibeExport: false,
  vibeModels: [],
  inputPrice: null,
  outputPrice: null,
  testModel: "",
};

/** Modelle, die nicht chatten (Embeddings, Audio …) – wie non_chat in providers.rs. */
export function isChatModel(id: string) {
  return !/(embed|whisper|tts|dall-e|moderation|ocr|transcribe|image|audio|realtime|babbage|davinci|rerank|aqa|veo|imagen)/i.test(id);
}

export function isEmbeddingModel(id: string) {
  return /embed/i.test(id);
}

interface ProvidersState {
  list: ProviderView[];
  loaded: boolean;
  refresh(): Promise<void>;
}

export const useProviders = create<ProvidersState>((set) => ({
  list: [],
  loaded: false,
  async refresh() {
    const list = await providersApi.list().catch(() => null);
    if (list) set({ list, loaded: true });
  },
}));

/** Anbieter einer Modell-Angabe (wie split_ref in providers.rs). */
export function splitRef(ref: string, list: ProviderView[] = useProviders.getState().list): { provider: ProviderView | undefined; model: string } {
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const provider = list.find((p) => p.id === ref.slice(0, slash));
    if (provider) return { provider, model: ref.slice(slash + 1) };
  }
  return { provider: list.find((p) => p.id === "mistral"), model: ref };
}

/** Anzeige „Modell · Anbieter“. */
export function refLabel(ref: string, list?: ProviderView[]) {
  if (!ref) return "–";
  const { provider, model } = splitRef(ref, list);
  return provider ? `${model} · ${provider.name}` : model;
}

/** Speichert der Anbieter dieses Modells keine Daten (Cortecs, als ZDR markiert, lokal)? */
export function refIsZdr(ref: string, list?: ProviderView[]) {
  const { provider } = splitRef(ref, list);
  return !!provider && (provider.zdr || provider.local);
}

export function refUsable(ref: string, list?: ProviderView[]) {
  const { provider } = splitRef(ref, list);
  return !!ref && !!provider?.usable;
}

/** Cortecs-Decision-Modelle antworten mit Wahrscheinlichkeiten, schreiben aber keinen Text. */
export const CORTECS_DECISION = ["clef-flash", "clef", "laya"];

/** Bekannte Modelle je fester Anbieter, solange keine Liste geladen ist. */
export const SUGGESTED: Record<string, string[]> = {
  mistral: ["mistral-small-latest", "ministral-8b-latest", "ministral-3b-latest", "mistral-medium-latest", "mistral-large-4", "zai-glm-5-3", "codestral-latest", "magistral-medium-latest"],
  anthropic: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  openai: ["gpt-4.1-nano", "gpt-4.1-mini", "gpt-4.1", "gpt-5-mini", "gpt-5"],
  gemini: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro"],
  cortecs: ["clef-flash", "clef", "glm-5.3", "mistral-small-2603", "qwen3.8-27b"],
};

/** Modelle eines Anbieters zur Auswahl: geladene Liste, sonst Vorschläge. */
export function modelsOf(p: ProviderView, kind: "chat" | "embed" = "chat") {
  const base = p.models.length ? p.models : SUGGESTED[p.id] ?? (p.testModel ? [p.testModel] : []);
  return base.filter((m) => (kind === "embed" ? isEmbeddingModel(m) : isChatModel(m)));
}
