import { useEffect, useMemo, useState } from "react";
import { api, Burndown, CloseStatus, CloseTask, OrgTree, Persona, Scope, TaskSummary } from "../api";
import { PageId, PAGES, isHiddenFromNav, resolveCtaPage } from "../nav";
import { useOverlay } from "../lib/industry";
import { CloseBurndown } from "../components/CloseBurndown";
import { CloseBurnRate } from "../components/CloseBurnRate";
import { Button, Card } from "../components/ui";
import { DashboardGrid } from "../components/AppShell";
import { CHART_COLORS } from "../lib/chartPalette";

const VALID_PAGES = new Set(PAGES.map((p) => p.id));

interface ReadinessItem {
  label: string;
  value: number;
  ok: boolean;
  /** Source data hasn't landed yet, so this gate's count means nothing. */
  pending: boolean;
  target: PageId;
  query?: string;
}

/** One close blocker. The four of these are exactly the gate the verdict is
 *  computed from, so the strip's verdict is explained by the row beneath it. */
function GateTile({ item, onNavigate }: { item: ReadinessItem; onNavigate: (p: PageId, q?: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(item.target, item.query)}
      className={`tile tile-hover ring-1 border-l-2 p-4 text-left flex flex-col w-full h-full ${
        item.pending || item.ok ? "ring-line border-transparent" : "ring-signal-bad/30 border-signal-bad"
      }`}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted truncate" title={item.label}>
        {item.label}
      </div>
      <div className="h-9 flex items-center mt-1">
        {item.pending ? (
          <span className="text-3xl font-bold num leading-none text-fg-subtle">—</span>
        ) : item.ok ? (
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-signal-good/15 text-signal-good text-sm font-bold">
            ✓
          </span>
        ) : (
          <span className="text-3xl font-bold num leading-none text-signal-bad">{item.value}</span>
        )}
      </div>
    </button>
  );
}

export default function Dashboard({
  status, summary, scope, org, persona, onNavigate, refreshKey,
}: {
  status: CloseStatus | null;
  summary: TaskSummary | null;
  scope: Scope;
  org: OrgTree | null;
  persona: Persona | null;
  onNavigate: (p: PageId, query?: string) => void;
  refreshKey: number;
}) {
  const overlay = useOverlay();
  const [burndown, setBurndown] = useState<Burndown | null>(null);
  const [tasks, setTasks] = useState<CloseTask[]>([]);

  // Close burn-down fetches independently so it paints as soon as its query
  // returns, and a failure never blocks the rest of the overview.
  useEffect(() => {
    let cancelled = false;
    setBurndown(null);
    api.taskBurndown(scope)
      .then((b) => { if (!cancelled) setBurndown(b); })
      .catch(() => { if (!cancelled) setBurndown(null); });
    return () => { cancelled = true; };
  }, [refreshKey, scope]);

  // The task breakdown works off the raw task rows so it can re-bucket by any
  // dimension client-side without extra round-trips.
  useEffect(() => {
    let cancelled = false;
    api.closeTasks(scope)
      .then((t) => { if (!cancelled) setTasks(t); })
      .catch(() => { if (!cancelled) setTasks([]); });
    return () => { cancelled = true; };
  }, [refreshKey, scope]);

  const availablePages = useMemo(
    () => (persona
      ? (persona.pages as PageId[]).filter((p) => VALID_PAGES.has(p) && !isHiddenFromNav(p, overlay.hiddenPages))
      : []),
    [persona, overlay]);

  const cta = (preferred: PageId, query?: string): { target: PageId; query?: string } => {
    const target = resolveCtaPage(preferred, availablePages);
    // Task filters only apply on the Tasks page; drop them when we fall back
    // (e.g. CFO lands on Approvals in Close Execution).
    if (query && target !== preferred) return { target };
    return query ? { target, query } : { target };
  };

  const failCount = status?.fail_count ?? 0;
  const unexplained = status?.unexplained_variances ?? 0;
  const openTasks = summary ? (summary.overdue + summary.blocked) : 0;

  // Adjustments still inside four-eyes, counted the way the Approvals queue
  // counts them: this persona sees the entries only they can move, so the two
  // pages never disagree. Approve and sign off can both apply, hence the sum.
  const awaitingMe =
    (persona?.can_approve ? status?.pending_approval ?? 0 : 0) +
    (persona?.can_sign_off ? status?.awaiting_sign_off ?? 0 : 0);
  const approvalVerb = persona?.can_sign_off && !persona?.can_approve ? "sign-off" : "approval";

  // Unexplained variances are a hard close blocker: the ledger can carry an open
  // variance as long as it is adjusted or explained, so the verdict gates on the
  // unexplained count (plus data-quality), not the raw open count.
  const isGo = status?.close_status === "GO" && unexplained === 0;
  const verdict = status ? (isGo ? "GO" : "NO-GO") : "—";

  const dq = cta("data-sources");
  const variances = cta("reconciliation");
  const triage = cta("tasks", "view=list&overdue=1");
  const adjustments = cta("approvals");
  const signOff = cta("trial-balance");

  // A gate whose source hasn't landed yet reads as "—", never as a green check:
  // an all-clear glyph is a claim, and claiming it before the data arrives would
  // show a clean close that nobody has verified.
  const readiness: ReadinessItem[] = [
    { label: "Data-quality checks", value: failCount, ok: failCount === 0, pending: !status, ...dq },
    { label: "Unexplained variances", value: unexplained, ok: unexplained === 0, pending: !status, ...variances },
    { label: "Overdue / blocked tasks", value: openTasks, ok: openTasks === 0, pending: !summary, ...triage },
    { label: `Adjustments awaiting ${approvalVerb}`, value: awaitingMe, ok: awaitingMe === 0, pending: !status, ...adjustments },
  ];

  // Single, unambiguous next action for the controller. Approvals sit last before
  // the all-clear: an entry inside four-eyes is not yet in the signed-off ledger,
  // so calling the close ready while one waits would overstate it.
  const nextAction: { text: string; target: PageId; query?: string } =
    failCount > 0 ? { text: `Resolve ${failCount} failing quality check${failCount > 1 ? "s" : ""}`, ...dq }
    : unexplained > 0 ? { text: `Explain or resolve ${unexplained} variance${unexplained > 1 ? "s" : ""}`, ...variances }
    : (summary?.overdue ?? 0) > 0 ? { text: `Triage ${summary!.overdue} overdue task${summary!.overdue > 1 ? "s" : ""}`, ...triage }
    : awaitingMe > 0 ? { text: `Clear ${awaitingMe} adjustment${awaitingMe > 1 ? "s" : ""} awaiting ${approvalVerb}`, ...adjustments }
    : { text: "Close is ready to sign off", ...signOff };

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      {/* Verdict, schedule and the single next action — one line, not a tile. */}
      <CloseStatusStrip
        verdict={verdict}
        tone={status ? (isGo ? "good" : "bad") : "neutral"}
        summary={summary}
        burndown={burndown}
        action={status ? nextAction : null}
        onNavigate={onNavigate}
      />

      {/* The close gate: one tile per blocker, in the order the verdict resolves.
          Four across from `lg` — the same breakpoint the strip uses to go
          single-line — so the gate stays one horizontal sweep on any desktop. */}
      <DashboardGrid>
        {readiness.map((item) => (
          <div key={item.label} className="col-span-6 lg:col-span-3">
            <GateTile item={item} onNavigate={onNavigate} />
          </div>
        ))}
      </DashboardGrid>

      <DashboardGrid className="flex-1 min-h-0">
        {burndown && burndown.total > 0 && (
          <div className="col-span-12 lg:col-span-7 min-h-0">
            <CloseBurndown
              data={burndown}
              beforeChart={<CloseBurnRate data={burndown} />}
              className="h-full min-h-0 flex flex-col"
            />
          </div>
        )}
        {tasks.length > 0 && (
          <div className="col-span-12 lg:col-span-5 min-h-0">
            <TaskExplorer tasks={tasks} org={org} asOf={burndown?.today ?? summary?.today ?? null}
                          onNavigate={onNavigate} className="h-full min-h-0 flex flex-col" />
          </div>
        )}
      </DashboardGrid>

    </div>
  );
}

/**
 * Verdict, schedule and the single next action on one line. This replaces the
 * former full-bleed verdict tile plus the close-progress tile: the same facts
 * stay first-read, but the saturated signal colour shrinks to a chip so it stops
 * competing with the behind-plan bands and overdue segments that use it for
 * precise meaning, and the bucket counts cost a caption instead of a button row.
 */
function CloseStatusStrip({
  verdict, tone, summary, burndown, action, onNavigate,
}: {
  verdict: string;
  tone: "good" | "bad" | "neutral";
  summary: TaskSummary | null;
  burndown: Burndown | null;
  /** Null until the close status lands — no action is offered on unknown data. */
  action: { text: string; target: PageId; query?: string } | null;
  onNavigate: (p: PageId, query?: string) => void;
}) {
  const shell = {
    good: "bg-signal-good/[0.08] ring-signal-good/30",
    bad: "bg-signal-bad/[0.08] ring-signal-bad/30",
    neutral: "bg-black/[0.03] ring-line",
  }[tone];
  const chip = {
    good: "bg-signal-good text-white",
    bad: "bg-signal-bad text-white",
    neutral: "bg-black/[0.06] text-fg-muted",
  }[tone];

  const pct = summary?.pct_complete ?? 0;
  const buckets = summary?.buckets ?? {};
  // Days to the target close. Prefer the burn-down's business-day offsets
  // (target_t − today_t); fall back to the summary's calendar days-to-close.
  const bdToTarget = burndown ? burndown.target_t - burndown.today_t : (summary?.days_to_close ?? null);
  const past = bdToTarget != null && bdToTarget < 0;
  const daysUnit = burndown ? "business days" : "days";
  const daysTone = bdToTarget == null ? "text-fg-muted"
    : past ? "text-signal-bad"
    : bdToTarget <= 1 ? "text-signal-warn"
    : "text-signal-good";

  // Done first so the bar fills from the left and "to do" trails on the right.
  const barSegs = [...STATUS_SEGS].reverse();
  const bucketTotal = barSegs.reduce((n, s) => n + (buckets[s.key] ?? 0), 0);

  return (
    <section className={`rounded-xl ring-1 px-5 py-3 flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-6 ${shell}`}>
      <div className="flex items-center gap-3 min-w-0 shrink-0">
        <span className={`rounded-md px-2.5 py-1 text-sm font-bold tracking-wide ${chip}`}>{verdict}</span>
      </div>

      <div className="flex-1 min-w-0">
        {bdToTarget != null && (
          <div className={`text-sm font-medium ${daysTone}`}>
            {Math.abs(bdToTarget)} {daysUnit} {past ? "over target" : "to target"}
          </div>
        )}
        <div className="flex items-center gap-3 mt-1.5">
          <div className="h-1.5 rounded-full bg-black/[0.06] overflow-hidden flex-1 min-w-0 flex">
            {bucketTotal > 0 && barSegs.map((s) => {
              const n = buckets[s.key] ?? 0;
              if (!n) return null;
              return (
                <div key={s.key} title={`${s.label}: ${n} of ${bucketTotal} tasks`}
                     style={{ width: `${(n / bucketTotal) * 100}%`, backgroundColor: s.color }} />
              );
            })}
          </div>
          <span className="num text-xl font-semibold text-fg whitespace-nowrap shrink-0 leading-none">{pct}%</span>
        </div>
        {/* Legend, not just a caption: each count carries the swatch of the band
            it names, so the bar's colours are decodable without a hover. */}
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px] text-fg-muted mt-1">
          {barSegs.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1">
              <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
              <span className="num">{buckets[s.key] ?? 0}</span> {s.label.toLowerCase()}
            </span>
          ))}
        </div>
      </div>

      {action && (
        <Button
          variant="primary"
          size="sm"
          className="shrink-0 self-start lg:self-auto"
          onClick={() => onNavigate(action.target, action.query)}
        >
          {action.text} →
        </Button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Close task breakdown — one slice-and-dice chart that merges "Progress by
// workstream" and "Workload by owner". Pick a dimension to Group by (bars) and
// a measure to Stack by (segments); everything is computed from the raw task
// rows so re-bucketing is instant and needs no extra API calls.
// ---------------------------------------------------------------------------
// Task-state palette. In-flight stages use the theme's gold/blue/slate so the
// breakdown isn't a green/red scorecard. Done stays green — that's the one
// stage that really is "good" — and overdue stays amber so it doesn't compete
// with the NO-GO chip.
const EXP = {
  open: CHART_COLORS.slate,
  doing: CHART_COLORS.seriesB,
  review: CHART_COLORS.seriesA,
  done: CHART_COLORS.good,
  overdue: CHART_COLORS.warn,
};

type GroupBy = "workstream" | "owner" | "entity" | "priority" | "source";
type StackBy = "status" | "health";

const GROUP_OPTS: { id: GroupBy; label: string }[] = [
  { id: "workstream", label: "Workstream" },
  { id: "owner", label: "Owner" },
  { id: "entity", label: "Entity" },
  { id: "priority", label: "Priority" },
  { id: "source", label: "Source" },
];

const STATUS_SEGS = [
  { key: "NOT_STARTED", label: "To do", color: EXP.open },
  { key: "IN_PROGRESS", label: "Doing", color: EXP.doing },
  { key: "IN_REVIEW", label: "Review", color: EXP.review },
  { key: "DONE", label: "Done", color: EXP.done },
];
const HEALTH_SEGS = [
  { key: "done", label: "Done", color: EXP.done },
  { key: "open", label: "Open", color: EXP.open },
  { key: "overdue", label: "Overdue", color: EXP.overdue },
];

const SOURCE_LABEL: Record<string, string> = {
  template: "Template", recon: "Reconciliation", dq: "Data quality",
  manual: "Manual", concentration: "Concentration",
};
const PRIORITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

const isTaskOverdue = (t: CloseTask, today: string) =>
  t.status !== "DONE" && !!t.due_date && t.due_date.slice(0, 10) < today;

interface Category {
  key: string;          // raw value used for the tasks filter / navigation
  label: string;        // display label
  total: number;
  done: number;
  counts: Record<string, number>;
  filter: string | null; // Tasks query fragment, or null when not filterable
}

function TaskExplorer({
  tasks, org, asOf, onNavigate, className,
}: {
  tasks: CloseTask[];
  org: OrgTree | null;
  asOf: string | null;
  onNavigate: (p: PageId, query?: string) => void;
  className?: string;
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>("workstream");
  const [stackBy, setStackBy] = useState<StackBy>("status");
  const [hover, setHover] = useState<string | null>(null);

  const today = asOf ?? new Date().toISOString().slice(0, 10);
  const buName = useMemo(() => {
    const m: Record<string, string> = {};
    org?.units.forEach((u) => { m[u.business_unit_id] = u.business_unit_name; });
    return m;
  }, [org]);

  const segs = stackBy === "status" ? STATUS_SEGS : HEALTH_SEGS;

  const cats = useMemo(() => {
    const catOf = (t: CloseTask): { key: string; label: string; filter: string | null } => {
      switch (groupBy) {
        case "owner": {
          const raw = t.assignee;
          return raw
            ? { key: raw, label: raw, filter: `owner=${encodeURIComponent(raw)}` }
            : { key: "__unassigned", label: "Unassigned", filter: "owner=__unassigned" };
        }
        case "entity": {
          const raw = t.business_unit_id;
          return raw
            ? { key: raw, label: buName[raw] ?? raw, filter: `entity=${encodeURIComponent(raw)}` }
            : { key: "__none", label: "No entity", filter: null };
        }
        case "priority":
          return { key: t.priority, label: t.priority, filter: null };
        case "source":
          return { key: t.source, label: SOURCE_LABEL[t.source] ?? t.source, filter: null };
        case "workstream":
        default: {
          const raw = t.workstream || "Other";
          return { key: raw, label: raw, filter: `workstream=${encodeURIComponent(raw)}` };
        }
      }
    };

    const map = new Map<string, Category>();
    for (const t of tasks) {
      const { key, label, filter } = catOf(t);
      let c = map.get(key);
      if (!c) { c = { key, label, total: 0, done: 0, counts: {}, filter }; map.set(key, c); }
      c.total += 1;
      const isDone = t.status === "DONE";
      if (isDone) c.done += 1;
      if (stackBy === "status") {
        c.counts[t.status] = (c.counts[t.status] ?? 0) + 1;
      } else {
        const bucket = isDone ? "done" : isTaskOverdue(t, today) ? "overdue" : "open";
        c.counts[bucket] = (c.counts[bucket] ?? 0) + 1;
      }
    }
    const arr = [...map.values()];
    arr.sort((a, b) =>
      groupBy === "priority"
        ? (PRIORITY_ORDER[a.key] ?? 9) - (PRIORITY_ORDER[b.key] ?? 9)
        : b.total - a.total);
    return arr;
  }, [tasks, groupBy, stackBy, buName, today]);

  const maxTotal = Math.max(1, ...cats.map((c) => c.total));
  const hovered = cats.find((c) => c.key === hover) ?? null;

  const openCat = (c: Category) =>
    onNavigate("tasks", c.filter ? `view=list&${c.filter}` : "view=list");

  return (
    <Card
      title="Close task breakdown"
      action={<Button variant="outline" size="sm" onClick={() => onNavigate("tasks")}>Open tasks</Button>}
      className={className}
    >
      <div className="px-5 py-4 flex-1 flex flex-col min-h-0 gap-4">
        {/* Group by / Stack by toggles. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 shrink-0">
          <span className="text-[11px] uppercase tracking-wide text-fg-subtle">Group by</span>
          <Toggle options={GROUP_OPTS} value={groupBy} onChange={(v) => setGroupBy(v as GroupBy)} />
          <span className="w-px h-5 bg-line mx-1 hidden sm:block" />
          <span className="text-[11px] uppercase tracking-wide text-fg-subtle">Stack by</span>
          <Toggle
            options={[{ id: "status", label: "Status" }, { id: "health", label: "Health" }]}
            value={stackBy} onChange={(v) => setStackBy(v as StackBy)} />
        </div>

        {/* Bars — one per category, shared absolute scale (length = load). The
            list scrolls inside a fixed-height area so the card height stays
            constant no matter how many groups the current filter produces. */}
        <div className="space-y-2.5 flex-1 min-h-0 overflow-y-auto pr-1">
          {cats.map((c) => (
            <button
              key={c.key}
              onClick={() => openCat(c)}
              onMouseEnter={() => setHover(c.key)}
              onMouseLeave={() => setHover(null)}
              className={`w-full flex items-center gap-3 text-left rounded-md px-1 py-0.5 transition ${hover === c.key ? "bg-black/[0.03]" : ""}`}
            >
              <div className="w-32 shrink-0 min-w-0">
                <div className="text-sm text-fg truncate">{c.label}</div>
                <div className="text-[10px] text-fg-subtle num">{c.done}/{c.total} done</div>
              </div>
              <div className="flex-1 h-4 rounded-full bg-black/[0.04] overflow-hidden">
                <div className="flex h-full" style={{ width: `${(c.total / maxTotal) * 100}%` }}>
                  {segs.map((s) => {
                    const n = c.counts[s.key] ?? 0;
                    if (!n) return null;
                    return (
                      <div key={s.key} style={{ width: `${(n / c.total) * 100}%`, backgroundColor: s.color, opacity: 0.9 }}
                           title={`${s.label}: ${n}`} />
                    );
                  })}
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Legend (follows the active Stack by) + hover caption. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-subtle pt-0.5 shrink-0">
          {segs.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color, opacity: 0.9 }} />{s.label}
            </span>
          ))}
          <span className="ml-auto">
            {hovered ? (
              <>
                <span className="font-semibold text-fg">{hovered.label}</span>
                {segs.map((s) => (hovered.counts[s.key]
                  ? <span key={s.key}> · {s.label} <span className="num" style={{ color: s.color }}>{hovered.counts[s.key]}</span></span>
                  : null))}
              </>
            ) : (
              <>{cats.length} {groupBy === "priority" ? "levels" : "groups"} · click a bar to open its tasks</>
            )}
          </span>
        </div>
      </div>
    </Card>
  );
}

function Toggle({
  options, value, onChange,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-black/[0.04] p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`px-2.5 py-1 text-xs rounded-md font-medium transition ${
            value === o.id ? "bg-accent text-white shadow-sm" : "text-fg-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
