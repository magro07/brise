import { useEffect, useState } from "react";
import { modelsOf, refLabel, splitRef, useProviders, type ProviderView } from "../../lib/providers";
import { clsx } from "../ui";

const SELECT = "h-8 min-w-[240px] max-w-[320px] rounded-lg border border-line bg-elev px-2 text-[0.92em] outline-none focus:border-accent disabled:opacity-50";

/**
 * Modellwahl aus allen Anbietern mit Schlüssel (gruppiert), plus freie Eingabe
 * „anbieter/modell“. `only` schränkt die Anbieter ein (z. B. nur ohne
 * Datenspeicherung), `extra` ergänzt Modelle je Anbieter (z. B. Cortecs-Decision-Modelle).
 */
export function ModelSelect({
  value,
  onChange,
  kind = "chat",
  emptyLabel,
  only,
  extra,
  disabled,
  className,
  testId,
}: {
  value: string;
  onChange: (ref: string) => void;
  kind?: "chat" | "embed";
  /** Eintrag für „kein Modell“ (Wert ""). */
  emptyLabel?: string;
  only?: (p: ProviderView) => boolean;
  extra?: Record<string, string[]>;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const list = useProviders((s) => s.list);
  const loaded = useProviders((s) => s.loaded);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (!loaded) useProviders.getState().refresh();
  }, [loaded]);

  const providers = list.filter((p) => p.usable && (!only || only(p)));
  const groups = providers.map((p) => ({ p, models: [...new Set([...(extra?.[p.id] ?? []), ...modelsOf(p, kind)])] })).filter((g) => g.models.length);
  const known = groups.some((g) => g.models.some((m) => `${g.p.id}/${m}` === value));
  const { provider } = splitRef(value, list);
  const missing = value && !known;

  if (custom) {
    return (
      <input
        autoFocus
        value={draft}
        placeholder="anbieter/modell, z. B. ollama/qwen3:8b"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft.trim()) onChange(draft.trim());
          setCustom(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setCustom(false);
        }}
        className={clsx(SELECT, "font-mono", className)}
        data-testid={testId ? `${testId}-custom` : undefined}
      />
    );
  }
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value === "__custom") {
          setDraft(value);
          setCustom(true);
        } else onChange(e.target.value);
      }}
      className={clsx(SELECT, className)}
      data-testid={testId}
    >
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {missing && (
        <option value={value}>
          {refLabel(value, list)}
          {provider?.usable ? "" : " (kein Schlüssel)"}
        </option>
      )}
      {groups.map(({ p, models }) => (
        <optgroup key={p.id} label={p.name}>
          {models.map((m) => (
            <option key={m} value={`${p.id}/${m}`}>
              {m} · {p.name}
            </option>
          ))}
        </optgroup>
      ))}
      {!groups.length && emptyLabel === undefined && <option value={value}>Kein Anbieter mit Schlüssel</option>}
      <option value="__custom">Anderes Modell eingeben …</option>
    </select>
  );
}
