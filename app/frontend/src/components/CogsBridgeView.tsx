import { useMemo } from "react";
import { useChartSize } from "../lib/useChartSize";
import { Sparkles } from "lucide-react";
import { CogsBridge, fmtCompact, fmtSignedCompact } from "../api";
import { CHART_AXIS_TEXT_PIXEL, CHART_COLORS as COLORS } from "../lib/chartPalette";

// The COGS rate × volume bridge, shown inline in the Variance dashboard when the
// user picks COGS as the bridge factor. (Previously its own "Bridge Analysis"
// page; folded in here so all bridges live on one surface.) Sourced from the
// inventory subledger via /bridge/cogs — rate and volume reconcile to the COGS
// movement, and we note the tie-out gap vs the P&L line honestly.

// Whole-dollar currency (no cents) for unit costs — distinct from the app's
// compact $/K/M formatter, which is too coarse for a per-unit figure.
const fmtUsd = (v: number): string =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const round2 = (v: number) => Math.round(v * 100) / 100;

interface Step { label: string; delta: number; hint?: string; }

function CogsWaterfall({ b }: { b: CogsBridge }) {
  const { ref, size } = useChartSize({ width: 720, height: 280 });
  const steps: Step[] = [
    { label: "Volume", delta: b.volume_effect, hint: "units consumed" },
    { label: "Rate", delta: b.rate_effect, hint: "unit cost" },
  ];
  if (Math.abs(b.residual) >= Math.max(Math.abs(b.total_var) * 0.005, 1)) {
    steps.push({ label: "Mix / other", delta: b.residual, hint: "residual" });
  }

  const bars = useMemo(() => {
    const out: { label: string; base: number; top: number; kind: "anchor" | "step" | "end"; delta: number; hint?: string }[] = [];
    out.push({ label: "Prior COGS", base: 0, top: b.anchor, kind: "anchor", delta: b.anchor });
    let run = b.anchor;
    for (const s of steps) {
      const base = run;
      run += s.delta;
      out.push({ label: s.label, base, top: run, kind: "step", delta: s.delta, hint: s.hint });
    }
    out.push({ label: "Actual COGS", base: 0, top: b.actual, kind: "end", delta: b.actual });
    return out;
  }, [b]);

  const W = size.width, H = size.height, padL = 8, padR = 8, padT = 28, padB = 48;
  const vals = bars.flatMap((x) => [x.base, x.top]);
  const rawMax = Math.max(...vals, 0);
  const rawMin = Math.min(...vals, 0);
  const span = rawMax - rawMin || 1;
  const yMax = rawMax + span * 0.12;
  const yMin = rawMin - span * 0.06;
  const step = (W - padL - padR) / bars.length;
  const bw = Math.min(step * 0.6, 72);
  const xc = (i: number) => padL + (i + 0.5) * step;
  const y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - padT - padB);
  // Expense colour: cost up (positive) = red/unfavourable, cost down = green.
  const color = (bar: (typeof bars)[number]) =>
    bar.kind !== "step" ? COLORS.slate : bar.delta > 0 ? COLORS.bad : COLORS.good;

  return (
    <div ref={ref} className="w-full" style={{ height: 280 }}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block font-sans" role="img" aria-label="COGS rate versus volume bridge">
      {yMin < 0 && yMax > 0 && (
        <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke={COLORS.grid} strokeWidth="1" />
      )}
      {bars.map((bar, i) => {
        const yTop = y(Math.max(bar.base, bar.top));
        const h = Math.max(Math.abs(y(bar.base) - y(bar.top)), 1);
        return (
          <g key={`${bar.label}-${i}`}>
            {i > 0 && (
              <line x1={xc(i - 1) + bw / 2} x2={xc(i) - bw / 2}
                    y1={y(bars[i - 1].top)} y2={y(bars[i - 1].top)}
                    stroke={COLORS.grid} strokeWidth="1" strokeDasharray="3 3" />
            )}
            <rect x={xc(i) - bw / 2} y={yTop} width={bw} height={h} rx="2" fill={color(bar)} opacity={0.9} />
            <text x={xc(i)} y={yTop - 6} fontSize="10" fill="#1E232B" textAnchor="middle" className="num">
              {bar.kind === "step" ? fmtSignedCompact(bar.delta) : fmtCompact(bar.top)}
            </text>
            <text x={xc(i)} y={H - 26} {...CHART_AXIS_TEXT_PIXEL}
                  fill={COLORS.axis} textAnchor="middle">{bar.label}</text>
            {bar.hint && (
              <text x={xc(i)} y={H - 14} fontSize="8" fill={COLORS.axis} textAnchor="middle" opacity="0.75">{bar.hint}</text>
            )}
          </g>
        );
      })}
    </svg>
    </div>
  );
}

export default function CogsBridgeView({ b, cogsLabel }: { b: CogsBridge; cogsLabel: string }) {
  const summary = useMemo(() => {
    const dominant = Math.abs(b.rate_effect) >= Math.abs(b.volume_effect) ? "rate" : "volume";
    return { dominant, rate: b.rate_effect, vol: b.volume_effect };
  }, [b]);
  const tieOut = useMemo(() => {
    if (b.pnl_cogs_var == null) return null;
    return { pnl: b.pnl_cogs_var, gap: round2(b.pnl_cogs_var - b.total_var) };
  }, [b]);

  return (
    <div className="px-3 py-3">
      <div className="flex items-center gap-1.5 px-2 text-[11px] uppercase tracking-wide text-fg-subtle mb-1">
        Prior {cogsLabel} → Actual · <span className="text-signal-good">green = cost fell</span> · <span className="text-signal-bad">red = cost rose</span>
      </div>
      <CogsWaterfall b={b} />
      <p className="text-[11px] text-fg-subtle px-2 pt-1">
        {cogsLabel} moved{" "}
        <span className={`font-semibold ${b.total_var > 0 ? "text-signal-bad" : "text-signal-good"}`}>{fmtSignedCompact(b.total_var)}</span>{" "}
        — mostly <span className="font-semibold text-fg">{summary.dominant}</span>-driven
        {" "}(rate <span className="num">{fmtSignedCompact(summary.rate)}</span>, volume <span className="num">{fmtSignedCompact(summary.vol)}</span>).
      </p>
      <div className="mt-2 mx-2 rounded-lg border border-line bg-black/[0.015] px-3.5 py-2.5 text-[12px] text-fg-muted">
        <div className="flex items-start gap-2">
          <Sparkles className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
          <p>
            <span className="font-medium text-fg">Rate</span> isolates unit cost
            (avg {fmtUsd(b.avg_cost_prior)} → {fmtUsd(b.avg_cost_actual)});{" "}
            <span className="font-medium text-fg">Volume</span> isolates units consumed
            ({Math.round(b.qty_prior).toLocaleString()} → {Math.round(b.qty_actual).toLocaleString()}).
            Sourced from the inventory subledger.
            {tieOut && Math.abs(tieOut.gap) >= 1 && (
              <> The <span className="num">{fmtSignedCompact(tieOut.gap)}</span> gap vs. the P&amp;L {cogsLabel} line is manual adjustments not yet in the subledger.</>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
