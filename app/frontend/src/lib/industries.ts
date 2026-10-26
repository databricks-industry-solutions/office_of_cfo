import type { PageId } from "../nav";
import type { StatementNote } from "./statementNotes";

// Cross-vertical overlay: relabel + copy layer over the (per-industry) close app.
// Each industry now also has its OWN data (own Unity Catalog schema set + Lakebase
// instance + real headline KPIs) resolved server-side from the X-Industry header;
// this overlay drives the visible copy, KPI labels, terminology, and which tiles
// are shown. Five first-class industries (FY2025, illustrative and brand-free;
// see data_generation/industry_profiles.py): consumer goods group, enterprise SaaS
// vendor, European bank, integrated energy company, global ETP market maker.
export type Industry = "consumer" | "software" | "fsi" | "energy" | "capmarkets";

export const INDUSTRIES: Industry[] = ["consumer", "software", "fsi", "energy", "capmarkets"];
export const DEFAULT_INDUSTRY: Industry = "consumer";

export interface PageCopy {
  eyebrow?: string;
  title?: string;
}

export interface ExposureCopy {
  /** Singular noun for the AR side (customer / counterparty). */
  noun: string;
  /** Singular noun for the AP side (vendor / supplier). */
  vendorNoun: string;
  /** Review action wording ("credit review" / "account review"). */
  action: string;
  /** AR/AP toggle labels shown on the Concentration/Exposure page. */
  arToggle?: string;
  apToggle?: string;
}

export interface AiRoiRevenueDimension {
  id: string;
  label: string;
  noun: string;
}

export interface AiRoiCopy {
  revenueDimensions: AiRoiRevenueDimension[];
}

export interface Overlay {
  id: Industry;
  /** Short industry name shown in the logo dropdown + brand sub-line. */
  label: string;
  /** Per-page nav label overrides (keyed by PageId). */
  navLabels: Partial<Record<PageId, string>>;
  /** Pages hidden entirely for this industry. */
  hiddenPages: PageId[];
  /** Per-page heading overrides (eyebrow/title/lead). */
  pageCopy: Partial<Record<PageId, PageCopy>>;
  /** KPI display-label overrides, keyed by stable id (dso/dpo/dio/ccc). */
  kpiLabels: Record<string, string>;
  /** KPI ids to hide (e.g. inventory-based DIO where it's meaningless). */
  hiddenKpis: string[];
  /** Label for the cost-of-revenue line (COGS / Cost of Revenue / Cost of Services). */
  cogsLabel: string;
  /** Financial-statement relabels, keyed by stable line id (revenue / cogs /
   *  gross_profit / opex / operating_income / net_income) plus the tab-title keys
   *  income / balance / cashflow. Same statements, different words per industry. */
  statementLabels?: Record<string, string>;
  /** Statement line ids to suppress (e.g. banks hide cogs + gross_profit). */
  hiddenStatementLines?: string[];
  /** Inventory-exposure page copy (title + noun). The page is hidden via
   *  hiddenPages for industries where inventory isn't a working-capital lens. */
  inventoryExposureCopy?: { title: string; noun: string };
  /** Genie suggestion chips shown in the assistant. */
  genieChips: string[];
  /** Concentration/exposure terminology. */
  exposure: ExposureCopy;
  /** Stress-test lever ids to hide (e.g. "inventory"). */
  stressHiddenLevers: string[];
  /** Stress-test lever label overrides, keyed by lever id (e.g. inventory). */
  stressLeverLabels?: Record<string, string>;
  /** Optional per-industry visual feature flags (default off = functional parity). */
  features?: Partial<Record<string, boolean>>;
  /** Optional per-industry statements notes override (defaults come from statementNotes.ts). */
  statementNotes?: StatementNote[];
  /** AI ROI message titles and industry terminology. */
  aiRoi: AiRoiCopy;
}

const AI_ROI_BASE: AiRoiCopy = {
  revenueDimensions: [
    { id: "business_unit", label: "BU", noun: "BUs" },
    { id: "use_case", label: "Project", noun: "projects" },
    { id: "market", label: "Market", noun: "markets" },
  ],
};

const CONSUMER: Overlay = {
  id: "consumer",
  label: "Consumer Goods",
  navLabels: {
    "data-sources": "Lineage & Data Quality",
  },
  hiddenPages: [],
  pageCopy: {
    executive: { title: "Executive KPIs — Growth, Margin & Cash" },
    exposure: { title: "Customer & Supplier Concentration" },
  },
  kpiLabels: {},
  hiddenKpis: [],
  cogsLabel: "Cost of Goods Sold",
  statementLabels: {
    operating_income: "Operating Profit",
  },
  inventoryExposureCopy: { title: "Inventory Exposure", noun: "inventory" },
  genieChips: [
    "What's our underlying sales growth this month, split by volume and price, and which category is driving it?",
    "What is our gross margin and underlying operating margin this period by region?",
    "What are our DSO, DPO and DIO this month, and how do they compare by region?",
    "What's our cash conversion cycle, and which business line is driving it?",
    "What is the data-quality status of this close right now?",
    "Are all subledgers and manual adjustments fully loaded and passing quality checks for this close?",
    "Show the variances that still need review.",
  ],
  exposure: {
    noun: "customer", vendorNoun: "supplier", action: "account review",
    arToggle: "Customers · AR", apToggle: "Suppliers · AP",
  },
  stressHiddenLevers: [],
  aiRoi: AI_ROI_BASE,
};

const SOFTWARE: Overlay = {
  id: "software",
  label: "Software & SaaS",
  navLabels: {
    "data-sources": "Lineage & Data Quality",
  },
  hiddenPages: ["inventory-exposure"],
  pageCopy: {
    executive: { title: "Executive KPIs — Growth, Margin & Cash" },
    "data-sources": { title: "Lineage & Data Quality" },
    "stress-test": { title: "Scenario Stress Test — Cash Efficiency" },
    exposure: { title: "Customer Concentration" },
  },
  kpiLabels: {},
  hiddenKpis: ["dio"],
  cogsLabel: "Cost of Revenue",
  statementLabels: {
    cogs: "Cost of Revenue",
    operating_income: "Operating Income",
  },
  genieChips: [
    "What's our operating-expense variance to forecast this month, and which business unit is driving it?",
    "What is our net income this period by region?",
    "What are our DSO and DPO this month, and how do they compare by region?",
    "What's our cash conversion cycle, and which business line is driving it?",
    "What is the data-quality status of this close right now?",
    "Are all subledgers and manual adjustments fully loaded and passing quality checks for this close?",
    "Show the variances that still need review.",
  ],
  exposure: {
    noun: "customer", vendorNoun: "vendor", action: "account review",
    arToggle: "Customers · AR", apToggle: "Vendors · AP",
  },
  stressHiddenLevers: ["inventory"],
  aiRoi: AI_ROI_BASE,
};

const FSI: Overlay = {
  id: "fsi",
  label: "Financial Services",
  navLabels: {
    "data-sources": "Lineage & Data Quality",
  },
  hiddenPages: ["inventory-exposure"],
  pageCopy: {
    executive: { title: "Executive KPIs — NII, Returns & Capital" },
    "data-sources": { title: "Lineage & Data Quality" },
    "stress-test": { title: "Scenario Stress Test — Liquidity" },
    exposure: { title: "Counterparty & Credit Risk" },
  },
  kpiLabels: { dso: "Receivables Days", dpo: "Payables Days", ccc: "Cash Cycle" },
  hiddenKpis: ["dio"],
  cogsLabel: "Cost of Services",
  statementLabels: {
    income: "Statement of Operations",
    revenue: "Net Interest & Fee Income",
    opex: "Operating Expenses",
    operating_income: "Operating Result",
    net_income: "Net Income",
  },
  // Banks don't present a COGS / gross-profit line.
  hiddenStatementLines: ["cogs", "gross_profit"],
  genieChips: [
    "What's our net interest income variance to forecast this month, and which line of business is driving it?",
    "What is our net income this period by region?",
    "What are our receivables and payables days this month, and how do they compare by region?",
    "What's our cash cycle, and which line of business is driving it?",
    "What is the data-quality status of this close right now?",
    "Are all subledgers and manual adjustments fully loaded and passing quality checks for this close?",
    "Show the variances that still need review.",
  ],
  exposure: {
    noun: "counterparty", vendorNoun: "counterparty", action: "credit review",
    arToggle: "Counterparties · AR", apToggle: "Counterparties · AP",
  },
  stressHiddenLevers: ["inventory"],
  aiRoi: AI_ROI_BASE,
};

const ENERGY: Overlay = {
  id: "energy",
  label: "Energy & Utilities",
  navLabels: {
    "data-sources": "Lineage & Data Quality",
  },
  hiddenPages: [],
  pageCopy: {
    executive: { title: "Executive KPIs — Commodity & Cash" },
    "data-sources": { title: "Lineage & Data Quality" },
    "stress-test": { title: "Scenario Stress Test — Wholesale & Cash" },
    exposure: { title: "Counterparty & Commodity Exposure" },
    "historical-insights": { eyebrow: "FP&A", title: "Historical Insights — Trends & Anomalies" },
    "payment-behavior": { eyebrow: "FP&A", title: "Counterparty Payment Behaviour" },
  },
  kpiLabels: { dio: "Gas Storage Days" },
  hiddenKpis: ["adjusted_operating_cash_flow", "net_generation_output"],
  cogsLabel: "Cost of Energy",
  statementLabels: {
    cogs: "Cost of Energy",
    gross_profit: "Gross Margin",
    operating_income: "Operating Profit",
  },
  inventoryExposureCopy: { title: "Gas in Storage Exposure", noun: "gas in storage" },
  genieChips: [
    "What's our wholesale energy cost variance to forecast this month, and which business unit is driving it?",
    "What is our net income this period by region?",
    "Which counterparties carry the largest single-name exposure across entities?",
    "What's our gas-in-storage position and how does it affect commodity days?",
    "What is the data-quality status of this close right now?",
    "Are all billing, settlement and trading subledgers fully loaded and passing quality checks?",
    "Show the variances that still need review.",
  ],
  exposure: {
    noun: "counterparty", vendorNoun: "counterparty", action: "credit review",
    arToggle: "Counterparties · Sales", apToggle: "Counterparties · Wholesale",
  },
  stressHiddenLevers: [],
  stressLeverLabels: { inventory: "Gas storage" },
  aiRoi: AI_ROI_BASE,
};

// Capital Markets: a global ETP market maker. Reports net trading income rather
// than revenue, has no COGS / gross-profit line, and runs each desk as its own
// P&L, so AI ROI attributes spend and value by desk.
const CAPMARKETS: Overlay = {
  id: "capmarkets",
  label: "Capital Markets",
  navLabels: {
    "data-sources": "Lineage & Data Quality",
  },
  hiddenPages: ["inventory-exposure"],
  pageCopy: {
    executive: { title: "Executive KPIs — Trading Income, Margin & Capital" },
    "data-sources": { title: "Lineage & Data Quality" },
    "stress-test": { title: "Scenario Stress Test — Trading Capital" },
    exposure: { title: "Counterparty & Venue Exposure" },
  },
  kpiLabels: { dso: "Receivables Days", dpo: "Payables Days", ccc: "Cash Cycle" },
  hiddenKpis: ["dio"],
  cogsLabel: "Exchange & Clearing Fees",
  statementLabels: {
    income: "Statement of Operations",
    revenue: "Net Trading Income",
    opex: "Operating Expenses",
    operating_income: "Operating Result",
    net_income: "Net Profit",
  },
  // A market maker does not present a COGS / gross-profit line.
  hiddenStatementLines: ["cogs", "gross_profit"],
  genieChips: [
    "What's our net trading income variance to forecast this month, and which entity is driving it?",
    "What is our net income this period by region?",
    "Which venues and clearing counterparties carry the largest fee exposure?",
    "How much of this month's operating expense is technology and market data?",
    "What is the data-quality status of this close right now?",
    "Are trade capture, clearing and finance subledgers fully loaded and passing quality checks?",
    "Show the variances that still need review.",
  ],
  exposure: {
    noun: "counterparty", vendorNoun: "venue", action: "counterparty review",
    arToggle: "Counterparties · AR", apToggle: "Venues & Clearing · AP",
  },
  stressHiddenLevers: ["inventory"],
  aiRoi: {
    revenueDimensions: [
      { id: "business_unit", label: "Desk", noun: "desks" },
      { id: "use_case", label: "Project", noun: "projects" },
      // Market carries region codes for this industry, so say so.
      { id: "market", label: "Region", noun: "regions" },
    ],
  },
};

const OVERLAYS: Record<Industry, Overlay> = {
  consumer: CONSUMER,
  software: SOFTWARE,
  fsi: FSI,
  energy: ENERGY,
  capmarkets: CAPMARKETS,
};

export function getOverlay(industry: Industry): Overlay {
  return OVERLAYS[industry] ?? CONSUMER;
}
