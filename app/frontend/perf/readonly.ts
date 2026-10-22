// Read-only request policy for the page-latency harness.
//
// Browser runs must never mutate the shared Lakebase/Delta data (preview and
// prod share OLTP). Every GET/HEAD is a safe read. The app also renders two
// initial views by POSTing to endpoints that only COMPUTE a result server-side
// (no write): Historical Insights' AI narrative and Scenario Planning's live
// projection. Those two POSTs must be allowed so the pages can reach
// feature-ready; every other non-GET/HEAD request (create/patch/commit/publish/
// approve/upload/extraction/competitor analysis/...) is blocked.
//
// Pure and dependency-free so it can be unit-tested under vitest and reused by
// the Playwright runner's network gate.

import { normalizeApiPath } from "./analysis.ts";

/**
 * The only POST endpoints permitted during a read-only run. Both perform a
 * read-only computation required to render a page's initial state:
 *   - /api/historical-insights/narrative → AI "what changed" summary.
 *   - /api/scenario/project              → live P&L/cash projection.
 * There is deliberately no allow-all-writes escape hatch.
 */
export const COMPUTATIONAL_POST_PATHS: readonly string[] = [
  "/api/historical-insights/narrative",
  "/api/scenario/project",
];

/**
 * True when a request is safe to let through during a read-only run: any
 * GET/HEAD, or a POST to one of the reviewed computational endpoints. Everything
 * else (other POSTs and every PUT/PATCH/DELETE) is a potential mutation and must
 * be blocked. `urlOrPath` may be a full URL or a bare path; the query string and
 * origin are ignored.
 */
export function isReadOnlyRequest(method: string, urlOrPath: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  if (m === "POST") return COMPUTATIONAL_POST_PATHS.includes(normalizeApiPath(urlOrPath));
  return false;
}
