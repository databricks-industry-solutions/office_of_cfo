import { CHART_COLORS } from "./chartPalette";

export type LineageStatus = "success" | "warning" | "error" | "unavailable";

export const LINEAGE_STATUS_COLOR: Record<LineageStatus, string> = {
  success: CHART_COLORS.good,
  warning: CHART_COLORS.warn,
  error: CHART_COLORS.bad,
  unavailable: CHART_COLORS.slate,
};

export const LINEAGE_STATUS_LABEL: Record<LineageStatus, string> = {
  success: "Successful",
  warning: "Warning",
  error: "Error",
  unavailable: "Unavailable",
};

export interface LineageLink {
  source: string;
  target: string;
  value: number;
  status: LineageStatus;
  flow_id: string;
  id: string;
}

export type LineageSelection =
  | { kind: "all" }
  | { kind: "flow"; flowId: string; status?: LineageStatus }
  | { kind: "node"; nodeId: string }
  | { kind: "link"; linkId: string; flowId: string; status: LineageStatus };

/** Visual width only. Tooltips / labels keep the true count.
 *  Success is square-root damped so a 20k ERP hop does not swallow smaller
 *  sources; warnings and errors get a floor against the damped max. */
export function bandLayoutValue(count: number, status: LineageStatus, maxCount: number): number {
  const max = Math.max(1, maxCount);
  const base = Math.max(0, count);
  if (base <= 0) return 0;
  const damped = Math.sqrt(base);
  const maxDamped = Math.sqrt(max);
  if (status === "error" || status === "warning") {
    return Math.max(damped, maxDamped * 0.08);
  }
  return Math.max(damped, maxDamped * 0.02);
}

export function nodeCaption(counts: Record<string, number>): string {
  const success = counts.success ?? 0;
  const warning = counts.warning ?? 0;
  const error = counts.error ?? 0;
  const unavailable = counts.unavailable ?? 0;
  const total = success + warning + error + unavailable;
  const parts = [`${total.toLocaleString()} records`];
  if (warning) parts.push(`${warning.toLocaleString()} warn`);
  if (error) parts.push(`${error.toLocaleString()} err`);
  return parts.join(" · ");
}

export function legacyPageRedirect(slug: string): string {
  if (slug === "audit-log" || slug === "supply-chain") return "data-sources";
  if (slug === "ai-roi-revenue" || slug === "ai-roi-profitability") return "ai-roi-roi";
  return slug;
}

export function queryFromSelection(
  sel: LineageSelection,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const q: Record<string, string | undefined> = { ...extra };
  if (sel.kind === "flow") {
    q.flow_id = sel.flowId;
    if (sel.status) q.status = sel.status;
  } else if (sel.kind === "node") {
    q.node_id = sel.nodeId;
  } else if (sel.kind === "link") {
    q.flow_id = sel.flowId;
    if (q.status === undefined) q.status = sel.status;
  }
  if (q.status === "") delete q.status;
  return q;
}

export function dimBySearch(flowId: string, matchedFlowIds: string[] | null): boolean {
  if (matchedFlowIds == null) return false;
  return !matchedFlowIds.includes(flowId);
}

export function selectionLabel(sel: LineageSelection, names: Record<string, string> = {}): string {
  if (sel.kind === "all") return "All flows";
  if (sel.kind === "flow") return names[sel.flowId] ?? sel.flowId;
  if (sel.kind === "node") return names[sel.nodeId] ?? sel.nodeId.replace(/^[^:]+:/, "");
  return names[sel.flowId] ?? sel.flowId;
}

const RULE_RECOMMENDATION: Record<string, string> = {
  ingestion_schema_reject:
    "Map the unexpected column to the governed schema and re-land the extract before posting.",
  ingestion_timeout:
    "Re-run the extract with a longer timeout and land the missing rows before this feed can close.",
  validity_debits_equal_credits:
    "Post a balancing correcting journal for the difference and re-run the validity check.",
  referential_integrity_ap_account:
    "Recode the invoice to a valid chart-of-accounts account, then re-run AP DQ.",
  freshness_fixed_assets:
    "Reload the asset register from source and confirm the feed is current as of the close date.",
  three_way_match_po_invoice:
    "Investigate the PO vs invoice difference and hold payment until the three-way match clears.",
  validity_standard_cost:
    "Enter a non-zero standard cost for the SKU, or write off the on-hand quantity.",
  policy_expense_limit:
    "Request a receipt or manager override, then resubmit the claim.",
  validity_accrual_sign:
    "Reverse the planning accrual and re-post it with the correct debit or credit.",
  reconciliation_subledger_to_gl:
    "Clear the recon break with a documented journal so the control account matches the subledger.",
};

const STAGE_RECOMMENDATION: Record<string, string> = {
  ingestion: "Quarantine the row, fix the extract, and re-land it before including it in close.",
  post_ingestion: "Investigate the failing check, post a correcting entry if needed, and re-run DQ.",
  reconciliation: "Clear the recon break with a documented journal before sign-off.",
};

/** Short AI-style next step for an error row. Null when the row is not an error. */
export function aiRecommendation(rec: {
  status: string;
  rule?: string | null;
  stage?: string | null;
  issues?: { check_id?: string | null }[];
}): string | null {
  if (rec.status !== "error") return null;
  const rule = rec.rule || rec.issues?.find((i) => i.check_id)?.check_id || "";
  return RULE_RECOMMENDATION[rule]
    ?? STAGE_RECOMMENDATION[rec.stage || ""]
    ?? "Investigate the failing check and document the correcting action before sign-off.";
}
