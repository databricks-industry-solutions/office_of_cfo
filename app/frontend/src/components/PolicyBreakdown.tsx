import { useMemo, useState } from "react";
import { AdjustmentStatus, ApprovalMode, DecisionDetail, fmt } from "../api";
import { CHART_COLORS } from "../lib/chartPalette";

// Two questions, in order. First: how much of this period did the policy decide
// on its own? That is the donut — two slices, nothing else. Second: within
// whichever half you pick, what drove it? That is the panel on the right.
//
// The breakdown is bars rather than a flow diagram on purpose. A Sankey has to
// conserve flow, which forces every entry into exactly one rule and hides any
// rule that never wins the tie. Bars carry no such constraint: an entry appears
// under every rule it broke, so no rule can go missing. The cost is that the
// bars sum to more than the slice, which the caption states outright.
//
// Reversals are excluded throughout: they are system-generated corrections, so
// counting them would flatter the automation rate and double-count the entry
// they undo. Recalls appear instead as the shaded part of each auto-approved bar.

export type Lane = "auto" | "review";

export type Focus =
  | { kind: "lane"; lane: Lane }
  | { kind: "rule"; rule: string }
  | { kind: "type"; type: string };

/** The shape this needs from an adjustment; `AdjustmentGroup` satisfies it. */
export interface DecisionEntry {
  adjustment_id: string;
  amount: number;
  status: AdjustmentStatus;
  approval_mode: ApprovalMode;
  adjustment_type: string | null;
  decision_detail: DecisionDetail | null;
  recalled_by: string | null;
  is_reversal: boolean;
}

/** How far along the four-eyes chain an entry is, from this persona's seat. The
 *  three stages are the same ones the queue below splits into, so a bar segment
 *  and a queue section always mean the same thing. */
type Stage = "mine" | "elsewhere" | "done";

const stageOf = (e: DecisionEntry, canApprove: boolean, canSignOff: boolean): Stage => {
  if (e.status === "signed_off") return "done";
  const isMine = e.status === "pending" ? canApprove : canSignOff;
  return isMine ? "mine" : "elsewhere";
};

const LANE_LABEL: Record<Lane, string> = {
  auto: "Auto-approved by policy",
  review: "Needs review",
};
const LANE_TONE: Record<Lane, string> = {
  auto: CHART_COLORS.seriesC,   // violet — matches the `Policy vN` badge on a row
  review: CHART_COLORS.warn, // signal-warn — matches the broken-rule chips
};
const RECALL_TONE = CHART_COLORS.bad;
// A review bar keeps its full length — the rule caught the entry whatever happened
// next — but steps the gold down as the entry moves along the chain, so the part
// still sitting with this persona visibly shrinks as they work the queue.
const STAGE_TONE: Record<Stage, string> = {
  mine: LANE_TONE.review,
  elsewhere: `${CHART_COLORS.seriesB}80`,
  done: CHART_COLORS.slate,
};
const NO_RULE = "__none__";
const UNTYPED = "__untyped__";

export const laneOf = (e: DecisionEntry): Lane =>
  e.approval_mode === "auto" ? "auto" : "review";

const prettify = (s: string) =>
  s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Rule label as the engine worded it, falling back to the raw id. */
function ruleLabel(rule: string, entries: DecisionEntry[]): string {
  if (rule === NO_RULE) return "No rule recorded";
  for (const e of entries) {
    const hit = e.decision_detail?.evaluations.find((v) => v.rule === rule);
    if (hit) return hit.label;
  }
  return prettify(rule);
}

/** The rules an entry broke — or the catch-all, so nothing goes uncounted. */
function brokenBy(e: DecisionEntry): string[] {
  const broken = e.decision_detail?.broken_rules ?? [];
  return broken.length ? broken : [NO_RULE];
}

export function matchesFocus(e: DecisionEntry, f: Focus): boolean {
  if (e.is_reversal) return false;
  switch (f.kind) {
    case "lane": return laneOf(e) === f.lane;
    case "rule": return laneOf(e) === "review" && brokenBy(e).includes(f.rule);
    case "type": return laneOf(e) === "auto" && (e.adjustment_type ?? UNTYPED) === f.type;
  }
}

export function focusLabel(f: Focus, entries: DecisionEntry[]): string {
  switch (f.kind) {
    case "lane": return LANE_LABEL[f.lane];
    case "rule": return ruleLabel(f.rule, entries);
    case "type": return f.type === UNTYPED ? "No type recorded" : prettify(f.type);
  }
}

const sameFocus = (a: Focus | null, b: Focus) =>
  !!a && a.kind === b.kind &&
  (b.kind === "lane" ? (a as any).lane === b.lane
    : b.kind === "rule" ? (a as any).rule === b.rule
    : (a as any).type === b.type);

/** Below this the two slices say nothing the tiles above have not. */
export const BREAKDOWN_MIN_ENTRIES = 3;

const compact = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `$${Math.round(n / 1_000)}k`
    : `$${Math.round(n)}`;

export default function PolicyBreakdown({
  entries, metric, onMetricChange, focus, onFocusChange, canApprove, canSignOff, waitingOn,
}: {
  entries: DecisionEntry[];
  metric: "count" | "value";
  onMetricChange: (m: "count" | "value") => void;
  focus: Focus | null;
  onFocusChange: (f: Focus | null) => void;
  canApprove: boolean;
  canSignOff: boolean;
  /** Who holds an entry this persona cannot action — "the CFO" / "the Controller". */
  waitingOn: string;
}) {
  // Which half's breakdown is on show. Kept separate from `focus` so opening the
  // page can explain the review pile without silently filtering the queue.
  const [shown, setShown] = useState<Lane | null>(null);

  const population = useMemo(() => entries.filter((e) => !e.is_reversal), [entries]);
  const lanes = useMemo(() => ({
    auto: population.filter((e) => laneOf(e) === "auto"),
    review: population.filter((e) => laneOf(e) === "review"),
  }), [population]);

  const weigh = (list: DecisionEntry[]) => metric === "value"
    ? list.reduce((s, e) => s + Math.max(e.amount, 0), 0)
    : list.length;
  const show = (list: DecisionEntry[]) => metric === "value"
    ? compact(weigh(list)) : `${list.length}`;

  const lane: Lane = shown ?? (lanes.review.length ? "review" : "auto");
  const pick = (f: Focus, l: Lane) => {
    setShown(l);
    onFocusChange(sameFocus(focus, f) ? null : f);
  };

  // One row per rule broken, with the entry appearing under each of them, split by
  // how far along the chain each one is.
  const ruleRows = useMemo(() => {
    const map = new Map<string, DecisionEntry[]>();
    for (const e of lanes.review) {
      for (const r of brokenBy(e)) {
        const list = map.get(r);
        if (list) list.push(e); else map.set(r, [e]);
      }
    }
    return [...map.entries()]
      .map(([rule, list]) => ({
        rule,
        label: ruleLabel(rule, list),
        list,
        stages: {
          mine: list.filter((e) => stageOf(e, canApprove, canSignOff) === "mine"),
          elsewhere: list.filter((e) => stageOf(e, canApprove, canSignOff) === "elsewhere"),
          done: list.filter((e) => stageOf(e, canApprove, canSignOff) === "done"),
        },
      }))
      .sort((a, b) => weigh(b.list) - weigh(a.list));
  }, [lanes.review, metric, canApprove, canSignOff]);

  // Counted over entries, not over rule rows: an entry that broke two rules appears
  // in two bars but is still one thing on this persona's desk, and this number has
  // to agree with the inbox tile above the card.
  const stillMine = useMemo(
    () => lanes.review.filter((e) => stageOf(e, canApprove, canSignOff) === "mine").length,
    [lanes.review, canApprove, canSignOff]);

  const typeRows = useMemo(() => {
    const map = new Map<string, DecisionEntry[]>();
    for (const e of lanes.auto) {
      const t = e.adjustment_type ?? UNTYPED;
      const list = map.get(t);
      if (list) list.push(e); else map.set(t, [e]);
    }
    return [...map.entries()]
      .map(([type, list]) => ({
        type,
        label: type === UNTYPED ? "No type recorded" : prettify(type),
        list,
        recalled: list.filter((e) => e.recalled_by),
      }))
      .sort((a, b) => weigh(b.list) - weigh(a.list));
  }, [lanes.auto, metric]);

  const violations = ruleRows.reduce((s, r) => s + r.list.length, 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,21rem)_1fr]">
      <div className="px-5 py-4 lg:border-r border-line">
        <div className="flex items-center justify-between gap-2 pb-3">
          <span className="text-xs text-fg-muted">This period</span>
          <div className="flex items-center gap-1 text-xs">
            {(["count", "value"] as const).map((m) => (
              <button key={m} type="button" onClick={() => onMetricChange(m)}
                      aria-pressed={metric === m}
                      className={`px-2 py-0.5 rounded-full transition ${
                        metric === m
                          ? "bg-black/[0.06] dark:bg-white/[0.10] text-fg font-medium"
                          : "text-fg-subtle hover:text-fg-muted"}`}>
                By {m}
              </button>
            ))}
          </div>
        </div>

        <Donut lanes={lanes} weigh={weigh} centre={show(population)}
               metric={metric} focus={focus} onPick={pick} />

        <div className="mt-3 space-y-1">
          {(["auto", "review"] as Lane[]).map((l) => {
            const list = lanes[l];
            const share = population.length
              ? Math.round((weigh(list) / (weigh(population) || 1)) * 100) : 0;
            const active = sameFocus(focus, { kind: "lane", lane: l });
            return (
              <button key={l} type="button" disabled={!list.length}
                      onClick={() => pick({ kind: "lane", lane: l }, l)}
                      aria-pressed={active}
                      className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition
                        ${active ? "bg-black/[0.05] dark:bg-white/[0.07] ring-1 ring-line"
                          : lane === l ? "bg-black/[0.02] dark:bg-white/[0.03]" : ""}
                        ${list.length ? "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                          : "opacity-50 cursor-default"}`}>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: LANE_TONE[l] }} />
                <span className="text-sm text-fg flex-1 min-w-0 truncate"
                      title={LANE_LABEL[l]}>{LANE_LABEL[l]}</span>
                <span className="text-sm tabular-nums text-fg">{show(list)}</span>
                <span className="text-xs tabular-nums text-fg-subtle w-8 text-right">{share}%</span>
              </button>
            );
          })}
        </div>

        <p className="mt-2.5 px-2 text-xs text-fg-subtle">
          Reversals excluded. These two are the period’s decision record, so they
          measure the policy and hold still as you work
          {stillMine > 0
            ? ` — the ${stillMine} still with you show up in the bars alongside.`
            : "."}
        </p>
      </div>

      <div className="px-5 py-4 border-t lg:border-t-0 border-line">
        {lane === "review" ? (
          <Panel
            title="Violated rules"
            caption={violations > lanes.review.length
              ? `${lanes.review.length} ${lanes.review.length === 1 ? "entry" : "entries"}, ` +
                `${violations} violations — an entry appears under every rule it broke.`
              : "Each entry broke a single rule."}
            // Bar length is the rule's whole catch for the period and does not move
            // as work is done; the darkest segment is what is still yours, so it is
            // the part that shrinks. Colour alone should not have to carry that.
            legend={([
              ["mine", "Needs you"],
              ["elsewhere", `With ${waitingOn}`],
              ["done", "Signed off"],
            ] as [Stage, string][])
              .filter(([s]) => ruleRows.some((r) => r.stages[s].length))
              .map(([s, label]) => ({ tone: STAGE_TONE[s], label }))}
            empty={!ruleRows.length && "Nothing came to a human this period."}>
            {ruleRows.map((r) => (
              <Bar key={r.rule} label={r.label}
                   segments={(["mine", "elsewhere", "done"] as Stage[]).map((s) => ({
                     weight: weigh(r.stages[s]), tone: STAGE_TONE[s],
                   }))}
                   max={Math.max(...ruleRows.map((x) => weigh(x.list)))}
                   value={show(r.list)}
                   note={r.stages.mine.length
                     ? `${r.stages.mine.length} with you` : undefined}
                   noteClass="text-signal-warn"
                   active={sameFocus(focus, { kind: "rule", rule: r.rule })}
                   onClick={() => pick({ kind: "rule", rule: r.rule }, "review")} />
            ))}
          </Panel>
        ) : (
          <Panel
            title="What the policy cleared"
            caption={typeRows.some((r) => r.recalled.length)
              ? "Each bar splits by what has since been recalled."
              : "Nothing the policy cleared has been recalled."}
            // Colour alone should not have to carry the split.
            legend={typeRows.some((r) => r.recalled.length) ? [
              { tone: LANE_TONE.auto, label: "Still standing" },
              { tone: RECALL_TONE, label: "Recalled" },
            ] : undefined}
            empty={!typeRows.length && "The policy has not cleared anything yet."}>
            {typeRows.map((r) => {
              const standing = r.list.filter((e) => !e.recalled_by);
              return (
                <Bar key={r.type} label={r.label}
                     segments={[
                       { weight: weigh(standing), tone: LANE_TONE.auto },
                       { weight: weigh(r.recalled), tone: RECALL_TONE },
                     ]}
                     max={Math.max(...typeRows.map((x) => weigh(x.list)))}
                     value={show(r.list)}
                     note={r.recalled.length
                       ? `${r.recalled.length} recalled` : undefined}
                     active={sameFocus(focus, { kind: "type", type: r.type })}
                     onClick={() => pick({ kind: "type", type: r.type }, "auto")} />
              );
            })}
          </Panel>
        )}
      </div>
    </div>
  );
}

function Donut({ lanes, weigh, centre, metric, focus, onPick }: {
  lanes: Record<Lane, DecisionEntry[]>;
  weigh: (l: DecisionEntry[]) => number;
  centre: string;
  metric: "count" | "value";
  focus: Focus | null;
  onPick: (f: Focus, l: Lane) => void;
}) {
  const R = 46, SW = 16, C = 2 * Math.PI * R;
  const order: Lane[] = ["auto", "review"];
  const total = order.reduce((s, l) => s + weigh(lanes[l]), 0);
  let offset = 0;

  return (
    <div className="flex items-center justify-center">
      <svg width={124} height={124} viewBox="0 0 124 124" role="img"
           aria-label={`${centre} adjustments: ${weigh(lanes.auto)} auto-approved, ` +
                       `${weigh(lanes.review)} sent to review`}>
        <g transform="rotate(-90 62 62)">
          <circle cx={62} cy={62} r={R} fill="none" strokeWidth={SW}
                  className="stroke-black/[0.06] dark:stroke-white/[0.08]" />
          {order.map((l) => {
            const w = weigh(lanes[l]);
            if (w <= 0 || total <= 0) return null;
            const len = (w / total) * C;
            const dash = offset;
            offset += len;
            const dim = !!focus && !sameFocus(focus, { kind: "lane", lane: l });
            return (
              <circle key={l} cx={62} cy={62} r={R} fill="none"
                      stroke={LANE_TONE[l]} strokeWidth={SW}
                      strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-dash}
                      opacity={dim ? 0.3 : 1}
                      className="cursor-pointer transition-opacity duration-150"
                      onClick={() => onPick({ kind: "lane", lane: l }, l)} />
            );
          })}
        </g>
        <text x={62} y={58} textAnchor="middle" dominantBaseline="middle"
              className="text-fg" fill="currentColor" fontSize={19} fontWeight={600}>
          {centre}
        </text>
        <text x={62} y={75} textAnchor="middle" dominantBaseline="middle"
              className="text-fg-subtle" fill="currentColor" fontSize={10}>
          {metric === "value" ? "posted" : "adjustments"}
        </text>
      </svg>
    </div>
  );
}

function Panel({ title, caption, legend, empty, children }: {
  title: string; caption: string;
  legend?: { tone: string; label: string }[];
  empty: string | false; children: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3 pb-0.5">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {!!legend?.length && (
          <div className="flex items-center gap-3 text-xs text-fg-muted">
            {legend.map((k) => (
              <span key={k.label} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: k.tone }} />
                {k.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="text-xs text-fg-muted pb-3">{caption}</p>
      {empty ? (
        <p className="py-8 text-center text-sm text-fg-muted">{empty}</p>
      ) : (
        <div className="space-y-1">{children}</div>
      )}
    </>
  );
}

function Bar({ label, segments, max, value, note, noteClass, active, onClick }: {
  label: string;
  segments: { weight: number; tone: string }[];
  max: number;
  value: string;
  note?: string;
  noteClass?: string;
  active: boolean;
  onClick: () => void;
}) {
  const total = segments.reduce((s, x) => s + x.weight, 0);
  // A zero-dollar entry still has to draw something, or the row reads as absent.
  const span = max > 0 ? Math.max((total / max) * 100, 1.5) : 0;
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
            className={`w-full flex items-center gap-3 px-2 py-1.5 rounded-lg text-left transition
              hover:bg-black/[0.04] dark:hover:bg-white/[0.05]
              ${active ? "bg-black/[0.05] dark:bg-white/[0.07] ring-1 ring-line" : ""}`}>
      <span className="w-36 shrink-0 text-sm text-fg truncate" title={label}>{label}</span>
      <span className="flex-1 min-w-0 h-5 rounded bg-black/[0.04] dark:bg-white/[0.06] overflow-hidden">
        <span className="flex h-full rounded" style={{ width: `${span}%` }}>
          {segments.map((s, i) => (
            s.weight > 0 && (
              <span key={i} className="h-full first:rounded-l last:rounded-r"
                    style={{ background: s.tone, flexGrow: s.weight, flexBasis: 0 }} />
            )
          ))}
        </span>
      </span>
      {note && <span className={`text-xs shrink-0 ${noteClass ?? "text-signal-bad"}`}>{note}</span>}
      <span className="text-sm tabular-nums text-fg w-14 text-right shrink-0">{value}</span>
    </button>
  );
}
