import { useEffect, useMemo, useRef, useState } from "react";
import { Filter } from "lucide-react";
import {
  api, CashFlow, HeadlineKpi, KpiBreakdownRow, KpiMetric, KpiTrendPoint,
  OperatingLeverageForecast, OrgTree, OpexVarianceRow, Persona, Scope, WorkingCapitalKpis,
} from "../api";
import { PageId } from "../nav";
import { Card, ChartSkeleton, ErrorNote, Section, SkeletonRegion } from "../components/ui";
import { DashboardGrid } from "../components/AppShell";
import { BudgetVariance, CashFlowWaterfall, OperatingLeverage, ProfitabilityBridge } from "../components/ExecutiveCharts";
import { useOverlay } from "../lib/industry";
import {
  activeSegmentCount,
  allSegments,
  applySegmentFilter,
  segmentFilterActive,
  segmentFilterSummary,
  type SegmentSelection,
} from "../lib/segmentFilter";

const round0 = (v: number) => Math.round(v);

function num(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

function calcKpis(ar: number, ap: number, inv: number, rev: number, cogs: number, days: number) {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const dso = rev ? r1((ar / rev) * days) : 0;
  const dpo = cogs ? r1((ap / cogs) * days) : 0;
  const dio = cogs ? r1((inv / cogs) * days) : 0;
  return { dso, dpo, dio, ccc: r1(dso + dio - dpo) };
}

function sumBreakdown(rows: { ar_balance: number; ap_balance: number; inventory_balance: number;
  revenue: number; cogs: number; operating_expense: number; days_in_period: number }[]) {
  return rows.reduce((a, r) => {
    a.ar += r.ar_balance; a.ap += r.ap_balance; a.inv += r.inventory_balance;
    a.rev += r.revenue; a.cogs += r.cogs; a.opex += r.operating_expense;
    a.days = Math.max(a.days, r.days_in_period);
    return a;
  }, { ar: 0, ap: 0, inv: 0, rev: 0, cogs: 0, opex: 0, days: 0 });
}

type Sel = Set<string> | null;

export default function Executive({
  scope, persona, onNavigate, refreshKey,
}: {
  scope: Scope;
  persona: Persona | null;
  org: OrgTree | null;
  onNavigate: (p: PageId, query?: string) => void;
  refreshKey: number;
}) {
  const ov = useOverlay();
  const [kpis, setKpis] = useState<WorkingCapitalKpis | null>(null);
  const [trend, setTrend] = useState<KpiTrendPoint[]>([]);
  const [breakdown, setBreakdown] = useState<KpiBreakdownRow[]>([]);
  const [profitFilter, setProfitFilter] = useState<SegmentSelection>(allSegments);
  const [wcFilter, setWcFilter] = useState<SegmentSelection>(allSegments);
  const [cashFlow, setCashFlow] = useState<CashFlow | null>(null);
  const [variance, setVariance] = useState<OpexVarianceRow[]>([]);
  const [headline, setHeadline] = useState<HeadlineKpi[]>([]);
  const [headlineSegs, setHeadlineSegs] = useState<HeadlineKpi[]>([]);
  const [leverageForecast, setLeverageForecast] = useState<OperatingLeverageForecast | null>(null);
  const [leverageForecastLoading, setLeverageForecastLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [kR, tR] = await Promise.allSettled([api.kpis(scope), api.kpiTrend(scope)]);
        if (cancelled) return;
        if (kR.status === "fulfilled") { setKpis(kR.value); setError(null); }
        else setError("Couldn't load KPIs.");
        if (tR.status === "fulfilled") setTrend(tR.value);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Couldn't load KPIs.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey, scope]);

  useEffect(() => {
    let cancelled = false;
    setLeverageForecast(null);
    setLeverageForecastLoading(true);
    api.operatingLeverageForecast(scope)
      .then((result) => { if (!cancelled) setLeverageForecast(result); })
      .catch(() => { if (!cancelled) setLeverageForecast(null); })
      .finally(() => { if (!cancelled) setLeverageForecastLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey, scope]);

  useEffect(() => {
    let cancelled = false;
    api.headlineKpis()
      .then((h) => { if (!cancelled) { setHeadline(h.kpis || []); setHeadlineSegs(h.segments || []); } })
      .catch(() => { if (!cancelled) { setHeadline([]); setHeadlineSegs([]); } });
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setCashFlow(null);
    api.cashFlow(scope)
      .then((cf) => { if (!cancelled) setCashFlow(cf); })
      .catch(() => { if (!cancelled) setCashFlow(null); });
    return () => { cancelled = true; };
  }, [refreshKey, scope]);

  useEffect(() => {
    let cancelled = false;
    setVariance([]);
    api.opexVariance(scope)
      .then((v) => { if (!cancelled) setVariance(v); })
      .catch(() => { if (!cancelled) setVariance([]); });
    return () => { cancelled = true; };
  }, [refreshKey, scope]);

  useEffect(() => {
    let cancelled = false;
    api.kpiBreakdown(scope).then((b) => { if (!cancelled) setBreakdown(b); }).catch(() => {});
    return () => { cancelled = true; };
  }, [scope, refreshKey]);

  useEffect(() => {
    setProfitFilter(allSegments());
    setWcFilter(allSegments());
  }, [scope]);

  const trends = useMemo(() => ({
    dso: trend.map((p) => num(p.dso)),
    dpo: trend.map((p) => num(p.dpo)),
    dio: trend.map((p) => num(p.dio)),
    ccc: trend.map((p) => num(p.ccc)),
  }), [trend]);

  const k = kpis?.kpis;

  const opts = useMemo(() => {
    const reg = new Map<string, string>(), bl = new Map<string, string>(), le = new Map<string, string>();
    for (const r of breakdown) {
      reg.set(r.region, r.region);
      bl.set(r.business_line, r.business_line);
      le.set(r.legal_entity_id, r.legal_entity_name);
    }
    const list = (m: Map<string, string>) =>
      [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    return { region: list(reg), bl: list(bl), le: list(le) };
  }, [breakdown]);

  const profitRows = useMemo(
    () => applySegmentFilter(breakdown, profitFilter),
    [breakdown, profitFilter]);
  const wcRows = useMemo(
    () => applySegmentFilter(breakdown, wcFilter),
    [breakdown, wcFilter]);

  const profitActive = segmentFilterActive(profitFilter) && breakdown.length > 0;
  const wcActive = segmentFilterActive(wcFilter) && breakdown.length > 0;

  const profitAgg = useMemo(() => sumBreakdown(profitRows), [profitRows]);
  const wcAgg = useMemo(() => sumBreakdown(wcRows), [wcRows]);

  const effKpis = wcActive
    ? calcKpis(wcAgg.ar, wcAgg.ap, wcAgg.inv, wcAgg.rev, wcAgg.cogs, wcAgg.days || 30)
    : null;
  const effComp = profitActive ? {
    ar_balance: profitAgg.ar, ap_balance: profitAgg.ap, inventory_balance: profitAgg.inv,
    revenue: profitAgg.rev, cogs: profitAgg.cogs, operating_expense: profitAgg.opex,
    net_income: profitAgg.rev - profitAgg.cogs - profitAgg.opex,
  } : null;

  const headlineTiles = useMemo(
    () => headline.filter((t) => !ov.hiddenKpis.includes(t.kpi_id)),
    [headline, ov.hiddenKpis],
  );

  const wcMetrics = useMemo(() => {
    const ids = ["dso", "dio", "dpo", "ccc"] as const;
    return ids
      .filter((id) => k?.[id] && !ov.hiddenKpis.includes(id))
      .map((id) => {
        const m = k![id] as KpiMetric;
        const series = trends[id];
        const d = series.length >= 2 ? series[series.length - 1] - series[series.length - 2] : null;
        const value = wcActive && effKpis ? effKpis[id] : m.value;
        return { id, label: ov.kpiLabels[id] ?? m.label, value, unit: m.unit, delta: wcActive ? null : d, better: m.better };
      });
  }, [k, ov.hiddenKpis, ov.kpiLabels, trends, wcActive, effKpis]);

  const profitFilters = (
    <FiltersPopover
      ariaLabel="Filter profitability"
      regionOpts={opts.region} blOpts={opts.bl} leOpts={opts.le}
      selection={profitFilter} onChange={setProfitFilter}
      activeCount={activeSegmentCount(profitFilter)}
      summary={segmentFilterSummary(profitRows.length, breakdown.length, profitActive)}
      filterActive={profitActive}
    />
  );
  const wcFilters = (
    <FiltersPopover
      ariaLabel="Filter working capital"
      regionOpts={opts.region} blOpts={opts.bl} leOpts={opts.le}
      selection={wcFilter} onChange={setWcFilter}
      activeCount={activeSegmentCount(wcFilter)}
      summary={segmentFilterSummary(wcRows.length, breakdown.length, wcActive)}
      filterActive={wcActive}
      dropUp
    />
  );

  return (
    <div className="relative space-y-4 pb-12">
      {error && <ErrorNote message={error} />}

      {loading ? (
        <DashboardGrid>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="col-span-12 md:col-span-6">
              <Card><div className="h-24" /></Card>
            </div>
          ))}
        </DashboardGrid>
      ) : (
        <>
          {headlineTiles.length > 0 && (
            <HeadlineKpiStrip tiles={headlineTiles} segments={headlineSegs} />
          )}

          <DashboardGrid>
            <div className="col-span-12 lg:col-span-6">
              <BudgetVariance variance={variance} />
            </div>
            <div className="col-span-12 lg:col-span-6">
              {cashFlow ? <CashFlowWaterfall cf={cashFlow} /> : (
                <Card title="Cash flow reconciliation" subtitle="Current close period · USD">
                  <SkeletonRegion><ChartSkeleton height={260} /></SkeletonRegion>
                </Card>
              )}
            </div>
          </DashboardGrid>

          {kpis && (
            <DashboardGrid className="items-start">
              <div className="col-span-12 lg:col-span-6">
                <ProfitabilityBridge
                  kpis={profitActive && effComp ? { ...kpis, components: effComp } : kpis}
                  action={profitFilters}
                  subtitle={profitActive
                    ? `${segmentFilterSummary(profitRows.length, breakdown.length, true)}`
                    : undefined}
                />
              </div>
              <div className="col-span-12 lg:col-span-6">
                <OperatingLeverage
                  trend={trend}
                  forecast={leverageForecast}
                  forecastLoading={leverageForecastLoading}
                />
              </div>
            </DashboardGrid>
          )}

          {wcMetrics.length > 0 && (
            <Section title="Working capital" subtitle="· days metrics" defaultOpen={false} collapsible
              action={wcFilters}>
              <div className="px-5 py-3 flex flex-wrap gap-x-6 gap-y-3">
                {wcMetrics.map((m) => (
                  <WorkingCapitalMetric key={m.id} {...m} />
                ))}
              </div>
              {wcActive && (
                <p className="px-5 pb-3 text-[11px] text-fg-subtle">
                  Filtered to {segmentFilterSummary(wcRows.length, breakdown.length, true)}.
                  Trend deltas are hidden while this panel is filtered.
                </p>
              )}
            </Section>
          )}

          <div className="flex items-center justify-between gap-4 flex-wrap px-1 text-sm">
            <span className="readable-copy text-fg-muted">
              {persona?.id === "cfo"
                ? "Consolidated view across all units. Chart filters apply only to the panel they sit on."
                : "Scoped to your org node — reconciliation and tasks reflect the same scope."}
            </span>
            <button
              type="button"
              onClick={() => onNavigate("trial-balance")}
              className="text-fg-muted hover:text-fg underline underline-offset-2"
            >
              Open trial balance
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function WorkingCapitalMetric({
  label, value, unit, delta, better,
}: {
  label: string; value: number; unit: string; delta: number | null; better: string;
}) {
  const deltaTone = delta == null || !Number.isFinite(delta)
    ? "text-fg-subtle"
    : (better === "lower" ? delta < 0 : delta > 0) ? "text-signal-good" : "text-signal-bad";
  const deltaSign = delta != null && delta > 0 ? "▲" : delta != null && delta < 0 ? "▼" : "";
  return (
    <div className="min-w-[7rem]">
      <div className="text-[11px] text-fg-muted">{label}</div>
      <div className="text-lg font-semibold text-fg tabular-nums">
        {round0(value)}<span className="text-sm font-normal text-fg-muted ml-0.5">{unit}</span>
      </div>
      {delta != null && Number.isFinite(delta) && (
        <div className={`text-[11px] font-medium ${deltaTone}`}>
          {deltaSign} {Math.abs(round0(delta))} {unit} vs last month
        </div>
      )}
    </div>
  );
}

function fmtKpi(v: number, unit: string): string {
  const abs = Math.abs(v);
  const numStr = abs >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : abs >= 100 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (unit === "%") return `${numStr}%`;
  if (unit === "p") return `${numStr}p`;
  if (!unit) return numStr;
  if (/^[£$€]/.test(unit)) return `${unit[0]}${numStr}${unit.slice(1)}`;
  return `${numStr} ${unit}`;
}

function HeadlineKpiStrip({ tiles, segments }: {
  tiles: HeadlineKpi[]; segments: HeadlineKpi[];
}) {
  const [segOpen, setSegOpen] = useState(false);
  const cols = tiles.length >= 6 ? "grid-cols-3 sm:grid-cols-6"
    : tiles.length === 5 ? "grid-cols-3 sm:grid-cols-5"
    : tiles.length === 4 ? "grid-cols-2 sm:grid-cols-4"
    : "grid-cols-2 sm:grid-cols-3";

  const deltaChip = (t: HeadlineKpi) => {
    if (t.delta == null || !Number.isFinite(t.delta)) return null;
    const improving = t.good_direction === "down" ? t.delta < 0 : t.delta > 0;
    const sign = t.delta > 0 ? "+" : "";
    return (
      <span className={`text-[10px] font-medium ${improving ? "text-signal-good" : "text-signal-bad"}`}>
        {sign}{t.delta.toLocaleString(undefined, { maximumFractionDigits: 2 })} vs PY
      </span>
    );
  };

  return (
    <section className="rounded-2xl tile ring-1 ring-line">
      {segments.length > 0 && (
        <div className="px-4 py-1.5 border-b border-line flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={() => setSegOpen((o) => !o)}
            className="text-[11px] text-fg-muted hover:text-fg underline underline-offset-2"
          >
            {segOpen ? "Hide" : "Show"} category mix ({segments.length})
          </button>
        </div>
      )}
      <div className="overflow-hidden rounded-b-2xl">
        <div className={`grid ${cols} divide-x divide-line`}>
          {tiles.map((t) => (
            <div key={t.kpi_id} className="px-3 py-2.5 min-w-0">
              <div className="text-[10px] text-fg-muted leading-tight truncate" title={t.label}>{t.label}</div>
              <div className="text-base font-semibold text-fg tabular-nums leading-tight mt-0.5">{fmtKpi(t.value, t.unit)}</div>
              {deltaChip(t)}
            </div>
          ))}
        </div>
        {segOpen && segments.length > 0 && (
          <div className="px-4 py-2 border-t border-line flex flex-wrap gap-2 bg-black/[0.02]">
            {segments.map((s) => (
              <span key={s.kpi_id} className="text-[11px] rounded-md border border-line px-2 py-0.5 text-fg-muted">
                <span className="text-fg-subtle">{s.segment}:</span>{" "}
                <span className="font-medium text-fg tabular-nums">{fmtKpi(s.value, s.unit)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function FiltersPopover({
  ariaLabel, regionOpts, blOpts, leOpts, selection, onChange,
  activeCount, summary, filterActive, dropUp = false,
}: {
  ariaLabel: string;
  regionOpts: { value: string; label: string }[];
  blOpts: { value: string; label: string }[];
  leOpts: { value: string; label: string }[];
  selection: SegmentSelection;
  onChange: (next: SegmentSelection) => void;
  activeCount: number;
  summary: string;
  filterActive: boolean;
  dropUp?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={activeCount > 0 ? `${ariaLabel}, ${activeCount} active` : ariaLabel}
        aria-expanded={open}
        title={ariaLabel}
        className={`text-[11px] inline-flex items-center hover:text-fg
                    ${filterActive ? "text-accent-400" : "text-fg-muted"}`}
      >
        <Filter className="w-[11px] h-[11px]" strokeWidth={2} />
      </button>
      {open && (
        <div className={`absolute right-0 z-50 w-72 rounded-xl bg-ink-700 ring-1 ring-line shadow-2xl p-3 space-y-2 ${dropUp ? "bottom-full mb-1" : "mt-1"}`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-fg-subtle">Segment filter</span>
            {filterActive && (
              <button type="button" onClick={() => onChange(allSegments())}
                      className="text-xs text-fg-muted hover:text-fg underline underline-offset-2">
                Clear
              </button>
            )}
          </div>
          <p className="text-[10px] text-fg-subtle leading-snug">
            Applies only to this panel.
          </p>
          <div className="flex flex-col gap-1.5">
            <MultiSelect block label="Region" options={regionOpts} selected={selection.region}
              onChange={(region) => onChange({ ...selection, region })} />
            <MultiSelect block label="Business line" options={blOpts} selected={selection.businessLine}
              onChange={(businessLine) => onChange({ ...selection, businessLine })} />
            <MultiSelect block label="Legal entity" options={leOpts} selected={selection.legalEntity}
              onChange={(legalEntity) => onChange({ ...selection, legalEntity })} />
          </div>
          <div className="text-[11px] text-fg-subtle pt-1.5 border-t border-line">{summary}</div>
        </div>
      )}
    </div>
  );
}

function MultiSelect({
  label, options, selected, onChange, block = false,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
  block?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const all = selected === null;
  const count = all ? options.length : selected.size;
  const summary = all
    ? "All"
    : count === 0 ? "None"
    : count === 1 ? (options.find((o) => selected!.has(o.value))?.label ?? "1 selected")
    : `${count} selected`;

  const toggleAll = () => onChange(all ? new Set() : null);
  const toggleItem = (v: string) => {
    if (all) {
      const next = new Set(options.map((o) => o.value));
      next.delete(v);
      onChange(next);
      return;
    }
    const next = new Set(selected);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(next.size === options.length ? null : next);
  };

  const disabled = options.length === 0;
  return (
    <div ref={ref} className={block ? "relative w-full" : "relative"}>
      <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)}
              className={`text-sm border border-line rounded-md pl-2.5 pr-2 py-1.5 flex items-center gap-1.5 hover:bg-black/[0.04] disabled:opacity-40 disabled:cursor-not-allowed ${block ? "w-full justify-between" : ""}`}>
        <span className="text-fg-muted">{label}:</span>
        <span className={`truncate ${block ? "max-w-[9rem]" : "max-w-[7rem]"} ${all ? "text-fg-muted" : "text-fg font-medium"}`}>{summary}</span>
        <span className="text-fg-subtle text-[10px] ml-auto">▾</span>
      </button>
      {open && !disabled && (
        <div className={`absolute right-0 z-50 mt-1 ${block ? "w-full" : "w-56"} max-h-72 overflow-y-auto rounded-lg bg-ink-700 ring-1 ring-line shadow-2xl p-1`}>
          <label className="flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-black/[0.04] cursor-pointer border-b border-line mb-1">
            <input type="checkbox" checked={all} onChange={toggleAll} className="accent-accent" />
            <span className="text-sm font-medium text-fg">Select all</span>
          </label>
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-black/[0.04] cursor-pointer">
              <input type="checkbox" checked={all || selected!.has(o.value)} onChange={() => toggleItem(o.value)} className="accent-accent" />
              <span className="text-sm text-fg-muted truncate">{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
