import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Camera, Trash2 } from "lucide-react";
import { AVATAR_COLORS, initials, shrinkImage, useProfile } from "../../lib/profile";
import { Button, Spinner, clsx } from "../ui";

/** Avatar: Bild oder Initialen auf der Kontofarbe. */
export function Avatar({ name, color, avatar, size = 28, className }: { name: string; color?: string; avatar?: string | null; size?: number; className?: string }) {
  return (
    <span
      className={clsx("relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white", className)}
      style={{ width: size, height: size, background: color || AVATAR_COLORS[0], fontSize: size * 0.38 }}
      aria-hidden
    >
      {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : initials(name)}
    </span>
  );
}

const INPUT = "h-9 w-full rounded-lg border border-line bg-bg px-3 text-[0.92em] outline-none focus:border-accent";

/** „Konto anlegen“ beim ersten Start bzw. „Konto bearbeiten“ aus dem Menü unten links. */
export function ProfileDialog() {
  const { dialog, profile, git, save, skip } = useProfile();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [color, setColor] = useState(AVATAR_COLORS[0]);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [useForCommits, setUseForCommits] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!dialog) return;
    setName(profile?.name ?? git.name ?? "");
    setEmail(profile?.email ?? git.email ?? "");
    setColor(profile?.color || AVATAR_COLORS[0]);
    setAvatar(profile?.avatar ?? null);
    setUseForCommits(profile?.useForCommits ?? false);
    setError(null);
  }, [dialog]);

  if (!dialog) return null;
  const creating = dialog === "create";
  const close = () => (creating ? skip() : useProfile.setState({ dialog: null }));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await save({ name, email, color, avatar, useForCommits });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-[14%] z-50 w-[min(460px,92vw)] -translate-x-1/2 rounded-2xl border border-line bg-elev p-6 shadow-pop fade-in" data-testid="profile-dialog">
          <Dialog.Title className="text-[1.25em] font-semibold tracking-tight">{creating ? "Konto anlegen" : "Konto bearbeiten"}</Dialog.Title>
          <Dialog.Description className="mt-1 text-[0.9em] text-fg-2">
            {creating
              ? "Dein Konto in Brise – nur auf diesem Rechner, ohne Server. Danach verbindest du Agenten (Vibe, Claude Code, Codex, Gemini) und API-Schlüssel."
              : "So erscheinst du unten links, in Teams, geteilten Sessions und im Audit-Log."}
          </Dialog.Description>

          <div className="mt-5 flex items-center gap-4">
            <button className="group relative" onClick={() => file.current?.click()} title="Bild wählen" type="button">
              <Avatar name={name || "?"} color={color} avatar={avatar} size={64} />
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100">
                <Camera className="h-5 w-5" />
              </span>
            </button>
            <input
              ref={file}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setAvatar(await shrinkImage(f).catch((err) => (setError(String(err)), null)));
                e.target.value = "";
              }}
            />
            <div className="flex-1">
              <div className="mb-1.5 text-[0.84em] text-muted">Farbe</div>
              <div className="flex flex-wrap items-center gap-1.5">
                {AVATAR_COLORS.map((c) => (
                  <button key={c} type="button" onClick={() => setColor(c)} className={clsx("h-6 w-6 rounded-full border-2", color === c ? "border-fg" : "border-transparent")} style={{ background: c }} aria-label={`Farbe ${c}`} />
                ))}
                {avatar && (
                  <button type="button" className="ml-1 text-muted hover:text-bad" onClick={() => setAvatar(null)} title="Bild entfernen">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>

          <label className="mt-4 block text-[0.86em] font-medium">
            Name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && submit()} placeholder="z. B. Max" className={clsx(INPUT, "mt-1 font-normal")} data-testid="profile-name" />
          </label>
          <label className="mt-3 block text-[0.86em] font-medium">
            E-Mail <span className="font-normal text-muted">(optional)</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="für Commits und Teams" className={clsx(INPUT, "mt-1 font-normal")} data-testid="profile-email" />
          </label>
          {(git.name || git.email) && (
            <div className="mt-1.5 text-[0.8em] text-muted">
              Vorschlag aus deiner Git-Konfiguration: {[git.name, git.email].filter(Boolean).join(" · ")}
            </div>
          )}
          <label className="mt-3 flex items-start gap-2 text-[0.88em]">
            <input type="checkbox" checked={useForCommits} onChange={(e) => setUseForCommits(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
            <span>
              Als Git-Autor für Commits aus Brise verwenden
              <span className="block text-[0.9em] text-muted">Sonst gilt deine Git-Konfiguration.</span>
            </span>
          </label>

          {error && <div className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-[0.86em] text-bad selectable">{error}</div>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={close} data-testid="profile-later">
              {creating ? "Später" : "Abbrechen"}
            </Button>
            <Button variant="primary" disabled={!name.trim() || busy} onClick={submit} data-testid="profile-save">
              {busy && <Spinner />} {creating ? "Konto anlegen" : "Speichern"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
