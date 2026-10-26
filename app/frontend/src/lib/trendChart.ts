// Shared helpers + palette for the time-series trend charts (the Executive
// "Operating leverage" MarginTrend and the "Competitors benchmarking" trend
// chart). Kept in one place so both charts read identically and stay in sync.

// Palette: light-blue dense line, blue mid line, navy trend, shaded forecast band.
export const MT = {
  raw: "#9BC0E4",     // light blue — dense / raw series
  trend: "#1F4E79",   // navy — the clear trend line
  opex: "#94A3B8",    // slate — context series
  band: "#3179C9",    // blue — mid line + forecast band
  grid: "rgba(23,25,32,0.08)",
  now: "rgba(23,25,32,0.28)",
};

// "20 Jul 25" style date tick.
export function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "2-digit" });
}

// Trailing simple moving average over `w` samples, with an expanding window at
// the start (min-periods = 1) so the line is defined across the whole span
// rather than leaving a gap for the first `w` points.
export function sma(vals: number[], w: number): number[] {
  const out = new Array<number>(vals.length);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= w) sum -= vals[i - w];
    out[i] = sum / Math.min(i + 1, w);
  }
  return out;
}

// Deterministic hash -> [0,1). Used to seed reproducible "texture" so synthesized
// lines are stable across renders (and differ per seed).
export function hashNoise(n: number): number {
  let t = (Math.trunc(n) * 2654435761) >>> 0;
  t = ((t ^ (t >>> 15)) * 2246822519) >>> 0;
  t = ((t ^ (t >>> 13)) * 3266489917) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

// Least-squares fit over the last `win` points, extended `steps` ahead. The
// band is a simple ±1.5σ of the fit residuals (visual uncertainty).
export function forecast(vals: number[], win: number, steps: number) {
  const n = vals.length;
  const xs: number[] = [], ys: number[] = [];
  for (let i = Math.max(0, n - win); i < n; i++) if (Number.isFinite(vals[i])) { xs.push(i); ys.push(vals[i]); }
  if (xs.length < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0;
  xs.forEach((xv, k) => { sxy += (xv - mx) * (ys[k] - my); sxx += (xv - mx) ** 2; });
  const slope = sxx ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const resid = ys.map((yv, k) => yv - (slope * xs[k] + intercept));
  const rStd = Math.sqrt(resid.reduce((a, b) => a + b * b, 0) / Math.max(1, resid.length - 1)) || 0;
  const pts = Array.from({ length: steps }, (_, s) => {
    const xv = n - 1 + (s + 1);
    return { v: slope * xv + intercept, band: rStd * 1.5 };
  });
  return { slope, pts };
}
