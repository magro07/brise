import { invoke } from "@tauri-apps/api/core";

/** Cortecs: europäischer LLM-Router mit Zero Data Retention (siehe cortecs.rs). */

export interface CortecsModel {
  id: string;
  description: string;
  context: number;
  providers: string[];
  tags: string[];
  zdr: boolean;
  euNative: boolean;
  /** EUR pro 1 Mio. Tokens */
  inputPrice: number;
  outputPrice: number;
  cachePrice: number | null;
}

export interface CortecsSettings {
  euNative: boolean;
  secrecy203: boolean;
  decisionModel: string;
  chatModel: string;
}

export interface CortecsStatus {
  keyPresent: boolean;
  hint: string | null;
  proxyPort: number;
  proxyRunning: boolean;
  settings: CortecsSettings;
  utilityActive: boolean;
  vibeModels: string[];
  decisionModels: [string, string][];
  secrecyProviders: string[];
}

export interface SensitiveHit {
  label: string;
  sample: string;
  source: string;
  strong: boolean;
}

export interface SensitiveCategory {
  id: "personal" | "special" | "secret" | "credentials" | "secrecy203" | "aiact";
  label: string;
  probability: number;
  hits: SensitiveHit[];
  reason: string;
}

export interface SensitiveVerdict {
  flagged: boolean;
  categories: SensitiveCategory[];
  reason: string;
  /** "local", "cortecs" oder die ID des Anbieters, dessen Modell geprüft hat. */
  checkedBy: string;
  model: string | null;
  ms: number;
  costEur: number;
  unreadable: string[];
  error: string | null;
}

export const cortecs = {
  status: () => invoke<CortecsStatus>("cortecs_status"),
  saveKey: (key: string) => invoke<{ valid: boolean; message: string; models: number }>("cortecs_save_key", { key }),
  checkKey: () => invoke<{ valid: boolean; message: string; models: number }>("cortecs_check_key"),
  deleteKey: () => invoke<void>("cortecs_delete_key"),
  saveSettings: (settings: CortecsSettings) => invoke<void>("cortecs_save_settings", { settings }),
  models: () => invoke<CortecsModel[]>("cortecs_models"),
  addModel: (id: string) => invoke<string>("cortecs_add_model", { id }),
  utilityActive: (on: boolean) => invoke<boolean>("cortecs_utility_active", { on }),
  projectConfig: () => invoke<{ readable: boolean; status?: number; config?: any }>("cortecs_project_config"),
  /** `model`: „anbieter/modell“ für die zweite Prüfung, null = laut Einstellungen (sonst Cortecs, falls vorhanden). */
  checkSensitivity: (text: string, attachments: string[], cwd: string | null, remote: boolean, model: string | null = null) =>
    invoke<SensitiveVerdict>("sensitivity_check", { text, attachments, cwd, remote, model }),
};

/** Vibe-Aliase der Cortecs-Modelle beginnen mit „cortecs-“ (Brise trägt nur ZDR-Modelle ein). */
export const isZdrModel = (alias?: string | null) => !!alias && alias.startsWith("cortecs-");
