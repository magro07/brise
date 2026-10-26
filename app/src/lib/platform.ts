/** Tastenkürzel passend zum System anzeigen: ⌘K auf dem Mac, Strg+K sonst. */
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

export const shortcut = (key: string) => (IS_MAC ? `⌘${key}` : `Strg+${key}`);
