import { describe, expect, it } from "vitest";
import {
  assertLandmarkCoverage,
  featureReadyPlan,
  LANDMARKS,
  LOADER_SELECTORS,
  MAIN_CONTENT,
  SKELETON_SELECTOR,
  STATUS_LOADER_SELECTOR,
} from "./landmarks.ts";
import { PAGES } from "../src/nav.ts";

describe("landmark coverage", () => {
  it("defines a landmark for every navigable page", () => {
    expect(assertLandmarkCoverage().missing).toEqual([]);
  });

  it("has no landmark for a page that is not in the nav", () => {
    // Guards against stale entries drifting from the real PageId union.
    const navIds = new Set(PAGES.map((p) => p.id));
    for (const key of Object.keys(LANDMARKS)) {
      expect(navIds.has(key as (typeof PAGES)[number]["id"])).toBe(true);
    }
  });
});

describe("featureReadyPlan mount proof", () => {
  it("requires the remounted main-content container, not a universal <h1>", () => {
    // Several pages (Financial Statements, Variance Analysis, Competitor
    // Benchmarking, Inventory Exposure) never render a PageHeading <h1>, so a
    // `#main-content h1` requirement made them time out forever. The mount proof
    // must be the container itself.
    const plan = featureReadyPlan("financial-statements");
    expect(plan.requireVisible).toContain(MAIN_CONTENT);
    expect(plan.requireVisible).not.toContain("#main-content h1");
  });

  it("adds the page-specific extra selector when present", () => {
    const plan = featureReadyPlan("exposure");
    expect(plan.requireVisible).toContain(MAIN_CONTENT);
    expect(plan.requireVisible).toContain("#main-content canvas");
  });

  it("requires only the container for pages without an extra anchor", () => {
    const plan = featureReadyPlan("settings");
    expect(plan.requireVisible).toEqual([MAIN_CONTENT]);
  });
});

describe("loader selectors ignore permanent and decorative elements", () => {
  it("waits only on skeleton blocks and aria-live loaders", () => {
    const plan = featureReadyPlan("comparative-statements");
    expect(plan.requireAbsent).toEqual([...LOADER_SELECTORS]);
    expect(LOADER_SELECTORS).toContain(SKELETON_SELECTOR);
    expect(LOADER_SELECTORS).toContain(STATUS_LOADER_SELECTOR);
  });

  it("does not treat the broad `.animate-pulse` / `[role=status]` families as loaders", () => {
    // Decorative Sparkles icons (<svg>), AI shimmer bars (<span>), pulsing
    // `bg-brick` stage dots, and permanent Reconciliation `role=status` banners
    // (no aria-live) must NOT block feature-ready.
    expect(LOADER_SELECTORS).not.toContain("#main-content .animate-pulse");
    expect(LOADER_SELECTORS).not.toContain('#main-content [role="status"]');
    // Skeletons are <div> blocks and exclude the pulsing stage dot.
    expect(SKELETON_SELECTOR).toContain("div.animate-pulse");
    expect(SKELETON_SELECTOR).toContain(":not(.bg-brick)");
    // Genuine Loading uses role=status WITH aria-live; permanent banners do not.
    expect(STATUS_LOADER_SELECTOR).toContain("[aria-live]");
  });
});
