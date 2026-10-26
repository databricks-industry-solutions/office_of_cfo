import {
  localIsoDate, shiftGeniePayload, toDisplayPayload, toSeedPayload,
} from "./lib/demoCalendar";

export interface CloseStatus {
  period: string;
  close_status: string;
  badge: string;
  fail_count: number;
  warn_count: number;
  total_checks: number;
  open_recon_breaks: number;
  unexplained_variances: number;
  adjustments_posted: number;
  /** Still inside four-eyes, split by the role that owns it. Period-wide, not scoped. */
  pending_approval: number;
  awaiting_sign_off: number;
}

export interface VarianceExplanation {
  ref: string;
  explanation: string;
  explained_by: string | null;
  explained_ts: string | null;
}

export interface DqCheck {
  check_id: string;
  dimension: string;
  scope: string;
  metric_value: string;
  status: string;
}

export interface ReconBreak {
  control_account_code: string;
  account_name: string;
  subledger: string;
  business_unit_id: string;
  business_unit_name: string;
  subledger_total: string;
  gl_balance: string;
  variance: string;
  abs_variance: string;
  is_break: boolean | string;
}

export interface TrialBalanceRow {
  account_code: string;
  account_name: string;
  account_type: string;
  statement: string;
  fs_line?: string;
  account_group?: string;
  total_debits: string;
  total_credits: string;
  debit_balance: string;
  credit_balance: string;
}

export interface Account {
  account_code: string;
  account_name: string;
  account_type: string;
  normal_balance: string;
}

export interface BusinessUnit {
  business_unit_id: string;
  business_unit_name: string;
  region: string;
  country?: string;
  legal_entity_id?: string;
  legal_entity_name?: string;
  primary_source_system?: string;
}

export type AdjustmentStatus = "pending" | "approved" | "signed_off";

/** How an adjustment reached its status: a human queue, or the Controller's policy. */
export type ApprovalMode = "manual" | "auto";

export type AdjustmentType =
  | "accrual" | "reclass" | "intercompany_elimination" | "fx_overlay";

/** One rule's verdict, frozen at decision time so it stays reconstructable. */
export interface RuleEvaluation {
  rule: string;
  label: string;
  passed: boolean;
  parameter: unknown;
  observed: unknown;
  detail: string;
}

export interface DecisionDetail {
  mode: ApprovalMode;
  auto_approval_enabled: boolean;
  policy_name: string | null;
  policy_version: number | null;
  broken_rules: string[];
  evaluations: RuleEvaluation[];
}

export interface Adjustment {
  adjustment_id: string;
  leg: string;
  account_code: string;
  business_unit_id: string;
  dr_cr: string;
  amount: number;
  memo: string;
  resolves_break: string | null;
  posted_by: string;
  posted_ts: string;
  status: AdjustmentStatus;
  approved_by: string | null;
  approved_ts: string | null;
  signed_off_by: string | null;
  signed_off_ts: string | null;
  adjustment_type: AdjustmentType | null;
  approval_mode: ApprovalMode;
  policy_version: number | null;
  decision_ts: string | null;
  decision_detail: DecisionDetail | null;
  recalled_by: string | null;
  recalled_ts: string | null;
  recall_reason: string | null;
  /** A system-generated reversal, not a candidate for approval. */
  is_reversal: boolean;
}

export interface AdjustmentIn {
  debit_account: string;
  credit_account: string;
  business_unit_id: string;
  amount: number;
  memo: string;
  resolves_break?: string | null;
  adjustment_type?: AdjustmentType | null;
}

/** What POST /adjustments reports back: the policy decision on the entry. */
export interface AdjustmentPosted {
  adjustment_id: string;
  status: AdjustmentStatus;
  approval_mode: ApprovalMode;
  policy_version: number | null;
  policy_name: string | null;
  broken_rules: string[];
  reasons: string[];
}

export interface PolicyRule {
  enabled: boolean;
  [param: string]: unknown;
}

export interface ApprovalPolicy {
  name: string;
  auto_approval_enabled: boolean;
  rules: Record<string, PolicyRule>;
}

export interface ApprovalPolicyState {
  policy_id: string;
  version: number | null;
  active: ApprovalPolicy | null;
  adjustment_types: AdjustmentType[];
  close_bd: number;
}

export interface ApprovalPolicyVersion {
  version: number;
  data: ApprovalPolicy;
  status: "draft" | "active" | "retired";
  authored_by: string | null;
  authored_ts: string | null;
  attested_by: string | null;
  attested_ts: string | null;
  activated_ts: string | null;
  retired_ts: string | null;
  diff: string[];
}

export interface PolicySimulationRow {
  adjustment_id: string;
  business_unit_id: string;
  amount: number;
  mode: ApprovalMode;
  broken_rules: string[];
  reasons: string[];
}

export interface PolicySimulation {
  evaluated: number;
  auto_approved: number;
  routed_to_review: number;
  auto_share_pct: number;
  auto_value: number;
  total_value: number;
  auto_value_share_pct: number;
  results: PolicySimulationRow[];
}

export interface AutoApprovalRegisterEntry {
  adjustment_id: string;
  business_unit_id: string;
  amount: number;
  memo: string;
  adjustment_type: AdjustmentType | null;
  policy_version: number | null;
  decision_ts: string | null;
  decision_detail: DecisionDetail | null;
  recalled_by: string | null;
  recalled_ts: string | null;
  recall_reason: string | null;
}

export interface AutoApprovalRegister {
  period: string;
  entries: AutoApprovalRegisterEntry[];
  auto_count: number;
  total_count: number;
  auto_value: number;
  total_value: number;
  count_share_pct: number;
  value_share_pct: number;
  policy_versions: number[];
  recalled_count: number;
}

export interface InventoryExposureRow {
  business_unit_id: string;
  business_unit_name: string;
  region: string;
  total_inventory: number | string;
  slow_moving_value: number | string;
  supplier_managed_value: number | string;
  item_count: number | string;
}

export interface StatementLine {
  equity_class?: string | null;
  section?: string | null;
  line_id: string;
  line_label: string;
  sort_order: number;
  amount: number | string;
  prior_amount?: number | string | null;
}

// Comparison basis for the FP&A comparative statements page. Budget is only
// available on the income statement (budget_forecast is IS-only).
// Legacy single axis — the backend still accepts it and maps it onto the two
// axes below, so older callers keep working.
export type CompareBasis = "mom" | "qoq" | "yoy" | "budget";

// The two orthogonal axes that replace CompareBasis in the UI:
//  - Window: how much of "now" to accumulate into the actual (MTD/QTD/YTD).
//  - CompareMode: what to measure against.
export type Window = "mtd" | "qtd" | "ytd";
export type CompareMode = "prior" | "prior_year" | "budget" | "scenario";

// One statement line with its actual, the comparison value, and the variance.
export interface ComparativeLine {
  section?: string;
  line_id: string;
  line_label: string;
  sort_order: number;
  actual: number;
  compare: number | null;
  var_abs: number | null;
  var_pct: number | null;
}

export interface ComparativeStatement {
  basis: CompareBasis;
  window?: Window;
  compare?: CompareMode;
  period: string;
  // The label for the "actual" column: the close month (MTD), the quarter
  // (QTD, e.g. "2026-Q2"), or the year (YTD, e.g. "2026 YTD").
  actual_period: string;
  compare_period: string;
  lines: ComparativeLine[];
}

export type AdhocDataType =
  | "text" | "number" | "date" | "datetime" | "time" | "boolean";
export type AdhocMappingTarget =
  | "metric_id" | "period" | "amount" | "version" | "ignore";

export interface AdhocMapping {
  source: string;
  target: AdhocMappingTarget;
  data_type: AdhocDataType;
  data_type_confidence: number;
  role_confidence: number;
  user_confirmed_data_type: boolean;
  user_confirmed_role: boolean;
  confidence?: number;
}

export interface AdhocAnalysisLine {
  line_id: string;
  line_label: string;
  sort_order: number;
  actual: number;
  uploaded: number;
  gap: number;
  gap_pct: number | null;
  favorable: boolean;
  source_range: string;
}

export interface AdhocParseResult {
  analysis_id: string;
  filename: string;
  sheet: string;
  layout_kind: string;
  mappings: AdhocMapping[];
  warnings: string[];
  row_count: number;
}

export interface AdhocRunRequest {
  analysis_id?: string;
  filename: string;
  sheet: string;
  headers: string[];
  rows: string[][];
  mappings: AdhocMapping[];
  scope_type: string;
  scope_id: string;
  period: string;
}

export interface AdhocSamplePack {
  analysis_id: string;
  period: string;
  industry: string;
  scope: { type: string; id: string };
  source: {
    filename: string;
    sheet: string;
    source_range: string;
    layout_kind: string;
  };
  mappings: AdhocMapping[];
  summary: {
    matched_rows: number;
    total_rows: number;
    join_coverage_pct: number;
    unmapped_amount: number;
    largest_gap_line_id: string | null;
  };
  lines: AdhocAnalysisLine[];
  exceptions: {
    code: string;
    label: string;
    amount: number;
    source_range: string;
  }[];
  narrative: { available: boolean; bullets: string[] };
}

// Persona-aware AI commentary on a comparative statement, plus a suggested Genie
// follow-up question. `available` is false when ai_query is unreachable (the UI
// then shows the seed question but no AI comments).
export interface ComparativeCommentary {
  available: boolean;
  persona: string;
  basis?: CompareBasis;
  period?: string;
  comments: string[];
  seed_question: string;
  note?: string;
}

// AI "why" per statement line (the always-on AI Insight column). `headline` is
// the short one-liner (always shown); `detail` is a deeper 1–2 sentence read
// (margin/ratio context) shown on expand, and is "" when there's no honest
// deeper point for that line.
export interface LineInsight {
  headline: string;
  detail: string;
}

// `insights` is keyed by the stable line_id; a missing key = no insight for that
// line (the cell renders blank). available=false when ai_query is unreachable.
export interface LineInsights {
  available: boolean;
  period?: string;
  insights: Record<string, LineInsight>;
}

/** A controller's written explanation of one statement line's variance, with the
 *  CFO's acknowledgement. Unlike the AI insight, this carries a named author. */
export interface LineCommentary {
  line_id: string;
  commentary: string;
  ai_draft: string | null;
  author: string | null;
  author_role: string | null;
  updated_ts: string | null;
  ack_by: string | null;
  ack_role: string | null;
  ack_ts: string | null;
  /** The author started from an AI draft (vs wrote from scratch). */
  from_ai_draft: boolean;
  /** They started from a draft AND changed the wording. */
  edited_from_draft: boolean;
  /** Scope the note was written at — needed to acknowledge it where it lives. */
  scope_type?: string;
  scope_id?: string;
  /** "EMEA" for a scoped note, "" when it explains the consolidated view. */
  scope_label?: string;
}

export interface LineCommentaryMap {
  available: boolean;
  period?: string;
  /** True when a sign-off persona is reading notes from every scope, not just theirs. */
  across_scopes?: boolean;
  entries: Record<string, LineCommentary>;
  /** All notes per line_id (one per scope), in write order, so a sign-off reader
   *  sees each region's explanation under its own `scope_label` instead of only the
   *  most recent. Single-scope authors get a 0/1-length list per line. */
  groups?: Record<string, LineCommentary[]>;
}

// One BU×region contributor to a single statement line's variance, for the
// attribution tornado on the variance dashboard.
export interface VarianceDriver {
  bu: string;
  region: string;
  actual: number;
  compare: number;
  var_abs: number;
}

export interface ComparativeDrivers {
  line_id: string | null;
  line_label: string | null;
  basis?: CompareBasis;
  period?: string;
  drivers: VarianceDriver[];
}

// COGS rate × volume bridge (Bridge Analysis page). Effects reconcile to
// total_var; pnl_cogs_var is the income-statement COGS variance for the honest
// tie-out (may be null / differ, since the subledger excludes manual adjustments).
export interface CogsBridge {
  basis: CompareBasis;
  period: string;
  compare_period: string;
  anchor: number;        // prior-period COGS (subledger)
  actual: number;        // current-period COGS (subledger)
  total_var: number;
  rate_effect: number;
  volume_effect: number;
  residual: number;
  qty_prior: number;
  qty_actual: number;
  avg_cost_prior: number;
  avg_cost_actual: number;
  pnl_cogs_var: number | null;
}

export interface OpexVarianceRow {
  account_code: string;
  account_name: string;
  business_unit_id: string;
  business_unit_name: string;
  actual_amount: string;
  forecast_amount: string;
  variance: string;
  variance_pct: string;
  variance_direction: string;
}

export interface ZeroOpsInsight {
  insight_id: string;
  detected_ts: string;
  signal_type: string;
  severity: string;
  source: string;
  title: string;
  diagnosis: string;
  proposed_repair: string;
  status: string;
  approver: string | null;
  period: string;
}

export interface SourceFile {
  source_spreadsheet: string;
  submitted_by: string;
  adjustments: number;
  total_amount: string;
  had_schema_drift: boolean | string;
}

export interface LineageNode {
  id: string;
  label: string;
  layer: string;
}
export interface LineageEdge {
  from: string;
  to: string;
}
export interface Lineage {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export interface ProvenanceAdjustment {
  adjustment_id: string;
  adjustment_type: string;
  account_code: string;
  business_unit_id: string;
  dr_cr: string;
  amount: string;
  memo: string;
  submitted_by: string;
  submitted_ts: string;
  had_schema_drift: boolean | string;
  source_spreadsheet: string;
}
export interface ProvenanceIncident {
  insight_id: string;
  signal_type: string;
  severity: string;
  title: string;
  status: string;
  approver: string | null;
}
export interface Provenance {
  adjustments: ProvenanceAdjustment[];
  dq_evidence: DqCheck[];
  incidents: ProvenanceIncident[];
}

export interface CloseTask {
  task_id: string;
  period: string;
  task_name: string;
  description: string | null;
  workstream: string | null;
  business_unit_id: string | null;
  assignee: string | null;
  priority: "HIGH" | "MEDIUM" | "LOW";
  due_date: string | null;
  status: string;
  is_blocked: boolean;
  delay_reason: string | null;
  source: "template" | "recon" | "dq" | "manual" | "concentration";
  linked_ref: string | null;
  depends_on: string | null;
  created_by: string | null;
  created_ts: string | null;
  started_ts: string | null;
  updated_ts: string | null;
  completed_ts: string | null;
}

export interface AssigneeLoad {
  assignee: string;
  open: number;
  overdue: number;
  completed: number;
}

export interface WorkstreamProgress {
  workstream: string;
  total: number;
  done: number;
}

export interface TaskSummary {
  period: string;
  total: number;
  buckets: Record<string, number>;
  overdue: number;
  blocked: number;
  awaiting_approval: number;
  auto_completed: number;
  pct_complete: number;
  /** Demo / close as-of date (YYYY-MM-DD); drives overdue + days-to-close. */
  today: string;
  target_close_date: string;
  days_to_close: number;
  by_assignee: AssigneeLoad[];
  by_workstream: WorkstreamProgress[];
}

export interface BurndownPoint {
  date: string;
  t: number;
  planned: number;
  actual: number | null;
  projected: number | null;
}

export interface Burndown {
  points: BurndownPoint[];
  total: number;
  completed: number;
  remaining: number;
  pct_complete: number;
  start_date: string;
  today: string;
  target_close_date: string;
  projected_finish_date: string | null;
  days_delta: number | null;
  on_track: boolean;
  cutoff_date: string;
  today_t: number;
  target_t: number;
  projected_t: number | null;
}

export interface TaskActivity {
  activity_id: string;
  task_id: string;
  ts: string;
  actor: string | null;
  action: string;
  detail: string | null;
  task_name?: string | null;
}

export interface TaskAssignee {
  name: string;
  role: string;
}

export interface StatusDef {
  id: string;
  label: string;
  color: string;
  order: number;
}

export interface TaskTemplate {
  name: string;
  workstream: string;
  owner: string;
  priority: string;
  due_offset_bd: number;
  seed_status?: string;
  blocked?: boolean;
  reason?: string;
}

export interface CloseConfig {
  workstreams: string[];
  statuses: StatusDef[];
  reason_codes: string[];
  team: TaskAssignee[];
  task_templates: TaskTemplate[];
  automations: Record<string, boolean>;
  target_close_bd: number;
}

export interface GenieAnswer {
  conversation_id: string;
  message_id: string;
  text: string | null;
  query: string | null;
  table: { columns: string[]; rows: string[][] } | null;
}

// ---- Personas, org hierarchy, scope --------------------------------------
export type ScopeType =
  | "consolidated" | "region" | "legal_entity" | "business_unit" | "business_line" | "use_case";

export interface Scope {
  scope_type: ScopeType;
  scope_id: string;
}

export const CONSOLIDATED: Scope = { scope_type: "consolidated", scope_id: "ALL" };

// The active reporting period travels on every scope-aware request. Set by the
// global period picker (App). Endpoints that are period-aware honor it; the
// close-workflow endpoints simply ignore the extra param, so they stay pinned to
// the active close. Empty string means "active close" (the endpoint default).
let activePeriod = "";
export function setActivePeriod(p: string) {
  activePeriod = p || "";
}
export function getActivePeriod(): string {
  return activePeriod;
}

function scopeQS(s?: Scope): string {
  const parts: string[] = [];
  if (s && s.scope_type !== "consolidated") {
    parts.push(`scope_type=${s.scope_type}`);
    parts.push(`scope_id=${encodeURIComponent(s.scope_id)}`);
  }
  if (activePeriod) parts.push(`period=${encodeURIComponent(activePeriod)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** scopeQS (scope + active period) merged with extra query params. */
function qsMerge(s: Scope | undefined, extra: Record<string, string | undefined>): string {
  const base = scopeQS(s);
  const parts = base ? base.slice(1).split("&") : [];
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== "") parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export interface Persona {
  id: string;
  label: string;
  title: string;
  description: string;
  default_page: string;
  default_query?: string;
  pages: string[];
  scope_type: ScopeType;
  scope_default?: string;
  scope_locked: boolean;
  can_post: boolean;
  can_approve?: boolean;
  can_sign_off?: boolean;
}

export interface OrgUnit {
  business_unit_id: string;
  business_unit_name: string;
  region: string;
  country: string;
  legal_entity_id: string;
  legal_entity_name: string;
  primary_source_system: string;
}

export interface OrgLegalEntity {
  legal_entity_id: string;
  legal_entity_name: string;
  country: string;
  business_units: { business_unit_id: string; business_unit_name: string; primary_source_system: string }[];
}

export interface OrgTree {
  regions: { region: string; legal_entities: OrgLegalEntity[] }[];
  business_lines: string[];
  units: OrgUnit[];
}

// ---- Working-capital KPIs -------------------------------------------------
export interface KpiMetric {
  value: number;
  delta: number | null;
  better: "lower" | "higher";
  label: string;
  unit: string;
}

export interface WorkingCapitalKpis {
  period: string;
  scope_type: string;
  scope_id: string;
  days_in_period: number;
  components: {
    ar_balance: number; ap_balance: number; inventory_balance: number;
    revenue: number; cogs: number; operating_expense: number; net_income: number;
  };
  kpis: { dso: KpiMetric; dpo: KpiMetric; dio: KpiMetric; ccc: KpiMetric };
}

export interface KpiTrendPoint {
  period: string;
  dso: string; dpo: string; dio: string; ccc: string;
  revenue: string; opex: string; net_income: string;
}

export interface OperatingLeverageForecastPoint {
  period: string;
  revenue: number;
  opex: number;
  net_income: number;
  net_margin_pct: number;
}

export interface OperatingLeverageForecast {
  status: "available" | "unavailable";
  source: "ai_seasonal_revenue_modeled_costs" | null;
  as_of: string;
  horizon_months: number;
  points: OperatingLeverageForecastPoint[];
  reason?: "no_history" | "insufficient_history" | "forecast_disabled" | "forecast_unavailable" | "invalid_history";
}

export interface KpiSegment {
  segment: string;
  dso: number; dpo: number; dio: number; ccc: number;
  revenue: number;
}

// Cash-flow reconciliation for the active scope (beginning -> collections ->
// operating disbursements + capex -> ending). Reconciles by construction.
export interface CashFlow {
  period: string;
  scope_type: string;
  scope_id: string;
  beginning_cash: number;
  collections: number;
  operating_disbursements: number;
  capex: number;
  ending_cash: number;
}

export interface CashFlowTrendPoint {
  period: string;
  beginning_cash: number;
  collections: number;
  operating_disbursements: number;
  capex: number;
  ending_cash: number;
}

// Fine-grained (BU x business-line) working-capital components. The Executive
// page filters these client-side by region / business line / legal entity and
// re-aggregates the additive components to drive the KPI visuals.
export interface KpiBreakdownRow {
  region: string;
  legal_entity_id: string;
  legal_entity_name: string;
  business_line: string;
  business_unit_id: string;
  business_unit_name: string;
  ar_balance: number;
  ap_balance: number;
  inventory_balance: number;
  revenue: number;
  cogs: number;
  operating_expense: number;
  days_in_period: number;
}

// ---- Close Support / IDP (Intelligent Document Processing) ----------------
export interface CloseDocument {
  filename: string;
  doc_type: string;
  counterparty: string;
  period: string;
  pages: number;
  ingested_ts: string;
}

export interface CompetitorBenchmark {
  competitor: string;
  metric: string;
  their_value: number | null;
  our_value: number | null;
  delta: number | null;
  unit: string;
  source_file: string;
  source_page: number;
}

export interface ContractObligation {
  counterparty: string;
  contract_id: string;
  category: string;
  renewal_date: string;
  auto_renew: boolean;
  payment_terms: string;
  annual_value: number | null;
  currency: string;
  liability: string;
  risk_level: string;
  risk_note: string;
  obligations: string[];
  source_file: string;
  source_page: number;
}

// ---- Live document extraction (interactive re-run of the IDP pipeline) -----
export type AnalysisScopeId = "all" | "filings" | "contracts";

export interface AnalysisScope {
  scope: AnalysisScopeId;
  label: string;
  path: string;
  pdf_count: number;
}

export type RunStage =
  | "idle" | "parsing" | "extracting" | "materializing" | "done" | "error";

export interface RunStatus {
  stage: RunStage;
  scope: AnalysisScopeId | null;
  docs: number;
  benchmarks: number;
  obligations: number;
  error: string | null;
}

export interface UploadResult {
  filename: string;
  doc_type: "filing" | "contract";
  path: string;
}

// ---- Company-search benchmarking (Competitors benchmarking) --------------
export interface CompanyCandidate {
  name: string;
  source: "ESEF" | "EDGAR";
  key: string;          // LEI (ESEF) or CIK (EDGAR)
  country: string;
  ticker?: string;
  detail: string;       // e.g. "ESEF (EU)" / "EDGAR (US)"
}

/**
 * Search result envelope. `notice` explains a thin result set — the company is
 * real but publishes no structured filing — and `degraded` names public sources
 * that were unreachable, which is a retryable outage rather than a missing
 * company. Without these, all three cases render identically as "no matches".
 */
export interface CompanySearchResult {
  candidates: CompanyCandidate[];
  degraded: string[];
  notice: string | null;
}

export interface SearchBenchmark {
  competitor: string;
  metric: string;
  their_value: number | null;
  our_value: number | null;
  delta: number | null;
  unit: string;
  source_file: string;
  source_url: string;
  period: string;
}

// One point in a competitor's (or "Us") multi-period metric trend. Peers come
// from public filings (quarterly for US / EDGAR, annual for EU / ESEF); "Us" is a
// synthesized quarterly series. Plotted on one continuous date axis by period_end.
export interface SearchTrendRow {
  competitor: string;
  metric: string;
  period_end: string;   // ISO date (yyyy-mm-dd)
  label: string;        // display label, e.g. "FY2023" or "Q3 '24"
  granularity: "quarterly" | "annual";
  value: number | null;
  unit: string;
}

export type SearchStage =
  | "idle" | "resolving" | "fetching" | "computing" | "writing" | "done" | "error";

export interface SearchRunStatus {
  stage: SearchStage;
  competitor: string | null;
  source: string | null;
  period: string | null;
  metrics: number;
  note: string | null;
  error: string | null;
  cached?: boolean;
}

export interface MetricCatalogEntry {
  name: string;
  unit: string;
  better: "high" | "low" | "neutral";
  chartable: boolean;
}

export interface MetricCatalogResponse {
  metric_schema: number;
  metrics: MetricCatalogEntry[];
}

export interface CompetitorNote {
  competitor: string;
  note: string;
  source: string;
}

// ---- Source-system integration map ---------------------------------------
export interface SourceDomain {
  domain: string;
  source_system: string;
  table: string;
  value_chain: string;
  note: string;
  status: string;
  row_count: number | null;
  last_load: string | null;
  regions: string[];
}

export interface SourceSystems {
  domains: SourceDomain[];
  value_chains: { name: string; flow: string[] }[];
  systems: string[];
}

export type LineageRecordStatus = "success" | "warning" | "error" | "unavailable";

export interface LineageGraphNode {
  id: string;
  name: string;
  stage: number;
  counts: Record<string, number>;
}

export interface LineageGraphLink {
  source: string;
  target: string;
  value: number;
  status: LineageRecordStatus;
  flow_id: string;
  id: string;
}

export interface LineageFlowMeta {
  flow_id: string;
  domain: string;
  table: string;
  value_chain: string;
  record_key: string;
  note: string;
  source_system: string;
  row_count: number | null;
  last_load: string | null;
  available: boolean;
}

export interface LineageSummary {
  total: number;
  success: number;
  warning: number;
  error: number;
  unavailable: number;
  last_ingestion: string | null;
}

export interface LineageGraph {
  nodes: LineageGraphNode[];
  links: LineageGraphLink[];
  summary: LineageSummary;
  systems: string[];
  stages: string[];
  flows: LineageFlowMeta[];
  partial: boolean;
  filters: { statuses: string[]; stages: string[]; systems: string[]; flow_ids: string[] };
  scope_regions?: string[] | null;
}

export interface LineageActivity {
  ts: string | null;
  actor: string | null;
  action: string | null;
  detail: string | null;
  record_id?: string | null;
  flow_id?: string | null;
}

export interface LineageRecord {
  record_id: string;
  flow_id: string;
  status: LineageRecordStatus;
  stage: string;
  source_system: string;
  domain: string;
  value_chain: string;
  table: string;
  entity: string | null;
  amount: number | null;
  event_ts: string | null;
  regions: string[];
  rule: string | null;
  message: string | null;
  attributes: Record<string, unknown>;
  provenance: Record<string, unknown>;
  issues: { check_id?: string | null; dimension?: string; status?: string; message?: string | null }[];
  activity: LineageActivity[];
}

export interface LineageRecordsPage {
  records: LineageRecord[];
  total: number;
  offset: number;
  limit: number;
  totals: LineageSummary;
  matched_flow_ids?: string[];
}

// ---- Concentration risk / counterparty exposure network ------------------
export type ExposureDimension = "customer" | "vendor";
// Which metric the top-N ranking / flagging is based on.
export type ExposureMetric = "amount" | "txn";

export interface GraphNode {
  id: string;
  type: "root" | "entity" | "counterparty";
  label: string;
  properties: {
    exposure?: number;
    txn_count?: number;
    entities_touched?: number;
    pct_of_total?: number;
    tone?: "good" | "warn" | "critical";
    flagged?: boolean;
  };
  // injected by the force-graph layout
  x?: number;
  y?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
  properties?: Record<string, unknown>;
}

export interface ExposureSummary {
  flagged_count?: number;
  flagged_exposure?: number;
  flagged_txn?: number;
  entities_exposed?: number;
  pct_of_total?: number;
  min_count?: number;
  counterparty_count?: number;
  total_exposure?: number;
}

export interface ExposureGraph {
  dimension: ExposureDimension;
  metric: ExposureMetric;
  nodes: GraphNode[];
  links: GraphEdge[];
  summary: ExposureSummary;
  threshold: number;
  converge_targets: string[];
  converge_target: string | null;
}

export interface RaiseReviewsResult {
  created: string[];
  skipped: string[];
  count: number;
}

// The active persona travels on every write so the backend can enforce RBAC +
// segregation of duties. Set by App whenever the "view as" persona changes.
let activePersona = "";
export function setActivePersona(id: string) {
  activePersona = id;
}

// The active industry travels on every request so backend label maps (KPI names,
// source systems, task templates, etc.) can localize. Set by the IndustryProvider.
let activeIndustry = "";
export function setActiveIndustry(id: string) {
  activeIndustry = id;
}

/** Month offset last seen from the API (`X-Demo-Month-Offset`). */
let demoMonthOffset = 0;
export function getDemoMonthOffset(): number {
  return demoMonthOffset;
}

function contextHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (activePersona) h["X-Persona"] = activePersona;
  if (activeIndustry) h["X-Industry"] = activeIndustry;
  h["X-Demo-Today"] = localIsoDate();
  return h;
}

function applyDemoOffset(r: Response): number {
  const raw = r.headers.get("X-Demo-Month-Offset");
  if (raw != null && /^-?\d+$/.test(raw)) demoMonthOffset = parseInt(raw, 10);
  return demoMonthOffset;
}

function decodeDemoJson(r: Response, path: string, body: unknown): unknown {
  const offset = applyDemoOffset(r);
  if (path.includes("/genie/conversations")) return shiftGeniePayload(body, offset);
  return toDisplayPayload(body, offset);
}

function writeHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...contextHeaders() };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`, { headers: contextHeaders() });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return decodeDemoJson(r, path, await r.json()) as T;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? undefined : toSeedPayload(body, demoMonthOffset);
  const r = await fetch(`/api${path}`, {
    method: "POST",
    headers: writeHeaders(),
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.detail || `${path}: ${r.status}`);
  }
  return decodeDemoJson(r, path, await r.json()) as T;
}

async function put<T>(path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? undefined : toSeedPayload(body, demoMonthOffset);
  const r = await fetch(`/api${path}`, {
    method: "PUT",
    headers: writeHeaders(),
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.detail || `${path}: ${r.status}`);
  }
  return decodeDemoJson(r, path, await r.json()) as T;
}

async function del<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`, { method: "DELETE", headers: writeHeaders() });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.detail || `${path}: ${r.status}`);
  }
  return decodeDemoJson(r, path, await r.json()) as T;
}

async function patch<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: "PATCH",
    headers: writeHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.detail || `${path}: ${r.status}`);
  }
  return r.json();
}

export interface DriverDef {
  id: string; label: string; unit: string; mode: string; default: number | null;
  group?: string; min?: number; max?: number; step?: number; applies_to?: string;
}

export interface DriverEntry { value: number; unit: string; mode: string; }

export interface StatementSet {
  periods: string[];
  hinge_index: number;
  lines: Record<string, number[]>;
  kpis: Record<string, number[]>;
}

export interface ProjectResult {
  as_of: string;
  baseline: StatementSet;
  projection: StatementSet;
  /** Where forecast-month revenue came from (absent on older servers). */
  baseline_source?: "ai" | "budget" | "run_rate";
}

// ── 13-Week Cash (treasury, direct method) — GET /treasury/13w ──────────────
// Dates are seed-calendar; the server adds `display_*` twins already shifted onto
// the demo calendar, so the page reads those (the generic payload walker doesn't
// know these keys).
export type CashConfidence = "high" | "medium" | "low";
export type CashRowMethod = "ai" | "rule" | "rolling" | "forecast";

export interface TreasuryWeek {
  index: number; start: string; end: string; display_start: string; display_end: string;
}

export interface TreasuryRow {
  id: string; label: string; direction: "in" | "out"; method: CashRowMethod;
  values: number[]; total: number;
  /** AI rows only: amount-weighted confidence per week (null = no flows). */
  confidence?: (CashConfidence | null)[];
}

export interface TreasuryItem {
  ledger: "ar" | "ap"; invoice_id: string; counterparty: string; amount: number;
  due_date: string; expected_date: string; display_due_date: string; display_expected_date: string;
  week: number | null; confidence: CashConfidence; past_habit: boolean;
}

export interface TreasuryDriver {
  ledger: "ar" | "ap"; counterparty: string; open_amount: number; terms: number;
  invoices_settled: number; avg_days_vs_due: number; spread_days: number;
  confidence: CashConfidence; explanation: string;
}

export interface TreasuryReconLine {
  receipts: number; operating_payments: number; capex: number; net_change: number; ending_cash: number;
}

export interface TreasuryForecast {
  as_of: string; display_as_of: string;
  weeks: TreasuryWeek[];
  rows: TreasuryRow[];
  summary: {
    opening_cash: number[]; inflows: number[]; outflows: number[]; net_flow: number[];
    closing_cash: number[]; lowest_week: number; lowest_cash: number; min_cash: number | null;
    beyond_horizon: { ar: number; ap: number };
  };
  items: TreasuryItem[];
  drivers: TreasuryDriver[];
  assumptions: {
    receipts_lag_days: number; supplier_lag_days: number; supplier_monthly_run_rate: number;
    other_weekly_run_rate: number; revenue_source: "ai" | "budget" | "run_rate";
    rules: { row_id: string; label: string; monthly_amount: number; schedule: string; basis: string }[];
  };
  reconciliation: {
    period: string; display_period: string;
    treasury: TreasuryReconLine; fpa: TreasuryReconLine | null; difference: TreasuryReconLine | null;
  }[];
}

export interface ScenarioPlan {
  scenario_id: string; name: string;
  status: "baseline" | "draft" | "committed" | "published" | "archived";
  is_baseline: boolean; is_official: boolean; scope_type: string; scope_id: string;
  as_of_period: string; horizon_end: string | null;
  assumptions: Record<string, DriverEntry>;
  frozen_result: { baseline: StatementSet; projection: StatementSet } | null;
  engine_version: string | null; parent_scenario_id: string | null; created_by: string | null;
  result?: { baseline: StatementSet; projection: StatementSet };
}

export interface PlanListItem {
  scenario_id: string; name: string;
  status: "baseline" | "draft" | "committed" | "published" | "archived";
  is_baseline: boolean; is_official: boolean; scope_type: string; scope_id: string;
  as_of_period: string; created_by: string | null; updated_ts: string;
  compare_eligible?: boolean;
  compare_block_reason?: string | null;
}

export interface BridgeStep { driver: string; label: string; value: number; }

export interface BridgeResult {
  target: string; base: number; scenario: number; total: number;
  steps: BridgeStep[]; residual: number;
}

export interface CompareScenario {
  scenario_id: string; name: string; is_baseline: boolean; projection: StatementSet;
}

export interface CompareResult {
  periods: string[]; hinge_index: number; base: StatementSet; scenarios: CompareScenario[];
}

export interface HeadlineKpi {
  kpi_id: string;
  label: string;
  value: number;
  unit: string;
  good_direction: "up" | "down";
  delta: number | null;
  segment: string | null;
}

export interface HeadlineKpis {
  period: string;
  kpis: HeadlineKpi[];
  segments: HeadlineKpi[];
}

// ---- Historical Insights + Payment behaviour ------------------------------
export interface PeriodInfo {
  period: string;
  month_label?: string;
  year?: number;
  month?: number;
  quarter?: string;
  days_in_period?: number;
  is_active_close?: boolean;
}
export interface PeriodsResp {
  active: string;
  periods: PeriodInfo[];
}

export interface HistPoint {
  period: string;
  scope_type: string; scope_id: string; scope_label: string;
  dso: number; dpo: number; dio: number; ccc: number;
  revenue: number; opex: number; net_income: number;
}
export interface HistCallouts {
  current: number; prev: number | null;
  mom: number | null; mom_pct: number | null; yoy: number | null;
  trailing_avg: number; trailing_std: number; zscore: number;
  above_normal: boolean; outlier: boolean; good_direction: "lower" | "higher";
}
export interface HistArea {
  scope_id: string; scope_label: string;
  current: number; prev: number | null;
  mom: number | null; mom_pct: number | null; vs_avg: number; zscore: number;
}
export interface HistoricalInsights {
  period: string; metric: string;
  scope_type: string; scope_id: string;
  series: HistPoint[];
  callouts: HistCallouts;
  leaderboard: { dimension: string; areas: HistArea[] };
}

export interface PayScorecardRow {
  counterparty: string;
  terms: number | null;
  invoices: number;
  amount: number;
  avg_days_vs_terms: number;
  on_time_pct: number;
  category: "early" | "prompt" | "late";
  overdue_open: number;
  overdue_amount: number;
  trend: number[];
}
export interface PayScorecard {
  period: string; ledger: "ar" | "ap";
  counterparties: PayScorecardRow[];
}
export interface PayAnomaly {
  counterparty: string;
  type: "overdue" | "timing_outlier";
  direction: "late" | "early";
  amount: number;
  count?: number;
  worst_due?: string | null;
  days_vs_terms?: number;
  baseline_avg: number;
  zscore?: number;
  category: string;
  detail: string;
}
export interface PayAnomalies {
  period: string; ledger: "ar" | "ap";
  anomalies: PayAnomaly[];
}
export interface HistNarrative {
  period: string; available: boolean; narrative: string; facts: string[];
}

// What the demo was installed with (scripts/setup.py --company / --industries).
export interface DeploymentInfo {
  company: string;
  industries: string[];
}

// ── Market Insights (driver identification) ─────────────────────────────────
export interface MarketDriverSeries {
  series_id: string;
  label: string;
  unit: string;
  category?: string;
  values: (number | null)[];
}
export interface MarketDriversResponse {
  periods: string[];
  target: MarketDriverSeries | null;
  drivers: MarketDriverSeries[];
}
export interface DriverSensitivity {
  driver_id: string;
  label: string;
  category: string;
  unit: string;
  lag_m: number;
  corr: number | null;
  beta_est: number | null;
  beta_true?: number | null;
  impact_per_sigma: number | null;
  selected: boolean;
  rank: number | null;
}
export interface DriverSensitivitiesResponse {
  target: { metric_id?: string; label?: string; unit?: string };
  r2: number | null;
  drivers: DriverSensitivity[];
}
export interface MarketSignal {
  event_id: string;
  driver_id: string;
  driver_label: string;
  category: string;
  headline: string;
  source: string;
  as_of: string | null;
  move_sigma: number | null;
  impact: number | null;
  direction: "favourable" | "adverse" | string;
  lag_m: number;
}
export interface MarketSignalsResponse {
  target: { metric_id?: string; label?: string; unit?: string };
  as_of: string | null;
  unit: string;
  net_impact: number | null;
  events: MarketSignal[];
}

// ── AI ROI ──────────────────────────────────────────────────────────────────
export type AiRoiDimension = "business_unit" | "use_case" | "market" | "model" | "environment" | "org_unit" | "consumer";
export interface AiRoiNativeAssets {
  dashboard?: string;
  genie?: string;
  metric_view?: string;
}
export interface AiRoiSummary {
  run_cost: number; ai_run_cost?: number; fully_loaded_cost: number;
  realised_value?: number; realised_value_all: number;
  realised_value_proven: number; net_value: number; run_rate_rodt: number | null;
  programme_rodt: number | null; profitability_index: number | null;
  profitability_index_proven: number | null; tokens: number; requests: number;
  net_run_rate_value?: number | null; cash_breakeven_month?: number | null;
  simple_payback_months?: number | null; ramp_drag_months?: number | null;
  previous?: { ai_run_cost?: number; run_cost?: number; run_rate_rodt?: number | null };
  spend_concentration_top10?: number | null; unattributed_cost?: number;
  tagging_coverage?: number | null;
  confidence_mix?: Record<string, number>;
  net_ai_value?: number;
  amortised_investment?: number;
  vpmt?: number | null;
  cost_per_outcome?: number | null;
}
export interface AiRoiAttributionPolicy {
  attribution_policy_id: string; policy_name: string; owner_role: string;
  rule: string; method: string; signed_off_on: string | null; review_due_on: string | null;
}
export interface AiRoiUseCaseDetail {
  use_case_id: string; name: string; org_unit_bk: string; category: string;
  status: string; launched_on: string | null; summary: AiRoiSummary;
  breakeven: NonNullable<AiRoiExecutive["breakeven"]>;
  attribution_policy: AiRoiAttributionPolicy | null;
  value_categories: { category: string; amount_usd: number }[];
}
export interface AiRoiExecutive {
  summary: AiRoiSummary;
  break_even_at: number;
  exception: { key: string; profitability_index: number | null; profitability_index_proven: number | null } | null;
  trend: { period: string; run_cost: number; realised_value: number; fully_loaded_cost?: number }[];
  breakeven?: {
    crossover_month?: number | null;
    simple_payback_months?: number | null;
    ramp_drag_months?: number | null;
    last_actual_index?: number | null;
    band_low?: (number | null)[] | null;
    band_high?: (number | null)[] | null;
    months?: { period?: string | null; cum_value?: number | null; cum_outlay?: number | null }[];
  };
  what_changed?: { key: string; label: string; value: number; delta: number }[];
  markets?: string[];
  native_assets: AiRoiNativeAssets;
}
export interface AiRoiOrgNode {
  key: string; name: string; level: number; run_cost: number; realised_value: number;
  ai_run_cost?: number; run_rate_rodt?: number | null;
  fully_loaded_cost?: number; profitability_index?: number | null;
  children: AiRoiOrgNode[];
}
export interface AiRoiOrg { tree: AiRoiOrgNode[]; node_count: number; hierarchy_as_of?: string | null }
export interface AiRoiOrgDetail {
  scope_label: string;
  summary: AiRoiSummary;
  children: { key: string; label: string; value: number; share: number }[];
  consumers: { key: string; label: string; value: number }[];
  spend_trend?: { period: string | null; group?: string | null; key?: string | null; run_cost: number }[];
}
export interface AiRoiEfficiency {
  models: {
    model_id: string; name: string; tier: string; model_class?: string | null; run_cost: number; tokens: number; requests: number;
    ai_run_cost?: number; total_tokens?: number;
    cost_per_mtok: number | null; blended_cost_per_mtok?: number | null; cost_per_request?: number | null;
  }[];
  trend: { period: string; run_cost: number; cost_per_mtok: number | null; blended_cost_per_mtok?: number | null }[];
  waste: {
    run_cost: number; cache_ratio: number | null; retried_requests: number; failed_requests: number;
    cache_saving_usd?: number; retry_waste_usd?: number; token_efficiency_ratio?: number | null;
  };
}
export interface AiRoiProvenance {
  provider: string; serving_schema: string; source_tables: string[];
  freshness: { max_event_date: string | null; max_event_time?: string | null; row_count: number; degraded?: boolean; lag_seconds?: number };
  coverage: { business_units: number; use_cases: number; unattributed_periods: number };
  native_assets: AiRoiNativeAssets;
  tagging_coverage?: number; unattributed_cost?: number; cost_model_version?: string;
  capabilities?: string[];
  rate_card?: {
    model_id: string; name: string; provider: string;
    price_input_per_mtok: number; price_output_per_mtok: number;
    price_in_per_mtok?: number; price_out_per_mtok?: number; price_cached_in_per_mtok?: number;
  }[];
  hierarchy_as_of?: string | null;
  reorganised_units?: (string | { org_unit_bk: string; name: string; note?: string })[];
}
export interface AiRoiGatewayTelemetry {
  available: boolean; reason?: string; detail?: string; table?: string; source?: string;
  freshness?: string; built_at?: string | null; days?: number; from?: string | null;
  to?: string | null; requests?: number; peak_requesters?: number; total_tokens?: number;
  failed_requests?: number; distinct_models?: number;
  series?: { usage_date: string; requests: number; tokens: number; failed: number; requesters: number }[];
  by_destination_type?: { destination_type: string; requests: number; tokens: number }[];
  top_destinations?: { name: string; destination_type: string; requests: number; tokens: number; p95_latency_ms: number | null }[];
}
export interface AiRoiLeagueRow {
  use_case_id: string; name: string; org_unit_bk?: string; status?: string;
  ai_run_cost: number; realised_value: number; run_rate_rodt: number | null;
  vpmt: number | null; cash_breakeven_month: number | null;
  cash_breakeven_days?: number | null; variance?: number | null;
  confidence_mix: Record<string, number>; rodt_trend: number[];
}
/** One unit in the profitability ranking. `pi_all` / `pi_proven` are the GROSS
 *  profitability index (realised value / fully loaded cost), so break-even is
 *  1.0. Do not confuse with `run_rate_rodt`, which is NET (break-even at 0). */
export interface AiRoiProfitabilityRow {
  key: string; label: string;
  run_cost: number; amortised_build: number; allocated_build: number;
  fully_loaded_cost: number; realised_value_all: number; realised_value_proven: number;
  /** All value (metered + attested + modelled) / fully loaded cost. */
  pi_all: number | null;
  /** Metered + attested value only / fully loaded cost. */
  pi_proven: number | null;
  revenue_per_mtok: number | null; loaded_cost_per_mtok: number | null;
  total_tokens: number;
}
export interface AiRoiAllocationPolicy {
  allocation_policy_id: string; policy_name: string; basis: string; owner_role: string;
  rule: string; signed_off_on: string | null; review_due_on: string | null;
}
export interface AiRoiProfitability {
  dimension: AiRoiDimension; group_by: AiRoiDimension; period_basis: string;
  /** Profitability-index threshold (1.0). */
  break_even_at: number;
  below_break_even: number; below_break_even_proven: number; counted: number;
  allocation_policy: AiRoiAllocationPolicy | null;
  /** Ranked lowest `pi_all` first, nulls last. */
  rows: AiRoiProfitabilityRow[];
}

export const api = {
  closeStatus: (s?: Scope) => get<CloseStatus>(`/close-status${scopeQS(s)}`),
  marketSignals: () => get<MarketSignalsResponse>("/market-signals"),
  driverSensitivities: () => get<DriverSensitivitiesResponse>("/driver-sensitivities"),
  marketDrivers: () => get<MarketDriversResponse>("/market-drivers"),
  aiRoiExecutive: (s?: Scope) => get<AiRoiExecutive>(`/ai-roi/executive${scopeQS(s)}`),
  aiRoiMetricsSummary: (s?: Scope) => get<AiRoiSummary>(`/ai-roi/metrics/summary${scopeQS(s)}`),
  aiRoiBreakdown: (groupBy: string, s?: Scope) =>
    get<{ group_by: string; metric: string; rows: { key: string; label: string; value: number; delta: number; delta_pct: number | null; share: number; model_class?: string | null }[] }>(
      `/ai-roi/metrics/breakdown${qsMerge(s, { metric: "ai_run_cost", group_by: groupBy, sort: "value" })}`),
  aiRoiValueBreakdown: (groupBy: string, s?: Scope, limit = 12) =>
    get<{ group_by: string; metric: string; rows: { key: string; label: string; value: number; delta: number; delta_pct: number | null; share: number; model_class?: string | null }[] }>(
      `/ai-roi/metrics/breakdown${qsMerge(s, { metric: "realised_value", group_by: groupBy, sort: "value", limit: String(limit) })}`),
  aiRoiTimeseries: (groupBy: string, s?: Scope) =>
    get<{ series: { period: string; group?: string; value: number | null }[] }>(
      `/ai-roi/metrics/timeseries${qsMerge(s, { metric: "ai_run_cost", group_by: groupBy })}`),
  /** Ungrouped monthly AI run cost: one point per month in the scoped window. */
  aiRoiRunCostByMonth: (s?: Scope) =>
    get<{ series: { period: string | null; value: number | null }[] }>(
      `/ai-roi/metrics/timeseries${qsMerge(s, { metric: "ai_run_cost" })}`),
  aiRoiLeague: (s?: Scope, ratio = "run_rate_rodt") =>
    get<{ ratio: string; rows: AiRoiLeagueRow[] }>(
      `/ai-roi/roi/league-table${qsMerge(s, { ratio })}`),
  aiRoiProfitability: (s?: Scope, dimension: AiRoiDimension = "business_unit") =>
    get<AiRoiProfitability>(`/ai-roi/profitability${qsMerge(s, { dimension })}`),
  aiRoiBreakeven: (s?: Scope, markets?: string[]) =>
    get<NonNullable<AiRoiExecutive["breakeven"]>>(
      `/ai-roi/roi/breakeven${qsMerge(s, { market: markets?.length ? markets.join(",") : undefined })}`),
  aiRoiUseCase: (id: string, s?: Scope) =>
    get<AiRoiUseCaseDetail>(`/ai-roi/roi/use-case/${encodeURIComponent(id)}${scopeQS(s)}`),
  aiRoiUseCaseEvents: (id: string, kind = "value", s?: Scope) =>
    get<{ kind: string; events: { event_date: string; category: string; amount_usd: number; confidence: string; source_system: string; note?: string }[] }>(
      `/ai-roi/roi/use-case/${encodeURIComponent(id)}/events${qsMerge(s, { kind })}`),
  aiRoiOrg: (s?: Scope) => get<AiRoiOrg>(`/ai-roi/org${scopeQS(s)}`),
  aiRoiOrgDetail: (s?: Scope) => get<AiRoiOrgDetail>(`/ai-roi/org/detail${scopeQS(s)}`),
  aiRoiBudgets: (s?: Scope) => get<{ budget_variance: { budget_usd: number; prorated_budget_usd: number; actual_usd: number; variance_usd: number; variance_pct: number | null; forecast_period_end_usd: number } | null }>(`/ai-roi/budgets${scopeQS(s)}`),
  aiRoiAnomalies: (s?: Scope) => get<{ anomalies: { org_unit_bk: string; usage_date: string; cost_usd: number; z: number }[] }>(`/ai-roi/anomalies${scopeQS(s)}`),
  aiRoiInvocations: (cursor = 0, s?: Scope) =>
    get<{ items: { invocation_id: string; event_time: string; consumer_id: string; model_id: string; input_tokens: number; output_tokens: number; latency_ms: number; status_code: number; cost_usd: number; request_tags?: Record<string, string> }[]; next_cursor: number | null }>(
      `/ai-roi/invocations${qsMerge(s, { cursor: String(cursor), limit: "25" })}`),
  aiRoiEfficiency: (s?: Scope) => get<AiRoiEfficiency>(`/ai-roi/efficiency${scopeQS(s)}`),
  aiRoiProvenance: () => get<AiRoiProvenance>("/ai-roi/provenance/status"),
  aiRoiProvenanceMetric: (id: string, s?: Scope) => get<{
    metric_id: string; label: string; formula: string; unit: string;
    inputs: string[]; row_count: number; confidence_mix: Record<string, number>;
  }>(`/ai-roi/provenance/metric/${encodeURIComponent(id)}${scopeQS(s)}`),
  aiRoiGatewayTelemetry: () => get<AiRoiGatewayTelemetry>("/ai-roi/gateway/telemetry"),
  deployment: () => get<DeploymentInfo>("/deployment"),
  dqChecks: () => get<DqCheck[]>("/dq-checks"),
  reconBreaks: (s?: Scope) => get<ReconBreak[]>(`/recon-breaks${scopeQS(s)}`),
  trialBalance: (s?: Scope) => get<TrialBalanceRow[]>(`/trial-balance${scopeQS(s)}`),
  accounts: () => get<Account[]>("/accounts"),
  businessUnits: () => get<BusinessUnit[]>("/business-units"),
  adjustments: () => get<Adjustment[]>("/adjustments"),
  opexVariance: (s?: Scope) => get<OpexVarianceRow[]>(`/opex-variance${scopeQS(s)}`),
  incomeStatement: (s?: Scope) => get<StatementLine[]>(`/statements/income${scopeQS(s)}`),
  balanceSheet: (s?: Scope) => get<StatementLine[]>(`/statements/balance${scopeQS(s)}`),
  cashFlowStatement: (s?: Scope) => get<StatementLine[]>(`/statements/cashflow${scopeQS(s)}`),
  comparativeStatement: (stmt: "income" | "balance" | "cashflow", window: Window, compare: CompareMode, s?: Scope) =>
    get<ComparativeStatement>(`/statements/${stmt}/comparative${qsMerge(s, { window, compare })}`),
  comparativeCommentary: (stmt: "income" | "balance" | "cashflow", window: Window, compare: CompareMode, s?: Scope) =>
    get<ComparativeCommentary>(`/statements/${stmt}/comparative/commentary${qsMerge(s, { window, compare })}`),
  comparativeDrivers: (stmt: "income" | "balance" | "cashflow", window: Window, compare: CompareMode, s?: Scope, lineId?: string) =>
    get<ComparativeDrivers>(`/statements/${stmt}/comparative/drivers${qsMerge(s, { window, compare, line_id: lineId })}`),
  comparativeLineInsights: (stmt: "income" | "balance" | "cashflow", window: Window, compare: CompareMode, s?: Scope) =>
    get<LineInsights>(`/statements/${stmt}/comparative/line-insights${qsMerge(s, { window, compare })}`),
  comparativeLineCommentary: (stmt: "income" | "balance" | "cashflow", window: Window, compare: CompareMode, s?: Scope) =>
    get<LineCommentaryMap>(`/statements/${stmt}/comparative/line-commentary${qsMerge(s, { window, compare })}`),
  saveLineCommentary: (
    stmt: "income" | "balance" | "cashflow",
    body: {
      line_id: string; line_label?: string; commentary: string; ai_draft?: string | null;
      window: Window; compare: CompareMode; scope_type?: string; scope_id?: string;
    },
  ) =>
    post<{ line_id: string; commentary: string; author: string; author_role: string }>(
      `/statements/${stmt}/comparative/line-commentary`, { stmt, ...body }),
  ackLineCommentary: (
    stmt: "income" | "balance" | "cashflow",
    body: {
      line_id: string; line_label?: string;
      window: Window; compare: CompareMode; scope_type?: string; scope_id?: string;
    },
  ) =>
    post<{ line_id: string; ack_by: string; ack_role: string; ack_ts: string | null }>(
      `/statements/${stmt}/comparative/line-commentary/ack`, { stmt, ...body }),
  cogsBridge: (window: Window, compare: CompareMode, s?: Scope) =>
    get<CogsBridge>(`/bridge/cogs${qsMerge(s, { window, compare })}`),
  equityStatement: (s?: Scope) => get<StatementLine[]>(`/statements/equity${scopeQS(s)}`),
  inventoryExposure: (s?: Scope) => get<InventoryExposureRow[]>(`/inventory-exposure${scopeQS(s)}`),
  varianceExplanations: () => get<VarianceExplanation[]>("/variance-explanations"),
  explainVariance: (body: { control_account_code: string; business_unit_id: string; explanation: string }) =>
    post<{ ref: string; status: string; explained_by: string }>("/variance-explanations", body),

  personas: () => get<{ personas: Persona[] }>("/personas"),
  orgTree: () => get<OrgTree>("/org-tree"),
  kpis: (s?: Scope) => get<WorkingCapitalKpis>(`/kpis${scopeQS(s)}`),
  kpiTrend: (s?: Scope) => get<KpiTrendPoint[]>(`/kpis/trend${scopeQS(s)}`),
  operatingLeverageForecast: (s?: Scope) =>
    get<OperatingLeverageForecast>(`/kpis/operating-leverage/forecast${scopeQS(s)}`),
  kpiSegments: (dimension: string) =>
    get<KpiSegment[]>(`/kpis/segments${qsMerge(undefined, { dimension })}`),
  kpiBreakdown: (s?: Scope) => get<KpiBreakdownRow[]>(`/kpis/breakdown${scopeQS(s)}`),
  cashFlow: (s?: Scope) => get<CashFlow>(`/kpis/cashflow${scopeQS(s)}`),
  cashFlowTrend: (s?: Scope) => get<CashFlowTrendPoint[]>(`/kpis/cashflow/trend${scopeQS(s)}`),
  headlineKpis: () => get<HeadlineKpis>(`/kpis/headline${scopeQS(undefined)}`),
  // Historical Insights + Payment behaviour
  periods: () => get<PeriodsResp>("/periods"),
  historicalInsights: (s: Scope | undefined, metric: string, dimension = "region") =>
    get<HistoricalInsights>(`/historical-insights${qsMerge(s, { metric, dimension })}`),
  paymentBehavior: (ledger: "ar" | "ap", s?: Scope) =>
    get<PayScorecard>(`/payment-behavior${qsMerge(s, { ledger })}`),
  paymentAnomalies: (ledger: "ar" | "ap", s?: Scope) =>
    get<PayAnomalies>(`/payment-behavior/anomalies${qsMerge(s, { ledger })}`),
  historicalNarrative: (body: { scope_type: string; scope_id: string; metric: string; period: string }) =>
    post<HistNarrative>("/historical-insights/narrative", body),
  adhocSample: (s: Scope | undefined, period: string) =>
    get<AdhocSamplePack>(`/adhoc-analysis/sample${qsMerge(s, { period })}`),
  adhocParse: (body: {
    analysis_id?: string;
    filename: string;
    sheet: string;
    headers: string[];
    sample_rows: string[][];
    row_count: number;
  }) => post<AdhocParseResult>("/adhoc-analysis/parse", body),
  adhocRun: (body: AdhocRunRequest) => post<AdhocSamplePack>("/adhoc-analysis/run", body),
  closeDocuments: () => get<CloseDocument[]>("/close-support/documents"),
  closeBenchmarks: () => get<CompetitorBenchmark[]>("/close-support/benchmarks"),
  closeObligations: () => get<ContractObligation[]>("/close-support/obligations"),
  analysisScopes: () => get<AnalysisScope[]>("/close-support/scopes"),
  runExtraction: (scope: AnalysisScopeId) =>
    post<{ started: boolean; scope: AnalysisScopeId }>("/close-support/run-extraction", { scope }),
  runStatus: () => get<RunStatus>("/close-support/run-status"),
  competitorSearch: (name: string) =>
    get<CompanySearchResult>(`/competitor-search/search?name=${encodeURIComponent(name)}`),
  // Peers of the configured company, derived by the model on the server. Every name
  // is resolver-validated there, so an empty list means "couldn't derive a peer
  // set" (never a chip that fails when clicked).
  competitorPeerSuggestions: () =>
    get<{ company: string; picks: string[] }>("/competitor-search/peer-suggestions"),
  addCompetitor: (c: { source: string; key: string; name: string }) =>
    post<{ started: boolean; name: string }>("/competitor-search/add", c),
  competitorRunStatus: () => get<SearchRunStatus>("/competitor-search/run-status"),
  metricCatalog: () => get<MetricCatalogResponse>("/competitor-search/metric-catalog"),
  searchBenchmarks: () => get<SearchBenchmark[]>("/competitor-search/benchmarks"),
  searchTrends: () => get<SearchTrendRow[]>("/competitor-search/trends"),
  searchNotes: () => get<CompetitorNote[]>("/competitor-search/notes"),
  removeCompetitor: (competitor: string) =>
    del<{ removed: string }>(`/competitor-search/competitor/${encodeURIComponent(competitor)}`),
  uploadDoc: async (file: File, docType: "filing" | "contract"): Promise<UploadResult> => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("doc_type", docType);
    const r = await fetch("/api/close-support/upload", {
      method: "POST", headers: contextHeaders(), body: fd,
    });
    if (!r.ok) {
      const detail = await r.json().catch(() => ({}));
      throw new Error(detail.detail || `upload: ${r.status}`);
    }
    return r.json();
  },
  sourceSystems: () => get<SourceSystems>("/source-systems"),
  lineageQuality: (s?: Scope) => get<LineageGraph>(`/lineage-quality${scopeQS(s)}`),
  lineageQualityRecords: (s: Scope | undefined, extra: Record<string, string | undefined>) =>
    get<LineageRecordsPage>(`/lineage-quality/records${qsMerge(s, extra)}`),
  exposureGraph: (dimension: ExposureDimension = "customer", minCount = 3, metric: ExposureMetric = "amount") =>
    get<ExposureGraph>(`/exposure-graph?dimension=${dimension}&min_count=${minCount}&metric=${metric}`),
  raiseConcentrationReviews: (dimension: ExposureDimension = "customer", minCount = 3, metric: ExposureMetric = "amount") =>
    post<RaiseReviewsResult>("/concentration/raise-reviews", { dimension, min_count: minCount, metric }),
  zeroopsInsights: () => get<ZeroOpsInsight[]>("/zeroops-insights"),
  approveInsight: (id: string) =>
    post<{ insight_id: string; status: string; approver: string }>(
      `/zeroops-insights/${encodeURIComponent(id)}/approve`),
  sources: () => get<SourceFile[]>("/sources"),
  lineage: () => get<Lineage>("/lineage"),
  provenance: () => get<Provenance>("/audit/provenance"),
  genieSuggestions: () => get<{ space_id: string; questions: string[] }>("/genie/suggestions"),
  genieEmbed: () => get<{ space_id: string; url: string }>("/genie/embed"),
  genieAsk: (content: string) => post<GenieAnswer>("/genie/conversations", { content }),
  genieFollowUp: (conversationId: string, content: string) =>
    post<GenieAnswer>(`/genie/conversations/${encodeURIComponent(conversationId)}/messages`, { content }),
  // Root-cause analysis of the close's open reconciliation breaks, answered by
  // the dedicated investigation Genie space. Optional custom question.
  genieInvestigate: (content?: string) =>
    post<GenieAnswer>("/genie/investigate", { content: content ?? "" }),
  postAdjustment: (body: AdjustmentIn) => post<AdjustmentPosted>("/adjustments", body),
  approveAdjustment: (id: string) =>
    post<{ adjustment_id: string; status: string; approved_by: string }>(
      `/adjustments/${encodeURIComponent(id)}/approve`),
  signOffAdjustment: (id: string) =>
    post<{ adjustment_id: string; status: string; signed_off_by: string }>(
      `/adjustments/${encodeURIComponent(id)}/sign-off`),
  recallAdjustment: (id: string, reason: string) =>
    post<{ adjustment_id: string; reversal_id: string; status: string; recalled_by: string }>(
      `/adjustments/${encodeURIComponent(id)}/recall`, { reason }),

  approvalPolicy: () => get<ApprovalPolicyState>("/approval-policy"),
  approvalPolicyVersions: () => get<ApprovalPolicyVersion[]>("/approval-policy/versions"),
  draftApprovalPolicy: (data: ApprovalPolicy) =>
    post<{ version: number; status: string; data: ApprovalPolicy }>("/approval-policy", { data }),
  attestApprovalPolicy: (version: number) =>
    post<{ version: number; status: string; attested_by: string }>(
      `/approval-policy/${version}/attest`),
  simulateApprovalPolicy: (data: ApprovalPolicy) =>
    post<PolicySimulation>("/approval-policy/simulate", { data }),
  autoApprovalRegister: () => get<AutoApprovalRegister>("/auto-approval-register"),

  closeTasks: (s?: Scope) => get<CloseTask[]>(`/close-tasks${scopeQS(s)}`),
  taskSummary: (s?: Scope) => get<TaskSummary>(`/close-tasks/summary${scopeQS(s)}`),
  taskBurndown: (s?: Scope) => get<Burndown>(`/close-tasks/burndown${scopeQS(s)}`),
  taskTeam: () => get<TaskAssignee[]>("/close-tasks/team"),
  closeConfig: () => get<CloseConfig>("/close-config"),
  saveConfig: (data: CloseConfig) => put<{ status: string }>("/close-config", { data }),
  createTask: (body: {
    task_name: string; workstream?: string | null; assignee?: string | null;
    priority?: string; due_date?: string | null; description?: string; business_unit_id?: string | null;
  }) => post<{ task_id: string }>("/close-tasks", body),
  assignTask: (id: string, assignee: string) =>
    post<{ task_id: string }>(`/close-tasks/${encodeURIComponent(id)}/assign`, { assignee }),
  setTaskStatus: (id: string, status: string, isBlocked?: boolean, delayReason?: string | null) =>
    post<{ task_id: string }>(`/close-tasks/${encodeURIComponent(id)}/status`,
      { status, is_blocked: isBlocked, delay_reason: delayReason }),
  addComment: (id: string, text: string) =>
    post<{ task_id: string }>(`/close-tasks/${encodeURIComponent(id)}/comment`, { text }),
  taskActivity: (id: string) =>
    get<TaskActivity[]>(`/close-tasks/${encodeURIComponent(id)}/activity`),
  closeActivity: () => get<TaskActivity[]>("/close-activity"),

  treasury13w: () => get<TreasuryForecast>("/treasury/13w"),
  scenarioDrivers: () => get<{ drivers: DriverDef[] }>("/scenario/drivers"),
  scenarioProject: (assumptions: Record<string, number>, as_of?: string) =>
    post<ProjectResult>("/scenario/project", { assumptions, as_of }),
  scenarioPlans: (period?: string) =>
    get<{ period: string; plans: PlanListItem[]; unavailable?: boolean }>(
      `/scenario/plans${period ? `?period=${encodeURIComponent(period)}` : ""}`),
  scenarioPlan: (id: string) => get<ScenarioPlan>(`/scenario/plans/${encodeURIComponent(id)}`),
  scenarioCreate: (body: { name: string; assumptions?: Record<string, number> }) =>
    post<ScenarioPlan>("/scenario/plans", body),
  scenarioPatch: (id: string, body: { name?: string; assumptions?: Record<string, number> }) =>
    patch<ScenarioPlan>(`/scenario/plans/${encodeURIComponent(id)}`, body),
  scenarioCommit: (id: string) =>
    post<ScenarioPlan>(`/scenario/plans/${encodeURIComponent(id)}/commit`),
  scenarioClone: (id: string) =>
    post<ScenarioPlan>(`/scenario/plans/${encodeURIComponent(id)}/clone`),
  scenarioArchive: (id: string) =>
    post<{ scenario_id: string; status: string }>(`/scenario/plans/${encodeURIComponent(id)}/archive`),
  scenarioPublish: (id: string) =>
    post<ScenarioPlan>(`/scenario/plans/${encodeURIComponent(id)}/publish`),
  scenarioUnpublish: (id: string) =>
    post<ScenarioPlan>(`/scenario/plans/${encodeURIComponent(id)}/unpublish`),
  scenarioCompare: (ids: string[]) =>
    post<CompareResult>("/scenario/compare", { ids }),
  scenarioBridge: (body: { scenario_id?: string; assumptions?: Record<string, number>; target?: string }) =>
    post<BridgeResult>("/scenario/bridge", body),
};

export const fmt = (v: string | number | null | undefined) => {
  const n = typeof v === "string" ? parseFloat(v) : v ?? 0;
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
};

// Compact currency for CFO-altitude scanning: 12_400_000 -> "$12.4M",
// 150_000 -> "$150K", 2_411 -> "$2,411". No cents. Auto-scales per value.
// Canonical home for what were three duplicated chart-local `fmtCompact`s.
export const fmtCompact = (v: string | number | null | undefined): string => {
  const n = typeof v === "string" ? parseFloat(v) : v ?? 0;
  if (Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "";
  if (a >= 1_000_000) return `${s}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 10_000) return `${s}$${Math.round(a / 1_000)}K`;
  return `${s}$${Math.round(a).toLocaleString("en-US")}`;
};
// Signed compact (leading + on positives) for deltas/variances: "+$500K".
export const fmtSignedCompact = (v: string | number | null | undefined): string => {
  const n = typeof v === "string" ? parseFloat(v) : v ?? 0;
  if (Number.isNaN(n)) return "—";
  return (n > 0 ? "+" : "") + fmtCompact(n);
};
