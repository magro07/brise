import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import * as RTooltip from "@radix-ui/react-tooltip";
import * as RMenu from "@radix-ui/react-dropdown-menu";
import * as RSwitch from "@radix-ui/react-switch";
import { Check } from "lucide-react";

export { clsx };

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }
>(({ variant = "secondary", size = "md", className, ...props }, ref) => (
  <button
    ref={ref}
    className={clsx(
      "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 whitespace-nowrap",
      size === "sm" && "h-7 px-2.5 text-[0.86em]",
      size === "md" && "h-8 px-3 text-[0.93em]",
      size === "lg" && "h-10 px-5 text-[1em]",
      variant === "primary" && "bg-accent text-accent-fg hover:brightness-110 shadow-soft",
      variant === "secondary" && "border border-line bg-elev text-fg hover:bg-hover",
      variant === "ghost" && "text-fg-2 hover:bg-hover hover:text-fg",
      variant === "subtle" && "bg-hover text-fg hover:bg-active",
      variant === "danger" && "border border-line bg-elev text-bad hover:bg-bad-soft hover:border-bad/40",
      className,
    )}
    {...props}
  />
));

export function Tip({ label, children, side = "bottom" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <RTooltip.Root delayDuration={400}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-md bg-fg px-2 py-1 text-[12px] text-bg shadow-pop fade-in max-w-xs"
        >
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: "sm" | "md" }
>(({ label, active, size = "md", className, children, ...props }, ref) => (
  <Tip label={label}>
    <button
      ref={ref}
      aria-label={label}
      className={clsx(
        "inline-flex items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40",
        size === "md" ? "h-8 w-8" : "h-6 w-6",
        active && "bg-active text-fg",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  </Tip>
));

export const TooltipProvider = RTooltip.Provider;

export const Menu = RMenu.Root;
export const MenuTrigger = RMenu.Trigger;

export function MenuContent({ children, align = "start", side = "bottom", className }: { children: ReactNode; align?: "start" | "end" | "center"; side?: "top" | "bottom"; className?: string }) {
  return (
    <RMenu.Portal>
      <RMenu.Content
        align={align}
        side={side}
        sideOffset={6}
        className={clsx("z-50 min-w-[200px] rounded-xl border border-line bg-elev p-1 shadow-pop fade-in", className)}
      >
        {children}
      </RMenu.Content>
    </RMenu.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  icon,
  danger,
  checked,
  hint,
  description,
}: {
  children: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  danger?: boolean;
  checked?: boolean;
  hint?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <RMenu.Item
      onSelect={onSelect}
      className={clsx(
        "flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-[0.93em] outline-none data-[highlighted]:bg-hover",
        danger ? "text-bad" : "text-fg",
      )}
    >
      {icon && <span className="mt-[3px] text-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
      <span className="flex-1">
        <span className="block">{children}</span>
        {description && <span className="block text-[0.86em] text-muted">{description}</span>}
      </span>
      {hint && <span className="mt-[2px] text-[0.82em] text-muted">{hint}</span>}
      {checked !== undefined && <Check className={clsx("mt-[3px] h-4 w-4", checked ? "text-accent" : "invisible")} />}
    </RMenu.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <RMenu.Label className="px-2.5 pb-1 pt-2 text-[0.78em] font-medium uppercase tracking-wide text-muted">{children}</RMenu.Label>;
}

export const MenuSeparator = () => <RMenu.Separator className="my-1 h-px bg-line" />;

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-40"
    >
      <RSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </RSwitch.Root>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-panel px-1.5 py-px font-sans text-[0.75em] text-muted">{children}</kbd>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={clsx("h-3.5 w-3.5 animate-spin", className)} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="brise-g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#3d6ef0" />
          <stop offset="1" stopColor="#18b6a4" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#brise-g)" />
      <path
        d="M14 24c10-6 20 6 30 0s8-4 8-4M12 34c12-6 22 6 34 0M16 44c8-4 16 4 24 0"
        stroke="#fff"
        strokeWidth="4.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Kreisförmige Kontextanzeige (belegt / Fenster). */
export function Ring({ value, size = 18, stroke = 2.5 }: { value: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  const color = v > 0.85 ? "var(--bad)" : v > 0.65 ? "var(--warn)" : "var(--accent)";
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--line-strong)" strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={stroke}
        fill="none"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v)}
        strokeLinecap="round"
      />
    </svg>
  );
}
