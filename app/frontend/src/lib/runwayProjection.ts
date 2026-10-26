export const RUNWAY_MONTHS = 12;
export const PHASE_MONTHS = 3;

export type DominantDriver = "wc" | "pl" | "none";

export interface RunwayInput {
  startCash: number;
  monthlyBase: number;
  wcRelease: number;
  plDelta: number;
}

export interface RunwayInsights {
  endUplift: number;
  minCash: number;
  breachMonth: number | null;
  dominantDriver: DominantDriver;
  dominantSharePct: number;
  wcUplift12: number;
  plUplift12: number;
}

export interface RunwayProjection {
  months: number[];
  baseline: number[];
  wcOnly: number[];
  plOnly: number[];
  combined: number[];
  insights: RunwayInsights;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function wcCum(wcRelease: number, m: number): number {
  return wcRelease * clamp01(m / PHASE_MONTHS);
}

function plCum(plDelta: number, m: number): number {
  let sum = 0;
  for (let i = 1; i <= m; i++) {
    sum += plDelta * clamp01(i / PHASE_MONTHS);
  }
  return sum;
}

export function projectRunway(input: RunwayInput): RunwayProjection {
  const { startCash, monthlyBase, wcRelease, plDelta } = input;
  const months = Array.from({ length: RUNWAY_MONTHS + 1 }, (_, m) => m);
  const baseline: number[] = [];
  const wcOnly: number[] = [];
  const plOnly: number[] = [];
  const combined: number[] = [];

  for (const m of months) {
    const base = startCash + monthlyBase * m;
    const wc = wcCum(wcRelease, m);
    const pl = plCum(plDelta, m);
    baseline.push(base);
    wcOnly.push(base + wc);
    plOnly.push(base + pl);
    combined.push(base + wc + pl);
  }

  const wcUplift12 = wcCum(wcRelease, RUNWAY_MONTHS);
  const plUplift12 = plCum(plDelta, RUNWAY_MONTHS);
  const absWc = Math.abs(wcUplift12);
  const absPl = Math.abs(plUplift12);
  const sum = absWc + absPl;

  let dominantDriver: DominantDriver = "none";
  let dominantSharePct = 0;
  if (sum > 1e-9) {
    dominantDriver = absWc >= absPl ? "wc" : "pl";
    dominantSharePct = Math.round(
      (100 * (dominantDriver === "wc" ? absWc : absPl)) / sum
    );
  }

  let breachMonth: number | null = null;
  for (let m = 1; m <= RUNWAY_MONTHS; m++) {
    if (combined[m] < 0) {
      breachMonth = m;
      break;
    }
  }

  return {
    months,
    baseline,
    wcOnly,
    plOnly,
    combined,
    insights: {
      endUplift: combined[RUNWAY_MONTHS] - baseline[RUNWAY_MONTHS],
      minCash: Math.min(...combined),
      breachMonth,
      dominantDriver,
      dominantSharePct,
      wcUplift12,
      plUplift12,
    },
  };
}

/**
 * Polyline SVG path (M... L... L...)
 */
export function linePath(xs: number[], ys: number[]): string {
  return xs
    .map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`)
    .join(" ");
}

/**
 * Centripetal-ish Catmull-Rom → cubic Bezier; passes through each (x,y).
 * Note: smoothing does not change monthly values, only visual appearance.
 */
export function catmullRomPath(xs: number[], ys: number[]): string {
  const n = xs.length;
  if (n === 0) return "";
  if (n === 1) return `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  let d = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const x0 = xs[i === 0 ? i : i - 1];
    const y0 = ys[i === 0 ? i : i - 1];
    const x1 = xs[i];
    const y1 = ys[i];
    const x2 = xs[i + 1];
    const y2 = ys[i + 1];
    const x3 = xs[i + 2 < n ? i + 2 : i + 1];
    const y3 = ys[i + 2 < n ? i + 2 : i + 1];
    const c1x = x1 + (x2 - x0) / 6;
    const c1y = y1 + (y2 - y0) / 6;
    const c2x = x2 - (x3 - x1) / 6;
    const c2y = y2 - (y3 - y1) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  }
  return d;
}

/**
 * Closed band between two series (top and bottom).
 */
export function bandPath(xs: number[], top: number[], bottom: number[]): string {
  const topLine = linePath(xs, top);
  const back = xs
    .slice()
    .reverse()
    .map((x, i) => {
      const yi = bottom[bottom.length - 1 - i];
      return `L${x.toFixed(1)},${yi.toFixed(1)}`;
    })
    .join(" ");
  return `${topLine} ${back} Z`;
}
