import {
  CHART_AXIS_TEXT_PIXEL,
  CHART_COLORS,
  SPEND_STACKED_AREA_CSS_VARS,
  SPEND_STACKED_AREA_ORDER,
} from "../../lib/chartPalette";
import { useChartSize } from "../../lib/useChartSize";

function spendStackedAreaFill(seriesIndex: number): string {
  const key = SPEND_STACKED_AREA_ORDER[seriesIndex] ?? "slate";
  return `var(${SPEND_STACKED_AREA_CSS_VARS[key]})`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function periodLabel(period: string) {
  const [year, month] = period.split("-");
  const index = Number(month) - 1;
  return Number.isInteger(index) && MONTHS[index]
    ? `${MONTHS[index]} ’${year.slice(-2)}`
    : period;
}

/** Return on Token Used trend. RoTU is NET, so the bad/good split is at 0. */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 0.01);
  const min = Math.min(...values, 0);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 80},${18 - ((v - min) / (max - min || 1)) * 16}`).join(" ");
  const last = values[values.length - 1];
  return (
    <svg viewBox="0 0 80 20" className="w-20 h-5" aria-hidden="true">
      <polyline fill="none" stroke={last < 0 ? CHART_COLORS.bad : CHART_COLORS.good} strokeWidth="1.8" points={pts} />
    </svg>
  );
}

export function StackedArea({ rows, asTable }: {
  rows: { period: string; group?: string | null; value: number | null }[];
  asTable?: boolean;
}) {
  const { ref, size } = useChartSize({ width: 1120, height: 260 });
  const clean = rows.filter((r) => r.period);
  const periods = [...new Set(clean.map((r) => r.period))];
  const groups = [...new Set(clean.map((r) => r.group || "All"))];
  const top = groups.slice(0, 4);
  const rest = groups.slice(4);
  const keys = rest.length ? [...top, "Other"] : top;
  const byPeriod = periods.map((period) => {
    const slice = clean.filter((r) => r.period === period);
    const values: Record<string, number> = {};
    for (const key of top) values[key] = slice.filter((r) => (r.group || "All") === key).reduce((s, r) => s + (r.value || 0), 0);
    if (rest.length) values.Other = slice.filter((r) => rest.includes(r.group || "All")).reduce((s, r) => s + (r.value || 0), 0);
    return { period, values };
  });
  if (asTable) {
    return (
      <table className="w-full text-sm">
        <thead><tr>{["Period", ...keys].map((h) => <th key={h} className="px-2 py-1 text-left text-xs text-fg-subtle">{h}</th>)}</tr></thead>
        <tbody>{byPeriod.map((p) => (
          <tr key={p.period}><td className="px-2 py-1">{p.period.slice(0, 7) || "—"}</td>
            {keys.map((k) => <td key={k} className="px-2 py-1 num">{Math.round(p.values[k] || 0).toLocaleString()}</td>)}</tr>
        ))}</tbody>
      </table>
    );
  }
  const W = size.width, H = size.height;
  const padL = 72, padR = 16, padT = 12, padB = 34;
  const axisText = CHART_AXIS_TEXT_PIXEL;
  const max = Math.max(...byPeriod.map((p) => keys.reduce((s, k) => s + (p.values[k] || 0), 0)), 1);
  const x = (i: number) => padL + (periods.length < 2 ? 0 : i * (W - padL - padR) / (periods.length - 1));
  const y = (v: number) => H - padB - (v / max) * (H - padT - padB);
  const formatAxis = (value: number) => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
  const paths = keys.map((key, gi) => {
    const topLine = byPeriod.map((p, i) => {
      const below = keys.slice(0, gi).reduce((s, k) => s + (p.values[k] || 0), 0);
      return `${x(i)},${y(below + (p.values[key] || 0))}`;
    });
    const bottom = [...byPeriod].reverse().map((p, i) => {
      const below = keys.slice(0, gi).reduce((s, k) => s + (p.values[k] || 0), 0);
      return `${x(byPeriod.length - 1 - i)},${y(below)}`;
    });
    return { key, d: `M${topLine.join(" L")} L${bottom.join(" L")} Z`, fill: spendStackedAreaFill(gi) };
  });
  return (
    <div>
      <div ref={ref} className="w-full" style={{ height: 260 }}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block font-sans"
        role="img"
        aria-label="AI run cost in US dollars"
      >
        <g className="font-sans">
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
            const value = max * fraction;
            return (
              <g key={fraction}>
                <line
                  x1={padL}
                  x2={W - padR}
                  y1={y(value)}
                  y2={y(value)}
                  stroke={CHART_COLORS.grid}
                  strokeWidth="1"
                />
                <text
                  x={padL - 9}
                  y={y(value) + 4}
                  textAnchor="end"
                  {...axisText}
                  fill={CHART_COLORS.axis}
                  className="font-sans"
                >
                  {formatAxis(value)}
                </text>
              </g>
            );
          })}
          <text
            x="14"
            y={(padT + H - padB) / 2}
            textAnchor="middle"
            {...axisText}
            fill={CHART_COLORS.axis}
            className="font-sans"
            transform={`rotate(-90 14 ${(padT + H - padB) / 2})`}
          >
            AI run cost (USD)
          </text>
        </g>
        {paths.map((p) => (
          <path
            key={p.key}
            d={p.d}
            fill={p.fill}
            fillOpacity="1"
            stroke="var(--c-spend-area-divider)"
            strokeWidth="0.75"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke={CHART_COLORS.grid} strokeWidth="1" />
        {periods.map((period, i) => (
          <text
            key={period}
            x={x(i)}
            y={H - 12}
            textAnchor={i === 0 ? "start" : i === periods.length - 1 ? "end" : "middle"}
            {...axisText}
            fill={CHART_COLORS.axis}
            className="font-sans"
          >
            {periodLabel(period)}
          </text>
        ))}
      </svg>
      </div>
      <div className="flex flex-wrap gap-3 px-1 text-[11px] text-fg-muted">
        {keys.map((k, i) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ background: spendStackedAreaFill(i) }} />
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

const GROUP_BAR_COLORS = [
  CHART_COLORS.series1,
  CHART_COLORS.series2,
  CHART_COLORS.series3,
  CHART_COLORS.series4,
  CHART_COLORS.seriesA,
  CHART_COLORS.seriesB,
  CHART_COLORS.seriesC,
  CHART_COLORS.good,
  CHART_COLORS.warn,
  CHART_COLORS.accent,
];

export function GroupedBar({ rows, asTable }: {
  rows: { period: string; group?: string | null; value: number | null }[];
  asTable?: boolean;
}) {
  const { ref, size } = useChartSize({ width: 1120, height: 260 });
  const clean = rows.filter((r) => r.period);
  const periods = [...new Set(clean.map((r) => r.period))];
  const groups = [...new Set(clean.map((r) => r.group || "All"))];
  const keys = groups.slice(0, 10);
  const byPeriod = periods.map((period) => {
    const slice = clean.filter((r) => r.period === period);
    const values: Record<string, number> = {};
    for (const key of keys) {
      values[key] = slice.filter((r) => (r.group || "All") === key).reduce((s, r) => s + (r.value || 0), 0);
    }
    return { period, values };
  });
  if (asTable) {
    return (
      <table className="w-full text-sm">
        <thead><tr>{["Period", ...keys].map((h) => <th key={h} className="px-2 py-1 text-left text-xs text-fg-subtle">{h}</th>)}</tr></thead>
        <tbody>{byPeriod.map((p) => (
          <tr key={p.period}><td className="px-2 py-1">{p.period.slice(0, 7) || "—"}</td>
            {keys.map((k) => <td key={k} className="px-2 py-1 num">{Math.round(p.values[k] || 0).toLocaleString()}</td>)}</tr>
        ))}</tbody>
      </table>
    );
  }
  const W = size.width, H = size.height;
  const padL = 72, padR = 16, padT = 12, padB = 34;
  const axisText = CHART_AXIS_TEXT_PIXEL;
  const max = Math.max(...byPeriod.flatMap((p) => keys.map((k) => p.values[k] || 0)), 1);
  const cluster = (W - padL - padR) / Math.max(periods.length, 1);
  const barW = Math.max(4, (cluster * 0.72) / Math.max(keys.length, 1));
  const xCluster = (i: number) => padL + i * cluster;
  const y = (v: number) => H - padB - (v / max) * (H - padT - padB);
  const formatAxis = (value: number) => new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
  }).format(value);
  return (
    <div>
      <div ref={ref} className="w-full" style={{ height: 260 }}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block font-sans"
        role="img"
        aria-label="AI run cost in US dollars"
      >
        <g className="font-sans">
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
            const value = max * fraction;
            return (
              <g key={fraction}>
                <line x1={padL} x2={W - padR} y1={y(value)} y2={y(value)} stroke={CHART_COLORS.grid} strokeWidth="1" />
                <text x={padL - 9} y={y(value) + 4} textAnchor="end" {...axisText} fill={CHART_COLORS.axis} className="font-sans">
                  {formatAxis(value)}
                </text>
              </g>
            );
          })}
        </g>
        {byPeriod.map((p, pi) => keys.map((key, ki) => {
          const h = (H - padT - padB) * ((p.values[key] || 0) / max);
          const x = xCluster(pi) + cluster * 0.14 + ki * barW;
          return (
            <rect
              key={`${p.period}-${key}`}
              x={x}
              y={H - padB - h}
              width={barW - 1}
              height={h}
              fill={GROUP_BAR_COLORS[ki % GROUP_BAR_COLORS.length]}
              fillOpacity="1"
            />
          );
        }))}
        <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke={CHART_COLORS.grid} strokeWidth="1" />
        {periods.map((period, i) => (
          <text
            key={period}
            x={xCluster(i) + cluster / 2}
            y={H - 12}
            textAnchor="middle"
            {...axisText}
            fill={CHART_COLORS.axis}
            className="font-sans"
          >
            {periodLabel(period)}
          </text>
        ))}
      </svg>
      </div>
      <div className="flex flex-wrap gap-3 px-1 text-[11px] text-fg-muted">
        {keys.map((k, i) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ background: GROUP_BAR_COLORS[i % GROUP_BAR_COLORS.length] }} />
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

export function TrendLine({
  rows,
  highlight = null,
  onHighlight,
  height = 280,
}: {
  rows: { period: string; key?: string | null; label?: string | null; value: number | null }[];
  highlight?: string | null;
  onHighlight?: (key: string | null) => void;
  height?: number;
}) {
  const { ref, size } = useChartSize({ width: 640, height });
  const points = rows.filter((row) => row.period);
  const periods = [...new Set(points.map((row) => row.period))];
  if (periods.length < 2) return <p className="p-5 text-sm text-fg-muted">Not enough history for a trend.</p>;
  const seriesKeys: string[] = [];
  const labels: Record<string, string> = {};
  for (const row of points) {
    const key = row.key || row.label || "Total";
    if (!seriesKeys.includes(key)) seriesKeys.push(key);
    labels[key] = row.label || key;
  }
  const ordered = [
    ...seriesKeys.filter((key) => key === "Total"),
    ...seriesKeys.filter((key) => key !== "Total"),
  ];
  const byKey: Record<string, number[]> = Object.fromEntries(ordered.map((key) => [key, periods.map((period) =>
    points.filter((row) => (row.key || row.label || "Total") === key && row.period === period)
      .reduce((sum, row) => sum + (row.value ?? 0), 0),
  )]));
  const W = size.width, H = size.height;
  const padL = 92, padR = 20, padT = 16, padB = 52;
  const max = Math.max(...ordered.flatMap((key) => byKey[key]), 1);
  const x = (index: number) => padL + (index / (periods.length - 1)) * (W - padL - padR);
  const y = (value: number) => padT + (1 - value / max) * (H - padT - padB);
  const colors = [CHART_COLORS.ink, ...GROUP_BAR_COLORS];
  const formatAxis = (value: number) => new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
  }).format(value);
  const axisText = CHART_AXIS_TEXT_PIXEL;
  const toggle = (key: string) => onHighlight?.(highlight === key ? null : key);
  return (
    <div>
      <div ref={ref} className="w-full" style={{ height }}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block font-sans"
        role="img"
        aria-label="Monthly run cost trend"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const value = max * fraction;
          return (
            <g key={fraction}>
              <line x1={padL} x2={W - padR} y1={y(value)} y2={y(value)} stroke={CHART_COLORS.grid} strokeWidth="1" />
              <text x={padL - 10} y={y(value) + 5} textAnchor="end" {...axisText} fill={CHART_COLORS.ink}>
                {formatAxis(value)}
              </text>
            </g>
          );
        })}
        <line x1={padL} x2={padL} y1={padT} y2={H - padB} stroke={CHART_COLORS.ink} strokeWidth="1.5" />
        <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke={CHART_COLORS.ink} strokeWidth="1.5" />
        {ordered.map((key, index) => {
          const values = byKey[key];
          const d = values.map((value, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
          const active = highlight == null || highlight === key;
          const color = key === "Total" ? CHART_COLORS.ink : colors[index % colors.length];
          return (
            <g key={key} className="cursor-pointer" onClick={() => toggle(key)}>
              <path d={d} fill="none" stroke="transparent" strokeWidth="12" />
              <path
                d={d}
                fill="none"
                stroke={active ? color : CHART_COLORS.slate}
                strokeWidth={key === "Total" ? 3 : 2.4}
                strokeOpacity={active ? 1 : 0.25}
                strokeDasharray={key === "Total" ? "6 4" : undefined}
              />
            </g>
          );
        })}
        {periods.map((period, i) => (
          (i === 0 || i === periods.length - 1 || i % 2 === 0) ? (
            <text
              key={period}
              x={x(i)}
              y={H - 16}
              textAnchor={i === 0 ? "start" : i === periods.length - 1 ? "end" : "middle"}
              {...axisText}
              fill={CHART_COLORS.ink}
            >
              {periodLabel(period)}
            </text>
          ) : null
        ))}
      </svg>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {ordered.map((key, index) => {
          const active = highlight == null || highlight === key;
          const color = key === "Total" ? CHART_COLORS.ink : colors[index % colors.length];
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggle(key)}
              className={`inline-flex items-center gap-1.5 ${active ? "text-fg" : "text-fg-subtle"}`}
            >
              <span className="h-0.5 w-4" style={{ background: active ? color : CHART_COLORS.slate, opacity: active ? 1 : 0.4 }} />
              {labels[key]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function BreakevenChart({
  months,
  lastActualIndex,
}: {
  months: { period?: string | null; cum_value?: number | null; cum_outlay?: number | null }[];
  crossover?: number | null;
  paybackMonths?: number | null;
  lastActualIndex?: number | null;
  bandLow?: (number | null)[] | null;
  bandHigh?: (number | null)[] | null;
}) {
  const { ref, size } = useChartSize({ width: 1000, height: 360 });
  const actual = months.slice(0, (lastActualIndex ?? months.length - 1) + 1);
  if (actual.length < 2) return <p className="p-5 text-sm text-fg-muted">Not enough history for a break-even path.</p>;
  const points = actual.map((m, index) => ({
    value: (m.cum_value ?? 0) - (index ? actual[index - 1].cum_value ?? 0 : 0),
    outlay: (m.cum_outlay ?? 0) - (index ? actual[index - 1].cum_outlay ?? 0 : 0),
    period: m.period,
  }));
  const W = size.width, H = size.height;
  const padL = 72, padR = 16, padT = 18, padB = 36;
  const max = Math.max(...points.flatMap((point) => [point.value, point.outlay]), 1);
  const x = (index: number) => padL + (index / (points.length - 1)) * (W - padL - padR);
  const y = (value: number) => padT + (1 - value / max) * (H - padT - padB);
  const line = (key: "value" | "outlay") =>
    points.map((point, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(point[key]).toFixed(1)}`).join(" ");
  let crossX: number | null = null;
  let crossY: number | null = null;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].value - points[i - 1].outlay;
    const cur = points[i].value - points[i].outlay;
    if (prev < 0 && cur >= 0) {
      const t = cur === prev ? 0 : -prev / (cur - prev);
      crossX = x(i - 1) + t * (x(i) - x(i - 1));
      crossY = y(points[i - 1].value + t * (points[i].value - points[i - 1].value));
      break;
    }
  }
  const formatAxis = (value: number) => new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
  }).format(value);
  const axisText = CHART_AXIS_TEXT_PIXEL;
  return (
    <div className="w-full">
      <div ref={ref} className="w-full" style={{ height: 360 }}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block font-sans"
        role="img"
        aria-label="Monthly value versus monthly outlay"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const value = max * fraction;
          return (
            <g key={fraction}>
              <line x1={padL} x2={W - padR} y1={y(value)} y2={y(value)} stroke={CHART_COLORS.grid} strokeWidth="1" />
              <text x={padL - 8} y={y(value) + 4} textAnchor="end" {...axisText} fill={CHART_COLORS.axis}>{formatAxis(value)}</text>
            </g>
          );
        })}
        <path d={line("outlay")} fill="none" stroke={CHART_COLORS.series3} strokeWidth="2.5" />
        <path d={line("value")} fill="none" stroke={CHART_COLORS.good} strokeWidth="2.5" />
        {crossX != null && crossY != null && (
          <g>
            <line x1={crossX} x2={crossX} y1={crossY} y2={H - padB} stroke={CHART_COLORS.axis} strokeWidth="1" strokeDasharray="4 4" />
            <circle cx={crossX} cy={crossY} r="5" fill={CHART_COLORS.ink} />
            <text x={crossX + 8} y={crossY - 10} fontSize="13" fontWeight="600" fill={CHART_COLORS.ink}>
              break-even
            </text>
          </g>
        )}
        <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke={CHART_COLORS.grid} strokeWidth="1" />
        {points.map((point, i) => (
          (i === 0 || i === points.length - 1 || i % 2 === 0) && point.period ? (
            <text key={point.period + i} x={x(i)} y={H - 12} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} {...axisText} fill={CHART_COLORS.axis}>
              {periodLabel(String(point.period))}
            </text>
          ) : null
        ))}
      </svg>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 bg-signal-good" />Monthly value</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4" style={{ background: CHART_COLORS.series3 }} />Monthly outlay (run + investment)</span>
      </div>
      {crossX == null && <p className="mt-1 text-xs text-signal-warn">Monthly value has not yet overtaken monthly outlay.</p>}
    </div>
  );
}
