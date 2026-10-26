import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  api, CashConfidence, CashRowMethod, TreasuryDriver, TreasuryForecast, TreasuryRow,
  fmtCompact, fmtSignedCompact,
} from "../api";
import { Card, ErrorNote, Skeleton } from "../components/ui";
import { CHART_COLORS } from "../lib/chartPalette";
import { cn } from "../lib/cn";
import {
  cellItems, confidenceMix, dayMonth, monthYear, roundedMinCash, weeklyOutlook, WeeklyOutlook,
} from "../lib/thirteenWeek";

// How each line is forecast — shown as a chip so treasury can see what's modelled
// vs fixed vs statistical at a glance.
const METHOD_COPY: Record<CashRowMethod, { chip: string; title: string }> = {
  ai: { chip: "AI", title: "Each open invoice settles on its expected date, from the counterparty's own payment history" },
  forecast: { chip: "Forecast", title: "Invoiced daily from the forecast, collected or paid after the ledger's average payment lag" },
  rule: { chip: "Rule", title: "Fixed calendar at the trailing 3-month run-rate from the ledger" },
  rolling: { chip: "Rolling", title: "Trailing 12-week average, spread over business days" },
};

// Confidence is always shown as a letter + colour (never colour alone).
const CONF_COPY: Record<CashConfidence, { letter: string; label: string; text: string; dot: string }> = {
  high: { letter: "H", label: "High", text: "text-signal-good", dot: "bg-signal-good" },
  medium: { letter: "M", label: "Medium", text: "text-signal-warn", dot: "bg-signal-warn" },
  low: { letter: "L", label: "Low", text: "text-signal-bad", dot: "bg-signal-bad" },
};

const SOURCE_COPY: Record<TreasuryForecast["assumptions"]["revenue_source"], string> = {
  ai: "the FP&A AI revenue forecast",
  budget: "the FP&A budget",
  run_rate: "the FP&A run-rate",
};

type Cell = { rowId: string; week: number };

function ConfidenceTag({ c, className }: { c: CashConfidence; className?: string }) {
  const k = CONF_COPY[c];
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium", k.text, className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", k.dot)} aria-hidden="true" />
      {k.label}
    </span>
  );
}

function MethodChip({ m }: { m: CashRowMethod }) {
  return (
    <span title={METHOD_COPY[m].title}
          className={cn("ml-2 rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide ring-1",
                        m === "ai" ? "text-accent ring-accent/30 bg-accent/[0.06]" : "text-fg-subtle ring-line")}>
      {METHOD_COPY[m].chip}
    </span>
  );
}

// ── Weekly cash balance vs minimum ──────────────────────────────────────────
function WeeklyCashChart({ f, minCash, outlook }: {
  f: TreasuryForecast; minCash: number; outlook: WeeklyOutlook | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const s = f.summary;
  // Week 0 = the posted opening balance, then each week's closing balance.
  const cash = [s.opening_cash[0], ...s.closing_cash];
  const n = cash.length;
  const W = 900, H = 240, padT = 14, padB = 26, padL = 56, padR = 16;
  const all = [...cash, minCash];
  const rawStep = (Math.max(...all) - Math.min(0, ...all)) / 4 || 1;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= rawStep) ?? 10) * mag;
  const lo = Math.floor(Math.min(0, ...all) / step) * step;
  const hi = Math.ceil(Math.max(...all) / step) * step;
  const X = (i: number) => padL + ((W - padL - padR) * i) / (n - 1);
  const Y = (v: number) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo || 1));
  const path = cash.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, k) => lo + k * step);
  const slot = (W - padL - padR) / (n - 1);
  const wk = hover !== null && hover > 0 ? hover - 1 : null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-fg-muted mb-2" aria-hidden="true">
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={CHART_COLORS.seriesA} strokeWidth="2" /></svg>
          Closing cash
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={CHART_COLORS.warn} strokeWidth="1.5" strokeDasharray="2 2" /></svg>
          Minimum cash
        </span>
      </div>
      <div className="relative" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
             aria-label={`Weekly closing cash over 13 weeks against a minimum of ${fmtCompact(minCash)}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} y1={Y(t)} x2={W - padR} y2={Y(t)} stroke={CHART_COLORS.grid} strokeWidth="1" />
              <text x={padL - 6} y={Y(t) + 3} fontSize="10" fill={CHART_COLORS.axis} textAnchor="end">{fmtCompact(t)}</text>
            </g>
          ))}
          <rect x={padL} y={Y(minCash)} width={W - padL - padR} height={Math.max(0, Y(lo) - Y(minCash))}
                fill={CHART_COLORS.bad} opacity="0.05" />
          <line x1={padL} y1={Y(minCash)} x2={W - padR} y2={Y(minCash)}
                stroke={CHART_COLORS.warn} strokeWidth="1.5" strokeDasharray="2 2" />
          <path d={path} fill="none" stroke={CHART_COLORS.seriesA} strokeWidth="2" strokeLinejoin="round" />
          {outlook && (
            <g>
              <circle cx={X(outlook.lowIndex + 1)} cy={Y(outlook.low)} r="4.5" fill={CHART_COLORS.seriesA}
                      stroke="white" strokeWidth="2" />
              <text x={X(outlook.lowIndex + 1)} y={Y(outlook.low) + 16} fontSize="10" fontWeight="600"
                    fill={CHART_COLORS.ink} textAnchor="middle">
                Low {fmtCompact(outlook.low)}
              </text>
            </g>
          )}
          {hover !== null && (
            <line x1={X(hover)} y1={padT} x2={X(hover)} y2={H - padB} stroke={CHART_COLORS.slate} strokeWidth="1" />
          )}
          {cash.map((_, i) => (
            <g key={i}>
              <text x={X(i)} y={H - 8} fontSize="10" fill={i ? CHART_COLORS.ink : CHART_COLORS.axis}
                    textAnchor="middle">{i ? `W${i}` : "Close"}</text>
              <rect x={X(i) - slot / 2} y={padT} width={slot} height={H - padT - padB} fill="transparent"
                    onMouseEnter={() => setHover(i)} />
            </g>
          ))}
        </svg>
        {hover !== null && (
          <div className="pointer-events-none absolute top-1 z-10 rounded-md bg-ink-800 ring-1 ring-line shadow-md px-3 py-2 text-[11px] text-fg"
               style={{ left: `${(X(hover) / W) * 100}%`,
                        transform: hover > n / 2 ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
            {wk === null ? (
              <>
                <div className="font-semibold mb-1">Close · {dayMonth(f.display_as_of)}</div>
                <div className="num tabular-nums">Posted cash {fmtCompact(cash[0])}</div>
              </>
            ) : (
              <>
                <div className="font-semibold mb-1">
                  W{wk + 1} · {dayMonth(f.weeks[wk].display_start)}–{dayMonth(f.weeks[wk].display_end)}
                </div>
                <div className="num tabular-nums text-fg-muted">In {fmtCompact(s.inflows[wk])} · Out {fmtCompact(s.outflows[wk])}</div>
                <div className="num tabular-nums text-fg-muted">Net {fmtSignedCompact(s.net_flow[wk])}</div>
                <div className="num tabular-nums">Closing {fmtCompact(s.closing_cash[wk])}</div>
                <div className="num tabular-nums text-fg-muted">
                  {s.closing_cash[wk] >= minCash ? "Headroom " : "Shortfall "}
                  {fmtCompact(Math.abs(s.closing_cash[wk] - minCash))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 13-week grid ────────────────────────────────────────────────────────────
function ForecastGrid({ f, minCash, selected, onSelect }: {
  f: TreasuryForecast; minCash: number; selected: Cell | null; onSelect: (c: Cell | null) => void;
}) {
  const s = f.summary;
  const weeks = f.weeks;
  const inflowRows = f.rows.filter((r) => r.direction === "in");
  const outflowRows = f.rows.filter((r) => r.direction === "out");
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const basis = Object.fromEntries(f.assumptions.rules.map((r) => [r.row_id, r.basis]));

  const renderRow = (r: TreasuryRow) => (
    <tr key={r.id}>
      <td className="py-1.5 pr-3 pl-6 text-fg-muted whitespace-nowrap" title={basis[r.id]}>
        {r.label}<MethodChip m={r.method} />
      </td>
      {r.values.map((v, k) => {
        const conf = r.confidence?.[k] ?? null;
        const isSel = selected?.rowId === r.id && selected.week === k;
        if (r.method !== "ai" || !v) {
          return <td key={k} className="py-1.5 px-2 text-right num tabular-nums">{v ? fmtCompact(v) : "–"}</td>;
        }
        return (
          <td key={k} className="py-0.5 px-0.5 text-right">
            <button type="button" onClick={() => onSelect(isSel ? null : { rowId: r.id, week: k })}
                    aria-pressed={isSel}
                    aria-label={`${r.label}, week ${k + 1}: ${fmtCompact(v)}${conf ? `, ${CONF_COPY[conf].label} confidence` : ""}. Show invoices`}
                    className={cn("w-full rounded px-1.5 py-1 text-right num tabular-nums hover:bg-accent/[0.08]",
                                  isSel && "ring-1 ring-accent bg-accent/[0.08]")}>
              {fmtCompact(v)}
              {conf && (
                <span className={cn("ml-1 text-[9px] font-semibold align-top", CONF_COPY[conf].text)}>
                  {CONF_COPY[conf].letter}
                </span>
              )}
            </button>
          </td>
        );
      })}
      <td className="py-1.5 pl-3 text-right num tabular-nums font-semibold">{fmtCompact(r.total)}</td>
    </tr>
  );

  const totalRow = (label: string, vals: number[], opts: { bold?: boolean; total?: number; signed?: boolean; flag?: boolean } = {}) => (
    <tr className={cn(opts.bold ? "font-bold text-fg border-t-2 border-line" : "font-semibold text-fg border-t border-line bg-ink-700/40")}>
      <td className="py-2 pr-3 whitespace-nowrap">{label}</td>
      {vals.map((v, k) => (
        <td key={k} className={cn("py-2 px-2 text-right num tabular-nums",
                                  opts.flag && v < minCash && "text-signal-bad")}>
          {opts.signed ? fmtSignedCompact(v) : fmtCompact(v)}
        </td>
      ))}
      <td className="py-2 pl-3 text-right num tabular-nums">
        {opts.total === undefined ? "" : opts.signed ? fmtSignedCompact(opts.total) : fmtCompact(opts.total)}
      </td>
    </tr>
  );

  const section = (title: string) => (
    <tr className="text-fg-subtle">
      <td colSpan={weeks.length + 2} className="pt-3 pb-1 text-[11px] uppercase tracking-wide font-semibold">{title}</td>
    </tr>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <colgroup>
          <col />
          {weeks.map((w) => <col key={w.index} />)}
          <col className="bg-ink-700/30" />
        </colgroup>
        <thead>
          <tr className="text-fg-subtle border-b border-line">
            <th className="py-2 pr-3 text-left font-medium">Line</th>
            {weeks.map((w) => (
              <th key={w.index} className="py-2 px-2 text-right font-medium whitespace-nowrap">
                <span className="block text-fg">W{w.index + 1}</span>
                <span className="block text-[10px] font-normal">{dayMonth(w.display_start)}</span>
              </th>
            ))}
            <th className="py-2 pl-3 text-right font-semibold">13 wk</th>
          </tr>
        </thead>
        <tbody>
          {totalRow("Opening cash", s.opening_cash, { total: s.opening_cash[0] })}
          {section("Receipts")}
          {inflowRows.map(renderRow)}
          {totalRow("Total receipts", s.inflows, { total: sum(s.inflows) })}
          {section("Payments")}
          {outflowRows.map(renderRow)}
          {totalRow("Total payments", s.outflows, { total: sum(s.outflows) })}
          {totalRow("Net cash flow", s.net_flow, { total: sum(s.net_flow), signed: true })}
          {totalRow("Closing cash", s.closing_cash, { bold: true, total: s.closing_cash[s.closing_cash.length - 1], flag: true })}
        </tbody>
      </table>
      <p className="text-[11px] text-fg-subtle mt-2">
        Weeks run from the day after the close ({dayMonth(f.display_as_of)}). Closing cash = opening + receipts − payments,
        rolled week to week from posted cash. <span className="font-semibold text-fg-muted">AI</span> cells show their
        confidence (<span className={CONF_COPY.high.text}>H</span>/<span className={CONF_COPY.medium.text}>M</span>/<span className={CONF_COPY.low.text}>L</span>):
        the chance the invoices land in that week. Click one to see the invoices and why.
      </p>
    </div>
  );
}

// ── Cell detail: the invoices behind an AI number, and why ──────────────────
function CellDetail({ f, cell, onClose }: { f: TreasuryForecast; cell: Cell; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // The panel opens below the grid — bring it into view on each new cell.
  useEffect(() => { ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [cell.rowId, cell.week]);
  const row = f.rows.find((r) => r.id === cell.rowId);
  if (!row) return null;
  const items = cellItems(f, row, cell.week);
  const wk = f.weeks[cell.week];
  const why = new Map(f.drivers.map((d) => [`${d.ledger}|${d.counterparty}`, d.explanation]));
  return (
    <div ref={ref} className="scroll-mt-4">
    <Card title={`${row.label} · W${cell.week + 1}`}
          subtitle={`${dayMonth(wk.display_start)}–${dayMonth(wk.display_end)} · ${items.length} invoice${items.length === 1 ? "" : "s"} · ${fmtCompact(row.values[cell.week])}`}
          action={<button type="button" onClick={onClose} className="text-xs text-accent hover:underline">Close</button>}>
      <div className="px-5 py-3 overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-fg-subtle border-b border-line">
              <th className="py-2 pr-3 text-left font-medium">{row.id === "receipts_open" ? "Customer" : "Supplier"}</th>
              <th className="py-2 px-2 text-right font-medium">Amount</th>
              <th className="py-2 px-2 text-right font-medium">Due</th>
              <th className="py-2 px-2 text-right font-medium">Expected</th>
              <th className="py-2 px-2 text-left font-medium">Confidence</th>
              <th className="py-2 pl-3 text-left font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.invoice_id} className="border-b border-line/60 align-top">
                <td className="py-1.5 pr-3 text-fg whitespace-nowrap">
                  {i.counterparty}
                  <span className="block text-[10px] text-fg-subtle">{i.invoice_id}</span>
                </td>
                <td className="py-1.5 px-2 text-right num tabular-nums">{fmtCompact(i.amount)}</td>
                <td className="py-1.5 px-2 text-right num tabular-nums text-fg-muted">{dayMonth(i.display_due_date)}</td>
                <td className="py-1.5 px-2 text-right num tabular-nums">{dayMonth(i.display_expected_date)}</td>
                <td className="py-1.5 px-2"><ConfidenceTag c={i.confidence} /></td>
                <td className="py-1.5 pl-3 text-fg-muted">
                  {i.past_habit
                    ? "Already later than this counterparty usually pays: assumed to land just after the close."
                    : why.get(`${i.ledger}|${i.counterparty}`)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
    </div>
  );
}

// ── Month 1–3 tie-out to FP&A ───────────────────────────────────────────────
const RECON_LINES: { id: keyof TreasuryForecast["reconciliation"][number]["treasury"]; label: string; bold?: boolean }[] = [
  { id: "receipts", label: "Receipts" },
  { id: "operating_payments", label: "Operating payments" },
  { id: "capex", label: "Capex" },
  { id: "net_change", label: "Net change in cash", bold: true },
  { id: "ending_cash", label: "Ending cash", bold: true },
];

function Reconciliation({ f }: { f: TreasuryForecast }) {
  const rec = f.reconciliation;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-fg-subtle">
            <th />
            {rec.map((m) => (
              <th key={m.period} colSpan={3} className="pt-1 pb-1 px-2 text-center font-semibold text-fg border-l border-line">
                {monthYear(m.display_period)}
              </th>
            ))}
          </tr>
          <tr className="text-fg-subtle border-b border-line">
            <th className="py-1.5 pr-3 text-left font-medium">Line</th>
            {rec.map((m) => (
              <Fragment key={m.period}>
                <th className="py-1.5 px-2 text-right font-medium border-l border-line">Treasury</th>
                <th className="py-1.5 px-2 text-right font-medium">FP&amp;A</th>
                <th className="py-1.5 px-2 text-right font-medium">Difference</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {RECON_LINES.map((l) => (
            <tr key={l.id} className={cn(l.bold && "font-semibold text-fg border-t border-line")}>
              <td className="py-1.5 pr-3 whitespace-nowrap">{l.label}</td>
              {rec.map((m) => (
                <Fragment key={m.period}>
                  <td className="py-1.5 px-2 text-right num tabular-nums border-l border-line">{fmtCompact(m.treasury[l.id])}</td>
                  <td className="py-1.5 px-2 text-right num tabular-nums text-fg-muted">{m.fpa ? fmtCompact(m.fpa[l.id]) : "–"}</td>
                  <td className="py-1.5 px-2 text-right num tabular-nums text-fg-muted">
                    {m.difference ? fmtSignedCompact(m.difference[l.id]) : "–"}
                  </td>
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-fg-subtle mt-2">
        Treasury builds cash bottom-up from invoices and payment runs (direct method); FP&amp;A derives it from the P&amp;L
        and working-capital days (indirect method, the Cash Flow page baseline). Both start from the same posted cash.
        FP&amp;A receipts = revenue − change in receivables; operating payments = receipts − operating cash flow.
        Differences are timing: invoice-level payment habits vs average DSO/DPO.
      </p>
    </div>
  );
}

// ── Counterparty drivers ────────────────────────────────────────────────────
function DriverList({ title, drivers }: { title: string; drivers: TreasuryDriver[] }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle font-semibold mb-2">{title}</div>
      <ul className="divide-y divide-line">
        {drivers.map((d) => (
          <li key={d.counterparty} className="py-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-fg font-medium truncate">{d.counterparty}</span>
              <span className="text-xs num tabular-nums text-fg shrink-0">{fmtCompact(d.open_amount)} open</span>
            </div>
            <div className="flex items-baseline justify-between gap-3 mt-0.5">
              <span className="text-[11px] text-fg-muted">{d.explanation}</span>
              <ConfidenceTag c={d.confidence} className="shrink-0" />
            </div>
          </li>
        ))}
        {!drivers.length && <li className="py-2 text-xs text-fg-subtle">No open invoices.</li>}
      </ul>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function ThirteenWeekCash({ refreshKey }: { refreshKey: number }) {
  const [f, setF] = useState<TreasuryForecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Cell | null>(null);
  // Minimum cash in $M; null = the default policy (one month of operating costs).
  const [minCashM, setMinCashM] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setF(null); setSelected(null); setMinCashM(null);
    api.treasury13w()
      .then((r) => { if (live) { setF(r); setError(null); } })
      .catch((e) => { if (live) setError(String(e.message ?? e)); });
    return () => { live = false; };
  }, [refreshKey]);

  const defaultMin = roundedMinCash(f?.summary.min_cash);
  const minCash = minCashM !== null ? minCashM * 1e6 : defaultMin;
  const outlook = useMemo(() => (f ? weeklyOutlook(f.summary.closing_cash, minCash) : null), [f, minCash]);
  const arMix = useMemo(() => (f ? confidenceMix(f.items, "ar") : null), [f]);

  const s = f?.summary;
  const end = s ? s.closing_cash[s.closing_cash.length - 1] : 0;
  const net = s ? end - s.opening_cash[0] : 0;
  const openAr = f ? f.rows.find((r) => r.id === "receipts_open")?.total ?? 0 : 0;

  type Note = { tone: "good" | "bad" | "muted"; text: string } | null;
  const tiles: { k: string; v: number | undefined; note: Note; valueBad?: boolean }[] = [
    { k: "Opening cash (posted)", v: s?.opening_cash[0], note: f ? { tone: "muted", text: `at close · ${dayMonth(f.display_as_of)}` } : null },
    { k: "Closing cash · week 13", v: end,
      note: s ? { tone: net >= 0 ? "good" : "bad", text: `${net >= 0 ? "▲" : "▼"} ${fmtSignedCompact(net)} over 13 weeks` } : null },
    { k: "Lowest week", v: outlook?.low, valueBad: !!outlook && outlook.firstBreachIndex !== null,
      note: !outlook ? null
        : outlook.firstBreachIndex !== null
          ? { tone: "bad", text: `▼ below minimum from W${outlook.firstBreachIndex + 1}` }
          : { tone: "good", text: `▲ ${fmtCompact(outlook.headroom)} above minimum · W${outlook.lowIndex + 1}` } },
    { k: "Open receivables collected", v: openAr,
      note: arMix ? { tone: "muted", text: `${Math.round((arMix.high + arMix.medium) * 100)}% of value at high or medium confidence` } : null },
  ];

  const customers = f?.drivers.filter((d) => d.ledger === "ar").slice(0, 6) ?? [];
  const suppliers = f?.drivers.filter((d) => d.ledger === "ap").slice(0, 6) ?? [];
  const a = f?.assumptions;

  return (
    <div className="space-y-5">
      {error && <ErrorNote message={error} />}

      {/* KPI strip — same typography as the FP&A Overview headline strip */}
      <section className="rounded-2xl tile ring-1 ring-line overflow-hidden">
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-line">
          {tiles.map((c) => (
            <div key={c.k} className="px-3 py-2.5 min-w-0">
              <div className="text-[10px] text-fg-muted leading-tight truncate">{c.k}</div>
              <div className={cn("text-base font-semibold tabular-nums leading-tight mt-0.5",
                                 c.valueBad ? "text-signal-bad" : "text-fg")}>
                {f ? fmtCompact(c.v ?? 0) : <Skeleton className="h-5 w-20" />}
              </div>
              {c.note && (
                <div className={cn("text-[10px] font-medium",
                                   c.note.tone === "good" ? "text-signal-good"
                                     : c.note.tone === "bad" ? "text-signal-bad" : "text-fg-subtle")}>
                  {c.note.text}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <Card title="Weekly cash vs minimum" subtitle="Closing balance each week, from posted cash at the close"
            action={
              <div className="flex flex-col items-end gap-1 text-xs text-fg-subtle shrink-0">
                <div className="flex items-center gap-2">
                  <label htmlFor="min-cash-13w">Minimum cash ($M)</label>
                  <input id="min-cash-13w" type="number" step="0.1" min="0"
                         value={minCashM ?? Number((defaultMin / 1e6).toFixed(1))}
                         onChange={(e) => setMinCashM(e.target.value === "" ? null : Number(e.target.value))}
                         className="w-20 rounded-md ring-1 ring-line bg-ink-800 text-fg text-xs px-2 py-1 num tabular-nums" />
                </div>
                {minCashM === null
                  ? <span className="text-[11px]">default: one month of operating costs (COGS + opex)</span>
                  : <button type="button" onClick={() => setMinCashM(null)} className="text-[11px] text-accent hover:underline">
                      reset to one month of operating costs
                    </button>}
              </div>
            }>
        <div className="px-4 py-4">
          {f ? <WeeklyCashChart f={f} minCash={minCash} outlook={outlook} /> : <Skeleton className="h-52 w-full" />}
        </div>
      </Card>

      <Card title="13-week cash forecast" subtitle="Direct method: receipts and payments by week">
        <div className="px-5 py-4">
          {f ? <ForecastGrid f={f} minCash={minCash} selected={selected} onSelect={setSelected} /> : (
            <div className="space-y-2">
              {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
              <p className="text-xs text-fg-subtle pt-1">Building the forecast from the ledgers…</p>
            </div>
          )}
        </div>
      </Card>

      {f && selected && <CellDetail f={f} cell={selected} onClose={() => setSelected(null)} />}

      <Card title="Tie-out to the FP&A forecast" subtitle="Months 1–3: treasury (bottom-up) vs FP&A (Cash Flow baseline)">
        <div className="px-5 py-4">
          {f ? <Reconciliation f={f} /> : <Skeleton className="h-40 w-full" />}
        </div>
      </Card>

      <Card title="Payment habits behind the forecast" subtitle="Largest open balances and how each counterparty usually pays">
        <div className="px-5 py-4 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {f ? (
            <>
              <DriverList title="Customers" drivers={customers} />
              <DriverList title="Suppliers" drivers={suppliers} />
            </>
          ) : <Skeleton className="h-40 w-full lg:col-span-2" />}
        </div>
      </Card>

      {a && (
        <p className="text-[11px] text-fg-subtle">
          <span className="font-semibold text-fg-muted">Assumptions:</span>{" "}
          sales not yet invoiced follow {SOURCE_COPY[a.revenue_source]}, collected after {a.receipts_lag_days} days
          (average terms + customers' average days vs due); new supplier invoices at the trailing run-rate
          ({fmtCompact(a.supplier_monthly_run_rate)}/month), paid after {a.supplier_lag_days} days;
          other operating payments at {fmtCompact(a.other_weekly_run_rate)}/week.
          Rules: {a.rules.filter((r) => r.monthly_amount).map((r) => `${r.label} ${fmtCompact(r.monthly_amount)}/month (${r.basis.split(", ").pop()})`).join("; ")}.
          Single currency; intercompany, VAT and factoring are not modelled yet.
        </p>
      )}
    </div>
  );
}
