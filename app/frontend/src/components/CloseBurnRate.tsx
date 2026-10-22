import { useMemo } from "react";
import { Burndown } from "../api";
import { CHART_COLORS } from "../lib/chartPalette";

// Emerald matches "done / progress" across the burn-down and task-breakdown.
const COMPLETED_COLOR = CHART_COLORS.good;

// Close-day label, matching CloseBurndown (T = month-end cutoff, T+n after).
const tLabel = (t: number) => (t === 0 ? "T" : t > 0 ? `T+${t}` : `T\u2212${-t}`);

/**
 * Daily completions ("burn rate") — how many tasks were finished on each close
 * day, derived from the day-over-day drop in the burn-down's remaining series.
 * The burn-down line shows cumulative work left; this shows momentum (are we
 * speeding up or stalling?), which nothing else on the overview surfaces.
 */
export function CloseBurnRate({ data }: { data: Burndown }) {
  const bars = useMemo(() => {
    const pts = data.points;
    // Completions between consecutive days = remaining[i-1] - remaining[i], only
    // where both have an actual (up to today; the future is projection). Points
    // are per calendar day, so several can share one close-day (t) across a
    // weekend — aggregate by t to get one clean bar per business close-day.
    const byT = new Map<number, number>();
    let minT = Infinity, maxT = -Infinity;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1].actual;
      const cur = pts[i].actual;
      if (prev == null || cur == null) continue;
      const t = pts[i].t;
      byT.set(t, (byT.get(t) ?? 0) + Math.max(0, prev - cur));
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    if (!Number.isFinite(minT)) return [];
    const out: { t: number; done: number; isToday: boolean }[] = [];
    for (let t = minT; t <= maxT; t++) {
      out.push({ t, done: byT.get(t) ?? 0, isToday: t === data.today_t });
    }
    return out;
  }, [data]);

  if (bars.length === 0) return null;

  const max = Math.max(1, ...bars.map((b) => b.done));
  const peak = bars.reduce((m, b) => (b.done > m.done ? b : m), bars[0]);
  const avg = bars.reduce((s, b) => s + b.done, 0) / bars.length;

  return (
    <div className="px-2 pt-1 pb-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] uppercase tracking-wide text-fg-subtle">Daily completions</span>
        <span className="text-[10px] text-fg-subtle">
          avg <span className="num">{avg.toFixed(1)}</span>/day · peak{" "}
          <span className="num" style={{ color: COMPLETED_COLOR }}>{peak.done}</span> on {tLabel(peak.t)}
        </span>
      </div>
      <div className="flex items-stretch gap-1">
        {bars.map((b, i) => (
          <div
            key={i}
            className="flex-1 min-w-0 flex flex-col items-center"
            title={`${tLabel(b.t)}: ${b.done} completed`}
          >
            <div className="w-full h-9 flex items-end">
              <div
                className="w-full rounded-t"
                style={{ height: `${Math.max(4, (b.done / max) * 100)}%`, backgroundColor: COMPLETED_COLOR, opacity: b.isToday ? 1 : 0.5 }}
              />
            </div>
            <div className={`text-[9px] mt-0.5 num ${b.isToday ? "text-fg font-semibold" : "text-fg-subtle"}`}>{tLabel(b.t)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
