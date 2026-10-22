import {
  ButtonHTMLAttributes, CSSProperties, Fragment, ReactNode, forwardRef,
  useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";

export const STATUS_COLORS: Record<string, string> = {
  PASS: "bg-signal-good/10 text-signal-good ring-1 ring-signal-good/30",
  WARN: "bg-signal-warn/10 text-signal-warn ring-1 ring-signal-warn/30",
  FAIL: "bg-signal-bad/10 text-signal-bad ring-1 ring-signal-bad/30",
  RESOLVED: "bg-signal-good/10 text-signal-good ring-1 ring-signal-good/30",
  APPROVED: "bg-signal-good/10 text-signal-good ring-1 ring-signal-good/30",
  PROPOSED: "bg-black/[0.04] text-fg-muted ring-1 ring-line",
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function Card({
  title, subtitle, action, children, className = "", tone = "default", fill = false,
}: {
  title?: ReactNode;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  tone?: "default" | "quiet";
  /** Stretch the body to the card's height so charts can fill the tile. */
  fill?: boolean;
}) {
  const shell = tone === "quiet"
    ? "rounded-2xl glass ring-1 ring-line"
    : "tile ring-1 ring-line";
  return (
    <section className={cn(shell, fill && "flex flex-col", className)}>
      {(title || action) && (
        <div className="px-5 py-4 border-b border-line flex items-center justify-between gap-3">
          <div className="min-w-0">
            {title && (
              <h2 className={tone === "quiet" ? "text-base font-semibold text-fg" : "text-lg font-semibold text-fg"}>
                {title}
              </h2>
            )}
            {subtitle && <p className="text-[11px] text-fg-subtle mt-0.5">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {fill ? <div className="flex-1 min-h-0 flex flex-col">{children}</div> : children}
    </section>
  );
}

/** Collapsible section for progressive disclosure. Set `collapsible={false}` to
 * render a permanently-open section with no toggle. */
export function Section({
  title, subtitle, count, action, defaultOpen = false, collapsible = true,
  tone = "quiet", children, className = "",
}: {
  title: string;
  subtitle?: string;
  count?: number | string;
  action?: ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
  tone?: "default" | "quiet";
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = collapsible ? open : true;
  const shell = tone === "quiet"
    ? "rounded-2xl glass ring-1 ring-line"
    : "tile ring-1 ring-line";
  const titleText = (
    <span className={tone === "quiet" ? "text-base font-semibold text-fg" : "text-lg font-semibold text-fg"}>
      {title}{" "}
      {subtitle && <span className="text-fg-subtle font-normal">{subtitle}</span>}
    </span>
  );
  return (
    <section className={`${shell} ${className}`}>
      <div className="px-5 py-3.5 flex items-center justify-between gap-3">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex items-center gap-2 text-left min-w-0"
          >
            <span className="text-fg-subtle text-xs w-3 shrink-0">{open ? "▾" : "▸"}</span>
            {titleText}
            {count !== undefined && count !== "" && (
              <span className="text-xs text-fg-subtle num">{count}</span>
            )}
          </button>
        ) : (
          <div className="flex items-center gap-2 min-w-0">
            {titleText}
            {count !== undefined && count !== "" && (
              <span className="text-xs text-fg-subtle num">{count}</span>
            )}
          </div>
        )}
        {action}
      </div>
      {isOpen && <div className="border-t border-line">{children}</div>}
    </section>
  );
}

/** Muted metadata line ("id · type · source"). */
export function MetaLine({ parts, className = "" }: { parts: (string | null | undefined)[]; className?: string }) {
  const shown = parts.filter((p): p is string => !!p);
  if (shown.length === 0) return null;
  return (
    <div className={`text-xs text-fg-subtle font-mono ${className}`}>{shown.join(" · ")}</div>
  );
}

export function Pill({ value, className }: { value: string; className?: string }) {
  const tone = className ?? STATUS_COLORS[value] ?? "bg-black/[0.04] text-fg-muted ring-1 ring-line";
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${tone}`}>{value}</span>
  );
}

const ADJ_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Pending approval", tone: "bg-signal-warn/10 text-signal-warn ring-1 ring-signal-warn/30" },
  approved: { label: "Approved", tone: "bg-signal-good/10 text-signal-good ring-1 ring-signal-good/30" },
  signed_off: { label: "Signed off", tone: "bg-signal-good/10 text-signal-good ring-1 ring-signal-good/30" },
};

/** Status chip for the Accountant -> Controller -> CFO adjustment workflow. */
export function AdjustmentStatusBadge({ status }: { status: string }) {
  const s = ADJ_STATUS[status] ?? { label: status, tone: "bg-black/[0.04] text-fg-muted ring-1 ring-line" };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.tone}`}>{s.label}</span>;
}

export function PageHeading({
  title, lead, eyebrow,
}: {
  title: string;
  lead?: string;
  eyebrow?: string;
}) {
  return (
    <header className="min-w-0">
      {eyebrow && (
        <div className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{eyebrow}</div>
      )}
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
      {lead && <p className="readable-copy mt-1 text-sm text-fg-muted">{lead}</p>}
    </header>
  );
}

/** Single metric component. */
export function Metric({
  label, value, tone = "neutral", size = "lg", className = "",
}: {
  label: string;
  value: number | string;
  tone?: "ok" | "warn" | "fail" | "neutral";
  size?: "sm" | "lg";
  className?: string;
}) {
  const toneClass = {
    ok: "text-signal-good", warn: "text-signal-warn", fail: "text-signal-bad", neutral: "text-fg",
  }[tone];
  const valueSize = size === "lg" ? "text-3xl mt-1" : "text-lg leading-tight";
  return (
    <div className={className}>
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className={`font-bold num ${valueSize} ${toneClass}`}>{value}</div>
    </div>
  );
}

type ButtonVariant = "primary" | "neutral" | "outline";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-600 disabled:opacity-50",
  neutral: "bg-black/[0.06] text-fg hover:bg-black/[0.08] ring-1 ring-line disabled:opacity-50",
  outline: "border border-line text-fg-muted bg-transparent hover:bg-black/[0.04] disabled:opacity-50",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "text-xs px-3 py-1.5",
  md: "text-sm px-4 py-2",
};

export function Button({
  variant = "primary", size = "md", className = "", children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      className={`rounded-lg font-medium transition ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Tiny inline trend line (no chart lib). */
export function Sparkline({
  values, width = 120, height = 32, className = "text-fg-muted",
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const stepX = width / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / span) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = coords[coords.length - 1].split(",");
  return (
    <svg width={width} height={height} className={className} aria-hidden="true">
      <polyline points={coords.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.75"
                strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill="currentColor" />
    </svg>
  );
}

/** Animate a number toward `target` with an ease-out curve. Re-targets smoothly
 *  and respects prefers-reduced-motion by snapping to the final value. */
export function useCountUp(
  target: number, { duration = 700, decimals = 0 }: { duration?: number; decimals?: number } = {},
): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (prefersReducedMotion()) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    const from = displayRef.current;
    const to = target;
    if (from === to) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = from + (to - from) * eased;
      displayRef.current = v;
      setDisplay(v);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else { displayRef.current = to; setDisplay(to); }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, duration]);

  const factor = Math.pow(10, decimals);
  return Math.round(display * factor) / factor;
}

/** Number that counts up to its value on mount and when the value changes. */
export function CountUp({
  value, duration, decimals, className,
}: {
  value: number;
  duration?: number;
  decimals?: number;
  className?: string;
}) {
  const dec = decimals ?? (Number.isInteger(value) ? 0 : 1);
  const v = useCountUp(value, { duration, decimals: dec });
  return (
    <span className={className}>
      {v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}
    </span>
  );
}

/** KPI headline card: value + unit, direction-of-travel delta, optional trend. */
export function KpiCard({
  label, value, unit, delta, better = "lower", trend, footnote, deltaSuffix = "vs last month",
  centered = false,
}: {
  label: string;
  value: number | string;
  unit?: string;
  delta?: number | null;
  better?: "lower" | "higher";
  trend?: number[];
  footnote?: string;
  deltaSuffix?: string;
  centered?: boolean;
}) {
  const good = delta == null ? null : better === "lower" ? delta < 0 : delta > 0;
  const arrow = delta == null || delta === 0 ? "→" : delta > 0 ? "▲" : "▼";
  const deltaTone = good == null ? "text-fg-subtle" : good ? "text-signal-good" : "text-signal-bad";
  return (
    <div className={`tile tile-hover ring-1 ring-line p-5 flex flex-col${centered ? " items-center text-center" : ""}`}>
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className={`flex items-end gap-2 mt-1 ${centered ? "justify-center" : "justify-between"}`}>
        <div className="text-3xl font-bold num text-fg">
          {typeof value === "number" ? <CountUp value={value} /> : value}
          {unit && <span className="text-base font-medium text-fg-subtle ml-1">{unit}</span>}
        </div>
        {trend && trend.length > 1 && (
          <Sparkline values={trend} className={good == null ? "text-fg-subtle" : good ? "text-signal-good" : "text-signal-bad"} />
        )}
      </div>
      <div className={`mt-2 flex items-center gap-2 text-xs ${centered ? "justify-center" : ""}`}>
        {delta != null && (
          <span className={`font-medium ${deltaTone}`}>
            {arrow} {Math.abs(delta)}{unit ? ` ${unit}` : ""} {deltaSuffix}
          </span>
        )}
        {footnote && <span className="text-fg-subtle">{footnote}</span>}
      </div>
    </div>
  );
}

export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}

/** Announces a skeleton region to assistive tech without showing any text. */
export function SkeletonRegion({ label = "Loading", className = "", children }: {
  label?: string; className?: string; children: ReactNode;
}) {
  return (
    <div className={className} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Generic loading placeholder: a few shimmering rows that mimic table content. */
export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="px-5 py-4 space-y-3" aria-hidden="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-4 ${c === 0 ? "w-1/3" : "flex-1"}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Card-shaped placeholder: header bar(s) plus a body that defaults to table rows. */
export function CardSkeleton({ action = false, className = "", children }: {
  action?: boolean; className?: string; children?: ReactNode;
}) {
  return (
    <div className={`tile ring-1 ring-line ${className}`} aria-hidden="true">
      <div className="px-5 py-4 border-b border-line flex items-center justify-between gap-4">
        <Skeleton className="h-4 w-44" />
        {action && <Skeleton className="h-7 w-32 rounded-lg" />}
      </div>
      {children ?? <TableSkeleton rows={5} cols={4} />}
    </div>
  );
}

/** Chart-area placeholder: y-axis ticks, plot block, x-axis ticks.
 *  Pass `aspectRatio` for charts whose SVG scales with width. */
export function ChartSkeleton({ height = 220, aspectRatio }: { height?: number; aspectRatio?: string }) {
  return (
    <div className="p-5" aria-hidden="true">
      <div className="flex gap-3" style={aspectRatio ? { aspectRatio } : { height }}>
        <div className="flex w-10 flex-col justify-between py-1">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-2.5 w-full" />)}
        </div>
        <Skeleton className="flex-1 rounded-lg" />
      </div>
      <div className="ml-[3.25rem] mt-3 flex justify-between">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-2.5 w-10" />)}
      </div>
    </div>
  );
}

const BAR_SKELETON_HEIGHTS = [72, 48, 60, 34, 54, 28, 44, 80, 38, 64];

/** Bridge / waterfall placeholder: vertical bars of varied height over an axis. */
export function BarChartSkeleton({ bars = 8, height = 180 }: { bars?: number; height?: number }) {
  return (
    <div className="p-5" aria-hidden="true">
      <div className="flex items-end gap-3 border-b border-line" style={{ height }}>
        {Array.from({ length: bars }).map((_, i) => (
          <Skeleton key={i} className="flex-1 rounded-b-none" style={{ height: `${BAR_SKELETON_HEIGHTS[i % BAR_SKELETON_HEIGHTS.length]}%` }} />
        ))}
      </div>
      <div className="mt-3 flex gap-3">
        {Array.from({ length: bars }).map((_, i) => <Skeleton key={i} className="h-2.5 flex-1" />)}
      </div>
    </div>
  );
}

/** Horizontal driver bars (label + bar), e.g. attribution tornado or movers list. */
export function HBarSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 py-2" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="grid grid-cols-[8rem_1fr_4rem] items-center gap-3">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-4" style={{ width: `${BAR_SKELETON_HEIGHTS[i % BAR_SKELETON_HEIGHTS.length]}%` }} />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}

/** A row of KPI-tile placeholders (label, value, sub-line). */
export function KpiSkeletonGrid({ count = 4, className = "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4", tileHeight = "h-[118px]" }: {
  count?: number; className?: string; tileHeight?: string;
}) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`tile ring-1 ring-line flex flex-col gap-3 p-5 ${tileHeight}`}>
          <Skeleton className="h-2.5 w-28" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="mt-auto h-2.5 w-36" />
        </div>
      ))}
    </div>
  );
}

/** Paragraph placeholder for narrative / commentary blocks. */
export function TextSkeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2.5 ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-3 ${i === lines - 1 ? "w-3/5" : "w-full"}`} />
      ))}
    </div>
  );
}

/** Fallback page skeleton: KPI row + a card. Prefer a layout-matched skeleton. */
export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <SkeletonRegion label={label} className="space-y-4">
      <KpiSkeletonGrid />
      <CardSkeleton />
    </SkeletonRegion>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div role="alert" className="text-sm bg-signal-bad/10 text-signal-bad rounded-lg px-4 py-3 ring-1 ring-signal-bad/30">
      {message}
    </div>
  );
}

export type SelectOption = {
  value: string;
  label: string;
  /** Optional secondary text shown right-aligned in the menu row. */
  hint?: string;
  /** Optional group heading; consecutive options sharing a group are bucketed. */
  group?: string;
  disabled?: boolean;
};

type SelectMenuPos = {
  width: number;
  horiz: { left: number } | { right: number };
  vert: { top: number } | { bottom: number };
};

function useAnchoredMenu(open: boolean, setOpen: (open: boolean) => void) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<SelectMenuPos | null>(null);

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const placement = spaceBelow < 260 && r.top > spaceBelow ? "up" : "down";
    const alignRight = r.left > window.innerWidth * 0.6;
    setPos({
      width: r.width,
      horiz: alignRight ? { right: window.innerWidth - r.right } : { left: r.left },
      vert: placement === "down" ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 },
    });
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onScroll = () => place();
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place, setOpen]);

  return { btnRef, menuRef, pos };
}

/** Styled dropdown that matches the app's menu language (see TopNav menus).
 *  Drop-in replacement for a native <select>: renders a button trigger plus a
 *  portalled popover so it never gets clipped inside tables, drawers, or modals. */
export const Select = forwardRef<
  HTMLButtonElement,
  {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    size?: "sm" | "md";
    fullWidth?: boolean;
    mono?: boolean;
    className?: string;
    "aria-label"?: string;
  }
>(function Select(
  {
    value, onChange, options, placeholder = "Select…", disabled = false,
    size = "md", fullWidth = false, mono = false, className = "",
    "aria-label": ariaLabel,
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  const { btnRef, menuRef, pos } = useAnchoredMenu(open, setOpen);

  useImperativeHandle(ref, () => btnRef.current as HTMLButtonElement);

  const selected = options.find((o) => o.value === value);
  const groups = Array.from(new Set(options.map((o) => o.group ?? "")));

  const sizeCls = size === "sm" ? "text-xs px-2.5 py-1.5" : "text-sm px-3 py-2";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-2 rounded-lg bg-ink-800 text-fg ring-1 ring-line text-left transition",
          "hover:ring-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          sizeCls,
          fullWidth && "w-full",
          className,
        )}
      >
        <span className={cn("flex-1 truncate", mono && "font-mono", !selected && "text-fg-subtle")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className={cn("w-4 h-4 shrink-0 text-fg-subtle transition-transform", open && "rotate-180")} />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          style={{
            position: "fixed",
            minWidth: pos.width,
            ...pos.horiz,
            ...pos.vert,
          } as CSSProperties}
          className="z-[70] max-h-64 overflow-y-auto bg-ink-800 rounded-xl shadow-depth ring-1 ring-line py-1"
        >
          {groups.map((g) => (
            <Fragment key={g || "_"}>
              {g && <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-fg-subtle">{g}</div>}
              {options.filter((o) => (o.group ?? "") === g).map((o) => {
                const active = o.value === value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    disabled={o.disabled}
                    onClick={() => { onChange(o.value); setOpen(false); }}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition disabled:opacity-40",
                      active ? "text-fg bg-black/[0.04]" : "text-fg-muted hover:bg-black/[0.04]",
                    )}
                  >
                    <Check className={cn("w-3.5 h-3.5 shrink-0", active ? "opacity-100 text-fg" : "opacity-0")} />
                    <span className={cn("flex-1 truncate", mono && "font-mono")}>{o.label}</span>
                    {o.hint && <span className="text-[11px] text-fg-subtle shrink-0">{o.hint}</span>}
                  </button>
                );
              })}
            </Fragment>
          ))}
          {options.length === 0 && <div className="px-3 py-2 text-sm text-fg-subtle">No options</div>}
        </div>,
        document.body,
      )}
    </>
  );
});

/** Multi-choice variant of `Select`: same trigger and menu, but rows toggle and
 *  the menu stays open. The first row selects every option. */
export function MultiSelect({
  values, onChange, options, allLabel, size = "md", className = "",
  "aria-label": ariaLabel,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  options: SelectOption[];
  allLabel: string;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const { btnRef, menuRef, pos } = useAnchoredMenu(open, setOpen);
  const all = options.length > 0 && options.every((o) => values.includes(o.value));
  const summary = all
    ? allLabel
    : options.filter((o) => values.includes(o.value)).map((o) => o.label).join(", ") || allLabel;
  const toggle = (value: string) => {
    if (all) return onChange([value]);
    const next = values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
    if (next.length) onChange(options.map((o) => o.value).filter((v) => next.includes(v)));
  };
  const row = (key: string, label: string, active: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition",
        active ? "text-fg bg-black/[0.04]" : "text-fg-muted hover:bg-black/[0.04]",
      )}
    >
      <Check className={cn("w-3.5 h-3.5 shrink-0", active ? "opacity-100 text-fg" : "opacity-0")} />
      <span className="flex-1 truncate">{label}</span>
    </button>
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-2 rounded-lg bg-ink-800 text-fg ring-1 ring-line text-left transition",
          "hover:ring-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          size === "sm" ? "text-xs px-2.5 py-1.5" : "text-sm px-3 py-2",
          className,
        )}
      >
        <span className="flex-1 truncate">{summary}</span>
        <ChevronDown className={cn("w-4 h-4 shrink-0 text-fg-subtle transition-transform", open && "rotate-180")} />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-multiselectable="true"
          style={{ position: "fixed", minWidth: pos.width, ...pos.horiz, ...pos.vert } as CSSProperties}
          className="z-[70] max-h-64 overflow-y-auto bg-ink-800 rounded-xl shadow-depth ring-1 ring-line py-1"
        >
          {row("__all", allLabel, all, () => onChange(options.map((o) => o.value)))}
          {options.map((o) => row(o.value, o.label, !all && values.includes(o.value), () => toggle(o.value)))}
        </div>,
        document.body,
      )}
    </>
  );
}
