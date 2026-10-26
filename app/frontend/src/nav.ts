export type PageId =
  | "executive"
  | "dashboard"
  | "tasks"
  | "trial-balance"
  | "reconciliation"
  | "financial-statements"
  | "comparative-statements"
  | "approvals"
  | "stress-test"
  | "market-insights"
  | "scenario-planning"
  | "cash-flow"
  | "thirteen-week-cash"
  | "exposure"
  | "inventory-exposure"
  | "close-support"
  | "close-support-2"
  | "historical-insights"
  | "adhoc-analysis"
  | "payment-behavior"
  | "data-sources"
  | "ai-roi-executive"
  | "ai-roi-spend"
  | "ai-roi-roi"
  | "ai-roi-org"
  | "ai-roi-efficiency"
  | "settings";

export interface PageDef {
  id: PageId;
  label: string;
}

// Office of the CFO pages, in journey order. The persona switcher filters this
// list to each persona's visible pages; the full set is defined here once.
export const PAGES: PageDef[] = [
  { id: "executive", label: "Executive KPIs" },
  { id: "dashboard", label: "Close Dashboard" },
  { id: "tasks", label: "Tasks" },
  { id: "trial-balance", label: "Trial Balance" },
  { id: "reconciliation", label: "Reconciliation Breaks" },
  { id: "financial-statements", label: "Financial Statements" },
  { id: "comparative-statements", label: "Variance Analysis" },
  { id: "approvals", label: "Approvals" },
  { id: "stress-test", label: "Stress Test" },
  { id: "market-insights", label: "Market Insights" },
  { id: "scenario-planning", label: "Scenario Planning" },
  { id: "cash-flow", label: "Cash Flow" },
  { id: "thirteen-week-cash", label: "13-Week Cash" },
  { id: "exposure", label: "Concentration Risk" },
  { id: "inventory-exposure", label: "Inventory Exposure" },
  { id: "close-support", label: "Benchmarking" },
  { id: "close-support-2", label: "Competitors benchmarking" },
  { id: "historical-insights", label: "Historical Insights" },
  { id: "adhoc-analysis", label: "Ad-hoc Analysis" },
  { id: "payment-behavior", label: "Payment Behaviour" },
  { id: "data-sources", label: "Lineage & Data Quality" },
  { id: "ai-roi-executive", label: "Executive" },
  { id: "ai-roi-spend", label: "Spend" },
  { id: "ai-roi-roi", label: "ROI" },
  { id: "ai-roi-org", label: "Org Explorer" },
  { id: "ai-roi-efficiency", label: "Efficiency" },
  { id: "settings", label: "Settings" },
];

/** Pages that stay in the codebase and persona lists but are omitted from nav. */
export const GLOBALLY_HIDDEN_PAGES: readonly PageId[] = [
  "stress-test",
  "inventory-exposure",
  "payment-behavior",
];

export function isHiddenFromNav(
  page: PageId,
  overlayHidden: readonly PageId[],
): boolean {
  return GLOBALLY_HIDDEN_PAGES.includes(page) || overlayHidden.includes(page);
}

export interface ModuleDef {
  id: string;
  label: string;
  enabled: boolean;
  /** Optional small label shown next to the module tab (e.g. "Beta"). */
  badge?: string;
}

// Level 1 of the top menu. Month-End Close and FP&A are live today; Treasury and
// Tax are forward-looking placeholders for the Office of the CFO suite.
export const MODULES: ModuleDef[] = [
  { id: "crr3", label: "Month-End Close", enabled: true },
  { id: "fpa", label: "FP&A", enabled: true },
  { id: "ai-roi", label: "AI ROI", enabled: true },
  { id: "treasury", label: "Treasury", enabled: false },
  { id: "tax", label: "Tax", enabled: false },
];

// Level 2 of the top menu: topic groups that live inside a module. Each group
// holds one or more pages; multi-page groups reveal a Level 3 pill row.
export interface NavGroup {
  id: string;
  label: string;
  pages: PageId[];
}

// Module → topic groups. The live modules (crr3, fpa) have topics; Treasury and
// Tax are placeholders with no pages yet. `settings` is intentionally excluded —
// it is surfaced as a gear icon, not a topic.
export const MODULE_GROUPS: Record<string, NavGroup[]> = {
  crr3: [
    { id: "overview", label: "Overview", pages: ["dashboard"] },
    // Labelled for the work, not for one of its pages, or Approvals reads as
    // misfiled under a group named after Tasks.
    { id: "close-tasks", label: "Close Execution", pages: ["tasks", "approvals"] },
    { id: "ledger-recon", label: "Ledger & Variance", pages: ["trial-balance", "reconciliation"] },
    { id: "reporting", label: "Reporting", pages: ["financial-statements"] },
    { id: "data-audit", label: "Data & Audit", pages: ["data-sources"] },
  ],
  fpa: [
    { id: "fpa-overview", label: "Overview", pages: ["executive"] },
    { id: "fpa-planning", label: "Performance & Trends", pages: ["comparative-statements", "historical-insights", "adhoc-analysis", "payment-behavior"] },
    { id: "fpa-risk", label: "Planning & Risk", pages: ["scenario-planning", "cash-flow", "thirteen-week-cash", "market-insights", "exposure", "inventory-exposure", "stress-test"] },
    { id: "fpa-benchmarking", label: "Competitors benchmarking", pages: ["close-support-2"] },
  ],
  "ai-roi": [
    { id: "ai-roi-executive", label: "Executive", pages: ["ai-roi-executive"] },
    { id: "ai-roi-spend", label: "Spend", pages: ["ai-roi-spend"] },
    { id: "ai-roi-roi", label: "ROI", pages: ["ai-roi-roi"] },
    { id: "ai-roi-org", label: "Org Explorer", pages: ["ai-roi-org"] },
    { id: "ai-roi-efficiency", label: "Efficiency", pages: ["ai-roi-efficiency"] },
  ],
};

/** The topic group that owns a page (for active-tab highlighting). */
export function groupForPage(pageId: PageId): NavGroup | undefined {
  for (const groups of Object.values(MODULE_GROUPS))
    for (const g of groups)
      if (g.pages.includes(pageId)) return g;
  return undefined;
}

/** The module id that owns a topic group. */
export function moduleForGroup(groupId: string): string | undefined {
  for (const [moduleId, groups] of Object.entries(MODULE_GROUPS))
    if (groups.some((g) => g.id === groupId)) return moduleId;
  return undefined;
}

/** The module id that owns a page (via its topic group). */
export function moduleForPage(pageId: PageId): string | undefined {
  const g = groupForPage(pageId);
  return g ? moduleForGroup(g.id) : undefined;
}

/**
 * Pick where to land after a persona switch so the user keeps context when
 * possible. `available` is the new persona's visible pages (already filtered
 * for the active industry overlay).
 *
 * Order: same page → same nav group → same module → persona default → first
 * available page.
 */
export function landingPageForPersonaSwitch(
  current: PageId,
  available: readonly PageId[],
  defaultPage: PageId,
): PageId {
  const can = (p: PageId) => available.includes(p);

  if (can(current)) return current;

  const group = groupForPage(current);
  if (group) {
    const sibling = group.pages.find(can);
    if (sibling) return sibling;
  }

  const moduleId = moduleForPage(current);
  if (moduleId) {
    for (const g of MODULE_GROUPS[moduleId] ?? []) {
      const hit = g.pages.find(can);
      if (hit) return hit;
    }
  }

  if (can(defaultPage)) return defaultPage;
  return available[0] ?? defaultPage;
}

/** Pick the initial page after the entrance without applying switch heuristics. */
export function landingPageForPersonaEntry(
  requested: PageId,
  available: readonly PageId[],
  defaultPage: PageId,
): PageId {
  if (available.includes(requested)) return requested;
  if (available.includes(defaultPage)) return defaultPage;
  return available[0] ?? defaultPage;
}

export function personaEntryDestination(
  requested: PageId | null,
  requestedQuery: string,
  available: readonly PageId[],
  defaultPage: PageId,
  defaultQuery = "",
): { page: PageId; query: string } {
  const page = landingPageForPersonaEntry(
    requested ?? defaultPage,
    available,
    defaultPage,
  );
  const query = requested && page === requested
    ? requestedQuery
    : (page === defaultPage ? defaultQuery : "");
  return { page, query };
}

/** Resolve a CTA preferred page to one the current persona can actually open. */
export function resolveCtaPage(
  preferred: PageId,
  available: readonly PageId[],
): PageId {
  if (available.length === 0) return preferred;
  return landingPageForPersonaSwitch(preferred, available, available[0]);
}
