// Pure result-analysis logic for the page-latency harness.
//
// Everything here is deterministic and dependency-free so it can be unit-tested
// under vitest without a browser. The Playwright runner produces raw
// `MatrixResult` documents; this module turns them into medians, a ranked
// diagnosis, and a before/after comparison.

import type {
  ApiTiming,
  MatrixResult,
  PageMeasurement,
  PageSample,
} from "./types.ts";

/**
 * Improvement/regression thresholds from the audit definition. A change only
 * "counts" when it clears BOTH the relative and the absolute bar, so tiny
 * absolute deltas on fast pages and tiny relative deltas on slow pages are
 * both ignored as noise.
 */
export const THRESHOLDS = {
  /** A useful improvement is at least this much faster, relatively. */
  improveRel: 0.2,
  /** ...and at least this many milliseconds faster. */
  improveAbsMs: 500,
  /** A meaningful regression is at least this much slower, relatively. */
  regressRel: 0.2,
  /** ...and at least this many milliseconds slower. */
  regressAbsMs: 300,
} as const;

/** Median of a list of numbers. Returns NaN for an empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Latency observations for a mode. A timed-out sample carries the timeout
 * duration as its `featureReadyMs`, and that IS a real (floor-bounded) latency
 * observation: the page took *at least* that long to become feature-ready.
 * Including timeouts keeps a fully-timed-out cell ranked at its timeout duration
 * instead of collapsing to a NaN median that renders as "—" and hides the very
 * worst pages.
 */
function latencyValues(samples: readonly PageSample[]): number[] {
  return samples.map((s) => s.featureReadyMs);
}

export interface CellSummary {
  industry: string;
  personaId: string;
  page: string;
  coldMedianMs: number;
  warmMedianMs: number;
  coldSamples: number;
  warmSamples: number;
  /** Samples that never reached feature-ready (cold + warm). */
  timeouts: number;
  /** Distinct failed requests observed across all samples for this cell. */
  failedRequests: number;
  /** Distinct console/page errors observed across all samples for this cell. */
  consoleErrors: number;
}

/** Collapse one (industry, persona, page) measurement into medians + health. */
export function summarizeMeasurement(m: PageMeasurement): CellSummary {
  const all = [...m.cold, ...m.warm];
  return {
    industry: m.industry,
    personaId: m.personaId,
    page: m.page,
    coldMedianMs: median(latencyValues(m.cold)),
    warmMedianMs: median(latencyValues(m.warm)),
    coldSamples: m.cold.length,
    warmSamples: m.warm.length,
    timeouts: all.filter((s) => s.timedOut).length,
    failedRequests: all.reduce((n, s) => n + s.failures.length, 0),
    consoleErrors: all.reduce((n, s) => n + s.consoleIssues.length, 0),
  };
}

export function summarizeResult(result: MatrixResult): CellSummary[] {
  return result.measurements.map(summarizeMeasurement);
}

export interface RankedHotspot extends CellSummary {
  /** The slower of the cold/warm medians — the headline latency for ranking. */
  worstMs: number;
  /** Which mode produced `worstMs`. */
  worstMode: "cold" | "warm";
}

/**
 * Rank cells by their worst feature-ready median, slowest first. Cells with no
 * successful sample in a mode fall back to the other mode; cells with neither
 * sort last (worstMs = -Infinity is impossible, so we use 0 and push NaN down).
 */
export function rankHotspots(summaries: readonly CellSummary[]): RankedHotspot[] {
  const ranked = summaries.map((s): RankedHotspot => {
    const cold = s.coldMedianMs;
    const warm = s.warmMedianMs;
    const coldOk = Number.isFinite(cold);
    const warmOk = Number.isFinite(warm);
    let worstMs: number;
    let worstMode: "cold" | "warm";
    if (coldOk && warmOk) {
      worstMs = Math.max(cold, warm);
      worstMode = cold >= warm ? "cold" : "warm";
    } else if (coldOk) {
      worstMs = cold;
      worstMode = "cold";
    } else if (warmOk) {
      worstMs = warm;
      worstMode = "warm";
    } else {
      worstMs = NaN;
      worstMode = "cold";
    }
    return { ...s, worstMs, worstMode };
  });
  return ranked.sort((a, b) => {
    const av = Number.isFinite(a.worstMs) ? a.worstMs : -1;
    const bv = Number.isFinite(b.worstMs) ? b.worstMs : -1;
    return bv - av;
  });
}

/**
 * Aggregate API timings across a measurement's samples into per-path medians so
 * the diagnosis can point at the exact slow backend route.
 */
export interface ApiPathStat {
  path: string;
  medianMs: number;
  maxMs: number;
  calls: number;
}

export function aggregateApiTimings(
  samples: readonly PageSample[],
): ApiPathStat[] {
  const byPath = new Map<string, number[]>();
  for (const s of samples) {
    for (const t of s.api) {
      const arr = byPath.get(t.path) ?? [];
      arr.push(t.durationMs);
      byPath.set(t.path, arr);
    }
  }
  const stats: ApiPathStat[] = [];
  for (const [path, durations] of byPath) {
    stats.push({
      path,
      medianMs: median(durations),
      maxMs: Math.max(...durations),
      calls: durations.length,
    });
  }
  return stats.sort((a, b) => b.medianMs - a.medianMs);
}

export type ChangeKind = "improved" | "regressed" | "neutral";

export interface ChangeVerdict {
  kind: ChangeKind;
  beforeMs: number;
  afterMs: number;
  deltaMs: number;
  deltaRel: number;
}

/**
 * Classify a before/after latency pair using the audit thresholds. A change is
 * only "improved"/"regressed" when it clears both the relative and the absolute
 * bar; everything else is "neutral".
 */
export function classifyChange(beforeMs: number, afterMs: number): ChangeVerdict {
  const deltaMs = afterMs - beforeMs;
  const deltaRel = beforeMs > 0 ? deltaMs / beforeMs : 0;
  let kind: ChangeKind = "neutral";
  if (Number.isFinite(beforeMs) && Number.isFinite(afterMs) && beforeMs > 0) {
    const fasterBy = -deltaMs;
    const fasterRel = -deltaRel;
    if (fasterBy >= THRESHOLDS.improveAbsMs && fasterRel >= THRESHOLDS.improveRel) {
      kind = "improved";
    } else if (deltaMs >= THRESHOLDS.regressAbsMs && deltaRel >= THRESHOLDS.regressRel) {
      kind = "regressed";
    }
  }
  return { kind, beforeMs, afterMs, deltaMs, deltaRel };
}

export interface CellKey {
  industry: string;
  personaId: string;
  page: string;
}

export interface CellChange extends CellKey {
  mode: "cold" | "warm";
  verdict: ChangeVerdict;
}

function cellKey(k: CellKey): string {
  return `${k.industry}|${k.personaId}|${k.page}`;
}

/**
 * Compare an "after" result against an immutable baseline, cell by cell and mode
 * by mode. Cells present in only one run are skipped (missing coverage is
 * reported separately by the runner, not inferred here).
 */
export function diffMatrices(
  baseline: MatrixResult,
  after: MatrixResult,
): CellChange[] {
  const beforeByKey = new Map<string, CellSummary>();
  for (const s of summarizeResult(baseline)) beforeByKey.set(cellKey(s), s);
  const changes: CellChange[] = [];
  for (const a of summarizeResult(after)) {
    const b = beforeByKey.get(cellKey(a));
    if (!b) continue;
    for (const mode of ["cold", "warm"] as const) {
      const beforeMs = mode === "cold" ? b.coldMedianMs : b.warmMedianMs;
      const afterMs = mode === "cold" ? a.coldMedianMs : a.warmMedianMs;
      if (!Number.isFinite(beforeMs) || !Number.isFinite(afterMs)) continue;
      changes.push({
        industry: a.industry,
        personaId: a.personaId,
        page: a.page,
        mode,
        verdict: classifyChange(beforeMs, afterMs),
      });
    }
  }
  return changes;
}

/** The regressions from a diff that clear the meaningful-regression bar. */
export function meaningfulRegressions(changes: readonly CellChange[]): CellChange[] {
  return changes.filter((c) => c.verdict.kind === "regressed");
}

function ms(n: number): string {
  return Number.isFinite(n) ? `${Math.round(n)} ms` : "—";
}

/** Render a ranked diagnosis as Markdown (pure — no file I/O). */
export function renderDiagnosisMarkdown(
  result: MatrixResult,
  topN = 15,
): string {
  const summaries = summarizeResult(result);
  const ranked = rankHotspots(summaries);
  const totalFailures = summaries.reduce((n, s) => n + s.failedRequests, 0);
  const totalConsole = summaries.reduce((n, s) => n + s.consoleErrors, 0);
  const totalTimeouts = summaries.reduce((n, s) => n + s.timeouts, 0);

  const lines: string[] = [];
  lines.push(`# Page-latency diagnosis`);
  lines.push("");
  lines.push(`- Base URL: \`${result.baseUrl}\``);
  lines.push(`- Started: ${result.startedAt}`);
  lines.push(`- Samples per mode: ${result.samples}`);
  lines.push(`- Cells measured: ${summaries.length}`);
  lines.push(`- Feature-ready timeouts: ${totalTimeouts}`);
  lines.push(`- Failed requests: ${totalFailures}`);
  lines.push(`- Console/page errors: ${totalConsole}`);
  lines.push("");
  lines.push(`## Top ${Math.min(topN, ranked.length)} latency hotspots`);
  lines.push("");
  lines.push(`| # | Industry | Persona | Page | Worst | Cold | Warm | Fails | Errors |`);
  lines.push(`|---|----------|---------|------|-------|------|------|-------|--------|`);
  ranked.slice(0, topN).forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.industry} | ${r.personaId} | ${r.page} | ` +
        `${ms(r.worstMs)} (${r.worstMode}) | ${ms(r.coldMedianMs)} | ` +
        `${ms(r.warmMedianMs)} | ${r.failedRequests} | ${r.consoleErrors} |`,
    );
  });
  lines.push("");
  lines.push("## Slow API routes in top hotspots");
  lines.push("");
  lines.push("| Industry | Persona | Page | API path | Median | Max | Calls |");
  lines.push("|----------|---------|------|----------|--------|-----|-------|");
  for (const r of ranked.slice(0, topN)) {
    for (const api of apiTimingsForPage(
      result, r.industry, r.personaId, r.page,
    ).slice(0, 3)) {
      lines.push(
        `| ${r.industry} | ${r.personaId} | ${r.page} | \`${api.path}\` | ` +
          `${ms(api.medianMs)} | ${ms(api.maxMs)} | ${api.calls} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Slice API-timing aggregates for a single page across a result. */
export function apiTimingsForPage(
  result: MatrixResult,
  industry: string,
  personaId: string,
  page: string,
): ApiPathStat[] {
  const m = result.measurements.find(
    (x) => x.industry === industry && x.personaId === personaId && x.page === page,
  );
  if (!m) return [];
  const samples: PageSample[] = [...m.cold, ...m.warm];
  return aggregateApiTimings(samples);
}

/** Normalize an API request URL to a stable, query-free path for grouping. */
export function normalizeApiPath(rawUrl: string): string {
  let path = rawUrl;
  try {
    // Absolute URL → pathname; relative already a path.
    path = new URL(rawUrl, "http://x").pathname;
  } catch {
    /* keep raw */
  }
  const q = path.indexOf("?");
  return q >= 0 ? path.slice(0, q) : path;
}

/** True when a captured timing looks like an app API call worth ranking. */
export function isApiTiming(t: ApiTiming): boolean {
  return t.path.startsWith("/api/");
}
