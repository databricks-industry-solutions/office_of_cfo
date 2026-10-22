import { describe, expect, it } from "vitest";
import {
  aggregateApiTimings,
  apiTimingsForPage,
  classifyChange,
  diffMatrices,
  meaningfulRegressions,
  median,
  normalizeApiPath,
  rankHotspots,
  renderDiagnosisMarkdown,
  summarizeMeasurement,
  summarizeResult,
  THRESHOLDS,
} from "./analysis.ts";
import type { MatrixResult, PageMeasurement, PageSample } from "./types.ts";

function sample(mode: "cold" | "warm", ms: number, extra: Partial<PageSample> = {}): PageSample {
  return {
    mode,
    featureReadyMs: ms,
    timedOut: false,
    api: [],
    failures: [],
    consoleIssues: [],
    ...extra,
  };
}

function measurement(over: Partial<PageMeasurement> = {}): PageMeasurement {
  return {
    industry: "consumer",
    personaId: "cfo",
    page: "executive",
    cold: [sample("cold", 1000), sample("cold", 1200), sample("cold", 1100)],
    warm: [sample("warm", 400), sample("warm", 500), sample("warm", 450)],
    ...over,
  };
}

describe("median", () => {
  it("handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("returns NaN for empty input", () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });
  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("summarizeMeasurement", () => {
  it("includes timed-out samples at their capped featureReadyMs in the median", () => {
    // A timed-out sample carries the timeout duration as its featureReadyMs, so
    // it must count toward the median (a timeout is a real, floor-bounded
    // latency observation) rather than being discarded.
    const m = measurement({
      cold: [sample("cold", 1000), sample("cold", 9999, { timedOut: true }), sample("cold", 1100)],
    });
    const s = summarizeMeasurement(m);
    expect(s.coldMedianMs).toBe(1100); // median of [1000, 1100, 9999]
    expect(s.warmMedianMs).toBe(450);
    expect(s.timeouts).toBe(1);
  });

  it("ranks a fully-timed-out cell at its timeout duration, not NaN", () => {
    // Regression guard: previously a cell where every sample timed out produced
    // a NaN median that rendered as "—" and sank to the bottom of the ranking,
    // hiding the very worst pages. It must now rank at the timeout duration.
    const m = measurement({
      cold: [sample("cold", 60000, { timedOut: true }), sample("cold", 60000, { timedOut: true })],
      warm: [sample("warm", 60000, { timedOut: true })],
    });
    const s = summarizeMeasurement(m);
    expect(s.coldMedianMs).toBe(60000);
    expect(s.warmMedianMs).toBe(60000);
    expect(s.timeouts).toBe(3);
    expect(Number.isNaN(s.coldMedianMs)).toBe(false);
  });
  it("counts failures and console errors across all samples", () => {
    const m = measurement({
      cold: [sample("cold", 1000, { failures: [{ url: "/api/x", method: "GET", status: 500 }] })],
      warm: [sample("warm", 400, { consoleIssues: [{ kind: "pageerror", text: "boom" }] })],
    });
    const s = summarizeMeasurement(m);
    expect(s.failedRequests).toBe(1);
    expect(s.consoleErrors).toBe(1);
  });
});

describe("rankHotspots", () => {
  it("ranks by the worst of cold/warm, slowest first", () => {
    const summaries = summarizeResult({
      startedAt: "t",
      baseUrl: "u",
      samples: 3,
      measurements: [
        measurement({ page: "executive", cold: [sample("cold", 800)], warm: [sample("warm", 300)] }),
        measurement({ page: "exposure", cold: [sample("cold", 2000)], warm: [sample("warm", 900)] }),
        measurement({ page: "tasks", cold: [sample("cold", 500)], warm: [sample("warm", 1500)] }),
      ],
    });
    const ranked = rankHotspots(summaries);
    expect(ranked.map((r) => r.page)).toEqual(["exposure", "tasks", "executive"]);
    expect(ranked[0].worstMs).toBe(2000);
    expect(ranked[0].worstMode).toBe("cold");
    expect(ranked[1].worstMode).toBe("warm");
  });

  it("ranks a fully-timed-out cell above a finite but faster cell", () => {
    const summaries = summarizeResult({
      startedAt: "t",
      baseUrl: "u",
      samples: 1,
      measurements: [
        measurement({ page: "data-sources", cold: [sample("cold", 13000)], warm: [sample("warm", 2000)] }),
        measurement({
          page: "financial-statements",
          cold: [sample("cold", 60000, { timedOut: true })],
          warm: [sample("warm", 60000, { timedOut: true })],
        }),
      ],
    });
    const ranked = rankHotspots(summaries);
    expect(ranked[0].page).toBe("financial-statements");
    expect(ranked[0].worstMs).toBe(60000);
  });
});

describe("classifyChange", () => {
  it("marks a change that clears both bars as improved", () => {
    // 2000 -> 1400: -600ms (>=500) and -30% (>=20%)
    expect(classifyChange(2000, 1400).kind).toBe("improved");
  });
  it("ignores an improvement that misses the absolute bar", () => {
    // 2000 -> 1550: -450ms (<500) even though -22.5%
    expect(classifyChange(2000, 1550).kind).toBe("neutral");
  });
  it("ignores an improvement that misses the relative bar", () => {
    // 5000 -> 4400: -600ms (>=500) but only -12% (<20%)
    expect(classifyChange(5000, 4400).kind).toBe("neutral");
  });
  it("marks a change that clears both regression bars as regressed", () => {
    // 1000 -> 1400: +400ms (>=300) and +40% (>=20%)
    expect(classifyChange(1000, 1400).kind).toBe("regressed");
  });
  it("ignores a regression that misses the absolute bar", () => {
    // 1000 -> 1250: +250ms (<300) even though +25%
    expect(classifyChange(1000, 1250).kind).toBe("neutral");
  });
  it("exposes the configured thresholds", () => {
    expect(THRESHOLDS.improveAbsMs).toBe(500);
    expect(THRESHOLDS.regressAbsMs).toBe(300);
  });
});

describe("diffMatrices", () => {
  const base: MatrixResult = {
    startedAt: "t0",
    baseUrl: "u",
    samples: 3,
    measurements: [
      measurement({ page: "exposure", cold: [sample("cold", 2000)], warm: [sample("warm", 800)] }),
      measurement({ page: "tasks", cold: [sample("cold", 900)], warm: [sample("warm", 400)] }),
    ],
  };

  it("classifies improvements and holds tasks neutral", () => {
    const after: MatrixResult = {
      startedAt: "t1",
      baseUrl: "u",
      samples: 3,
      measurements: [
        measurement({ page: "exposure", cold: [sample("cold", 1200)], warm: [sample("warm", 780)] }),
        measurement({ page: "tasks", cold: [sample("cold", 890)], warm: [sample("warm", 410)] }),
      ],
    };
    const changes = diffMatrices(base, after);
    const exposureCold = changes.find((c) => c.page === "exposure" && c.mode === "cold");
    expect(exposureCold?.verdict.kind).toBe("improved");
    // warm 800 -> 780 is tiny → neutral
    const exposureWarm = changes.find((c) => c.page === "exposure" && c.mode === "warm");
    expect(exposureWarm?.verdict.kind).toBe("neutral");
    expect(meaningfulRegressions(changes)).toHaveLength(0);
  });

  it("flags a meaningful regression", () => {
    const after: MatrixResult = {
      startedAt: "t1",
      baseUrl: "u",
      samples: 3,
      measurements: [
        measurement({ page: "exposure", cold: [sample("cold", 2000)], warm: [sample("warm", 800)] }),
        measurement({ page: "tasks", cold: [sample("cold", 1400)], warm: [sample("warm", 400)] }),
      ],
    };
    const regressions = meaningfulRegressions(diffMatrices(base, after));
    expect(regressions).toHaveLength(1);
    expect(regressions[0].page).toBe("tasks");
    expect(regressions[0].mode).toBe("cold");
  });

  it("skips cells missing from the baseline", () => {
    const after: MatrixResult = {
      startedAt: "t1",
      baseUrl: "u",
      samples: 3,
      measurements: [measurement({ page: "settings", cold: [sample("cold", 700)], warm: [sample("warm", 300)] })],
    };
    expect(diffMatrices(base, after)).toHaveLength(0);
  });
});

describe("api timing aggregation", () => {
  it("aggregates per-path medians sorted slowest first", () => {
    const samples: PageSample[] = [
      sample("cold", 1000, {
        api: [
          { path: "/api/slow", method: "GET", status: 200, durationMs: 800 },
          { path: "/api/fast", method: "GET", status: 200, durationMs: 50 },
        ],
      }),
      sample("cold", 1000, {
        api: [{ path: "/api/slow", method: "GET", status: 200, durationMs: 900 }],
      }),
    ];
    const stats = aggregateApiTimings(samples);
    expect(stats[0].path).toBe("/api/slow");
    expect(stats[0].medianMs).toBe(850);
    expect(stats[0].calls).toBe(2);
    expect(stats[1].path).toBe("/api/fast");
  });

  it("slices timings for a specific page via apiTimingsForPage", () => {
    const result: MatrixResult = {
      startedAt: "t",
      baseUrl: "u",
      samples: 1,
      measurements: [
        measurement({
          page: "exposure",
          cold: [sample("cold", 1000, { api: [{ path: "/api/exposure/graph", method: "GET", status: 200, durationMs: 1200 }] })],
          warm: [],
        }),
      ],
    };
    const stats = apiTimingsForPage(result, "consumer", "cfo", "exposure");
    expect(stats).toHaveLength(1);
    expect(stats[0].path).toBe("/api/exposure/graph");
  });
});

describe("normalizeApiPath", () => {
  it("strips origin and query string", () => {
    expect(normalizeApiPath("http://localhost:8000/api/tasks?scope=GLOBAL")).toBe("/api/tasks");
    expect(normalizeApiPath("/api/close/status?x=1")).toBe("/api/close/status");
  });
});

describe("renderDiagnosisMarkdown", () => {
  it("includes header stats and a ranked table", () => {
    const result: MatrixResult = {
      startedAt: "t",
      baseUrl: "http://localhost:8000",
      samples: 3,
      measurements: [
        measurement({
          page: "exposure",
          cold: [sample("cold", 2000, {
            api: [{ path: "/api/exposure/graph", method: "GET", status: 200, durationMs: 1200 }],
          })],
          warm: [sample("warm", 900)],
        }),
      ],
    };
    const md = renderDiagnosisMarkdown(result);
    expect(md).toContain("# Page-latency diagnosis");
    expect(md).toContain("http://localhost:8000");
    expect(md).toContain("| exposure |");
    expect(md).toContain("## Slow API routes in top hotspots");
    expect(md).toContain("`/api/exposure/graph`");
  });

  it("renders a fully-timed-out cell at its timeout duration, never as —", () => {
    const result: MatrixResult = {
      startedAt: "t",
      baseUrl: "http://localhost:8000",
      samples: 1,
      measurements: [
        measurement({
          page: "financial-statements",
          cold: [sample("cold", 60000, { timedOut: true })],
          warm: [sample("warm", 60000, { timedOut: true })],
        }),
      ],
    };
    const md = renderDiagnosisMarkdown(result);
    const row = md.split("\n").find((l) => l.includes("| financial-statements |"))!;
    expect(row).toContain("60000 ms");
    expect(row).not.toContain("—");
  });
});
