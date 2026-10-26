import { describe, expect, it } from "vitest";
import {
  landingPageForPersonaEntry,
  landingPageForPersonaSwitch,
  personaEntryDestination,
  resolveCtaPage,
  PageId,
  MODULE_GROUPS,
  isHiddenFromNav,
} from "../nav";
import { getOverlay } from "./industries";

const CFO: PageId[] = [
  "executive", "dashboard", "trial-balance", "financial-statements",
  "comparative-statements", "approvals", "market-insights", "scenario-planning", "historical-insights",
  "adhoc-analysis", "payment-behavior", "close-support-2", "data-sources",
  "ai-roi-executive", "ai-roi-spend", "ai-roi-roi", "ai-roi-org", "ai-roi-efficiency",
  "settings",
];

const CONTROLLER: PageId[] = [
  "executive", "dashboard", "tasks", "trial-balance",
  "reconciliation", "financial-statements", "comparative-statements",
  "approvals", "stress-test", "market-insights", "scenario-planning", "exposure", "inventory-exposure",
  "historical-insights", "adhoc-analysis", "payment-behavior", "data-sources",
  "ai-roi-executive", "ai-roi-spend", "ai-roi-roi", "ai-roi-org", "ai-roi-efficiency",
  "settings",
];

const ACCOUNTANT: PageId[] = [
  "reconciliation", "financial-statements", "trial-balance",
  "tasks", "data-sources", "settings",
];

describe("landingPageForPersonaSwitch", () => {
  it("keeps the same page when the new persona can see it", () => {
    expect(landingPageForPersonaSwitch("approvals", CONTROLLER, "dashboard"))
      .toBe("approvals");
    expect(landingPageForPersonaSwitch("dashboard", CFO, "executive"))
      .toBe("dashboard");
  });

  it("falls to a sibling in the same Close Execution group (tasks → approvals)", () => {
    expect(landingPageForPersonaSwitch("tasks", CFO, "executive"))
      .toBe("approvals");
  });

  it("falls to a sibling in Ledger & Variance (reconciliation → trial-balance)", () => {
    expect(landingPageForPersonaSwitch("reconciliation", CFO, "executive"))
      .toBe("trial-balance");
  });

  it("stays in the same module when the group is empty for the new persona", () => {
    expect(landingPageForPersonaSwitch("stress-test", ACCOUNTANT, "tasks"))
      .toBe("tasks");
  });

  it("picks another page in the same module when a group is hidden", () => {
    expect(landingPageForPersonaSwitch("inventory-exposure", CONTROLLER, "dashboard"))
      .toBe("inventory-exposure");
    expect(landingPageForPersonaSwitch("inventory-exposure", CFO, "executive"))
      .toBe("scenario-planning");
  });

  it("falls to a sibling in Variance Analysis (historical-insights)", () => {
    const withoutHist = CFO.filter((p) => p !== "historical-insights");
    expect(landingPageForPersonaSwitch("historical-insights", withoutHist, "executive"))
      .toBe("comparative-statements");
  });

  it("falls back to the persona default when nothing related is available", () => {
    expect(landingPageForPersonaSwitch("executive", ACCOUNTANT, "tasks"))
      .toBe("tasks");
  });

  it("falls back to the first available page if default is also unavailable", () => {
    const onlySettings: PageId[] = ["settings"];
    expect(landingPageForPersonaSwitch("tasks", onlySettings, "dashboard"))
      .toBe("settings");
  });
});

describe("landingPageForPersonaEntry", () => {
  it("keeps a deep link the selected persona can see", () => {
    expect(landingPageForPersonaEntry("trial-balance", CFO, "executive"))
      .toBe("trial-balance");
  });

  it("uses the persona home when the deep link is unavailable", () => {
    expect(landingPageForPersonaEntry("approvals", ACCOUNTANT, "tasks"))
      .toBe("tasks");
  });

  it("uses the first available page when the persona home is unavailable", () => {
    expect(landingPageForPersonaEntry("executive", ["settings"], "dashboard"))
      .toBe("settings");
  });
});

describe("personaEntryDestination", () => {
  it("preserves the query for an allowed deep link", () => {
    expect(personaEntryDestination(
      "tasks",
      "view=list",
      CONTROLLER,
      "dashboard",
      "",
    )).toEqual({ page: "tasks", query: "view=list" });
  });

  it("uses the persona default query when no valid deep link was requested", () => {
    expect(personaEntryDestination(
      null,
      "",
      ACCOUNTANT,
      "tasks",
      "view=calendar",
    )).toEqual({ page: "tasks", query: "view=calendar" });
  });

  it("drops an inaccessible deep link and uses the persona home query", () => {
    expect(personaEntryDestination(
      "approvals",
      "status=pending",
      ACCOUNTANT,
      "tasks",
      "view=calendar",
    )).toEqual({ page: "tasks", query: "view=calendar" });
  });
});

describe("resolveCtaPage (Month-End Close readiness / next action)", () => {
  it("Controller DQ Review stays on lineage & data quality", () => {
    expect(resolveCtaPage("data-sources", CONTROLLER)).toBe("data-sources");
  });

  it("CFO DQ Review lands in Data & Audit (data-sources)", () => {
    expect(resolveCtaPage("data-sources", CFO)).toBe("data-sources");
  });

  it("Accountant can open lineage & data quality", () => {
    expect(resolveCtaPage("data-sources", ACCOUNTANT)).toBe("data-sources");
  });

  it("Controller Triage stays on tasks", () => {
    expect(resolveCtaPage("tasks", CONTROLLER)).toBe("tasks");
  });

  it("CFO Triage lands on Approvals (Close Execution)", () => {
    expect(resolveCtaPage("tasks", CFO)).toBe("approvals");
  });

  it("CFO unexplained variances lands on trial-balance", () => {
    expect(resolveCtaPage("reconciliation", CFO)).toBe("trial-balance");
  });
});

function fpaTopics(personaPages: PageId[], overlayHidden: readonly PageId[]) {
  const allowed = new Set(
    personaPages.filter((p) => !isHiddenFromNav(p, overlayHidden)),
  );
  return MODULE_GROUPS.fpa
    .map((g) => ({ label: g.label, visible: g.pages.filter((p) => allowed.has(p)) }))
    .filter((g) => g.visible.length > 0);
}

describe("FP&A nav grouping after hide + regroup", () => {
  it("hides stress-test, inventory-exposure, and payment-behavior globally", () => {
    expect(isHiddenFromNav("stress-test", [])).toBe(true);
    expect(isHiddenFromNav("inventory-exposure", [])).toBe(true);
    expect(isHiddenFromNav("payment-behavior", [])).toBe(true);
    expect(isHiddenFromNav("exposure", [])).toBe(false);
  });

  it("CFO sees Performance & Trends pills and Planning & Risk as Scenario Planning + Market Insights", () => {
    const topics = fpaTopics(CFO, getOverlay("consumer").hiddenPages);
    expect(topics.map((t) => t.label)).toEqual([
      "Overview",
      "Performance & Trends",
      "Planning & Risk",
      "Competitors benchmarking",
    ]);
    expect(topics.find((t) => t.label === "Performance & Trends")?.visible).toEqual([
      "comparative-statements",
      "historical-insights",
      "adhoc-analysis",
    ]);
    expect(topics.find((t) => t.label === "Planning & Risk")?.visible).toEqual([
      "scenario-planning",
      "market-insights",
    ]);
  });

  it("Controller sees Scenario Planning and Concentration Risk, not stress or inventory", () => {
    const topics = fpaTopics(CONTROLLER, getOverlay("consumer").hiddenPages);
    expect(topics.find((t) => t.label === "Planning & Risk")?.visible).toEqual([
      "scenario-planning",
      "market-insights",
      "exposure",
    ]);
    const software = fpaTopics(CONTROLLER, getOverlay("software").hiddenPages);
    expect(software.find((t) => t.label === "Planning & Risk")?.visible).toEqual([
      "scenario-planning",
      "market-insights",
      "exposure",
    ]);
  });
});
