import { useMemo } from "react";
import { CHART_AXIS_TEXT_PIXEL, CHART_COLORS } from "../../../lib/chartPalette";
import { useChartSize } from "../../../lib/useChartSize";
import { money, pctShare, unitPrice } from "../revenue/format";
import { pct } from "../shared";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthLabel(iso: string) {
  const [y, m] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ’${y.slice(2)}`;
}

function niceTickStep(max: number) {
  const raw = max / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw || 1));
  const normalized = raw / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function smoothMonotonePath(points: { x: number; y: number }[]) {
  if (!points.length) return "";
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const midX = (previous.x + point.x) / 2;
    return `${path} C${midX},${previous.y} ${midX},${point.y} ${point.x},${point.y}`;
  }, `M${points[0].x},${points[0].y}`);
}

export function findMigrationMarker(pts: { period: string; blended_cost_per_mtok?: number | null; cost_per_mtok?: number | null }[]) {
  let best = -1;
  let drop = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].blended_cost_per_mtok ?? pts[i - 1].cost_per_mtok ?? 0;
    const b = pts[i].blended_cost_per_mtok ?? pts[i].cost_per_mtok ?? 0;
    if (a && b && a - b > drop) {
      drop = a - b;
      best = i;
    }
  }
  return best >= 0
    ? { period: pts[best].period, pct: drop / (pts[best - 1].blended_cost_per_mtok ?? pts[best - 1].cost_per_mtok ?? 1) }
    : null;
}

export function EfficiencyHeadline({
  trend,
  migration,
}: {
  trend: { period: string; blended_cost_per_mtok?: number | null; cost_per_mtok?: number | null }[];
  migration: { period: string; pct: number } | null;
}) {
  const first = trend[0]?.blended_cost_per_mtok ?? trend[0]?.cost_per_mtok;
  const latest = trend[trend.length - 1]?.blended_cost_per_mtok ?? trend[trend.length - 1]?.cost_per_mtok;
  if (latest == null) {
    return { headline: "No token usage in scope", subhead: "" };
  }
  const movement = first && latest ? (first - latest) / first : 0;
  const movementDir = movement > 0 ? "down" : "up";
  const headline =
    `Blended cost per million tokens is ${unitPrice(latest)}, ` +
    `${movementDir} ${pct(Math.abs(movement))} from start of period`;
  const subhead = migration
    ? `Model migration drove a ${pct(migration.pct)} drop in unit economics`
    : "No significant model migration detected in this period";
  return { headline, subhead };
}

export function BlendedCostChart({
  pts,
  migration,
  asTable,
}: {
  pts: { period: string; blended_cost_per_mtok?: number | null; cost_per_mtok?: number | null }[];
  migration: { period: string; pct: number } | null;
  asTable?: boolean;
}) {
  const { ref, size } = useChartSize({ width: 1120, height: 260 });
  const values = pts.map((p) => p.blended_cost_per_mtok ?? p.cost_per_mtok ?? 0);
  if (asTable) {
    return (
      <div className="p-5">
        <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-fg-subtle">
            <th className="px-3 py-2 text-left">Period</th>
            <th className="px-3 py-2 text-right">Blended $/Mtok</th>
          </tr>
        </thead>
        <tbody>
          {pts.map((p) => (
            <tr key={p.period} className="border-b border-line/60">
              <td className="px-3 py-1.5">{monthLabel(p.period.slice(0, 10))}</td>
              <td className="px-3 py-1.5 text-right num">{unitPrice(p.blended_cost_per_mtok ?? p.cost_per_mtok)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    );
  }
  if (pts.length < 2) return <p className="p-5 text-sm text-fg-muted">Not enough history to chart.</p>;
  const W = size.width;
  const H = size.height;
  const padL = 84, padR = 16, padT = 16, padB = 36;
  const max = Math.max(...values, 0.01);
  const tickStep = niceTickStep(max);
  const yMax = Math.ceil(max / tickStep) * tickStep;
  const ticks = Array.from(
    { length: Math.round(yMax / tickStep) + 1 },
    (_, index) => index * tickStep,
  );
  const x = (index: number) => padL + (index / (pts.length - 1)) * (W - padL - padR);
  const y = (value: number) => padT + (1 - value / yMax) * (H - padT - padB);
  const chartPoints = values.map((value, index) => ({ x: x(index), y: y(value) }));
  const path = smoothMonotonePath(chartPoints);
  const axisText = {
    ...CHART_AXIS_TEXT_PIXEL,
    fill: CHART_COLORS.axis,
  } as const;
  const migIndex = migration ? pts.findIndex((p) => p.period === migration.period) : -1;
  const migX = migIndex >= 0 ? x(migIndex) : null;
  return (
    <div className="p-5">
      <div ref={ref} className="h-[260px] w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="block font-sans"
        role="img"
        aria-label="Blended cost per million tokens trend"
      >
        <title>AI run cost efficiency: blended cost per million tokens</title>
        <text
          x={16}
          y={(padT + H - padB) / 2}
          textAnchor="middle"
          transform={`rotate(-90 16 ${(padT + H - padB) / 2})`}
          fill={CHART_COLORS.axis}
          {...CHART_AXIS_TEXT_PIXEL}
        >
          USD per million tokens
        </text>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(tick)}
              y2={y(tick)}
              stroke={CHART_COLORS.grid}
              strokeWidth="1"
            />
            <text x={padL - 10} y={y(tick) + 4} textAnchor="end" {...axisText}>
              {unitPrice(tick)}
            </text>
          </g>
        ))}
        <line
          x1={padL}
          x2={W - padR}
          y1={H - padB}
          y2={H - padB}
          stroke={CHART_COLORS.grid}
          strokeWidth="1"
        />
        {pts.map((point, index) => {
          if (index % 2 !== 0 && index !== pts.length - 1) return null;
          return (
            <text
              key={point.period}
              x={x(index)}
              y={H - 10}
              textAnchor={index === 0 ? "start" : index === pts.length - 1 ? "end" : "middle"}
              {...axisText}
            >
              {monthLabel(point.period.slice(0, 10))}
            </text>
          );
        })}
        {migX != null && (
          <g>
            <line
              x1={migX}
              x2={migX}
              y1={padT}
              y2={H - padB}
              stroke={CHART_COLORS.series4}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={migX + 8}
              y={padT + 12}
              fill={CHART_COLORS.series4}
              fontFamily="inherit"
              fontSize="12"
            >
              model migration −{Math.round(migration!.pct * 100)}%
            </text>
          </g>
        )}
        <path
          d={path}
          fill="none"
          stroke="var(--c-efficiency-line)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      </div>
    </div>
  );
}

export function ModelEconomicsTable({
  models,
}: {
  models: {
    model_id: string;
    name: string;
    tier: string;
    run_cost: number;
    ai_run_cost?: number;
    cost_per_mtok: number | null;
    blended_cost_per_mtok?: number | null;
    cost_per_request?: number | null;
  }[];
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-y border-line text-xs text-fg-subtle">
          {["Model", "Tier", "Run cost", "$/Mtok", "$/request"].map((h, i) => (
            <th key={h} className={`px-3 py-2 font-medium ${i > 1 ? "text-right" : "text-left"}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {models.map((m) => (
          <tr key={m.model_id} className="border-b border-line/60">
            <td className="px-3 py-2 font-medium">{m.name}</td>
            <td className="px-3 py-2 capitalize text-fg-muted">{m.tier}</td>
            <td className="px-3 py-2 text-right num">{money(m.ai_run_cost ?? m.run_cost)}</td>
            <td className="px-3 py-2 text-right num">{unitPrice(m.blended_cost_per_mtok ?? m.cost_per_mtok)}</td>
            <td className="px-3 py-2 text-right num">{unitPrice(m.cost_per_request ?? null)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function WasteSavingsPanel({
  waste,
}: {
  waste: {
    cache_saving_usd?: number;
    retry_waste_usd?: number;
    token_efficiency_ratio?: number | null;
  };
}) {
  return (
    <div className="flex flex-col gap-3 p-5">
      <Row label="Cache saving realised" value={money(waste.cache_saving_usd ?? 0)} />
      <Row label="Retry waste" value={money(waste.retry_waste_usd ?? 0)} />
      <Row label="Token efficiency" value={pct(waste.token_efficiency_ratio ?? null)} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-fg-muted">{label}</span>
      <span className="num text-sm font-semibold">{value}</span>
    </div>
  );
}
