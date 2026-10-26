import { PageId } from "../nav";
import { cn } from "./cn";

export type LayoutMode = "standard" | "wide" | "full";

/** Density of the page workspace. Forms stay compact; dashboards widen;
 *  ledgers and graphs can use the full viewport. */
export const PAGE_LAYOUT: Record<PageId, LayoutMode> = {
  executive: "wide",
  dashboard: "wide",
  tasks: "wide",
  "trial-balance": "full",
  reconciliation: "wide",
  "financial-statements": "full",
  "comparative-statements": "full",
  approvals: "wide",
  "scenario-planning": "wide",
  "cash-flow": "full",
  "thirteen-week-cash": "full",
  "market-insights": "wide",
  "stress-test": "wide",
  exposure: "full",
  "inventory-exposure": "full",
  "close-support": "wide",
  "close-support-2": "wide",
  "historical-insights": "wide",
  "adhoc-analysis": "wide",
  "payment-behavior": "wide",
  "data-sources": "wide",
  "ai-roi-executive": "wide",
  "ai-roi-spend": "wide",
  "ai-roi-roi": "wide",
  "ai-roi-org": "wide",
  "ai-roi-efficiency": "wide",
  settings: "standard",
};

export function layoutForPage(page: PageId): LayoutMode {
  return PAGE_LAYOUT[page] ?? "standard";
}

export function shellContainerClass(mode: LayoutMode): string {
  return cn(
    "mx-auto w-full px-[var(--app-gutter)]",
    mode === "standard" && "max-w-[90rem]",
    mode === "wide" && "max-w-[105rem]",
    mode === "full" && "max-w-none",
  );
}
