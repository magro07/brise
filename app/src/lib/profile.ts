import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * Brise-Konto (profile.rs): die eigene Identität in Brise – lokal, ohne
 * zentralen Server. Name und Farbe erscheinen unten links, in Teams,
 * geteilten Sessions, beim Gastzugang und im Audit-Log.
 */
export interface Profile {
  name: string;
  email: string;
  color: string;
  /** Data-URL eines kleinen Bildes, sonst Initialen. */
  avatar: string | null;
  useForCommits: boolean;
  createdAt: number;
}

interface ProfileState {
  profile: Profile | null;
  skipped: boolean;
  /** Vorschlag aus `git config --global`. */
  git: { name: string | null; email: string | null };
  loaded: boolean;
  /** Dialog offen: "create" beim Start, "edit" aus dem Menü. */
  dialog: "create" | "edit" | null;
  load(): Promise<void>;
  save(p: Omit<Profile, "createdAt">): Promise<Profile>;
  skip(): Promise<void>;
}

export const AVATAR_COLORS = ["#3d6ef0", "#18b6a4", "#7048e8", "#d6336c", "#e8590c", "#2f9e44", "#0c8599", "#868e96"];

export const useProfile = create<ProfileState>((set, get) => ({
  profile: null,
  skipped: false,
  git: { name: null, email: null },
  loaded: false,
  dialog: null,
  async load() {
    const r = await invoke<{ profile: Profile | null; skipped: boolean; git: { name: string | null; email: string | null } }>("profile_get").catch(() => null);
    if (!r) return set({ loaded: true });
    set({ profile: r.profile, skipped: r.skipped, git: r.git, loaded: true, dialog: !r.profile && !r.skipped && !get().dialog ? "create" : get().dialog });
  },
  async save(p) {
    const profile = await invoke<Profile>("profile_save", { profile: { ...p, createdAt: get().profile?.createdAt ?? 0 } });
    set({ profile, skipped: false, dialog: null });
    return profile;
  },
  async skip() {
    await invoke("profile_skip").catch(() => {});
    set({ skipped: true, dialog: null });
  },
}));

/** Initialen aus dem Namen (höchstens zwei Buchstaben). */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Name für Teams, geteilte Sessions und Gastzugang. */
export function displayName(fallback: string) {
  return useProfile.getState().profile?.name.trim() || fallback;
}

/** Bild verkleinern (128 px, quadratisch zugeschnitten) und als Data-URL liefern. */
export function shrinkImage(file: File, size = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Kein Canvas"));
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.86));
    };
    img.onerror = () => reject(new Error("Bild nicht lesbar"));
    img.src = URL.createObjectURL(file);
  });
}
