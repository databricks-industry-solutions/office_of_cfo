import { Info } from "lucide-react";
import { AiRoiGatewayTelemetry, api } from "../../../api";
import { CHART_COLORS } from "../../../lib/chartPalette";
import { Card, SkeletonRegion } from "../../ui";
import { GatewaySkeleton } from "../skeletons";
import { useAiRoiLoad, pct } from "../shared";

function formatCount(n?: number) {
  return (n ?? 0).toLocaleString();
}

function formatTokens(n?: number) {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString();
}

function DailySeriesChart({
  data,
  maxRequests,
}: {
  data: Array<{ usage_date: string; requests: number }>;
  maxRequests: number;
}) {
  if (!data.length) return null;
  const W = 1000;
  const H = 160;
  const padL = 8;
  const padR = 8;
  const padT = 12;
  const padB = 20;
  const n = data.length;
  const barWidth = (W - padL - padR) / n;
  const gap = Math.max(1, barWidth * 0.15);
  const effectiveBarWidth = barWidth - gap;
  const x = (i: number) => padL + i * barWidth + gap / 2;
  const y = (v: number) => padT + (1 - (v || 0) / maxRequests) * (H - padT - padB);

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={100}
        role="img"
        aria-label={`Daily requests over ${n} days. Peak: ${formatCount(maxRequests)} requests.`}
      >
        {data.map((d, i) => (
          <rect
            key={i}
            x={x(i)}
            y={y(d.requests)}
            width={effectiveBarWidth}
            height={H - padB - y(d.requests)}
            fill={CHART_COLORS.accent}
            rx={1}
          />
        ))}
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke={CHART_COLORS.grid} strokeWidth={1} />
      </svg>
      <div className="mt-1 flex justify-between px-1 text-[10px] text-fg-muted">
        <span>{data[0].usage_date}</span>
        <span>{data[data.length - 1].usage_date}</span>
      </div>
    </div>
  );
}

export function GatewayTelemetryPanel() {
  const { data, error } = useAiRoiLoad(() => api.aiRoiGatewayTelemetry(), []);
  const d = data;

  if (!d && !error) {
    return (
      <SkeletonRegion>
        <div data-testid="ai-roi-gateway"><GatewaySkeleton /></div>
      </SkeletonRegion>
    );
  }

  if (!d?.available) {
    return (
      <div data-testid="ai-roi-gateway">
        <Card title="Real workspace AI Gateway telemetry">
          <div className="flex items-center justify-between gap-2 px-5 pt-5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.05] px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
              <Info size={12} aria-hidden="true" />
              Not available
            </span>
          </div>
          <p className="p-5 text-sm text-fg-muted">
            {d?.reason ?? "Real gateway telemetry is not available in this workspace."}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div data-testid="ai-roi-gateway" className="space-y-4">
      <GatewayBody data={d} />
    </div>
  );
}

function GatewayBody({ data: d }: { data: AiRoiGatewayTelemetry }) {
  const series = d.series ?? [];
  const topDestinations = d.top_destinations ?? [];
  const byType = d.by_destination_type ?? [];
  const maxRequests = series.reduce((m, s) => Math.max(m, s.requests), 0) || 1;

  return (
    <>
      <Card title="Real workspace AI Gateway telemetry">
        <div className="p-5 space-y-4">
          <div className="flex justify-end">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-signal-good/10 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-signal-good">
              <span className="h-1.5 w-1.5 rounded-full bg-signal-good" aria-hidden="true" />
              Active
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["Requests", formatCount(d.requests)],
              ["Distinct models", formatCount(d.distinct_models)],
              ["Peak requesters", formatCount(d.peak_requesters)],
              ["Total tokens", formatTokens(d.total_tokens)],
              ["Failed", formatCount(d.failed_requests)],
              ["Span", `${d.days ?? 0} days`],
            ].map(([k, v]) => (
              <div key={String(k)}>
                <div className="text-[11px] uppercase tracking-wide text-fg-subtle">{k}</div>
                <div className={`text-lg font-semibold num ${k === "Failed" ? "text-signal-warn" : ""}`}>{v}</div>
              </div>
            ))}
          </div>
          {series.length > 0 && (
            <div className="pt-2">
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-2">Daily requests</div>
              <DailySeriesChart data={series} maxRequests={maxRequests} />
            </div>
          )}
          <div className="border-t border-line pt-3 text-xs text-fg-muted">
            <p>
              {d.from} to {d.to} · Last built {d.built_at?.slice(0, 10)} ({d.freshness})
            </p>
          </div>
        </div>
      </Card>

      {byType.length > 0 && (
        <Card title="Traffic by destination type">
          <div className="p-5 space-y-3">
            {byType.map((t) => {
              const requestShare = t.requests / (d.requests || 1);
              const tokenShare = t.tokens / (d.total_tokens || 1);
              return (
                <div key={t.destination_type} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="capitalize">{t.destination_type.replace(/_/g, " ")}</span>
                    <div className="flex items-center gap-4 text-xs text-fg-muted num">
                      <span>{pct(requestShare)} of requests</span>
                      <span>{pct(tokenShare)} of tokens</span>
                    </div>
                  </div>
                  <div className="relative h-2 overflow-hidden rounded-full bg-black/[0.06]">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-brick"
                      style={{ width: `${Math.max(0, Math.min(1, requestShare)) * 100}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {topDestinations.length > 0 && (
        <Card title="Top destinations">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-fg-subtle">
                  <th className="px-4 py-2 text-left font-medium">Destination</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-right font-medium">Requests</th>
                  <th className="px-3 py-2 text-right font-medium">Tokens</th>
                  <th className="px-4 py-2 text-right font-medium">p95 latency (ms)</th>
                </tr>
              </thead>
              <tbody>
                {topDestinations.map((row, i) => (
                  <tr key={i} className="border-b border-line/70">
                    <td className="px-4 py-2 font-mono text-xs">{row.name}</td>
                    <td className="px-3 py-2 text-xs capitalize text-fg-muted">{row.destination_type.replace(/_/g, " ")}</td>
                    <td className="px-3 py-2 text-right num">{formatCount(row.requests)}</td>
                    <td className="px-3 py-2 text-right num">{formatTokens(row.tokens)}</td>
                    <td className="px-4 py-2 text-right num">
                      {row.p95_latency_ms != null ? Math.round(row.p95_latency_ms) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="About this data">
        <div className="flex items-start gap-2 p-5 text-xs text-fg-muted">
          <Info size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p>
            This panel shows <strong className="text-fg">real workspace AI Gateway usage</strong>, not the synthetic
            ROI attribution. It is a batch aggregate of{" "}
            <code className="font-mono bg-black/[0.05] px-1 rounded">system.ai_gateway.usage</code> because that table is
            not on a streaming path. It shows counts only, never requester identities.
          </p>
        </div>
      </Card>
    </>
  );
}
