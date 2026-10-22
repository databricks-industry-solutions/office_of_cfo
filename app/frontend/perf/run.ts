// CLI entry point for the page-latency harness.
//
// Usage (from app/frontend):
//   node perf/run.ts --base-url http://localhost:8000 --samples 3 \
//                    --out .ralph/latency/local-baseline.json
//
// Discovers the persona-visible navigation for every industry from the running
// app, measures cold + warm feature-ready medians for each (industry, persona,
// page), and writes an immutable raw result JSON plus a ranked diagnosis
// Markdown. Generated artifacts default to the gitignored `.ralph/latency/`
// directory and must never be committed.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDiagnosisMarkdown } from "./analysis.ts";
import { launchBrowser, measureEntry, DEFAULT_OPTIONS, type MeasureOptions } from "./browser.ts";
import { buildCoverageMatrix, countCombinations } from "./discovery.ts";
import { INDUSTRIES, type Industry } from "../src/lib/industries.ts";
import type { CoverageEntry, HarnessPersona, MatrixResult, PageMeasurement } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

interface CliArgs {
  baseUrl: string;
  samples: number;
  timeoutMs: number;
  out: string;
  md: string;
  industries: Industry[];
  personaFilter: string[] | null;
  headed: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const baseUrl = (get("--base-url") ?? process.env.PERF_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
  const samples = Number(get("--samples") ?? DEFAULT_OPTIONS.samples);
  const timeoutMs = Number(get("--timeout") ?? DEFAULT_OPTIONS.timeoutMs);
  const outArg = get("--out") ?? ".ralph/latency/local-baseline.json";
  const out = isAbsolute(outArg) ? outArg : resolve(REPO_ROOT, outArg);
  const mdArg = get("--md");
  const md = mdArg
    ? (isAbsolute(mdArg) ? mdArg : resolve(REPO_ROOT, mdArg))
    : out.replace(/\.json$/, ".md");

  const industriesArg = get("--industries");
  const industries = industriesArg
    ? (industriesArg.split(",").map((s) => s.trim()).filter((s): s is Industry => (INDUSTRIES as string[]).includes(s)))
    : [...INDUSTRIES];

  const personasArg = get("--personas");
  const personaFilter = personasArg ? personasArg.split(",").map((s) => s.trim()) : null;

  return {
    baseUrl,
    samples: Number.isFinite(samples) && samples > 0 ? samples : DEFAULT_OPTIONS.samples,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_OPTIONS.timeoutMs,
    out,
    md,
    industries,
    personaFilter,
    headed: has("--headed"),
  };
}

interface RawPersona {
  id: string;
  label?: string;
  name?: string;
  pages: string[];
  default_page: string;
  default_query?: string;
}

/** Fetch the persona roster for one industry from the running app. */
async function fetchPersonas(baseUrl: string, industry: Industry): Promise<HarnessPersona[]> {
  const res = await fetch(`${baseUrl}/api/personas`, {
    headers: { "X-Industry": industry },
  });
  if (!res.ok) throw new Error(`GET /api/personas [${industry}] → ${res.status}`);
  const body = (await res.json()) as { personas: RawPersona[] };
  return (body.personas ?? []).map((p) => ({
    id: p.id,
    name: p.name ?? p.label,
    pages: p.pages,
    default_page: p.default_page,
    default_query: p.default_query,
  }));
}

function applyPersonaFilter(entry: CoverageEntry, filter: string[] | null): boolean {
  return filter === null || filter.includes(entry.personaId);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[perf] base-url   : ${args.baseUrl}`);
  console.log(`[perf] industries : ${args.industries.join(", ")}`);
  console.log(`[perf] samples    : ${args.samples} (per mode)`);
  console.log(`[perf] read-only  : yes (non-GET/HEAD /api blocked; 2 reviewed computational POSTs allowed)`);

  // Discover persona-visible navigation per industry from the running app.
  const personasByIndustry: Partial<Record<Industry, HarnessPersona[]>> = {};
  for (const industry of args.industries) {
    personasByIndustry[industry] = await fetchPersonas(args.baseUrl, industry);
  }
  const matrix = buildCoverageMatrix(personasByIndustry, args.industries).filter((e) =>
    applyPersonaFilter(e, args.personaFilter),
  );
  const plannedCombos = countCombinations(matrix);
  console.log(`[perf] coverage   : ${matrix.length} persona/industry slices, ${plannedCombos} page combinations`);

  const opts: MeasureOptions = {
    baseUrl: args.baseUrl,
    samples: args.samples,
    timeoutMs: args.timeoutMs,
    // Read-only is non-negotiable: there is deliberately no flag to disable it.
    blockWrites: true,
    headed: args.headed,
  };

  const browser = await launchBrowser(args.headed);
  const measurements: PageMeasurement[] = [];
  const startedAt = new Date().toISOString();
  try {
    for (const entry of matrix) {
      console.log(`[perf] measuring  : ${entry.industry} / ${entry.personaId} (${entry.pages.length} pages)`);
      const entryMeasurements = await measureEntry(browser, entry, opts);
      measurements.push(...entryMeasurements);
    }
  } finally {
    await browser.close();
  }

  const result: MatrixResult = {
    startedAt,
    baseUrl: args.baseUrl,
    samples: args.samples,
    measurements,
  };

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(result, null, 2) + "\n", "utf8");
  await mkdir(dirname(args.md), { recursive: true });
  await writeFile(args.md, renderDiagnosisMarkdown(result), "utf8");

  const measuredCombos = measurements.length;
  const failures = measurements.reduce(
    (n, m) => n + [...m.cold, ...m.warm].reduce((k, s) => k + s.failures.length, 0),
    0,
  );
  const consoleErrors = measurements.reduce(
    (n, m) => n + [...m.cold, ...m.warm].reduce((k, s) => k + s.consoleIssues.length, 0),
    0,
  );
  console.log(`[perf] measured   : ${measuredCombos}/${plannedCombos} combinations`);
  console.log(`[perf] failures   : ${failures} failed requests, ${consoleErrors} console/page errors`);
  console.log(`[perf] wrote raw  : ${args.out}`);
  console.log(`[perf] wrote diag : ${args.md}`);
  if (measuredCombos !== plannedCombos) {
    console.warn(`[perf] WARNING: measured ${measuredCombos} of ${plannedCombos} planned combinations`);
  }
}

main().catch((err) => {
  console.error("[perf] fatal:", err);
  process.exit(1);
});
