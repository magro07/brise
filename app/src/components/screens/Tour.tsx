import { useEffect, useLayoutEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useStore } from "../../lib/store";
import { shortcut } from "../../lib/platform";
import { Button, Logo } from "../ui";

interface Step {
  target?: string;
  title: string;
  text: string;
}

const STEPS: Step[] = [
  {
    title: "Willkommen bei Brise",
    text: "Eine kurze Tour durch die wichtigsten Stellen – dauert eine Minute. Du kannst sie jederzeit über die Befehlspalette neu starten.",
  },
  {
    target: '[data-brise="sidebar"]',
    title: "Projekte und Sessions",
    text: "Links stehen deine Projekte mit allen Sessions. Über das Ordner-Symbol legst du neue Projekte an oder öffnest vorhandene Ordner.",
  },
  {
    target: '[data-brise="composer"]',
    title: "Aufgabe beschreiben",
    text: "Schreib hier, was der Agent tun soll. Mit @ hängst du Dateien an, mit / rufst du Befehle und Skills auf (z. B. /deep-research). Das Mikrofon startet die Spracheingabe.",
  },
  {
    target: '[data-tour="mode"]',
    title: "Freigaben",
    text: "Bestimmt, wann der Agent nachfragt: bei allem, nur bei Befehlen oder gar nicht. Freigaben erscheinen direkt über dem Eingabefeld.",
  },
  {
    target: '[data-tour="model"]',
    title: "Auto-Modellwahl",
    text: "Mit Mistral Vibe stuft „Auto“ jede Aufgabe ein und nimmt das passende Modell – klein und schnell für Einfaches, Large 4 für Komplexes. Claude Code, Codex und Gemini bringen ihre eigene Modellwahl mit.",
  },
  {
    target: '[data-brise="header"]',
    title: "Werkzeuge",
    text: `Oben rechts: Änderungen, Kontext-Aufschlüsselung, Subagents, Aufgaben, Suche, Git, Dateien mit Editor und das Terminal (${shortcut("ö")}).`,
  },
  {
    target: '[data-tour="settings"]',
    title: "Einstellungen – oder einfach fragen",
    text: "Modelle, Skills, Websuche, Sprache und mehr findest du in den Einstellungen. Oder sag es dem Agenten im Chat: „Mach Brise orange und die Schrift größer.“",
  },
  {
    title: "Los geht’s",
    text: `${shortcut("K")} findet Sessions, Projekte und Befehle. Viel Spaß mit Brise!`,
  },
];

export function Tour() {
  const step = useStore((s) => s.tourStep);
  const set = useStore((s) => s.set);
  const setPrefs = useStore((s) => s.setPrefs);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const current = step != null ? STEPS[step] : null;

  useLayoutEffect(() => {
    if (!current?.target) return setRect(null);
    const update = () => setRect(document.querySelector(current.target!)?.getBoundingClientRect() ?? null);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [step]);

  if (step == null || !current) return null;
  const finish = () => {
    set({ tourStep: null });
    setPrefs({ tourDone: true });
  };
  const last = step === STEPS.length - 1;

  // Karte neben dem hervorgehobenen Bereich platzieren.
  const card: React.CSSProperties = { width: 340 };
  if (rect) {
    const spaceRight = window.innerWidth - rect.right;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceRight > 380) Object.assign(card, { left: rect.right + 16, top: Math.min(Math.max(16, rect.top), window.innerHeight - 260) });
    else if (spaceBelow > 240) Object.assign(card, { top: rect.bottom + 14, left: Math.min(Math.max(16, rect.left), window.innerWidth - 360) });
    else Object.assign(card, { top: Math.max(16, rect.top - 230), left: Math.min(Math.max(16, rect.left), window.innerWidth - 360) });
  } else {
    Object.assign(card, { left: "50%", top: "50%", transform: "translate(-50%, -50%)" });
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && finish()}>
      <Dialog.Portal>
        {rect ? (
          <div
            className="pointer-events-none fixed z-40 rounded-xl transition-all duration-300"
            style={{
              left: rect.left - 6,
              top: rect.top - 6,
              width: rect.width + 12,
              height: rect.height + 12,
              boxShadow: "0 0 0 2px var(--accent), 0 0 0 9999px rgb(0 0 0 / 0.45)",
            }}
          />
        ) : (
          <div className="fixed inset-0 z-40 bg-black/45" />
        )}
        <Dialog.Content
          className="fixed z-50 rounded-2xl border border-line bg-elev p-5 shadow-pop fade-in"
          style={card}
          key={step}
          onInteractOutside={(e) => e.preventDefault()}
        >
          {!rect && (
            <div className="mb-3">
              <Logo size={36} />
            </div>
          )}
          <Dialog.Title className="font-semibold">{current.title}</Dialog.Title>
          <Dialog.Description className="mt-1.5 text-[0.92em] text-fg-2">{current.text}</Dialog.Description>
          <div className="mt-4 flex items-center gap-2">
            <div className="flex gap-1">
              {STEPS.map((_, i) => (
                <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? "w-4 bg-accent" : "w-1.5 bg-line-strong"}`} />
              ))}
            </div>
            <div className="flex-1" />
            {!last && (
              <Button variant="ghost" size="sm" onClick={finish}>
                Überspringen
              </Button>
            )}
            {step > 0 && (
              <Button size="sm" onClick={() => set({ tourStep: step - 1 })}>
                Zurück
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={() => (last ? finish() : set({ tourStep: step + 1 }))}>
              {last ? "Fertig" : "Weiter"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Eigener Texteingabe-Dialog (window.prompt geht im macOS-WebView nicht). */
export function TextPrompt() {
  const prompt = useStore((s) => s.textPrompt);
  const [value, setValue] = useState("");
  useEffect(() => setValue(""), [prompt]);
  if (!prompt) return null;
  const close = (v: string | null) => {
    prompt.resolve(v);
    useStore.setState({ textPrompt: null });
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && close(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <Dialog.Content className="fixed left-1/2 top-[24%] z-50 w-[min(420px,92vw)] -translate-x-1/2 rounded-2xl border border-line bg-elev p-5 shadow-pop fade-in">
          <Dialog.Title className="font-semibold">{prompt.title}</Dialog.Title>
          <input
            autoFocus
            value={value}
            placeholder={prompt.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && value.trim() && close(value)}
            className="mt-3 h-10 w-full rounded-lg border border-line bg-bg px-3 font-mono text-[0.92em] outline-none focus:border-accent"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => close(null)}>
              Abbrechen
            </Button>
            <Button variant="primary" disabled={!value.trim()} onClick={() => close(value)}>
              OK
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
