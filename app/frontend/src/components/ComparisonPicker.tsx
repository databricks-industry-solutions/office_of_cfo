import { Window, CompareMode } from "../api";
import { Select } from "./ui";

// A single dropdown that replaces the old two-axis "Time window × Compare with"
// pill rows. It lists only the *valid, whole* comparisons for a statement as
// plain-English sentences ("This month vs. last month"), grouped by timeframe.
// The backend contract is unchanged — the picker still resolves to a
// (window, compare) pair; it's purely a friendlier presentation of the same
// state, and it makes the old greying / silent-remap rules disappear because
// invalid combinations never appear as options.
//
//   income  → windowed (MTD/QTD/YTD), Budget compare allowed
//   flow    → windowed, no Budget (Cash Flow, COGS bridge — no plan basis)
//   balance → as-of position: window collapses to period-end, no Budget
export type ComparisonKind = "income" | "flow" | "balance";

export type Preset = { window: Window; compare: CompareMode; group: string; label: string };

const WMETA: Record<Window, { group: string; prefix: string; prior: string; priorYear: string }> = {
  mtd: { group: "Month",   prefix: "This month",      prior: "vs. last month",    priorYear: "vs. same month last year" },
  qtd: { group: "Quarter", prefix: "Quarter to date", prior: "vs. last quarter",  priorYear: "vs. same quarter last year" },
  // YTD has no clean sequential prior period, so it never offers "vs. prior".
  ytd: { group: "Year",    prefix: "Year to date",    prior: "",                  priorYear: "vs. last year" },
};

// The list of valid comparisons for a statement, in display order.
export function comparisonPresets(kind: ComparisonKind): Preset[] {
  if (kind === "balance") {
    // As-of stock: every window is the same period-end position, so we don't
    // accumulate. Only prior period / prior year make sense; no budget.
    return [
      { window: "mtd", compare: "prior",      group: "As of period end", label: "vs. last month" },
      { window: "mtd", compare: "prior_year", group: "As of period end", label: "vs. same month last year" },
    ];
  }
  const out: Preset[] = [];
  (["mtd", "qtd", "ytd"] as Window[]).forEach((w) => {
    const m = WMETA[w];
    if (w !== "ytd") out.push({ window: w, compare: "prior", group: m.group, label: `${m.prefix} ${m.prior}` });
    out.push({ window: w, compare: "prior_year", group: m.group, label: `${m.prefix} ${m.priorYear}` });
    if (kind === "income") out.push({ window: w, compare: "budget", group: m.group, label: `${m.prefix} vs. budget` });
    if (kind === "income") out.push({ window: w, compare: "scenario", group: m.group, label: `${m.prefix} vs. official forecast` });
  });
  return out;
}

// Snap an arbitrary (window, compare) — e.g. a selection carried over when the
// user switches statements — to the nearest valid preset for the new kind.
// Mirrors the backend's resolve_window_compare so the picker shows exactly what
// the data reflects.
export function clampComparison(kind: ComparisonKind, window: Window, compare: CompareMode): { window: Window; compare: CompareMode } {
  const presets = comparisonPresets(kind);
  if (presets.some((p) => p.window === window && p.compare === compare)) return { window, compare };
  const w: Window = kind === "balance" ? "mtd" : window;
  let c: CompareMode = compare;
  if ((c === "budget" || c === "scenario") && kind !== "income") c = "prior"; // income-only compares
  if (c === "prior" && w === "ytd") c = "prior_year";        // YTD has no sequential prior
  return presets.some((p) => p.window === w && p.compare === c)
    ? { window: w, compare: c }
    : { window: presets[0].window, compare: presets[0].compare };
}

export function ComparisonPicker({
  kind, window, compare, onChange, className,
}: {
  kind: ComparisonKind;
  window: Window;
  compare: CompareMode;
  onChange: (window: Window, compare: CompareMode) => void;
  className?: string;
}) {
  const presets = comparisonPresets(kind);
  const eff = clampComparison(kind, window, compare);
  const value = `${eff.window}:${eff.compare}`;

  // The custom Select buckets consecutive options by `group`; presets are
  // already emitted in group order (Month → Quarter → Year / As of period end),
  // so the timeframe headings render without a manual grouping pass. Using the
  // app's Select (not a native <select>) keeps the menu on the design tokens —
  // notably it reads correctly in dark mode.
  const options = presets.map((p) => ({
    value: `${p.window}:${p.compare}`,
    label: p.label,
    group: p.group,
  }));

  return (
    <Select
      aria-label="Comparison"
      value={value}
      onChange={(v) => {
        const [w, c] = v.split(":");
        onChange(w as Window, c as CompareMode);
      }}
      options={options}
      size="sm"
      className={className}
    />
  );
}
