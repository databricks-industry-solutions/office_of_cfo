import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles, MessageSquareText, Table2, BarChart3, ChevronRight, Check, Pencil,
  HelpCircle, X,
} from "lucide-react";
import {
  api, fmt, fmtCompact, fmtSignedCompact, getActivePeriod, CloseStatus, Persona, Scope, Window, CompareMode,
  ComparativeLine, ComparativeCommentary, VarianceDriver, CogsBridge, LineInsights,
  LineInsight, LineCommentary,
} from "../api";
import { Button, Card, ErrorNote, HBarSkeleton, SkeletonRegion, TableSkeleton, TextSkeleton } from "../components/ui";
import { openGenie } from "../components/GenieWindow";
import VarianceDashboard from "../components/VarianceDashboard";
import { ComparisonPicker, clampComparison, ComparisonKind } from "../components/ComparisonPicker";
import { CHART_COLORS } from "../lib/chartPalette";
import { useOverlay } from "../lib/industry";
import type { Overlay } from "../lib/industries";
import { comparisonDisplayLabels, withDisplayPeriod } from "../lib/demoCalendar";

type ViewMode = "table" | "dashboard";

type StatementKey = "income" | "balance" | "cashflow";

const TABS: { key: StatementKey; label: string }[] = [
  { key: "income", label: "Income Statement" },
  { key: "balance", label: "Balance Sheet" },
  { key: "cashflow", label: "Cash Flow" },
];

// The old two-axis "Time window × Compare with" pill rows are replaced by a
// single ComparisonPicker dropdown (see components/ComparisonPicker.tsx) that
// lists the valid whole comparisons as plain-English sentences. It still
// resolves to a (window, compare) pair, so nothing downstream changes.

// A single rendered line. Mirrors FinancialStatements' DisplayRow but carries the
// comparison value + variance so the extra columns can render.
export interface DisplayRow {
  key: string;
  // Stable statement line id (matches the API `line_id`). Used to join a row to
  // the drivers endpoint response — never match on `label`, which the overlay
  // relabels per industry.
  lineId?: string;
  label: string;
  actual: number | null;
  compare: number | null;
  varAbs: number | null;
  varPct: number | null;
  kind: "line" | "subtotal" | "total" | "section";
  indent?: boolean;
  // On expenses / liabilities an increase is unfavourable, so the sign that
  // colours the variance is flipped relative to the raw delta.
  favorableWhenUp?: boolean;
  // Favourability in terms of the RAW view amount (expense up = positive). The
  // drivers endpoint returns raw amounts, so the attribution tornado must colour
  // by this, not by `favorableWhenUp` (which is calibrated to the negated
  // display sign for expense lines).
  favorableRawUp?: boolean;
}

const n = (v: number | string | null | undefined) => (v == null ? 0 : Number(v) || 0);

// Resolve a line label through the overlay (same rules as FinancialStatements).
function labelFor(ov: Overlay, lineId: string, apiLabel: string): string {
  const sl = ov.statementLabels ?? {};
  if (sl[lineId]) return sl[lineId];
  if (lineId === "cogs") return ov.cogsLabel;
  return apiLabel;
}

const tabLabel = (ov: Overlay, key: StatementKey, fallback: string) =>
  ov.statementLabels?.[key] ?? fallback;

function isHidden(ov: Overlay, lineId: string): boolean {
  return (ov.hiddenStatementLines ?? []).includes(lineId);
}

const SECTION_TITLES: Record<string, string> = {
  assets: "Assets", liabilities: "Liabilities", equity: "Equity",
  operating: "Operating Activities", investing: "Investing Activities",
  financing: "Financing Activities",
};

// A blank comparison row so subtotals/totals stay type-consistent.
const BLANK = { compare: null, varAbs: null, varPct: null };

// --- Build the comparative display model for each statement. -----------------
// Each statement keeps its native structure (income = derived subtotals, balance
// & cash flow = sectioned) but every line now carries actual + comparison.

function buildIncome(lines: ComparativeLine[], ov: Overlay): DisplayRow[] {
  const byId = (id: string) => lines.find((l) => l.line_id === id);
  const val = (id: string, k: "actual" | "compare") => n(byId(id)?.[k]);
  const apiLabel = (id: string, dflt: string) => byId(id)?.line_label ?? dflt;

  // Derive subtotals on both actual and comparison so the variance ties out.
  const rev = { a: val("revenue", "actual"), c: val("revenue", "compare") };
  const cogs = { a: val("cogs", "actual"), c: val("cogs", "compare") };
  const opex = { a: val("opex", "actual"), c: val("opex", "compare") };
  const gp = { a: rev.a - cogs.a, c: rev.c - cogs.c };
  const oi = { a: gp.a - opex.a, c: gp.c - opex.c };

  const mk = (
    key: string, label: string, a: number, c: number,
    kind: DisplayRow["kind"], favorableWhenUp = true, favorableRawUp = favorableWhenUp,
  ): DisplayRow => ({
    key, lineId: key, label, actual: a, compare: c,
    varAbs: c == null ? null : Math.round((a - c) * 100) / 100,
    varPct: !c ? null : Math.round(((a - c) / Math.abs(c)) * 1000) / 10,
    kind, favorableWhenUp, favorableRawUp,
  });

  const out: DisplayRow[] = [
    mk("revenue", labelFor(ov, "revenue", apiLabel("revenue", "Revenue")), rev.a, rev.c, "line"),
    // cogs/opex are stored as NEGATED deductions (-cogs.a). Because the displayed
    // value is already negated, "up is favourable" holds on the displayed sign: a
    // higher (less-negative) value means the expense shrank. So favorableWhenUp
    // stays true here — flipping it double-negates and paints overspend green.
    // But the drivers endpoint returns the RAW (positive) expense amount, so
    // favorableRawUp is false: a higher raw expense is unfavourable.
    mk("cogs", labelFor(ov, "cogs", apiLabel("cogs", "Cost of Goods Sold")), -cogs.a, -cogs.c, "line", true, false),
    mk("gross_profit", labelFor(ov, "gross_profit", "Gross Profit"), gp.a, gp.c, "subtotal"),
    mk("opex", labelFor(ov, "opex", apiLabel("opex", "Operating Expenses")), -opex.a, -opex.c, "line", true, false),
    mk("operating_income", labelFor(ov, "operating_income", "Operating Income"), oi.a, oi.c, "subtotal"),
    mk("net_income", labelFor(ov, "net_income", "Net Income"), oi.a, oi.c, "total"),
  ];
  return out.filter((r) => !isHidden(ov, r.key));
}

function buildSectioned(
  lines: ComparativeLine[], ov: Overlay,
  sections: readonly string[], totalLabel: string, favorableWhenUp: boolean,
): DisplayRow[] {
  const out: DisplayRow[] = [];
  let grandA = 0, grandC = 0;
  for (const section of sections) {
    const inSection = lines.filter((l) => l.section === section && !isHidden(ov, l.line_id));
    if (inSection.length === 0) continue;
    out.push({ key: `sec-${section}`, label: SECTION_TITLES[section] ?? section, kind: "section",
      actual: null, ...BLANK });
    let subA = 0, subC = 0;
    for (const l of inSection) {
      const a = n(l.actual), c = l.compare == null ? null : n(l.compare);
      subA += a; subC += c ?? 0;
      out.push({
        key: `${section}-${l.line_id}`, lineId: l.line_id, label: labelFor(ov, l.line_id, l.line_label),
        actual: a, compare: c, varAbs: l.var_abs, varPct: l.var_pct,
        // Sectioned amounts aren't negated for display, so raw favourability
        // matches the display favourability here.
        kind: "line", indent: true, favorableWhenUp, favorableRawUp: favorableWhenUp,
      });
    }
    grandA += subA; grandC += subC;
    out.push({
      key: `total-${section}`, label: `Total ${SECTION_TITLES[section] ?? section}`,
      actual: subA, compare: subC, varAbs: Math.round((subA - subC) * 100) / 100,
      varPct: !subC ? null : Math.round(((subA - subC) / Math.abs(subC)) * 1000) / 10,
      kind: "subtotal", favorableWhenUp,
    });
  }
  out.push({
    key: "grand-total", label: totalLabel,
    actual: grandA, compare: grandC, varAbs: Math.round((grandA - grandC) * 100) / 100,
    varPct: !grandC ? null : Math.round(((grandA - grandC) / Math.abs(grandC)) * 1000) / 10,
    kind: "total", favorableWhenUp,
  });
  return out;
}

function buildRows(key: StatementKey, resp: ComparativeLine[], ov: Overlay): DisplayRow[] {
  if (key === "income") return buildIncome(resp, ov);
  if (key === "balance") return buildSectioned(resp, ov, ["assets", "liabilities", "equity"], "Total Liabilities & Equity", true);
  return buildSectioned(resp, ov, ["operating", "investing", "financing"], "Net Change in Cash", true);
}

// Format a signed variance with a leading +/- and accounting parentheses for
// negatives, e.g. -12000 -> "(12,000)".
const fmtVar = (v: number | null): string => {
  if (v == null) return "—";
  const s = fmtCompact(Math.abs(v));
  return v < 0 ? `(${s})` : v > 0 ? `+${s}` : s;
};
const fmtPct = (v: number | null): string => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);

// "% of Var" heat-fill tone: a magnitude bar tinted by favourability so it reads
// with the Variance/Var% colouring. Neutral slate when direction is ambiguous.
const povFill = (fav: boolean | null): string =>
  fav == null ? `${CHART_COLORS.slate}33` : fav ? `${CHART_COLORS.good}29` : `${CHART_COLORS.bad}29`;

/* --------------------------------------------------------------------------
 * Expandable driver detail — what a clicked line reveals inline.
 *
 * Two tiers, both reusing endpoints that already exist (no backend change):
 *   1. Rate / Volume / Mix — only where a real decomposition exists. Today that
 *      is COGS (from /bridge/cogs). Other lines simply omit this tier until the
 *      Tier-2 revenue PVM data lands, at which point a per-line bridge feeds it.
 *   2. Top movers by business unit × region — every line, from
 *      /statements/{stmt}/comparative/drivers?line_id=…
 *
 * Self-fetching on mount (i.e. on expand) so the parent table stays simple and
 * only the opened rows pay the query cost. Best-effort: a failed fetch degrades
 * to "no detail", never breaks the row.
 * ------------------------------------------------------------------------ */
function DriverDetail({
  lineId, favorableRawUp, stmt, window, compare, scope,
}: {
  lineId: string;
  favorableRawUp: boolean;
  stmt: StatementKey;
  window: Window;
  compare: CompareMode;
  scope: Scope;
}) {
  const [movers, setMovers] = useState<VarianceDriver[] | null>(null);
  const [bridge, setBridge] = useState<CogsBridge | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMovers(null); setBridge(null);
    // Rate/vol/mix only for COGS today; other lines skip that call entirely.
    const bridgeP = lineId === "cogs"
      ? api.cogsBridge(window, compare, scope).catch(() => null)
      : Promise.resolve(null);
    Promise.all([
      api.comparativeDrivers(stmt, window, compare, scope, lineId).catch(() => null),
      bridgeP,
    ]).then(([drv, br]) => {
      if (cancelled) return;
      setMovers(drv?.drivers ?? []);
      setBridge(br);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [lineId, stmt, window, compare, scope]);

  if (loading) {
    return (
      <SkeletonRegion className="px-9 py-3"><HBarSkeleton rows={4} /></SkeletonRegion>
    );
  }

  // Rate/vol/mix rows (COGS). For an expense, a positive effect = cost rose =
  // unfavourable, so favourability is the inverse of the raw-up sign.
  const rvmRows = bridge
    ? [
        { label: "Rate (unit cost)", val: bridge.rate_effect },
        { label: "Volume", val: bridge.volume_effect },
        { label: "Mix (residual)", val: bridge.residual },
      ].filter((d) => Math.abs(d.val) >= 1)
    : [];
  // Share of each effect = |effect| / Σ|effects| (gross). Same rationale as the
  // table's "% of Var": rate & volume can offset (rate up, volume down) so a
  // net-total denominator yields nonsensical >100% shares. Gross keeps them ≤100%
  // and summing to ~100%.
  const rvmGross = rvmRows.reduce((s, d) => s + Math.abs(d.val), 0);
  const rvmTone = (v: number) => {
    const fav = favorableRawUp ? v > 0 : v < 0;
    return fav ? "text-signal-good" : "text-signal-bad";
  };

  const moverMaxAbs = movers && movers.length
    ? Math.max(...movers.map((m) => Math.abs(m.var_abs)), 1) : 1;

  return (
    <div className="px-9 py-4 space-y-4 bg-black/[0.02]">
      {rvmRows.length > 0 && (
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
            Rate / Volume / Mix decomposition
          </div>
          <div className="space-y-1">
            {rvmRows.map((d) => {
              const share = rvmGross ? Math.round((Math.abs(d.val) / rvmGross) * 100) : null;
              return (
                <div key={d.label} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 text-[13px]">
                  <span className="text-fg-muted">→ {d.label}</span>
                  <span className={`text-right tabular-nums ${rvmTone(d.val)}`}>{fmtSignedCompact(d.val)}</span>
                  <span className="w-20 text-right text-xs text-fg-subtle">
                    {share == null ? "" : `${share}% of line`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
          Top movers — business unit × region
        </div>
        {movers && movers.length > 0 ? (
          <div className="space-y-1.5">
            {movers.map((m, i) => {
              const fav = m.var_abs === 0 ? null : favorableRawUp ? m.var_abs > 0 : m.var_abs < 0;
              const w = (Math.abs(m.var_abs) / moverMaxAbs) * 100;
              return (
                <div key={`${m.bu}-${m.region}-${i}`} className="grid grid-cols-[minmax(9rem,14rem)_1fr_auto] items-center gap-3 text-xs">
                  <span className="truncate text-fg-muted">{m.bu}<span className="text-fg-subtle"> · {m.region}</span></span>
                  <span className="relative h-3">
                    <span className="absolute inset-y-0 left-0 rounded"
                          style={{ width: `${w}%`,
                                   backgroundColor: fav == null ? CHART_COLORS.slate : fav ? CHART_COLORS.good : CHART_COLORS.bad }} />
                  </span>
                  <span className={`w-20 text-right tabular-nums ${fav == null ? "text-fg-subtle" : fav ? "text-signal-good" : "text-signal-bad"}`}>
                    {fmtSignedCompact(m.var_abs)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-fg-subtle">No business-unit detail for this line in the current view.</p>
        )}
      </div>
    </div>
  );
}

/** The AI Insight cell: a short headline "why" always visible, plus — when the
 *  model has a deeper, honestly-grounded point (margin/ratio context) — a "Why"
 *  toggle that expands the 1–2 sentence analysis. Keeps the table scannable while
 *  putting the analysis one click away. The toggle is kept off the row so it
 *  doesn't also fire the driver drill-down. */
/** Dismiss a popover/drawer on Escape or a click outside `ref`. */
function useDismiss(open: boolean, onClose: () => void, ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [open, onClose, ref]);
}

/** AI "why" for one line. The headline is clamped to a single line so every row
 *  keeps the same height; a "?" opens a popover with the full note — the deeper
 *  margin read when there is one, and always the complete headline, so a headline
 *  too long for the column is never left unreadable. The insight is already
 *  fetched with the page, so the popover is instant — no hover latency. Positioned
 *  `fixed` so it escapes the table's horizontal-scroll clip. */
function InsightCell({
  insight, loading, hasVar,
}: {
  insight: LineInsight | undefined;
  loading: boolean;
  hasVar: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [clipped, setClipped] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  useDismiss(open, () => setOpen(false), wrapRef);

  // The "?" should appear whenever there's more to see than the one visible line:
  // a deeper detail, or a headline the column had to truncate. Re-measure on any
  // column-width change so the affordance stays honest.
  const headline = insight?.headline ?? "";
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [headline]);

  if (!insight) {
    if (loading && hasVar) {
      // A shimmer bar (not a bare "…") so the ~10–20s ai_query wait reads clearly
      // as "insight loading here", never as an empty column.
      return (
        <span className="inline-flex items-center gap-2 text-fg-subtle" aria-label="Generating insight">
          <Sparkles className="w-3 h-3 animate-pulse text-accent shrink-0" />
          <span className="h-2 w-28 max-w-full rounded bg-fg/10 animate-pulse" />
        </span>
      );
    }
    return <span className="text-fg-subtle">—</span>;
  }

  const hasMore = !!insight.detail || clipped;
  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: Math.max(8, r.right - 300) });
    setOpen((o) => !o);
  };

  return (
    <span ref={wrapRef} className="flex items-center gap-1.5 min-w-0">
      <span ref={textRef} className="truncate text-fg-muted" title={insight.headline}>{insight.headline}</span>
      {hasMore && (
        <>
          <button
            ref={btnRef}
            type="button"
            onClick={(e) => { e.stopPropagation(); toggle(); }}
            aria-label={insight.detail ? "Show the full AI note and the margin detail" : "Show the full AI note"}
            aria-expanded={open}
            className="shrink-0 text-fg-subtle hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-full"
          >
            <HelpCircle className="w-3.5 h-3.5" />
          </button>
          {open && pos && (
            <div
              role="dialog"
              aria-label="AI insight detail"
              style={{ position: "fixed", top: pos.top, left: pos.left, width: 300 }}
              className="z-50 rounded-xl bg-ink-800 ring-1 ring-line shadow-depth p-3 text-xs"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-accent">
                <Sparkles className="w-3 h-3" /> AI insight
              </div>
              <p className="text-fg leading-snug">{insight.headline}</p>
              {insight.detail && (
                <p className="mt-1.5 text-fg-subtle leading-snug">{insight.detail}</p>
              )}
              <p className="mt-2 text-[10px] text-fg-subtle/70">AI-generated — verify against the figures above.</p>
            </div>
          )}
        </>
      )}
    </span>
  );
}

/** The commentary cell: whose words these are, and whether the CFO has signed
 *  off on them. Read-only for the CFO (plus an Acknowledge action); editable for
 *  whoever holds posting rights. Clicks are kept off the row so opening the
 *  editor doesn't also toggle the driver drill-down. */
/** One note within a cell: its wording, who wrote it, which cut it explains, and
 *  its own acknowledge action — so the CFO can sign off each region's note
 *  independently (each lives at its own scope in Lakebase). */
function SingleNote({
  note, canAck, onAck, divided,
}: {
  note: LineCommentary;
  canAck: boolean;
  onAck: () => Promise<void>;
  divided: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const acked = !!note.ack_ts;
  return (
    <div className={divided ? "pt-2 border-t border-fg/10" : ""}>
      <p className="text-fg">{note.commentary}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-fg-subtle">
        <span>
          {note.author_role || "—"}
          {note.author ? ` · ${note.author}` : ""}
        </span>
        {/* Which cut the note explains. The CFO reads notes from every scope, so
            without this an EMEA explanation would look like a consolidated one. */}
        {note.scope_label && (
          <span className="rounded bg-fg/5 px-1 py-px font-medium text-fg-subtle">
            {note.scope_label}
          </span>
        )}
        {/* Whether a human accepted the AI's words or rewrote them — the
            governance signal that separates this column from the AI insight. */}
        {note.from_ai_draft && (
          <span className="rounded bg-accent/10 px-1 py-px font-medium text-accent">
            {note.edited_from_draft ? "AI draft · edited" : "AI draft · accepted"}
          </span>
        )}
        {acked ? (
          <span className="inline-flex items-center gap-0.5 rounded bg-signal-good/10 px-1 py-px font-medium text-signal-good">
            <Check className="w-2.5 h-2.5" /> {note.ack_role || "CFO"} acknowledged
          </span>
        ) : (
          <span className="rounded bg-signal-warn/10 px-1 py-px font-medium text-signal-warn">
            Awaiting CFO
          </span>
        )}
        {canAck && !acked && (
          <button
            disabled={busy}
            onClick={async () => { setBusy(true); try { await onAck(); } finally { setBusy(false); } }}
            className="text-[10px] font-medium text-signal-good hover:underline disabled:opacity-50"
          >
            {busy ? "Acknowledging…" : "Acknowledge"}
          </button>
        )}
      </div>
    </div>
  );
}

/** Compact commentary status in the row — a single chip, so rows stay one line
 *  tall. It says whose cut is explained and where sign-off stands ("EMEA · Awaiting
 *  CFO", or "2 regional notes · 1 awaiting"); the full prose + per-region
 *  acknowledge live in a drawer opened on click. Empty falls back to Add note /
 *  Not yet explained. Clicks are kept off the row so this never toggles the driver
 *  drill-down. */
function CommentaryCell({
  notes, canWrite, onEdit, onOpen,
}: {
  notes: LineCommentary[];
  canWrite: boolean;
  onEdit: () => void;
  onOpen: () => void;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  if (notes.length === 0) {
    return (
      <div onClick={stop}>
        {canWrite ? (
          <button
            onClick={onEdit}
            className="inline-flex items-center gap-1 text-xs text-fg-subtle hover:text-accent"
          >
            <Pencil className="w-3 h-3" /> Add note
          </button>
        ) : (
          <span className="text-fg-subtle">Not yet explained</span>
        )}
      </div>
    );
  }

  const awaiting = notes.filter((n) => !n.ack_ts).length;
  const settled = awaiting === 0;
  // Single note names its cut; several notes summarize the sign-off backlog.
  const label = notes.length === 1
    ? `${notes[0].scope_label || "Consolidated"} · ${settled ? "Acknowledged" : "Awaiting CFO"}`
    : `${notes.length} notes · ${settled ? "all acknowledged" : `${awaiting} awaiting`}`;
  const tone = settled
    ? "bg-signal-good/10 text-signal-good ring-signal-good/30"
    : "bg-signal-warn/10 text-signal-warn ring-signal-warn/30";

  return (
    <div onClick={stop}>
      <button
        type="button"
        onClick={onOpen}
        className={`inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ${tone} hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
      >
        {settled ? <Check className="w-2.5 h-2.5 shrink-0" /> : null}
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}

/** Right-side drawer with the full controller notes for one line. A sign-off CFO
 *  reads notes from every scope, so each region's note shows under its own label
 *  with its own Acknowledge (each lives at its own scope in Lakebase); a Controller
 *  sees only their single-scope note plus Edit. Mirrors the app's TaskDrawer. */
function NotesDrawer({
  lineLabel, notes, canWrite, canAck, onClose, onAck, onEdit,
}: {
  lineLabel: string;
  notes: LineCommentary[];
  canWrite: boolean;
  canAck: boolean;
  onClose: () => void;
  onAck: (note: LineCommentary) => Promise<void>;
  onEdit: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const consolidated = notes.filter((n) => !n.scope_label);
  const regional = notes.filter((n) => n.scope_label);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true"
         aria-label={`Controller notes for ${lineLabel}`}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="relative w-full max-w-md bg-ink-800 h-full shadow-xl flex flex-col">
        <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Controller notes</div>
            <h3 className="text-base font-semibold leading-snug truncate">{lineLabel}</h3>
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 text-fg-subtle hover:text-fg">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Consolidated explanations are kept visually apart from the regional
              cuts, so a CFO never reads an EMEA note as company-wide. */}
          {consolidated.length > 0 && (
            <section className="space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Consolidated</div>
              {consolidated.map((n, i) => (
                <SingleNote key={`c:${n.scope_id}`} note={n} canAck={canAck} onAck={() => onAck(n)} divided={i > 0} />
              ))}
            </section>
          )}
          {regional.length > 0 && (
            <section className="space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                Regional {regional.length > 1 ? `(${regional.length})` : ""}
              </div>
              {regional.map((n, i) => (
                <SingleNote key={`r:${n.scope_type}:${n.scope_id}`} note={n} canAck={canAck} onAck={() => onAck(n)} divided={i > 0} />
              ))}
            </section>
          )}
          {canWrite && (
            <button onClick={onEdit} className="inline-flex items-center gap-1 text-xs text-fg-subtle hover:text-accent">
              <Pencil className="w-3 h-3" /> {notes.some((n) => canWrite) ? "Edit your note" : "Add note"}
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

/** Inline editor for one line's commentary. Opens pre-filled with the AI insight
 *  when there's no note yet, so the controller edits a draft rather than facing a
 *  blank box — but what gets saved is always the human's final wording, and the
 *  original draft travels along so we can show whether it was changed. */
function CommentaryEditor({
  lineLabel, existing, aiDraft, onCancel, onSave,
}: {
  lineLabel: string;
  existing: string;
  aiDraft: string;
  onCancel: () => void;
  onSave: (text: string, draft: string) => Promise<void>;
}) {
  const [text, setText] = useState(existing || aiDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = async () => {
    setBusy(true); setError("");
    try {
      await onSave(text.trim(), aiDraft);
    } catch (e: any) {
      setError(e?.message || "Couldn’t save the note.");
    } finally {
      // Always clear the spinner, even on success: onSave closes the editor, but if
      // the request fails (or the backend blocks until its pool times out) the button
      // must return to "Save note" with the error shown, never stay on "Saving…".
      setBusy(false);
    }
  };

  return (
    <div onClick={(e) => e.stopPropagation()} className="bg-black/[0.03] px-5 py-4 space-y-2">
      <div className="text-xs font-medium text-fg">Explain the {lineLabel} variance</div>
      <p className="text-[11px] text-fg-subtle">
        Your name and role are recorded with this note, and the CFO is asked to acknowledge it.
        Revising it later re-opens that acknowledgement.
      </p>
      {aiDraft && !existing && (
        <p className="text-[11px] text-fg-subtle">
          Pre-filled from the AI insight — edit it into your own words, or accept as-is.
        </p>
      )}
      <textarea
        ref={ref}
        className="w-full border border-line rounded-md px-3 py-2 text-sm min-h-[72px]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Unit costs rose on the new resin contract; pricing action lands next quarter."
      />
      {error && <div role="alert" className="text-xs text-signal-bad">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={busy || !text.trim()}>
          {busy ? "Saving…" : "Save note"}
        </Button>
      </div>
    </div>
  );
}

export default function ComparativeStatements({
  status, scope, persona, refreshKey,
}: {
  status: CloseStatus | null;
  scope: Scope;
  persona: Persona | null;
  refreshKey: number;
}) {
  const ov = useOverlay();
  const [tab, setTab] = useState<StatementKey>("income");
  const [view, setView] = useState<ViewMode>("table");
  const [window, setWindow] = useState<Window>("mtd");
  const [compare, setCompare] = useState<CompareMode>("prior");
  const [lines, setLines] = useState<ComparativeLine[]>([]);
  const [comparePeriod, setComparePeriod] = useState("");
  const [actualPeriod, setActualPeriod] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commentary, setCommentary] = useState<ComparativeCommentary | null>(null);
  const [commentaryLoading, setCommentaryLoading] = useState(true);
  // Per-line AI "why" (the always-on AI Insight column), keyed by line_id.
  // Loads alongside the statement; best-effort — empty map just renders blanks.
  const [insights, setInsights] = useState<Record<string, LineInsight>>({});
  const [insightsLoading, setInsightsLoading] = useState(true);
  // Which lines have their deeper AI insight expanded (by lineId). A set, not a
  // single id, because the CFO may want the fuller read open on several lines at
  // once while scanning. Reset when the view changes (below), like the drill-down.
  // Which line's controller-notes drawer is open (by lineId), if any.
  const [notesDrawer, setNotesDrawer] = useState<string | null>(null);
  // Which line row is expanded to show its driver detail (by lineId). Only one
  // open at a time. Reset when the statement/window/compare/scope changes, since
  // a line that was open may not exist (or means something else) in the new view.
  const [expanded, setExpanded] = useState<string | null>(null);
  // Controller-authored commentary for this exact view, keyed by line_id. The AI
  // insight above says why; this says who stands behind it. Best-effort like the
  // insights — an empty map just renders the "add" affordance.
  const [notes, setNotes] = useState<Record<string, LineCommentary>>({});
  // All notes per line (one per scope) for the sign-off cross-scope read; a
  // single-scope author gets a 0/1-length list per line. Drives the cell so each
  // region's note shows under its own label instead of the most recent winning.
  const [noteGroups, setNoteGroups] = useState<Record<string, LineCommentary[]>>({});
  // Which line's commentary editor is open (by lineId), independent of the
  // driver drill-down so a controller can read drivers while writing.
  const [editing, setEditing] = useState<string | null>(null);

  // Who may do what — the whole point of the feature. Controllers/accountants
  // author; the CFO acknowledges. Nobody does both.
  const canWrite = !!persona?.can_post;
  const canAck = !!persona?.can_sign_off;

  // The picker only offers valid comparisons for the current statement, but a
  // selection can carry over when the user switches tabs (e.g. a YTD-vs-budget
  // pick when moving to the balance sheet). clampComparison snaps it back to a
  // valid (window, compare) — balance = as-of period-end, budget = income-only,
  // YTD has no sequential prior — mirroring the backend's resolve_window_compare.
  const compareKind: ComparisonKind = tab === "income" ? "income" : tab === "balance" ? "balance" : "flow";
  const { window: effectiveWindow, compare: effectiveCompare } = clampComparison(compareKind, window, compare);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.comparativeStatement(tab, effectiveWindow, effectiveCompare, scope)
      .then((r) => { if (!cancelled) { setLines(r.lines); setComparePeriod(r.compare_period); setActualPeriod(r.actual_period); setError(null); } })
      .catch((e: any) => { if (!cancelled) setError(e?.message || "Couldn’t load the statement."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tab, effectiveWindow, effectiveCompare, scope, refreshKey]);

  // AI commentary — loads on page load and whenever the statement, window,
  // compare, scope or persona changes. The active persona travels on the request
  // header (set by App). Best-effort: on failure we clear it and show a fallback.
  useEffect(() => {
    let cancelled = false;
    setCommentaryLoading(true);
    api.comparativeCommentary(tab, effectiveWindow, effectiveCompare, scope)
      .then((r) => { if (!cancelled) setCommentary(r); })
      .catch(() => { if (!cancelled) setCommentary(null); })
      .finally(() => { if (!cancelled) setCommentaryLoading(false); });
    return () => { cancelled = true; };
  }, [tab, effectiveWindow, effectiveCompare, scope, refreshKey]);

  // Per-line AI insight — one grounded call returns a why-sentence per line_id.
  // Best-effort: on failure the map stays empty and the column renders blank.
  useEffect(() => {
    let cancelled = false;
    setInsightsLoading(true);
    setInsights({});
    api.comparativeLineInsights(tab, effectiveWindow, effectiveCompare, scope)
      .then((r) => { if (!cancelled) setInsights(r.available ? r.insights : {}); })
      .catch(() => { if (!cancelled) setInsights({}); })
      .finally(() => { if (!cancelled) setInsightsLoading(false); });
    return () => { cancelled = true; };
  }, [tab, effectiveWindow, effectiveCompare, scope, refreshKey]);

  // Controller commentary — reloaded whenever the view key changes, because a
  // commentary belongs to one statement/window/compare/scope combination.
  const reloadNotes = () => {
    api.comparativeLineCommentary(tab, effectiveWindow, effectiveCompare, scope)
      .then((r) => {
        setNotes(r.available ? r.entries : {});
        setNoteGroups(r.available ? (r.groups ?? {}) : {});
      })
      .catch(() => { setNotes({}); setNoteGroups({}); });
  };
  useEffect(() => {
    let cancelled = false;
    setNotes({});
    setNoteGroups({});
    api.comparativeLineCommentary(tab, effectiveWindow, effectiveCompare, scope)
      .then((r) => {
        if (cancelled) return;
        setNotes(r.available ? r.entries : {});
        setNoteGroups(r.available ? (r.groups ?? {}) : {});
      })
      .catch(() => { if (!cancelled) { setNotes({}); setNoteGroups({}); } });
    return () => { cancelled = true; };
  }, [tab, effectiveWindow, effectiveCompare, scope, refreshKey]);

  // Close any open drill-down when the view axes change (the row may not exist
  // or would show stale drivers for the new window/compare/scope).
  useEffect(() => {
    setExpanded(null); setEditing(null); setNotesDrawer(null);
  }, [tab, effectiveWindow, effectiveCompare, scope]);

  const display = useMemo(() => buildRows(tab, lines, ov), [tab, lines, ov]);

  // "% of Var" — each independent line's share of the period's TOTAL movement.
  // Denominator is the sum of the ABSOLUTE line-level variances (gross movement),
  // never the net total: with offsetting drivers a net-based share explodes when
  // the total nets to ~0. Only `line` rows count — subtotals/totals are derived
  // from them, so including them would double-count. Also flag the biggest mover
  // (the "TOP" badge). Keyed by row.key.
  const { povByKey, topKey } = useMemo(() => {
    const lineRows = display.filter((r) => r.kind === "line" && r.varAbs != null && r.varAbs !== 0);
    const gross = lineRows.reduce((s, r) => s + Math.abs(r.varAbs ?? 0), 0);
    const pov: Record<string, number> = {};
    let top: string | null = null, topAbs = 0;
    if (gross > 0) {
      for (const r of lineRows) {
        const abs = Math.abs(r.varAbs ?? 0);
        pov[r.key] = (abs / gross) * 100;
        if (abs > topAbs) { topAbs = abs; top = r.key; }
      }
    }
    return { povByKey: pov, topKey: top };
  }, [display]);
  const title = tabLabel(ov, tab, TABS.find((t) => t.key === tab)!.label);
  // Build period labels from the selected display-calendar month. This avoids
  // exposing the seed June/May labels even if a cached/raw API response arrives.
  const displayPeriod = getActivePeriod() || status?.period || actualPeriod || "";
  const displayLabels = comparisonDisplayLabels(displayPeriod, effectiveWindow, effectiveCompare);
  const period = displayLabels.actual || actualPeriod;
  // Accumulating windows sum a span, so label the Actual column to match.
  const actualHeader = tab === "balance" ? "Actual"
    : effectiveWindow === "ytd" ? "YTD"
    : effectiveWindow === "qtd" ? "Quarter" : "Actual";
  const scopeLabel = !scope || scope.scope_type === "consolidated" ? "Consolidated" : scope.scope_id;
  const displayComparePeriod = displayLabels.compare || comparePeriod;
  const displaySeedQuestion = commentary?.seed_question
    ? withDisplayPeriod(commentary.seed_question, displayPeriod)
    : "";
  const compareHeader = effectiveCompare === "budget" ? "Budget"
    : effectiveCompare === "scenario" ? `Official Forecast${displayComparePeriod ? ` (${displayComparePeriod})` : ""}`
    : effectiveCompare === "prior_year" ? `Prior Year${displayComparePeriod ? ` (${displayComparePeriod})` : ""}`
    : effectiveWindow === "qtd" ? `Prior Quarter${displayComparePeriod ? ` (${displayComparePeriod})` : ""}`
    : `Prior Period${displayComparePeriod ? ` (${displayComparePeriod})` : ""}`;

  // Was the movement favourable for this line? (revenue up = good; expense up =
  // bad). null when there's no movement / no direction to colour.
  const favorable = (r: DisplayRow): boolean | null => {
    if (r.varAbs == null || r.varAbs === 0) return null;
    return r.favorableWhenUp ? r.varAbs > 0 : r.varAbs < 0;
  };
  // Colour a variance green/red by favourability.
  const varTone = (r: DisplayRow): string => {
    const fav = favorable(r);
    return fav == null ? "" : fav ? "text-signal-good" : "text-signal-bad";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="inline-flex items-center gap-0.5 rounded-lg bg-black/[0.04] p-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition ${
                tab === t.key ? "bg-accent text-white shadow-sm" : "text-fg-muted hover:text-fg"
              }`}
            >
              {tabLabel(ov, t.key, t.label)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Single dropdown of valid, plain-English comparisons for this
              statement, grouped by timeframe. Replaces the old two pill rows. */}
          <ComparisonPicker
            kind={compareKind}
            window={window}
            compare={compare}
            onChange={(w, c) => { setWindow(w); setCompare(c); }}
          />
          {/* Table ↔ Dashboard view switch. Shares tab/window/compare/scope state. */}
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-black/[0.04] p-0.5">
            {([["table", Table2, "Table"], ["dashboard", BarChart3, "Dashboard"]] as const).map(
              ([key, Icon, label]) => (
                <button
                  key={key}
                  onClick={() => setView(key)}
                  aria-label={label}
                  title={label}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md font-medium transition ${
                    view === key ? "bg-accent text-white shadow-sm" : "text-fg-muted hover:text-fg"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ),
            )}
          </div>
        </div>
      </div>

      {error && <ErrorNote message={error} />}

      {view === "dashboard" ? (
        loading ? (
          <Card title={`${title} — ${scopeLabel}${period ? ` · ${period}` : ""} · ${compareHeader}`}>
            <TableSkeleton rows={6} cols={4} />
          </Card>
        ) : (
          <VarianceDashboard
            rows={display}
            stmt={tab}
            window={effectiveWindow}
            compare={effectiveCompare}
            scope={scope}
            compareHeader={compareHeader}
          />
        )
      ) : (
      <Card title={`${title} — ${scopeLabel}${period ? ` · ${period}` : ""} · ${compareHeader}`}>
        {loading ? (
          <TableSkeleton rows={8} cols={7} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-fg-muted border-b border-line">
                  <th className="px-5 py-2 text-left font-semibold">Line</th>
                  <th className="px-5 py-2 text-right font-semibold">{actualHeader}</th>
                  <th className="px-5 py-2 text-right font-semibold">{compareHeader}</th>
                  <th className="px-5 py-2 text-right font-semibold">Variance</th>
                  <th className="px-5 py-2 text-right font-semibold">Var %</th>
                  <th className="px-5 py-2 text-right font-semibold">% of Var</th>
                  <th className="px-5 py-2 text-left font-semibold">AI Insight (why)</th>
                  <th className="px-5 py-2 text-left font-semibold">Controller note</th>
                </tr>
              </thead>
              <tbody>
                {display.length === 0 && (
                  <tr><td colSpan={8} className="px-5 py-8 text-center text-fg-muted">No data in this scope.</td></tr>
                )}
                {display.map((r) => {
                  if (r.kind === "section") {
                    return (
                      <tr key={r.key} className="bg-black/[0.04]">
                        <td colSpan={8} className="px-5 py-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                          {r.label}
                        </td>
                      </tr>
                    );
                  }
                  const bold = r.kind === "total";
                  const subtotal = r.kind === "subtotal";
                  const actual = r.actual ?? 0;
                  // Only concrete lines with a stable id drill in (subtotals/totals
                  // are derived — nothing to attribute at BU/region grain).
                  const canExpand = r.kind === "line" && !!r.lineId;
                  const isOpen = canExpand && expanded === r.lineId;
                  return (
                    <Fragment key={r.key}>
                    <tr
                      onClick={canExpand ? () => setExpanded(isOpen ? null : r.lineId!) : undefined}
                      className={`border-b last:border-0 ${bold ? "font-semibold text-fg border-t-2 border-line" : subtotal ? "font-medium text-fg" : ""} ${canExpand ? "cursor-pointer record-row-hover" : ""} ${isOpen ? "bg-black/[0.02]" : ""}`}
                    >
                      <td className={`px-5 py-2 whitespace-nowrap ${r.indent ? "pl-9 text-fg-muted" : ""}`}>
                        {canExpand && (
                          <ChevronRight
                            className={`inline-block w-3.5 h-3.5 mr-1.5 -ml-1 text-fg-subtle transition-transform ${isOpen ? "rotate-90" : ""}`}
                          />
                        )}
                        {r.label}
                      </td>
                      <td className={`px-5 py-2 text-right tabular-nums whitespace-nowrap ${actual < 0 ? "text-signal-bad" : ""}`}>
                        {r.actual == null ? "" : fmtCompact(actual)}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums whitespace-nowrap text-fg-muted">
                        {r.compare == null ? "—" : fmtCompact(r.compare)}
                      </td>
                      <td className={`px-5 py-2 text-right tabular-nums whitespace-nowrap ${varTone(r)}`}>
                        {fmtVar(r.varAbs)}
                      </td>
                      <td className={`px-5 py-2 text-right tabular-nums whitespace-nowrap ${varTone(r)}`}>
                        {fmtPct(r.varPct)}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums whitespace-nowrap">
                        {povByKey[r.key] == null ? (
                          <span className="text-fg-subtle">—</span>
                        ) : (
                          <span className="relative inline-flex items-center justify-end min-w-[3.5rem] px-1.5 py-0.5 rounded">
                            <span
                              className="absolute inset-y-0.5 left-1 right-1 rounded"
                              style={{ width: `${Math.min(povByKey[r.key], 100)}%`,
                                       backgroundColor: povFill(favorable(r)) }}
                            />
                            <span className={`relative z-10 font-medium ${varTone(r)}`}>
                              {Math.round(povByKey[r.key])}%
                            </span>
                            {r.key === topKey && (
                              <span className="relative z-10 ml-1.5 rounded bg-signal-bad px-1 py-px text-[9px] font-bold uppercase tracking-wide text-white">
                                Top
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-2 text-left align-middle text-xs w-[22rem] max-w-[22rem]" onClick={(e) => e.stopPropagation()}>
                        <InsightCell
                          insight={r.lineId ? insights[r.lineId] : undefined}
                          loading={insightsLoading}
                          hasVar={r.varAbs != null && r.varAbs !== 0}
                        />
                      </td>
                      <td className="px-5 py-2 text-left align-middle text-xs max-w-[16rem]">
                        {canExpand ? (
                          <CommentaryCell
                            notes={noteGroups[r.lineId!] ?? (notes[r.lineId!] ? [notes[r.lineId!]!] : [])}
                            canWrite={canWrite}
                            onEdit={() => setEditing(editing === r.lineId ? null : r.lineId!)}
                            onOpen={() => setNotesDrawer(r.lineId!)}
                          />
                        ) : (
                          <span className="text-fg-subtle">—</span>
                        )}
                      </td>
                    </tr>
                    {canExpand && editing === r.lineId && (
                      <tr className="border-b last:border-0">
                        <td colSpan={8} className="p-0">
                          <CommentaryEditor
                            lineLabel={r.label}
                            existing={notes[r.lineId!]?.commentary ?? ""}
                            // Editing an existing note must preserve its ORIGINAL ai_draft, so the
                            // accepted/edited/from-scratch badge stays truthful — a note written by
                            // hand (stored ai_draft null) must not get re-stamped with the live AI
                            // insight. Only a brand-new note is pre-filled from the current insight
                            // (headline + deeper detail, so the controller starts from the fuller read).
                            aiDraft={notes[r.lineId!]
                              ? (notes[r.lineId!]!.ai_draft ?? "")
                              : (r.lineId && insights[r.lineId]
                                  ? [insights[r.lineId].headline, insights[r.lineId].detail].filter(Boolean).join(" ")
                                  : "")}
                            onCancel={() => setEditing(null)}
                            onSave={async (text, draft) => {
                              await api.saveLineCommentary(tab, {
                                line_id: r.lineId!, line_label: r.label,
                                commentary: text, ai_draft: draft || null,
                                window: effectiveWindow, compare: effectiveCompare,
                                scope_type: scope.scope_type, scope_id: scope.scope_id,
                              });
                              setEditing(null);
                              reloadNotes();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                    {isOpen && (
                      <tr className="border-b last:border-0">
                        <td colSpan={8} className="p-0">
                          <DriverDetail
                            lineId={r.lineId!}
                            favorableRawUp={r.favorableRawUp ?? true}
                            stmt={tab}
                            window={effectiveWindow}
                            compare={effectiveCompare}
                            scope={scope}
                          />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      )}

      {/* AI commentary — persona-aware key comments + a seeded Genie follow-up. */}
      <Card title={commentary?.persona === "cfo" ? "Key comments" : "Variance commentary"}>
        <div className="px-5 py-4 space-y-4">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
            <Sparkles className="w-3.5 h-3.5 text-accent" />
            AI-generated · grounded in the variances above
          </div>
          {commentaryLoading ? (
            <SkeletonRegion label="Generating commentary"><TextSkeleton lines={4} /></SkeletonRegion>
          ) : commentary?.available && commentary.comments.length > 0 ? (
            <ul className="space-y-2">
              {commentary.comments.map((c, i) => (
                <li key={i} className="flex gap-2 text-sm text-fg leading-relaxed">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">
              {commentary?.note || "AI commentary unavailable — see the variances above."}
            </p>
          )}

          {displaySeedQuestion && (
            <div className="pt-1">
              <button
                onClick={() => openGenie(displaySeedQuestion)}
                className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-fg hover:bg-black/[0.04] transition"
              >
                <MessageSquareText className="w-4 h-4 text-accent" />
                Ask a follow-up in Genie
              </button>
              <p className="mt-1.5 text-xs text-fg-muted">“{displaySeedQuestion}”</p>
            </div>
          )}
        </div>
      </Card>

      {notesDrawer && (() => {
        const lineLabel = display.find((r) => r.lineId === notesDrawer)?.label ?? notesDrawer;
        const drawerNotes = noteGroups[notesDrawer] ?? (notes[notesDrawer] ? [notes[notesDrawer]!] : []);
        return (
          <NotesDrawer
            lineLabel={lineLabel}
            notes={drawerNotes}
            canWrite={canWrite}
            canAck={canAck}
            onClose={() => setNotesDrawer(null)}
            onEdit={() => { setEditing(notesDrawer); setNotesDrawer(null); }}
            onAck={async (n) => {
              await api.ackLineCommentary(tab, {
                line_id: notesDrawer, line_label: lineLabel,
                window: effectiveWindow, compare: effectiveCompare,
                // Acknowledge the note where it was WRITTEN, not where the CFO is
                // standing: a note authored at region/EMEA must be acked at
                // region/EMEA or the UPDATE matches nothing and returns 404.
                scope_type: n.scope_type ?? scope.scope_type,
                scope_id: n.scope_id ?? scope.scope_id,
              });
              reloadNotes();
            }}
          />
        );
      })()}
    </div>
  );
}
