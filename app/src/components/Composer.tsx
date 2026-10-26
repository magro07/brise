import { useEffect, useRef, useState } from "react";

export function Composer({
  running,
  disabled,
  placeholder,
  onSend,
  onStop,
}: {
  running: boolean;
  disabled?: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Mit dem Inhalt wachsen, bis zu einer Höchstgröße.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    if (!running) ref.current?.focus();
  }, [running]);

  const send = () => {
    const t = text.trim();
    if (!t || running || disabled) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
          if (e.key === "Escape" && running) onStop();
        }}
      />
      {running ? (
        <button className="btn btn-stop" onClick={onStop} title="Abbrechen (Esc)">
          ■ Stopp
        </button>
      ) : (
        <button className="btn btn-primary" onClick={send} disabled={!text.trim() || disabled} title="Senden (Enter)">
          Senden
        </button>
      )}
    </div>
  );
}
