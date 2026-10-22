// Axis scaling for the benchmark scatter, where one filer can be 1,000x the
// others. Public filings routinely include a pre-revenue peer — Joby Aviation
// reports +39,183% growth on a -1,347% operating margin — and a raw min/max
// domain then squeezes every real peer into a few pixels in one corner. These
// helpers scale to the sensible core of the data and report which points fell
// outside so the caller can pin them to the edge instead of dropping them.

export interface Domain {
  lo: number;
  hi: number;
}

/** Linearly interpolated quantile of an ascending array. */
function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** The window holding the sensible cluster, by Tukey fence on the IQR.
 *
 * Falls back to the full range whenever there is nothing to judge (fewer than
 * three values, or a zero IQR) or whenever the fence would throw out more than
 * a third of the points — a squashed chart is better than one where half the
 * peer set is pinned to an edge. */
export function coreWindow(vals: number[], k = 3): Domain {
  const s = [...vals].sort((a, b) => a - b);
  const full = { lo: s[0], hi: s[s.length - 1] };
  if (s.length < 3) return full;
  const q25 = quantile(s, 0.25);
  const q75 = quantile(s, 0.75);
  const iqr = q75 - q25;
  if (iqr === 0) return full;
  const fenceLo = q25 - k * iqr;
  const fenceHi = q75 + k * iqr;
  const inside = s.filter((v) => v >= fenceLo && v <= fenceHi);
  if (s.length - inside.length > Math.floor(s.length / 3)) return full;
  // Tighten to the data actually inside the fence so the domain hugs the cluster.
  return { lo: inside[0], hi: inside[inside.length - 1] };
}

export interface AxisOptions {
  /** Values the domain must contain regardless of the data (reference lines). */
  include?: number[];
  /** Padding on each side, as a fraction of the span. */
  pad?: number;
  /** Fence width in IQRs, passed through to coreWindow. */
  k?: number;
}

/** Padded plot domain for one axis.
 *
 * The padding is a fraction of the span added to *both* ends, which is what
 * keeps markers off the axes. (The previous `max * 1.08` inverted whenever the
 * maximum was negative — an all-negative-margin peer set pushed the best point
 * outside the clip box, where it vanished.) */
export function axisDomain(vals: number[], opts: AxisOptions = {}): Domain {
  const { include = [], pad = 0.12, k } = opts;
  const finite = vals.filter((v) => Number.isFinite(v));
  const forced = include.filter((v) => Number.isFinite(v));
  if (finite.length === 0 && forced.length === 0) return { lo: 0, hi: 1 };
  const core = finite.length ? coreWindow(finite, k) : { lo: forced[0], hi: forced[0] };
  const lo = Math.min(core.lo, ...forced);
  const hi = Math.max(core.hi, ...forced);
  const span = hi - lo;
  const p = span > 0 ? span * pad : Math.max(1, Math.abs(hi) * pad);
  return { lo: lo - p, hi: hi + p };
}

/** Clamp a finite value into the domain, reporting which side overflowed. */
export function clampToDomain(v: number, d: Domain): { v: number; off: -1 | 0 | 1 } {
  if (v < d.lo) return { v: d.lo, off: -1 };
  if (v > d.hi) return { v: d.hi, off: 1 };
  return { v, off: 0 };
}

export type LabelSide = "start" | "end";

export interface LabelSlot {
  /** Preferred y, usually the point's own y. */
  y: number;
  /** Anchor side; labels on opposite sides of the plot can't collide. */
  side: LabelSide;
}

/** Push overlapping labels apart vertically, per anchor side.
 *
 * Greedy downward pass, then the whole side shifts back up if it ran past the
 * bottom, which preserves the gaps it just created. Returns final y values in
 * input order. Labels can still overlap if a side holds more of them than the
 * bounds can fit at minGap — with ~10 peers and a 210px plot that doesn't
 * happen. */
export function spreadLabels(
  slots: LabelSlot[],
  minGap: number,
  bounds: { top: number; bottom: number },
): number[] {
  const out = slots.map((s) => s.y);
  for (const side of ["start", "end"] as const) {
    const idx = slots
      .map((_, i) => i)
      .filter((i) => slots[i].side === side)
      .sort((a, b) => slots[a].y - slots[b].y);
    if (idx.length === 0) continue;
    let prev = -Infinity;
    for (const i of idx) {
      out[i] = Math.max(slots[i].y, prev + minGap);
      prev = out[i];
    }
    const overflow = out[idx[idx.length - 1]] - bounds.bottom;
    if (overflow > 0) {
      const shift = Math.min(overflow, Math.max(0, out[idx[0]] - bounds.top));
      for (const i of idx) out[i] -= shift;
    }
    for (const i of idx) out[i] = Math.min(Math.max(out[i], bounds.top), bounds.bottom);
  }
  return out;
}

/** Which end of a horizontal reference line can carry its caption, or null when
 * both ends are crowded by point labels and the caption should be dropped. */
export function captionSide(
  lineY: number,
  labels: { y: number; side: LabelSide }[],
  minGap: number,
): LabelSide | null {
  const clearance = (side: LabelSide) => {
    const gaps = labels.filter((l) => l.side === side).map((l) => Math.abs(l.y - lineY));
    return gaps.length ? Math.min(...gaps) : Infinity;
  };
  const start = clearance("start");
  const end = clearance("end");
  const best = end >= start ? "end" : "start";
  return Math.max(start, end) < minGap ? null : best;
}
