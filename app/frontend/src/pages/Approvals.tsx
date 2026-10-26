import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api, fmt, Adjustment, AdjustmentStatus, ApprovalMode, DecisionDetail, Persona,
} from "../api";
import { Button, Card, ErrorNote, Section, TableSkeleton } from "../components/ui";
import PolicyBreakdown, {
  BREAKDOWN_MIN_ENTRIES, Focus, focusLabel, matchesFocus,
} from "../components/PolicyBreakdown";

interface AdjustmentGroup {
  adjustment_id: string;
  status: AdjustmentStatus;
  amount: number;
  business_unit_id: string;
  memo: string;
  debit_account: string;
  credit_account: string;
  posted_by: string;
  posted_ts: string | null;
  approved_by: string | null;
  approved_ts: string | null;
  signed_off_by: string | null;
  signed_off_ts: string | null;
  adjustment_type: string | null;
  approval_mode: ApprovalMode;
  policy_version: number | null;
  decision_detail: DecisionDetail | null;
  recalled_by: string | null;
  recall_reason: string | null;
  is_reversal: boolean;
}

// Two leg-rows per adjustment collapse into one reviewable item.
function groupLegs(legs: Adjustment[]): AdjustmentGroup[] {
  const byId = new Map<string, AdjustmentGroup>();
  for (const l of legs) {
    const g = byId.get(l.adjustment_id) ?? {
      adjustment_id: l.adjustment_id,
      status: l.status,
      amount: l.amount,
      business_unit_id: l.business_unit_id,
      memo: l.memo,
      debit_account: "",
      credit_account: "",
      posted_by: l.posted_by,
      posted_ts: l.posted_ts,
      approved_by: l.approved_by,
      approved_ts: l.approved_ts,
      signed_off_by: l.signed_off_by,
      signed_off_ts: l.signed_off_ts,
      adjustment_type: l.adjustment_type,
      approval_mode: l.approval_mode ?? "manual",
      policy_version: l.policy_version,
      decision_detail: l.decision_detail,
      recalled_by: l.recalled_by,
      recall_reason: l.recall_reason,
      is_reversal: !!l.is_reversal,
    };
    if (l.dr_cr === "D") g.debit_account = l.account_code;
    else g.credit_account = l.account_code;
    byId.set(l.adjustment_id, g);
  }
  return Array.from(byId.values());
}

function fmtWhen(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function prettyType(t: string | null): string | null {
  if (!t) return null;
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const byPostedDesc = (a: AdjustmentGroup, b: AdjustmentGroup) =>
  (b.posted_ts ?? "").localeCompare(a.posted_ts ?? "");

// Broken-rule chips shown on a collapsed row before spilling into a "+N more".
const MAX_CHIPS = 2;

export default function Approvals({
  persona, onDataChange, refreshKey,
}: {
  persona: Persona | null;
  onDataChange: () => void;
  refreshKey: number;
}) {
  const [items, setItems] = useState<AdjustmentGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [metric, setMetric] = useState<"count" | "value">("count");
  // Slice or bar picked in the breakdown; drives the queue below it.
  const [focus, setFocus] = useState<Focus | null>(null);

  const canApprove = !!persona?.can_approve;
  const canSignOff = !!persona?.can_sign_off;
  const canRecall = canApprove || canSignOff;

  const refresh = useCallback(async () => {
    try {
      setItems(groupLegs(await api.adjustments()));
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Couldn’t load the approval queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const act = async (id: string, kind: "approve" | "sign-off") => {
    setBusyId(id); setError(null);
    try {
      if (kind === "approve") await api.approveAdjustment(id);
      else await api.signOffAdjustment(id);
      await refresh();
      onDataChange();
    } catch (e: any) {
      setError(e?.message || "Action failed.");
    } finally {
      setBusyId(null);
    }
  };

  const recall = async (id: string) => {
    const reason = window.prompt(
      "Why is this entry being recalled? A reversing entry will be posted and the " +
      "original kept on record.");
    if (!reason || reason.trim().length < 5) return;
    setBusyId(id); setError(null);
    try {
      await api.recallAdjustment(id, reason.trim());
      await refresh();
      onDataChange();
    } catch (e: any) {
      setError(e?.message || "Recall failed.");
    } finally {
      setBusyId(null);
    }
  };

  // The page has two jobs — surface the work, and hold the record — and they are
  // deliberately not the same list. Only what this persona can action is open by
  // default; everything settled collapses into the record below it. Reversals get
  // their own lane: they are system-generated corrections, so filing them under
  // "signed off by a person" would misstate who decided what.
  const lanes = useMemo(() => {
    const live = items.filter((i) => !i.is_reversal);
    const pending = live.filter((i) => i.status === "pending").sort(byPostedDesc);
    const approved = live.filter((i) => i.status === "approved").sort(byPostedDesc);
    const done = live.filter((i) => i.status === "signed_off");
    return {
      mine: [
        ...(canApprove ? pending : []),
        ...(canSignOff ? approved : []),
      ].sort(byPostedDesc),
      others: [
        ...(canApprove ? [] : pending),
        ...(canSignOff ? [] : approved),
      ].sort(byPostedDesc),
      auto: done.filter((i) => i.approval_mode === "auto").sort(byPostedDesc),
      manual: done.filter((i) => i.approval_mode !== "auto").sort(byPostedDesc),
      reversals: items.filter((i) => i.is_reversal).sort(byPostedDesc),
    };
  }, [items, canApprove, canSignOff]);

  // Reversals are system-generated corrections, so they never count toward the
  // automation rate — including them would flatter or distort it.
  const stats = useMemo(() => {
    const population = items.filter((i) => !i.is_reversal);
    const auto = population.filter((i) => i.approval_mode === "auto");
    const value = population.reduce((s, i) => s + i.amount, 0);
    const autoValue = auto.reduce((s, i) => s + i.amount, 0);
    return {
      total: population.length,
      auto: auto.length,
      rate: population.length ? Math.round((auto.length / population.length) * 100) : 0,
      valueRate: value ? Math.round((autoValue / value) * 100) : 0,
      autoValue,
      recalled: population.filter((i) => i.recalled_by).length,
    };
  }, [items]);

  // A focus is *why* an entry was decided the way it was, which outlives its
  // status — approving an entry does not remove it from the rule that caught it.
  const focused = useMemo(() => {
    if (!focus) return [];
    return items.filter((i) => matchesFocus(i, focus)).sort(byPostedDesc);
  }, [items, focus]);

  const actionVerb = canSignOff && !canApprove ? "sign-off" : "approval";
  // Whatever this persona cannot action is, by construction, sitting with the
  // other role — so an empty inbox can say where the work actually is.
  const waitingOn = canApprove ? "the CFO" : "the Controller";

  const rowProps = {
    open, toggle, busyId, canApprove, canSignOff, canRecall, act, recall,
  };

  return (
    <div className="space-y-5">
      {error && <ErrorNote message={error} />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <InboxTile count={lanes.mine.length} verb={actionVerb} loading={loading}
                   total={items.length} elsewhere={lanes.others.length}
                   waitingOn={waitingOn} />
        <AutomationTile stats={stats} loading={loading} />
      </div>

      {/* Below a handful of entries two slices say nothing the tiles above
          have not already said. */}
      {!loading && stats.total >= BREAKDOWN_MIN_ENTRIES && (
        <Card>
          <PolicyBreakdown
            entries={items} metric={metric} onMetricChange={setMetric}
            focus={focus} onFocusChange={setFocus}
            canApprove={canApprove} canSignOff={canSignOff} waitingOn={waitingOn} />
        </Card>
      )}

      {loading ? (
        <Card title="Approval queue"><TableSkeleton rows={4} cols={4} /></Card>
      ) : items.length === 0 ? (
        <Card title="Approval queue">
          <div className="px-5 py-12 text-center text-fg-muted text-sm">
            No adjustments yet. Post one from the Reconciliation Breaks page to start the workflow.
          </div>
        </Card>
      ) : focus ? (
        <Card
          title={`${focusLabel(focus, focused)} · ${focused.length} ${
            focused.length === 1 ? "entry" : "entries"}`}
          action={
            <Button variant="outline" size="sm" onClick={() => setFocus(null)}>
              Show the full queue
            </Button>
          }>
          {focused.length === 0 ? (
            <div className="px-5 py-10 text-center text-fg-muted text-sm">
              Nothing is left in this group.
            </div>
          ) : (
            <ul className="divide-y">
              {focused.map((a) => <Row key={a.adjustment_id} a={a} {...rowProps} />)}
            </ul>
          )}
        </Card>
      ) : (
        <div className="space-y-4">
          {lanes.mine.length > 0 && (
            <Card title={`Needs your ${actionVerb}`}>
              <ul className="divide-y">
                {lanes.mine.map((a) => <Row key={a.adjustment_id} a={a} {...rowProps} />)}
              </ul>
            </Card>
          )}

          {lanes.others.length > 0 && (
            <Section title={`In flight with ${waitingOn}`} count={lanes.others.length}>
              <ul className="divide-y">
                {lanes.others.map((a) => <Row key={a.adjustment_id} a={a} {...rowProps} />)}
              </ul>
            </Section>
          )}

          {lanes.auto.length > 0 && (
            <Section title="Auto-approved by policy" count={lanes.auto.length}>
              <ul className="divide-y">
                {lanes.auto.map((a) => <Row key={a.adjustment_id} a={a} {...rowProps} />)}
              </ul>
            </Section>
          )}

          {lanes.manual.length > 0 && (
            <Section title="Signed off by a person" count={lanes.manual.length}>
              <ul className="divide-y">
                {lanes.manual.map((a) => <Row key={a.adjustment_id} a={a} {...rowProps} />)}
              </ul>
            </Section>
          )}

          {lanes.reversals.length > 0 && (
            <Section title="Reversals" count={lanes.reversals.length}>
              <ul className="divide-y">
                {lanes.reversals.map((a) => <Row key={a.adjustment_id} a={a} {...rowProps} />)}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

/** The call to action: the one number that decides whether this page needs you.
 *
 *  The attention state is carried by a filled amber eyebrow rather than a tinted
 *  background or ring: `.tile` sets its own background and `.dark .tile` rewrites
 *  `box-shadow`, so both a `bg-*` tint and a `ring-*` colour are silently lost.
 */
function InboxTile({ count, verb, loading, total, elsewhere, waitingOn }: {
  count: number; verb: string; loading: boolean;
  total: number; elsewhere: number; waitingOn: string;
}) {
  const clear = count === 0;
  // Nothing posted at all is not the same as nothing left to do, and the queue
  // below says "No adjustments yet" — so this must not claim anything cleared.
  const clearCopy = total === 0
    ? "No adjustments have been posted for this period yet."
    : elsewhere > 0
      ? `${elsewhere} ${elsewhere === 1 ? "entry is" : "entries are"} still with ${waitingOn}.`
      // Deliberately silent on *how* it was approved: saying "cleared the policy"
      // is false in a period where nothing auto-approved.
      : "Everything posted this period has been signed off.";
  return (
    <div className="tile ring-1 ring-line p-5 lg:col-span-2">
      {loading ? (
        <div className="h-14" />
      ) : clear ? (
        <>
          {/* Green is a verdict. An empty period has not passed anything yet. */}
          <div className={`text-2xl font-semibold ${
            total === 0 ? "text-fg-muted" : "text-signal-good"}`}>
            {total === 0 ? "Nothing here yet" : "Nothing needs you"}
          </div>
          <p className="text-sm text-fg-muted mt-1">{clearCopy}</p>
        </>
      ) : (
        <>
          {/* Solid amber, dark text. White on #B8862F is only 3.2:1, and a 15%
              wash barely separated from the tile — this is the loudest thing on
              the page by design, so it has to clear AA in both themes. */}
          <span className="inline-block text-[11px] font-semibold uppercase tracking-wide
                           px-2 py-0.5 rounded-full bg-signal-warn text-fg dark:text-ink-900">
            Action required
          </span>
          <div className="flex items-baseline gap-2 mt-2">
            <span className="text-5xl font-bold num text-signal-warn">{count}</span>
            <span className="text-lg font-medium text-fg">
              {count === 1 ? "entry needs" : "entries need"} your {verb}
            </span>
          </div>
          <p className="text-sm text-fg-muted mt-1">
            These broke the approval policy. Everything else cleared it without a human.
          </p>
        </>
      )}
    </div>
  );
}

/** The counterweight: how much the policy is deciding, by count AND by value.
 *  Deliberately quieter than the inbox — it is a statistic, not a task. */
function AutomationTile({ stats, loading }: {
  stats: { total: number; auto: number; rate: number; valueRate: number; autoValue: number; recalled: number };
  loading: boolean;
}) {
  const idle = stats.auto === 0;
  return (
    <div className="tile ring-1 ring-line p-5">
      {/* Not "Auto-approved by policy" — that names the lane below, and the same
          words heading a rate and a list reads as the same thing twice. */}
      <div className="text-[11px] uppercase tracking-wide text-fg-muted">Automation rate</div>
      {/* "None yet" is a claim about the period; don't make it before the
          adjustments have actually loaded. */}
      {loading ? (
        <div className="h-14" />
      ) : idle ? (
        <>
          <div className="text-2xl font-semibold text-fg-muted mt-1">None yet</div>
          <div className="text-xs text-fg-subtle mt-1.5">
            {stats.total === 0
              ? "No adjustments posted this period."
              : `All ${stats.total} came to a human.`}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-3xl font-bold num text-violet-600 dark:text-violet-300">
              {stats.rate}%
            </span>
            <span className="text-sm text-fg-muted">{stats.auto} of {stats.total}</span>
          </div>
          <div className="text-xs text-fg-muted mt-1.5">
            {fmt(stats.autoValue)} · {stats.valueRate}% by value
          </div>
          <div className="text-xs text-fg-muted mt-0.5">Reversals excluded</div>
          {stats.recalled > 0 && (
            <div className="text-xs text-fg-muted mt-0.5">
              {stats.recalled} since recalled
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Collapsed: amount, where, and the one thing that explains this row. Expanded:
 *  the full evidence — accounts, memo, timeline, and every rule the policy ran. */
function Row({
  a, open, toggle, busyId, canApprove, canSignOff, canRecall, act, recall,
}: {
  a: AdjustmentGroup;
  open: Set<string>;
  toggle: (id: string) => void;
  busyId: string | null;
  canApprove: boolean;
  canSignOff: boolean;
  canRecall: boolean;
  act: (id: string, kind: "approve" | "sign-off") => void;
  recall: (id: string) => void;
}) {
  const expanded = open.has(a.adjustment_id);
  const busy = busyId === a.adjustment_id;
  const broken = a.decision_detail?.evaluations.filter((e) => !e.passed) ?? [];
  const auto = a.approval_mode === "auto";

  return (
    <li>
      <div className="flex items-center gap-3 px-5 py-3 min-h-[3.25rem] record-row-hover">
        <button
          onClick={() => toggle(a.adjustment_id)}
          aria-expanded={expanded}
          aria-controls={expanded ? `detail-${a.adjustment_id}` : undefined}
          className="flex-1 min-w-0 text-left flex items-center gap-3"
        >
          <span aria-hidden="true"
                className={`text-fg-subtle text-xs w-3 shrink-0 transition-transform ${
                  expanded ? "rotate-90" : ""}`}>▶</span>

          <span className="num font-semibold text-fg tabular-nums w-32 shrink-0 text-right">
            {fmt(a.amount)}
          </span>

          <span className="text-xs text-fg-muted w-16 shrink-0">{a.business_unit_id}</span>

          <span className="min-w-0 flex items-center gap-1.5 flex-wrap">
            {prettyType(a.adjustment_type) && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-black/[0.05] text-fg-muted whitespace-nowrap">
                {prettyType(a.adjustment_type)}
              </span>
            )}
            {auto && (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-violet-500/10 text-violet-700 dark:text-violet-300 ring-1 ring-violet-500/25 whitespace-nowrap">
                Policy v{a.policy_version ?? "?"}
              </span>
            )}
            {a.is_reversal && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-black/[0.05] text-fg-muted whitespace-nowrap">
                Reversal
              </span>
            )}
            {a.recalled_by && (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-signal-bad/10 text-signal-bad ring-1 ring-signal-bad/25 whitespace-nowrap">
                Recalled
              </span>
            )}
            {/* The reason lives as chips, not sentences: the full wording is one
                click away and the amount is already on the row. Capped, because
                the worst row would otherwise also be the busiest to read. */}
            {broken.slice(0, MAX_CHIPS).map((e) => (
              <span key={e.rule}
                    className="text-xs px-2 py-0.5 rounded-full font-medium bg-signal-warn/10 text-signal-warn ring-1 ring-signal-warn/25 whitespace-nowrap">
                {e.label}
              </span>
            ))}
            {broken.length > MAX_CHIPS && (
              <span className="text-xs text-signal-warn whitespace-nowrap">
                +{broken.length - MAX_CHIPS} more
              </span>
            )}
          </span>
        </button>

        <div className="shrink-0 flex items-center gap-2">
          {a.status === "pending" && (canApprove ? (
            <Button variant="primary" size="sm" disabled={busy}
                    onClick={() => act(a.adjustment_id, "approve")}>
              {busy ? "Approving…" : "Approve"}
            </Button>
          ) : <span className="text-xs text-fg-subtle">Awaiting controller</span>)}

          {a.status === "approved" && (canSignOff ? (
            <Button variant="primary" size="sm" disabled={busy}
                    onClick={() => act(a.adjustment_id, "sign-off")}>
              {busy ? "Signing off…" : "Sign off"}
            </Button>
          ) : <span className="text-xs text-fg-subtle">Awaiting CFO</span>)}

          {/* A recalled entry was signed off and then undone; a green tick beside
              its red badge would read as two contradictory verdicts. */}
          {a.status === "signed_off" && (a.recalled_by ? (
            <span className="text-xs text-fg-subtle">Reversed</span>
          ) : (
            <span className="text-xs text-signal-good" aria-label="Signed off">✓</span>
          ))}
        </div>
      </div>

      {expanded && (
        <div id={`detail-${a.adjustment_id}`} className="px-5 pb-4 pl-11 space-y-3">
          <div className="text-xs text-fg-muted">
            <span className="font-mono">{a.adjustment_id}</span>
            {" · "}Dr {a.debit_account} / Cr {a.credit_account}
          </div>
          {a.memo && <div className="text-sm text-fg">{a.memo}</div>}
          {a.recalled_by && a.recall_reason && (
            <div className="text-xs text-signal-bad">
              Recalled by {a.recalled_by}: {a.recall_reason}
            </div>
          )}
          <Timeline a={a} />
          <RuleRecord detail={a.decision_detail} auto={auto} />
          {auto && !a.recalled_by && canRecall && (
            <Button variant="outline" size="sm" disabled={busy}
                    onClick={() => recall(a.adjustment_id)}>
              {busy ? "Recalling…" : "Recall this entry"}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** Every rule the policy ran, with the parameter as it stood at decision time.
 *  What failed is the reason this row is here, so it leads; what passed is still
 *  on the record but folds into one line until asked for. */
function RuleRecord({ detail, auto }: { detail: DecisionDetail | null; auto: boolean }) {
  const [showPasses, setShowPasses] = useState(false);
  if (!detail) return null;
  if (!detail.auto_approval_enabled) {
    return (
      <div className="text-xs text-signal-warn">
        Auto-approval was switched off when this was posted, so it came straight to a human.
      </div>
    );
  }
  const failed = detail.evaluations.filter((e) => !e.passed);
  const passed = detail.evaluations.filter((e) => e.passed);
  const line = (e: typeof detail.evaluations[number]) => (
    <div key={e.rule} className="text-xs flex items-start gap-1.5">
      <span className={e.passed ? "text-signal-good" : "text-signal-bad"} aria-hidden="true">
        {e.passed ? "✓" : "✕"}
      </span>
      <span className="text-fg-muted">
        <span className="font-medium text-fg">{e.label}</span> — {e.detail}
      </span>
    </div>
  );
  return (
    <div className="rounded-lg bg-black/[0.02] dark:bg-white/[0.03] ring-1 ring-line px-3.5 py-2.5 space-y-1">
      <div className="text-[11px] text-fg-subtle uppercase tracking-wide">
        {auto ? "Approved by" : "Evaluated against"} {detail.policy_name} v{detail.policy_version}
      </div>
      {failed.map(line)}
      {passed.length > 0 && (showPasses ? (
        passed.map(line)
      ) : (
        <button type="button" onClick={() => setShowPasses(true)}
                className="text-xs text-fg-subtle hover:text-fg-muted underline underline-offset-2">
          {passed.length} {passed.length === 1 ? "rule" : "rules"} passed
        </button>
      ))}
    </div>
  );
}

function Timeline({ a }: { a: AdjustmentGroup }) {
  // An auto-approved entry gets a single Policy node: the UI must never suggest a
  // person reviewed what a rule decided.
  const steps = a.approval_mode === "auto"
    ? [
        { label: "Posted", by: a.posted_by, ts: a.posted_ts, done: true, policy: false },
        {
          label: "Auto-approved & signed off",
          by: a.signed_off_by ?? `Policy v${a.policy_version}`,
          ts: a.signed_off_ts, done: true, policy: true,
        },
      ]
    : [
        { label: "Posted", by: a.posted_by, ts: a.posted_ts, done: true, policy: false },
        { label: "Approved", by: a.approved_by, ts: a.approved_ts, done: a.status !== "pending", policy: false },
        { label: "Signed off", by: a.signed_off_by, ts: a.signed_off_ts, done: a.status === "signed_off", policy: false },
      ];
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 ${s.done ? "text-fg" : "text-fg-subtle"}`}>
            <span className={`inline-block w-2 h-2 rounded-full ${
              !s.done ? "bg-fg-subtle" : s.policy ? "bg-violet-500" : "bg-signal-good"}`} />
            <span className="font-medium">{s.label}</span>
            {s.done && s.by && <span className="text-fg-muted">by {s.by}</span>}
            {s.done && s.ts && <span className="text-fg-subtle">· {fmtWhen(s.ts)}</span>}
          </span>
          {i < steps.length - 1 && <span className="text-fg-subtle">→</span>}
        </div>
      ))}
    </div>
  );
}
