// Feature-ready landmarks for every navigable page.
//
// "Feature-ready" ends at a stable, page-specific visible landmark, NOT merely
// at `networkidle`. The mount proof is the app's page container itself
// (`#main-content`, which App.tsx remounts per page via `key={page}`) — NOT a
// universal `<h1>`, because several pages (Financial Statements, Variance
// Analysis, Competitor Benchmarking, Inventory Exposure) never render a
// PageHeading heading and a `#main-content h1` requirement made them time out
// forever.
//
// A page is feature-ready when its container is visible AND no *genuine* loading
// affordance remains inside it. Genuine loaders are element/attribute-scoped so
// that decorative pulses never count:
//   - `Skeleton`/`TableSkeleton` render `<div class="animate-pulse …">` blocks →
//     SKELETON_SELECTOR. Scoped to `div` (excludes the `<svg>` Sparkles icon and
//     the `<span>` AI shimmer bar) and `:not(.bg-brick)` (excludes the pulsing
//     StageBar/IDP "active" dot).
//   - `Loading` renders `<div role="status" aria-live="polite">` → the
//     STATUS_LOADER_SELECTOR requires the `aria-live` attribute so it never
//     matches Reconciliation's permanent `role="status"` PostOutcome banner.
//
// Broad `.animate-pulse` / `[role="status"]` families are deliberately NOT used
// (they falsely block on decorations and permanent banners). Pages can add a
// positive `extraSelector` where a distinctive stable content anchor exists
// (e.g. the Concentration force-graph `<canvas>`). This module is pure/DOM-free
// so it can be unit-tested under vitest; the browser runner consumes
// `featureReadyPlan()`.

import { PAGES, type PageId } from "../src/nav.ts";

/** The container the app mounts the active page into (see App.tsx). */
export const MAIN_CONTENT = "#main-content";

/**
 * Skeleton loading blocks (Skeleton / TableSkeleton). Scoped to `<div>` so the
 * decorative `<svg>` Sparkles icon and the `<span>` AI shimmer bar (both use
 * `.animate-pulse`) are ignored, and `:not(.bg-brick)` so the pulsing StageBar /
 * IDP "active" step dot is ignored.
 */
export const SKELETON_SELECTOR = `${MAIN_CONTENT} div.animate-pulse:not(.bg-brick)`;

/**
 * The genuine `Loading` spinner: `role="status"` WITH `aria-live`. Requiring
 * `aria-live` excludes Reconciliation's permanent `role="status"` PostOutcome
 * banner (which has no `aria-live`), so it never blocks feature-ready.
 */
export const STATUS_LOADER_SELECTOR = `${MAIN_CONTENT} [role="status"][aria-live]`;

/** Selectors whose *absence* inside main content signals data has settled. */
export const LOADER_SELECTORS: readonly string[] = [
  SKELETON_SELECTOR,
  STATUS_LOADER_SELECTOR,
];

export interface Landmark {
  /** Human description of the page-specific feature-ready condition. */
  description: string;
  /**
   * Optional extra element that must be visible for feature-ready, on top of
   * the container mount + loader-absence rule. Used where a page has a
   * distinctive, stable content element (e.g. a graph canvas).
   */
  extraSelector?: string;
}

/**
 * Per-page landmarks, keyed by the stable PageId (never by relabeled copy).
 * Descriptions are page-specific; `extraSelector` is added where a robust
 * content anchor exists today and can be extended during the audit.
 */
export const LANDMARKS: Record<PageId, Landmark> = {
  executive: { description: "Executive container mounted, KPI tiles rendered, no skeletons" },
  dashboard: { description: "Close dashboard container mounted, status tiles rendered, no skeletons" },
  tasks: { description: "Tasks container mounted, task table rendered, no skeletons" },
  "trial-balance": { description: "Trial Balance container mounted, TB table rendered, no skeletons" },
  reconciliation: { description: "Reconciliation container mounted, breaks table rendered, no skeletons" },
  "financial-statements": { description: "Financial Statements container mounted, statement rendered, no skeletons" },
  "comparative-statements": { description: "Variance Analysis container mounted, variance table rendered, no skeletons" },
  approvals: { description: "Approvals container mounted, adjustments table rendered, no skeletons" },
  "stress-test": { description: "Stress Test container mounted, levers rendered, no skeletons" },
  "market-insights": { description: "Market Insights container mounted, content rendered, no skeletons" },
  "scenario-planning": { description: "Scenario Planning container mounted, projection rendered, no skeletons" },
  "cash-flow": { description: "Cash Flow container mounted, cash-flow statement rendered, no skeletons" },
  "thirteen-week-cash": { description: "13-Week Cash container mounted, weekly grid rendered, no skeletons" },
  exposure: {
    description: "Concentration container mounted, force-graph canvas painted, no skeletons",
    extraSelector: `${MAIN_CONTENT} canvas`,
  },
  "inventory-exposure": { description: "Inventory Exposure container mounted, content rendered, no skeletons" },
  "close-support": { description: "Benchmarking container mounted, content rendered, no skeletons" },
  "close-support-2": { description: "Competitor benchmarking container mounted, content rendered, no skeletons" },
  "historical-insights": { description: "Historical Insights container mounted, charts rendered, no skeletons" },
  "adhoc-analysis": { description: "Ad-hoc Analysis container mounted, upload surface rendered, no skeletons" },
  "payment-behavior": { description: "Payment Behaviour container mounted, content rendered, no skeletons" },
  "data-sources": { description: "Lineage & Data Quality container mounted, lineage rendered, no skeletons" },
  settings: { description: "Settings container mounted, config form rendered, no skeletons" },
  "ai-roi-executive": { description: "AI ROI Executive container mounted, content rendered, no skeletons" },
  "ai-roi-spend": { description: "AI ROI Spend container mounted, content rendered, no skeletons" },
  "ai-roi-roi": { description: "AI ROI return container mounted, content rendered, no skeletons" },
  "ai-roi-org": { description: "AI ROI Org Explorer container mounted, content rendered, no skeletons" },
  "ai-roi-efficiency": { description: "AI ROI Efficiency container mounted, content rendered, no skeletons" },
};

export interface FeatureReadyPlan {
  page: PageId;
  /** Selectors that must be visible before the page is considered ready. */
  requireVisible: string[];
  /** Selectors whose count must reach zero before the page is considered ready. */
  requireAbsent: string[];
  description: string;
}

/** The concrete wait plan the browser runner should apply for a page. */
export function featureReadyPlan(page: PageId): FeatureReadyPlan {
  const landmark = LANDMARKS[page];
  const requireVisible = [MAIN_CONTENT];
  if (landmark?.extraSelector) requireVisible.push(landmark.extraSelector);
  return {
    page,
    requireVisible,
    requireAbsent: [...LOADER_SELECTORS],
    description: landmark?.description ?? `${page} container mounted, no skeletons`,
  };
}

/** True when every navigable page has a landmark entry (used by tests). */
export function assertLandmarkCoverage(): { missing: PageId[] } {
  const missing = PAGES.map((p) => p.id).filter((id) => !(id in LANDMARKS));
  return { missing };
}
