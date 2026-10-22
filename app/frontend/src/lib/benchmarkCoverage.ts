// Run-scoped coverage for sparse competitor benchmarks: which curated metrics
// appear for enough entities to compare (charts) vs only one (table-only).

export type BetterDirection = "high" | "low" | "neutral";

export interface MetricMeta {
  name: string;
  unit: string;
  better: BetterDirection;
  chartable: boolean;
}

export interface MetricCatalog {
  metric_schema: number;
  metrics: MetricMeta[];
}

/** Fallback catalog mirroring server METRIC_REGISTRY (Close Support / offline). */
export const DEFAULT_METRIC_CATALOG: MetricCatalog = {
  metric_schema: 1,
  metrics: [
    { name: "Revenue ($B)", unit: "currencyB", better: "neutral", chartable: false },
    { name: "Revenue growth", unit: "%", better: "high", chartable: true },
    { name: "Gross margin", unit: "%", better: "high", chartable: true },
    { name: "Operating margin", unit: "%", better: "high", chartable: true },
    { name: "Net margin", unit: "%", better: "high", chartable: true },
    { name: "DSO", unit: "days", better: "low", chartable: true },
    { name: "DIO", unit: "days", better: "low", chartable: true },
    { name: "DPO", unit: "days", better: "high", chartable: true },
    { name: "CCC", unit: "days", better: "low", chartable: true },
  ],
};

export interface CoverageRow {
  competitor: string;
  metric: string;
  their_value: number | null;
  our_value: number | null;
}

export type EntityCount = {
  metric: string;
  /** Distinct entities with a non-null value (Us and/or peers). */
  entities: string[];
  count: number;
};

/** Count entities with a non-null value per metric (Us from our_value, peers from their_value). */
export function entityCounts(rows: CoverageRow[]): Map<string, EntityCount> {
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.metric)) map.set(r.metric, new Set());
    const set = map.get(r.metric)!;
    if (r.their_value != null) set.add(r.competitor);
    if (r.our_value != null) set.add("Us");
  }
  const out = new Map<string, EntityCount>();
  for (const [metric, set] of map) {
    out.set(metric, { metric, entities: [...set], count: set.size });
  }
  return out;
}

/** Metrics present for ≥1 entity, in catalog order (unknown metrics appended). */
export function presentMetrics(
  rows: CoverageRow[],
  catalog: MetricCatalog = DEFAULT_METRIC_CATALOG,
): string[] {
  const counts = entityCounts(rows);
  const known = catalog.metrics.map((m) => m.name).filter((n) => (counts.get(n)?.count ?? 0) >= 1);
  const extras = [...counts.keys()].filter((n) => !known.includes(n) && (counts.get(n)?.count ?? 0) >= 1);
  return [...known, ...extras];
}

/** Metrics with ≥2 entities — eligible for comparison charts. */
export function sharedMetrics(
  rows: CoverageRow[],
  catalog: MetricCatalog = DEFAULT_METRIC_CATALOG,
): string[] {
  const counts = entityCounts(rows);
  return presentMetrics(rows, catalog).filter((n) => (counts.get(n)?.count ?? 0) >= 2);
}

/** Metrics with exactly one entity — table-only, labeled company-only. */
export function uniqueMetrics(
  rows: CoverageRow[],
  catalog: MetricCatalog = DEFAULT_METRIC_CATALOG,
): { metric: string; entity: string }[] {
  const counts = entityCounts(rows);
  return presentMetrics(rows, catalog)
    .filter((n) => (counts.get(n)?.count ?? 0) === 1)
    .map((metric) => ({ metric, entity: counts.get(metric)!.entities[0] }));
}

/** Oldest plottable peer point, or null when no peer has a line. Series must be
 * date-ascending. Peers need ≥2 points to be drawn, so shorter ones don't set
 * the floor. */
export function peerHistoryFloor(
  series: Map<string, { t: number }[]>,
  minPoints = 2,
): number | null {
  const firsts = [...series.entries()]
    .filter(([name, pts]) => name !== "Us" && pts.length >= minPoints)
    .map(([, pts]) => pts[0].t);
  return firsts.length ? Math.min(...firsts) : null;
}

/** Trim the synthesized "Us" series to the peers' own history window.
 *
 * Our series reaches much further back than the public filings do, so without
 * this the chart opened on years where only "Us" had a line — a comparison view
 * with nothing to compare against. Peers keep every point they reported. */
export function clipUsToPeerHistory<T extends { t: number }>(
  series: Map<string, T[]>,
  minPoints = 2,
): Map<string, T[]> {
  const floor = peerHistoryFloor(series, minPoints);
  const us = series.get("Us");
  if (floor == null || !us) return series;
  const clipped = new Map(series);
  clipped.set("Us", us.filter((p) => p.t >= floor));
  return clipped;
}

export function metaFor(
  name: string,
  catalog: MetricCatalog = DEFAULT_METRIC_CATALOG,
): MetricMeta {
  return catalog.metrics.find((m) => m.name === name)
    ?? { name, unit: "", better: "neutral", chartable: true };
}

/** Chartable shared metrics for trend / rank selectors. */
export function chartableShared(
  rows: CoverageRow[],
  catalog: MetricCatalog = DEFAULT_METRIC_CATALOG,
): string[] {
  return sharedMetrics(rows, catalog).filter((n) => metaFor(n, catalog).chartable);
}
