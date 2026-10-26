// Shared, framework-free types for the page-latency harness.
//
// This module is intentionally free of Playwright and Node built-ins so the
// pure analysis/discovery/landmark logic can be unit-tested under vitest and
// re-used by the browser runner. Keep it erasable TypeScript (interfaces and
// type aliases only) so Node's type-stripping loader can import it directly.

import type { Industry } from "../src/lib/industries.ts";
import type { PageId } from "../src/nav.ts";

/** A persona as returned by `GET /api/personas` (only the fields we need). */
export interface HarnessPersona {
  id: string;
  name?: string;
  pages: string[];
  default_page: string;
  default_query?: string;
}

/** One (industry, persona) slice of the coverage matrix. */
export interface CoverageEntry {
  industry: Industry;
  personaId: string;
  personaName?: string;
  /** The nav-visible pages for this persona under this industry overlay. */
  pages: PageId[];
  /** The page the persona lands on after entering. */
  defaultPage: PageId;
}

/** A single captured API call for one page load. */
export interface ApiTiming {
  /** Request path (query string stripped) e.g. `/api/close/status`. */
  path: string;
  method: string;
  status: number;
  /** Wall-clock duration in milliseconds from request start to response end. */
  durationMs: number;
}

/** A request that never produced a successful response. */
export interface RequestFailure {
  url: string;
  method: string;
  /** HTTP status for >=400 responses, or 0 for network-level failures. */
  status: number;
  errorText?: string;
}

/** A console error or uncaught page error observed during a load. */
export interface ConsoleIssue {
  kind: "console.error" | "pageerror";
  text: string;
}

/** One timed navigation to feature-ready for a single page. */
export interface PageSample {
  /** Whether this was a cold-browser entry or a warm in-app navigation. */
  mode: "cold" | "warm";
  /** Milliseconds from navigation start to the feature-ready landmark. */
  featureReadyMs: number;
  /** True if the feature-ready landmark was never observed (timed out). */
  timedOut: boolean;
  api: ApiTiming[];
  failures: RequestFailure[];
  consoleIssues: ConsoleIssue[];
}

/** All samples collected for one (industry, persona, page) combination. */
export interface PageMeasurement {
  industry: Industry;
  personaId: string;
  page: PageId;
  cold: PageSample[];
  warm: PageSample[];
}

/** Immutable top-level result document written to `.ralph/latency/*.json`. */
export interface MatrixResult {
  /** ISO timestamp when the run started. */
  startedAt: string;
  /** Base URL the app was served from. */
  baseUrl: string;
  /** Samples requested per (combination, mode). */
  samples: number;
  measurements: PageMeasurement[];
}
