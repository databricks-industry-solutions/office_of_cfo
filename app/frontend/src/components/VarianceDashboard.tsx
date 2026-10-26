import { useEffect, useMemo, useState } from "react";
import { api, fmtCompact, fmtSignedCompact, Window, CompareMode, Scope, VarianceDriver, CogsBridge } from "../api";
import { BarChartSkeleton, Card, HBarSkeleton, Select, SkeletonRegion } from "./ui";
import CogsBridgeView from "./CogsBridgeView";
import { CHART_AXIS_TEXT_PIXEL, CHART_COLORS as COLORS } from "../lib/chartPalette";
import { useChartSize } from "../lib/useChartSize";
import type { DisplayRow } from "../pages/ComparativeStatements";

// Sentinel for the "let the endpoint auto-pick the biggest mover" selector entry.
const AUTO = "__auto__";

const fmtPct = (v: number | null): string =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

// Favourable = the movement helped the business (revenue up / expense down). Uses
// the same favorableWhenUp flag the table rows already carry.
function favorable(r: { varAbs: number | null; favorableWhenUp?: boolean }): boolean | null {
  if (r.varAbs == null || r.varAbs === 0) return null;
  return r.favorableWhenUp ? r.varAbs > 0 : r.varAbs < 0;
}
const toneClass = (fav: boolean | null): string =>
  fav == null ? "text-fg-subtle" : fav ? "text-signal-good" : "text-signal-bad";

/* --------------------------------------------------------------------------
 * 1. KPI variance tiles — the total/subtotal rows with their variance.
 * ------------------------------------------------------------------------ */
function KpiTiles({ rows }: { rows: DisplayRow[] }) {
  const tiles = rows.filter((r) => r.kind === "total" || r.kind === "subtotal");
  if (tiles.length === 0) return null;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {tiles.map((r) => {
        const fav = favorable(r);
        return (
          <div key={r.key} className="tile ring-1 ring-line p-4">
            <div className="text-[11px] uppercase tracking-wide text-fg-subtle truncate">{r.label}</div>
            <div className="text-2xl font-bold num text-fg mt-1">{fmtCompact(r.actual ?? 0)}</div>
            <div className={`mt-1.5 text-xs font-medium ${toneClass(fav)}`}>
              {r.varAbs == null ? "—" : (
                <>
                  {fav == null ? "→" : r.varAbs > 0 ? "▲" : "▼"} {fmtSignedCompact(r.varAbs)}
                  {r.varPct != null && <span className="text-fg-subtle font-normal"> · {fmtPct(r.varPct)}</span>}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * 2. Variance bridge (waterfall): compare-period total → per-line steps →
 *    actual total. Only rendered when the steps reconcile to the total delta
 *    (income: line rows sum to net income; cash flow: section subtotals sum to
 *    net change). Otherwise the caller shows the grouped-bar fallback.
 * ------------------------------------------------------------------------ */
interface BridgeModel {
  targetKey: string;
  anchorLabel: string; endLabel: string;
  anchor: number; end: number;
  steps: { label: string; delta: number; fav: boolean | null }[];
}

// The factors that can be shown as a reconciling walk — the subtotals and the
// grand total, in display order. A single line isn't offered here: it has no
// P&L sub-components, so its decomposition is by driver (the "What drove it"
// tornado below), not a walk.
function bridgeFactors(rows: DisplayRow[]): DisplayRow[] {
  return rows.filter((r) => (r.kind === "subtotal" || r.kind === "total") && r.compare != null && r.actual != null);
}

// The component lines that make up a chosen factor, IF they reconcile to its
// variance (else null — we never draw a bridge that doesn't tie out):
//  - income (no sections): every line above the factor rolls into it
//    (Revenue, COGS → Gross Profit; + OpEx → Operating Income / Net Income).
//  - sectioned (cash flow): a section subtotal decomposes into that section's
//    lines; the grand total decomposes into the section subtotals.
function componentSteps(rows: DisplayRow[], target: DisplayRow): DisplayRow[] | null {
  const targetVar = (target.actual ?? 0) - (target.compare ?? 0);
  const tol = Math.max(Math.abs(targetVar) * 0.01, 1); // 1% or $1 tolerance
  const hasSections = rows.some((r) => r.kind === "section");
  const idx = rows.indexOf(target);

  let cand: DisplayRow[];
  if (!hasSections) {
    cand = rows.filter((r, i) => r.kind === "line" && i < idx && r.varAbs != null);
  } else if (target.kind === "total") {
    cand = rows.filter((r) => r.kind === "subtotal" && r.varAbs != null);
  } else {
    const section = target.key.replace(/^total-/, "");
    cand = rows.filter((r) => r.kind === "line" && r.key.startsWith(`${section}-`) && r.varAbs != null);
  }
  if (cand.length === 0) return null;
  const sum = cand.reduce((s, r) => s + (r.varAbs ?? 0), 0);
  return Math.abs(sum - targetVar) <= tol ? cand : null;
}

// Build the reconciling waterfall for a chosen factor. Defaults to the grand
// total (the original Net Income walk). `excludeGrandTotal` drops the total from
// the choices and defaults to the first subtotal — used on the balance sheet,
// where the grand total ("Total Liabilities & Equity") sums both sides of the
// sheet and so double-counts; only the section-level walks are meaningful there.
function buildBridge(rows: DisplayRow[], targetKey?: string, excludeGrandTotal = false): BridgeModel | null {
  let factors = bridgeFactors(rows);
  if (excludeGrandTotal) factors = factors.filter((f) => f.kind !== "total");
  if (factors.length === 0) return null;
  const target =
    (targetKey ? factors.find((f) => f.key === targetKey) : undefined) ??
    (excludeGrandTotal ? factors[0] : factors.find((f) => f.kind === "total")) ??
    factors[factors.length - 1];
  const steps = componentSteps(rows, target);
  if (!steps) return null;
  return {
    targetKey: target.key,
    anchorLabel: "Prior",
    endLabel: target.label,
    anchor: target.compare ?? 0,
    end: target.actual ?? 0,
    steps: steps.map((r) => ({
      label: r.label, delta: r.varAbs ?? 0, fav: favorable(r),
    })),
  };
}

// Per-step share of the bridge's gross movement (Σ|step deltas|), so each bar can
// carry a "N% of var" tag. Gross (absolute) denominator, same rationale as the
// table's "% of Var": offsetting steps must not cancel to a meaningless total.
function stepShares(model: BridgeModel): number[] {
  const gross = model.steps.reduce((s, st) => s + Math.abs(st.delta), 0);
  return model.steps.map((st) => (gross > 0 ? (Math.abs(st.delta) / gross) * 100 : 0));
}

// One-line CFO talk-track: net movement framed as favourable vs unfavourable
// forces, naming the largest of each side. Returns null when there's nothing to
// say (no steps, or a single-sided move).
function talkTrack(model: BridgeModel): string | null {
  if (model.steps.length === 0) return null;
  const net = model.end - model.anchor;
  const fav = model.steps.filter((s) => s.fav === true);
  const unf = model.steps.filter((s) => s.fav === false);
  const sum = (xs: typeof model.steps) => xs.reduce((s, x) => s + Math.abs(x.delta), 0);
  const largest = (xs: typeof model.steps) =>
    xs.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a), xs[0]);

  const netTxt = Math.abs(net) < 1 ? "Flat net movement" : `Net ${fmtSignedCompact(net)}`;
  const parts: string[] = [];
  if (fav.length) parts.push(`+${fmtCompact(sum(fav))} favourable (largest: ${largest(fav).label})`);
  if (unf.length) parts.push(`−${fmtCompact(sum(unf))} unfavourable (largest: ${largest(unf).label})`);
  if (parts.length === 0) return null;
  return `${netTxt} = ${parts.join(" offset by ")}.`;
}

function VarianceBridge({ model }: { model: BridgeModel }) {
  const { ref, size } = useChartSize({ width: 720, height: 260 });
  // Floating bars: anchor + end sit on the axis; each step floats from the
  // running total. Mirrors ExecutiveCharts.CashFlowWaterfall geometry.
  const bars = useMemo(() => {
    const out: { label: string; base: number; top: number; kind: "anchor" | "step" | "end"; fav: boolean | null; delta: number }[] = [];
    out.push({ label: model.anchorLabel, base: 0, top: model.anchor, kind: "anchor", fav: null, delta: model.anchor });
    let run = model.anchor;
    for (const s of model.steps) {
      const base = run;
      run += s.delta;
      out.push({ label: s.label, base, top: run, kind: "step", fav: s.fav, delta: s.delta });
    }
    out.push({ label: model.endLabel, base: 0, top: model.end, kind: "end", fav: null, delta: model.end });
    return out;
  }, [model]);

  const shares = useMemo(() => stepShares(model), [model]);
  const W = size.width, H = size.height, padL = 8, padR = 8, padT = 26, padB = 56;
  const vals = bars.flatMap((b) => [b.base, b.top]);
  const rawMax = Math.max(...vals, 0);
  const rawMin = Math.min(...vals, 0);
  const span = rawMax - rawMin || 1;
  const yMax = rawMax + span * 0.12;
  const yMin = rawMin - span * 0.06;
  const step = (W - padL - padR) / bars.length;
  const bw = Math.min(step * 0.6, 68);
  const xc = (i: number) => padL + (i + 0.5) * step;
  const y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - padT - padB);
  const color = (b: (typeof bars)[number]) =>
    b.kind !== "step" ? COLORS.slate : b.fav ? COLORS.good : COLORS.bad;

  return (
    <div ref={ref} className="w-full" style={{ height: 260 }}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block font-sans" role="img" aria-label="Variance bridge waterfall">
      {yMin < 0 && yMax > 0 && (
        <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke={COLORS.grid} strokeWidth="1" />
      )}
      {bars.map((b, i) => {
        const yTop = y(Math.max(b.base, b.top));
        const h = Math.max(Math.abs(y(b.base) - y(b.top)), 1);
        return (
          <g key={`${b.label}-${i}`}>
            {i > 0 && (
              <line x1={xc(i - 1) + bw / 2} x2={xc(i) - bw / 2}
                    y1={y(bars[i - 1].top)} y2={y(bars[i - 1].top)}
                    stroke={COLORS.grid} strokeWidth="1" strokeDasharray="3 3" />
            )}
            <rect x={xc(i) - bw / 2} y={yTop} width={bw} height={h} rx="2" fill={color(b)} opacity={0.9} />
            <text x={xc(i)} y={yTop - 5} fontSize="9.5" fill="#1E232B" textAnchor="middle" className="num">
              {b.kind === "step" ? fmtSignedCompact(b.delta) : fmtCompact(b.top)}
            </text>
            {/* wrap-free label; long labels truncate via SVG textLength isn't ideal, so keep short */}
            <text x={xc(i)} y={H - 36} {...CHART_AXIS_TEXT_PIXEL}
                  fill={COLORS.axis} textAnchor="middle">
              {b.label.length > 14 ? b.label.slice(0, 13) + "…" : b.label}
            </text>
            {/* "% of var" tag under step bars only (anchor/end have no share). */}
            {b.kind === "step" && shares[i - 1] >= 1 && (
              <text x={xc(i)} y={H - 24} fontSize="8.5" fill={COLORS.ink} textAnchor="middle">
                {Math.round(shares[i - 1])}% of var
              </text>
            )}
          </g>
        );
      })}
    </svg>
    </div>
  );
}

// Fallback when no reconciling bridge exists (e.g. balance sheet): a simple
// signed variance bar per line, centered on zero.
function VarianceBars({ rows }: { rows: DisplayRow[] }) {
  const items = rows.filter((r) => r.kind === "line" && r.varAbs != null && r.varAbs !== 0);
  if (items.length === 0) return <div className="py-10 text-center text-sm text-fg-subtle">No line-level variance to chart.</div>;
  const maxAbs = Math.max(...items.map((r) => Math.abs(r.varAbs ?? 0)), 1);
  return (
    <div className="space-y-2">
      {items.map((r) => {
        const fav = favorable(r);
        const w = (Math.abs(r.varAbs ?? 0) / maxAbs) * 46;
        const right = (r.varAbs ?? 0) > 0;
        return (
          <div key={r.key} className="flex items-center gap-2 text-xs">
            <span className="w-40 truncate text-fg-muted">{r.label}</span>
            <div className="relative flex-1 h-3.5">
              <div className="absolute left-1/2 top-0 bottom-0 w-px bg-black/[0.08]" />
              <div className="absolute top-0 bottom-0 rounded"
                   style={{ [right ? "left" : "right"]: "50%", width: `${w}%`,
                            backgroundColor: fav ? COLORS.good : COLORS.bad }} />
            </div>
            <span className={`w-20 text-right num ${toneClass(fav)}`}>{fmtSignedCompact(r.varAbs ?? 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * 3. Attribution tornado — top BU × region movers of the biggest-variance
 *    line, from the /comparative/drivers endpoint.
 * ------------------------------------------------------------------------ */
function AttributionTornado({
  drivers, lineLabel, favorableWhenUp,
}: {
  drivers: VarianceDriver[]; lineLabel: string | null; favorableWhenUp: boolean;
}) {
  if (drivers.length === 0) {
    return <div className="py-10 text-center text-sm text-fg-subtle">No driver-level detail for this basis.</div>;
  }
  const maxAbs = Math.max(...drivers.map((d) => Math.abs(d.var_abs)), 1);
  return (
    <div className="space-y-2.5">
      <p className="text-xs text-fg-muted">
        Top movers of <span className="font-medium text-fg">{lineLabel ?? "the largest variance"}</span>, by business unit &amp; region.
      </p>
      {drivers.map((d, i) => {
        const fav = d.var_abs === 0 ? null : favorableWhenUp ? d.var_abs > 0 : d.var_abs < 0;
        const w = (Math.abs(d.var_abs) / maxAbs) * 46;
        const right = d.var_abs > 0;
        return (
          <div key={`${d.bu}-${d.region}-${i}`} className="flex items-center gap-2 text-xs">
            <span className="w-44 truncate text-fg-muted">
              {d.bu}<span className="text-fg-subtle"> · {d.region}</span>
            </span>
            <div className="relative flex-1 h-3.5">
              <div className="absolute left-1/2 top-0 bottom-0 w-px bg-black/[0.08]" />
              <div className="absolute top-0 bottom-0 rounded"
                   style={{ [right ? "left" : "right"]: "50%", width: `${w}%`,
                            backgroundColor: fav == null ? COLORS.slate : fav ? COLORS.good : COLORS.bad }} />
            </div>
            <span className={`w-20 text-right num ${toneClass(fav)}`}>{fmtSignedCompact(d.var_abs)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * The dashboard view. Consumes the already-built (overlay-resolved) DisplayRow
 * model from the table, so it is industry-agnostic for free, and fetches the
 * BU×region drivers for the attribution chart.
 * ------------------------------------------------------------------------ */
export default function VarianceDashboard({
  rows, stmt, window, compare, scope, compareHeader,
}: {
  rows: DisplayRow[];
  stmt: "income" | "balance" | "cashflow";
  window: Window;
  compare: CompareMode;
  scope: Scope;
  compareHeader: string;
}) {
  const [drivers, setDrivers] = useState<VarianceDriver[]>([]);
  const [driverLineId, setDriverLineId] = useState<string | null>(null);
  const [driversLoading, setDriversLoading] = useState(true);
  // Which line to attribute: AUTO = let the endpoint pick the biggest mover;
  // otherwise a specific line id. Resets to AUTO whenever the statement / window
  // / compare / scope changes, so a selection never sticks to a line that no
  // longer exists (e.g. after switching income → balance).
  const [selected, setSelected] = useState<string>(AUTO);
  // Which factor the bridge walks to. null = the grand total (Net Income) — the
  // original behaviour.
  const [bridgeTarget, setBridgeTarget] = useState<string | null>(null);
  // Reset both selections together whenever the statement / window / compare /
  // scope changes, so neither sticks to a line or factor that no longer exists
  // (e.g. after switching income → balance, or income → cash flow).
  useEffect(() => {
    setSelected(AUTO);
    setBridgeTarget(null);
  }, [stmt, window, compare, scope]);

  useEffect(() => {
    let cancelled = false;
    setDriversLoading(true);
    const lineId = selected === AUTO ? undefined : selected;
    api.comparativeDrivers(stmt, window, compare, scope, lineId)
      .then((r) => { if (!cancelled) { setDrivers(r.drivers); setDriverLineId(r.line_id); } })
      .catch(() => { if (!cancelled) { setDrivers([]); setDriverLineId(null); } })
      .finally(() => { if (!cancelled) setDriversLoading(false); });
    return () => { cancelled = true; };
  }, [stmt, window, compare, scope, selected]);

  // COGS can be bridged by rate × volume (from the inventory subledger), offered
  // as a factor on the income statement — but not vs. budget (there's no budgeted
  // unit cost). Folded in from the retired standalone Bridge Analysis page: unlike
  // the reconciling walks (computed from `rows`), this fetches /bridge/cogs.
  const cogsRow = stmt === "income" ? rows.find((r) => r.key === "cogs") : undefined;
  const cogsAvailable = !!cogsRow && compare !== "budget";
  const isCogsSelected = bridgeTarget === "cogs" && cogsAvailable;
  const [cogsBridge, setCogsBridge] = useState<CogsBridge | null>(null);
  const [cogsLoading, setCogsLoading] = useState(false);
  useEffect(() => {
    if (!isCogsSelected) { setCogsBridge(null); return; }
    let cancelled = false;
    setCogsLoading(true);
    api.cogsBridge(window, compare, scope)
      .then((r) => { if (!cancelled) setCogsBridge(r); })
      .catch(() => { if (!cancelled) setCogsBridge(null); })
      .finally(() => { if (!cancelled) setCogsLoading(false); });
    return () => { cancelled = true; };
  }, [isCogsSelected, window, compare, scope]);

  // The balance sheet's grand total double-counts (assets vs. liabilities+equity),
  // so drop it there and offer only the section-level walks.
  const isBalance = stmt === "balance";
  const bridge = useMemo(() => buildBridge(rows, bridgeTarget ?? undefined, isBalance), [rows, bridgeTarget, isBalance]);
  // Factors the user can bridge to (subtotals, plus the grand total off the
  // balance sheet). The selector only shows when there's a real choice and a
  // reconciling bridge exists.
  const factors = useMemo(() => {
    const f = bridgeFactors(rows);
    return isBalance ? f.filter((r) => r.kind !== "total") : f;
  }, [rows, isBalance]);
  // Selector options = factors that ACTUALLY reconcile into a walk + COGS (rate ×
  // volume) when available. We pre-filter with componentSteps here (not just
  // bridgeFactors) so the dropdown never offers a factor whose bridge fails to
  // tie out — picking one would otherwise draw nothing and blank the control.
  const factorOptions = useMemo(() => {
    const opts = factors
      .filter((f) => componentSteps(rows, f) !== null)
      .map((f) => ({ value: f.key, label: f.label }));
    if (cogsAvailable && cogsRow) opts.push({ value: "cogs", label: cogsRow.label });
    return opts;
  }, [factors, rows, cogsAvailable, cogsRow]);
  // What the selector shows. Driven by the chosen STATE (the source of truth),
  // not by bridge?.targetKey (a result) — so a valid pick never reverts to a
  // blank placeholder. Falls back to the resolved default when nothing's picked,
  // and defends against a stale bridgeTarget that isn't a current option.
  const selectedFactor = isCogsSelected
    ? "cogs"
    : bridgeTarget && factorOptions.some((o) => o.value === bridgeTarget)
      ? bridgeTarget
      : bridge?.targetKey ?? "";
  // Join the attributed line to its display row by STABLE line id (never label —
  // the overlay relabels labels per industry). This drives both the industry-
  // correct heading label and the tornado's favourable direction.
  const driverRow = rows.find((r) => r.lineId === driverLineId);
  const driverLabel = driverRow?.label ?? null;
  // The drivers endpoint returns RAW amounts (expense up = positive), so colour
  // by favorableRawUp — NOT favorableWhenUp (which is display-sign calibrated).
  const driverFavUp = driverRow?.favorableRawUp ?? true;

  // Selector options: only concrete, attributable lines (subtotals/totals are
  // derived and can't be attributed at BU/region grain), plus the auto entry.
  const lineOptions = useMemo(() => [
    { value: AUTO, label: "Biggest mover (auto)" },
    ...rows
      .filter((r) => r.kind === "line" && r.lineId)
      .map((r) => ({ value: r.lineId as string, label: r.label })),
  ], [rows]);

  return (
    <div className="space-y-4">
      <KpiTiles rows={rows} />

      <Card
        title="Variance bridge"
        action={
          factorOptions.length > 1 ? (
            <Select
              value={selectedFactor}
              onChange={(v) => setBridgeTarget(v)}
              options={factorOptions}
              size="sm"
              aria-label="Factor to bridge"
            />
          ) : undefined
        }
      >
        {isCogsSelected ? (
          cogsLoading ? (
            <SkeletonRegion><BarChartSkeleton bars={5} height={200} /></SkeletonRegion>
          ) : cogsBridge ? (
            <CogsBridgeView b={cogsBridge} cogsLabel={cogsRow?.label ?? "COGS"} />
          ) : (
            <div className="px-5 py-10 text-center text-sm text-fg-subtle">No inventory data in this scope.</div>
          )
        ) : (
          <div className="px-3 py-3">
            <div className="flex items-center gap-1.5 px-2 text-[11px] uppercase tracking-wide text-fg-subtle mb-1">
              {compareHeader} → Actual {bridge ? bridge.endLabel : ""} · <span className="text-signal-good">green = favourable</span> · <span className="text-signal-bad">red = unfavourable</span>
            </div>
            {bridge ? (
              <>
                <VarianceBridge model={bridge} />
                {talkTrack(bridge) && (
                  <div className="mt-2 mx-2 rounded-lg border border-accent/15 bg-accent/[0.05] px-3.5 py-2.5">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-accent mb-1">CFO talk-track</div>
                    <p className="text-xs leading-relaxed text-fg">{talkTrack(bridge)}</p>
                  </div>
                )}
              </>
            ) : (
              <div className="px-2 pb-1">
                <p className="text-[11px] text-fg-subtle mb-2">
                  Line-level variance (a reconciling bridge isn't defined for this statement).
                </p>
                <VarianceBars rows={rows} />
              </div>
            )}
          </div>
        )}
      </Card>

      <Card
        title="What drove it"
        action={
          <Select
            value={selected}
            onChange={setSelected}
            options={lineOptions}
            size="sm"
            aria-label="Line to attribute"
          />
        }
      >
        <div className="px-5 py-4">
          {driversLoading ? (
            <SkeletonRegion><HBarSkeleton rows={5} /></SkeletonRegion>
          ) : (
            <AttributionTornado drivers={drivers} lineLabel={driverLabel} favorableWhenUp={driverFavUp} />
          )}
        </div>
      </Card>
    </div>
  );
}
