export function relativeTime(iso?: string | null): string {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "gerade eben";
  if (diff < 3600) return `${Math.floor(diff / 60)} Min.`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} Std.`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} T.`;
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

export function tokens(n?: number): string {
  if (n == null) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")} Mio.`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(".", ",")}k`;
  return String(n);
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** Kurze Wartezeiten: „640 ms“, „1,4 s“, „12 s“. */
export function latency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
  return duration(ms);
}

export function short(value: unknown, max = 400): string {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return s && s.length > max ? `${s.slice(0, max)}…` : (s ?? "");
}

/** Erkennt Befehle, die vermutlich Zugangsdaten enthalten. */
export function looksSecret(cmd: string): boolean {
  return /(sshpass|-p\s*'[^']+'|password|passwd|AUTH=|token=|api[_-]?key|:[^@\s/]{4,}@|-u\s+'?[^'\s]+:[^'\s]+)/i.test(cmd);
}

/** Maskiert offensichtliche Geheimnisse für die Anzeige. */
export function maskSecrets(cmd: string): string {
  return cmd
    .replace(/(sshpass\s+-p\s*)'[^']*'/g, "$1'••••••'")
    .replace(/(sshpass\s+-p\s*)(\S+)/g, "$1••••••")
    .replace(/(-u\s+'?[^:'\s]+:)[^'\s]+/g, "$1••••••")
    .replace(/(AUTH=')[^:']*:[^']*'/g, "$1••••••'")
    .replace(/(echo\s+')[^']+('\s*\|\s*sudo)/g, "$1••••••$2")
    .replace(/((?:password|passwd|token|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1••••••")
    .replace(/(\/\/[^:\s/]+:)[^@\s]+@/g, "$1••••••@");
}
