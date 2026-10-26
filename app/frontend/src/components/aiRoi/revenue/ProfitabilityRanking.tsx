// Profitability ranking for the ROI page: for each business unit, what a dollar
// of fully loaded AI cost (run cost + amortised and allocated build) brings back.
//
// The index is GROSS (realised value / fully loaded cost), so break-even is the
// explicit dashed 1.0 line from the payload's `break_even_at`. This chart must
// never be read against Return on Token Used, which is NET and breaks even at 0.
//
// Ranked lowest first so the units that do not pay for themselves are read
// first. Each bar carries a tick at its proven-only index (metered + attested
// value), so the drop from excluding modelled value shows without a second
// chart. Below-threshold units are marked in text as well as colour.

import { AiRoiProfitability, Scope, api } from "../../../api";
import { CHART_COLORS } from "../../../lib/chartPalette";
import { useOverlay } from "../../../lib/industry";
import { Card } from "../../ui";
import { rankLowestFirst, unitNoun } from "../ranking";
import { DataState, ratio, useAiRoiLoad } from "../shared";
import { BarListSkeleton } from "../skeletons";

/** One fixed grid for the scale strip and every row, so the 1.0 label lands on
 *  the same x as each row's reference line. The value column is a fixed width
 *  for the same reason: an `auto` column would size differently per grid. */
const ROW_GRID = "grid grid-cols-[minmax(9rem,15rem)_minmax(0,1fr)_16rem] items-center gap-3";

const pctOf = (value: number, max: number) => `${Math.max(0, Math.min(1, value / max)) * 100}%`;

export function ProfitabilityRanking({ scope }: { scope: Scope }) {
  const noun = unitNoun(useOverlay().aiRoi.revenueDimensions);
  const result = useAiRoiLoad(() => api.aiRoiProfitability(scope), [scope]);
  const data = result.data;
  const rated = (data?.rows ?? []).filter((r) => r.pi_all != null);

  return (
    <Card
      title={`Profitability index across ${noun}`}
      subtitle="Realised value ÷ fully loaded cost (run cost + amortised and allocated build) · ranked lowest first"
    >
      <DataState
        loading={!data && !result.error}
        error={result.error}
        empty={!!data && !rated.length}
        skeleton={<BarListSkeleton rows={5} />}
      >
        {data && <ProfitabilityBars data={data} noun={noun} />}
      </DataState>
    </Card>
  );
}

/** Presentational ranking: 1.0 scale strip, bars with proven ticks, legend. */
export function ProfitabilityBars({
  data,
  noun,
}: {
  data: Pick<AiRoiProfitability, "rows" | "break_even_at">;
  noun: string;
}) {
  const threshold = data.break_even_at;
  const rows = rankLowestFirst(data.rows);
  const rated = rows.filter((r) => r.pi_all != null);
  // Keep the threshold on screen with some headroom, whatever the data range.
  const maxPi = Math.max(threshold * 1.15, ...rated.map((r) => r.pi_all as number));
  const thresholdLabel = `${threshold.toFixed(1)} break-even`;

  return (
    <div data-testid="ai-roi-profitability" className="p-5">
      <div className={`${ROW_GRID} mb-1.5`} aria-hidden="true">
        <span />
        <div className="relative h-4">
          <span
            className="absolute -translate-x-1/2 whitespace-nowrap text-[11px] font-medium uppercase tracking-wide text-fg-muted"
            style={{ left: pctOf(threshold, maxPi) }}
          >
            {thresholdLabel}
          </span>
        </div>
        <span />
      </div>

      <ul className="flex flex-col gap-2.5">
        {rows.map((r) => {
          const pi = r.pi_all;
          const below = pi != null && pi < threshold;
          return (
            <li key={r.key} className={ROW_GRID}>
              <span className="truncate text-sm font-medium" title={r.label}>{r.label}</span>
              <div className="relative h-5 rounded bg-black/[0.04]" aria-hidden="true">
                {pi != null && (
                  <div
                    className="absolute inset-y-0 left-0 rounded-r"
                    style={{ width: pctOf(pi, maxPi), background: below ? CHART_COLORS.bad : CHART_COLORS.slate }}
                  />
                )}
                <div
                  className="absolute -inset-y-1.5 border-l border-dashed border-fg-muted"
                  style={{ left: pctOf(threshold, maxPi) }}
                />
                {pi != null && r.pi_proven != null && (
                  <div
                    className="absolute -inset-y-1 w-0.5 bg-fg"
                    style={{ left: `calc(${pctOf(r.pi_proven, maxPi)} - 1px)` }}
                    title={`Metered and attested only: ${ratio(r.pi_proven)}`}
                  />
                )}
              </div>
              <span className="flex items-baseline justify-end gap-3">
                <span className="num w-12 text-right text-sm text-fg">{ratio(pi)}</span>
                <span className="num w-24 text-right text-xs text-fg-muted">
                  {pi == null ? "no loaded cost" : `proven ${ratio(r.pi_proven)}`}
                </span>
                <span className="w-20 text-right text-[11px] font-medium uppercase tracking-wide text-signal-bad">
                  {below ? `below ${threshold.toFixed(1)}` : ""}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line pt-3 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CHART_COLORS.slate }} />
          at or above break-even
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CHART_COLORS.bad }} />
          below break-even
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-0.5 bg-fg" />
          proven only (metered and attested value)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 border-l border-dashed border-fg-muted" />
          {thresholdLabel}
        </span>
      </div>
    </div>
  );
}
