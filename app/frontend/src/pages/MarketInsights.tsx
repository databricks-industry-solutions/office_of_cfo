import { useEffect, useState } from "react";
import {
  api, DriverSensitivitiesResponse, DriverSensitivity, MarketDriverSeries,
  MarketDriversResponse, MarketSignal, MarketSignalsResponse,
} from "../api";
import { PageId } from "../nav";
import { Button, Card, CardSkeleton, ErrorNote, Metric, Section, Skeleton, SkeletonRegion, TextSkeleton } from "../components/ui";
import { CHART_AXIS_TEXT_PIXEL, CHART_COLORS } from "../lib/chartPalette";
import { useChartSize } from "../lib/useChartSize";
import { cn } from "../lib/cn";

const CAT_LABEL: Record<string, string> = {
  commodity: "Commodity", macro: "Macro", weather: "Weather",
  sector: "Sector", internal: "Internal", market: "Market",
};

/** Format a value already expressed in the target's unit (£m / €m / $bn / …). */
function fmtUnit(v: number | null | undefined, unit: string): string {
  if (v == null || Number.isNaN(v)) return "—";
  const m = unit.match(/^([£€$])(m|bn)$/);
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (m) {
    const [, sym, scale] = m;
    return scale === "bn" ? `${sign}${sym}${a.toFixed(2)}bn` : `${sign}${sym}${a.toFixed(0)}m`;
  }
  return `${v.toFixed(1)} ${unit}`;
}

/** Signed, with a leading + on positives (for impacts/deltas). */
function fmtSignedUnit(v: number | null | undefined, unit: string): string {
  if (v == null || Number.isNaN(v)) return "—";
  const s = v > 0 ? "+" : v < 0 ? "−" : "";
  return s + fmtUnit(Math.abs(v), unit);
}

function sigmaLabel(s: number | null): string {
  if (s == null) return "";
  return `${s > 0 ? "+" : ""}${s.toFixed(1)}σ`;
}
function lagLabel(lag: number): string {
  return lag <= 0 ? "coincident" : `leads ${lag} mo`;
}

/** Min-max normalise a series to [0,1] over its finite points (nulls → null). */
function normalise(vals: (number | null)[]): (number | null)[] {
  const fin = vals.filter((v): v is number => v != null && Number.isFinite(v));
  if (fin.length === 0) return vals.map(() => null);
  const min = Math.min(...fin), max = Math.max(...fin), span = max - min || 1;
  return vals.map((v) => (v == null || !Number.isFinite(v) ? null : (v - min) / span));
}

function linePoints(norm: (number | null)[], w: number, h: number, pad: number): string {
  const n = norm.length;
  const innerW = w - pad * 2, innerH = h - pad * 2;
  return norm
    .map((v, i) => (v == null ? null : `${(pad + (n <= 1 ? 0 : (i / (n - 1)) * innerW)).toFixed(1)},${(pad + (1 - v) * innerH).toFixed(1)}`))
    .filter((p): p is string => p != null)
    .join(" ");
}

function CoMovementChart({ periods, target, driver }: {
  periods: string[]; target: MarketDriverSeries; driver: MarketDriverSeries;
}) {
  const { ref, size } = useChartSize({ width: 640, height: 212 });
  const W = size.width, H = size.height - 22, PAD = 16;
  const tgt = linePoints(normalise(target.values), W, H, PAD);
  const drv = linePoints(normalise(driver.values), W, H, PAD);
  const ticks = [0, Math.floor((periods.length - 1) / 2), periods.length - 1];
  return (
    <div className="w-full overflow-x-auto">
      <div ref={ref} className="w-full" style={{ height: 212 }}>
      <svg width={W} height={size.height} viewBox={`0 0 ${W} ${H + 22}`} className="block font-sans" role="img"
           aria-label={`${driver.label} versus ${target.label} over time`}>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={PAD} x2={W - PAD} y1={PAD + g * (H - PAD * 2)} y2={PAD + g * (H - PAD * 2)}
                stroke={CHART_COLORS.grid} strokeWidth="1" />
        ))}
        <polyline points={tgt} fill="none" stroke={CHART_COLORS.accent} strokeWidth="2.25"
                  strokeLinejoin="round" strokeLinecap="round" />
        <polyline points={drv} fill="none" stroke={CHART_COLORS.ink} strokeWidth="2"
                  strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />
        {ticks.map((i) => (
          <text key={i} x={PAD + (periods.length <= 1 ? 0 : (i / (periods.length - 1)) * (W - PAD * 2))}
                y={H + 14} {...CHART_AXIS_TEXT_PIXEL} fill={CHART_COLORS.axis}
                textAnchor={i === 0 ? "start" : i === periods.length - 1 ? "end" : "middle"}>
            {periods[i]}
          </text>
        ))}
      </svg>
      </div>
      <div className="flex items-center gap-4 px-1 text-[11px] text-fg-subtle">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4" style={{ background: CHART_COLORS.accent }} /> {target.label}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4" style={{ background: CHART_COLORS.ink }} /> {driver.label}
        </span>
      </div>
    </div>
  );
}

function CorrRow({ d, maxCorr, active, onFocus }: {
  d: DriverSensitivity; maxCorr: number; active: boolean; onFocus: () => void;
}) {
  const corr = d.corr ?? 0;
  const pct = (Math.abs(corr) / maxCorr) * 100;
  return (
    <button type="button" onClick={onFocus}
      className={cn("w-full text-left px-4 py-2.5 transition hover:bg-black/[0.03]", active && "bg-black/[0.04]")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className={cn("text-sm font-medium", d.selected ? "text-fg" : "text-fg-subtle")}>{d.label}</span>
          <span className="ml-2 text-[10px] uppercase tracking-wide text-fg-subtle">{CAT_LABEL[d.category] ?? d.category}</span>
        </div>
        <span className={cn("num text-xs shrink-0", d.selected ? "text-fg-muted" : "text-fg-subtle")}>
          r={corr.toFixed(2)} · {d.selected ? lagLabel(d.lag_m) : "not significant"}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
        <div className="h-full rounded-full"
             style={{ width: `${pct}%`, background: d.selected ? CHART_COLORS.accent : CHART_COLORS.slate, opacity: d.selected ? 1 : 0.5 }} />
      </div>
    </button>
  );
}

/** A single market-signal card in the feed. */
function SignalCard({ ev, unit, onModel }: { ev: MarketSignal; unit: string; onModel: () => void }) {
  const fav = ev.direction === "favourable";
  const accent = fav ? CHART_COLORS.good : CHART_COLORS.bad;
  return (
    <div className="tile ring-1 ring-line overflow-hidden h-full">
      <div className="flex h-full">
        <div className="w-1.5 shrink-0" style={{ background: accent }} />
        <div className="flex-1 p-4">
          <p className="text-sm font-semibold text-fg">{ev.headline}</p>
          <p className="mt-0.5 text-[11px] text-fg-subtle">{ev.source} · as of {ev.as_of}</p>
          <div className="mt-3 flex items-baseline gap-2">
            <span className={cn("num text-2xl font-bold", fav ? "text-signal-good" : "text-signal-bad")}>
              {fmtSignedUnit(ev.impact, unit)}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">est. impact</span>
          </div>
          <p className="mt-1.5 text-xs text-fg-muted">
            <span className="font-medium text-fg">{ev.driver_label}</span>
            <span className="text-fg-subtle"> · {sigmaLabel(ev.move_sigma)} · {lagLabel(ev.lag_m)}</span>
          </p>
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={onModel}>Model in scenario →</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MarketInsights({ refreshKey, onNavigate }: {
  refreshKey?: number;
  onNavigate?: (p: PageId, query?: string) => void;
}) {
  const [sig, setSig] = useState<MarketSignalsResponse | null>(null);
  const [sens, setSens] = useState<DriverSensitivitiesResponse | null>(null);
  const [series, setSeries] = useState<MarketDriversResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setErr(null); setSig(null); setSens(null); setSeries(null);
    Promise.all([api.marketSignals(), api.driverSensitivities(), api.marketDrivers()])
      .then(([g, s, m]) => {
        if (!alive) return;
        setSig(g); setSens(s); setSeries(m);
        setFocus(s.drivers.find((d) => d.selected)?.driver_id ?? s.drivers[0]?.driver_id ?? null);
      })
      .catch((e) => alive && setErr(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [refreshKey]);

  if (err) return <ErrorNote message={`Market Insights is unavailable: ${err}`} />;
  if (!sig || !sens || !series) {
    return (
      <SkeletonRegion className="w-full space-y-5">
        <TextSkeleton lines={1} className="readable-copy" />
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-5 items-start">
          <div className="order-2 lg:order-1 grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="tile ring-1 ring-line p-5 space-y-3">
                <div className="flex justify-between"><Skeleton className="h-3 w-24" /><Skeleton className="h-5 w-16 rounded-full" /></div>
                <Skeleton className="h-4 w-4/5" />
                <TextSkeleton lines={2} />
                <Skeleton className="h-8 w-28 rounded-lg" />
              </div>
            ))}
          </div>
          <div className="order-1 lg:order-2 tile ring-1 ring-line">
            <div className="p-5 space-y-2"><Skeleton className="h-2.5 w-40" /><Skeleton className="h-8 w-32" /><Skeleton className="h-2.5 w-36" /></div>
            <div className="grid grid-cols-2 gap-4 px-5 py-4 border-t border-line">
              {[0, 1].map((i) => <div key={i} className="space-y-2"><Skeleton className="h-2.5 w-20" /><Skeleton className="h-5 w-12" /></div>)}
            </div>
          </div>
        </div>
        <CardSkeleton />
      </SkeletonRegion>
    );
  }

  const target = sig.target;
  const unit = sig.unit;
  const targetLabel = target.label ?? "the forecast";
  const net = sig.net_impact ?? 0;
  const netFav = net >= 0;
  const selected = sens.drivers.filter((d) => d.selected);
  const dropped = sens.drivers.filter((d) => !d.selected);
  const maxCorr = Math.max(...sens.drivers.map((d) => Math.abs(d.corr ?? 0)), 0.01);
  const maxImpact = Math.max(...selected.map((d) => Math.abs(d.impact_per_sigma ?? 0)), 0.01);
  const r2Pct = sens.r2 == null ? "—" : `${Math.round(sens.r2 * 100)}%`;
  const focusDriver = series.drivers.find((s) => s.series_id === focus);

  return (
    <div className="w-full space-y-5">
      <p className="readable-copy text-sm text-fg-muted">
        {`Current market signals mapped to your forecast drivers — what moved, what it's worth to ${targetLabel}, and a one-click path to plan for it.`}
      </p>

      {/* Signals feed (hero) beside a compact net-exposure rail. The feed sits in
          a capped-width main column so cards read comfortably instead of stretching;
          the KPIs move to a right rail (above the feed on narrow screens). */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-5 items-start">
        {/* Feed — two-up so cards fill their width instead of stretching */}
        <div className="order-2 lg:order-1 min-w-0">
          {sig.events.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {sig.events.map((ev) => (
                <SignalCard key={ev.event_id} ev={ev} unit={unit}
                            onModel={() => onNavigate?.("scenario-planning")} />
              ))}
            </div>
          ) : (
            <Card><div className="p-5 text-sm text-fg-subtle">No material market signals this period.</div></Card>
          )}
        </div>

        {/* Net-exposure rail */}
        <aside className="order-1 lg:order-2">
          <Card>
            <div className="p-5">
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Net estimated impact · {targetLabel}</div>
              <div className={cn("num text-3xl font-bold mt-1", netFav ? "text-signal-good" : "text-signal-bad")}>
                {fmtSignedUnit(net, unit)}
              </div>
              <div className="text-[11px] text-fg-subtle mt-0.5">
                {netFav ? "net upside exposure" : "net downside exposure"} · as of {sig.as_of}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 px-5 py-4 border-t border-line">
              <Metric label="Active signals" value={sig.events.length} size="sm" />
              <Metric label="Model fit (R²)" value={r2Pct} size="sm"
                      tone={sens.r2 != null && sens.r2 >= 0.7 ? "ok" : "neutral"} />
            </div>
          </Card>
        </aside>
      </div>

      {/* Supporting: the driver model (methodology) */}
      <Section title="The model behind these estimates"
               subtitle={`how each signal's impact on ${targetLabel} is derived`} defaultOpen={false}>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-4">
            <div className="rounded-2xl ring-1 ring-line divide-y divide-line overflow-hidden">
              <div className="px-4 py-2.5 text-xs font-semibold text-fg-subtle uppercase tracking-wide">
                Drivers ranked by correlation with {targetLabel}
              </div>
              {[...selected, ...dropped].map((d) => (
                <CorrRow key={d.driver_id} d={d} maxCorr={maxCorr}
                         active={focus === d.driver_id} onFocus={() => setFocus(d.driver_id)} />
              ))}
            </div>
            <div className="rounded-2xl ring-1 ring-line p-4">
              {focusDriver && series.target
                ? <CoMovementChart periods={series.periods} target={series.target} driver={focusDriver} />
                : <div className="text-sm text-fg-subtle p-4">Select a driver to see its co-movement with the target.</div>}
              <p className="mt-2 px-1 text-[11px] text-fg-subtle">
                Each line is independently scaled — the shape and lead matter, not the absolute level.
              </p>
            </div>
          </div>

          <div className="rounded-2xl ring-1 ring-line overflow-hidden">
            <div className="px-5 py-3 border-b border-line text-sm font-semibold text-fg">
              Sensitivity — impact of a one-standard-deviation move
            </div>
            <div className="divide-y divide-line">
              {selected.map((d) => {
                const impact = d.impact_per_sigma ?? 0;
                const pct = (Math.abs(impact) / maxImpact) * 100;
                const favourable = impact >= 0;
                return (
                  <div key={d.driver_id} className="px-5 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-fg">
                        <span className="text-fg-subtle num mr-2">{d.rank}.</span>{d.label}
                      </span>
                      <span className={cn("num text-sm font-semibold", favourable ? "text-signal-good" : "text-signal-bad")}>
                        {fmtSignedUnit(impact, unit)} <span className="text-fg-subtle font-normal">/σ</span>
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3">
                      <div className="flex-1 h-2 rounded-full bg-black/[0.06] overflow-hidden">
                        <div className="h-full rounded-full"
                             style={{ width: `${pct}%`, background: favourable ? CHART_COLORS.good : CHART_COLORS.bad }} />
                      </div>
                      <span className="text-[11px] text-fg-subtle shrink-0">{lagLabel(d.lag_m)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <p className="px-1 text-[11px] leading-relaxed text-fg-subtle">
            Fitted with LassoCV over 36 months of history (model R² {r2Pct}). A signal becomes a
            key driver only when it both correlates with {targetLabel} <em>and</em> adds unique
            explanatory power — redundant / unrelated signals
            {dropped.length ? ` (${dropped.map((d) => d.label).join(", ")})` : ""} are shown but
            not selected. Signals in the feed above are illustrative.
          </p>
        </div>
      </Section>
    </div>
  );
}
