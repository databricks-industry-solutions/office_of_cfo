import { useState } from "react";
import { useChartSize } from "../../../lib/useChartSize";
import { AiRoiSummary, Scope, api } from "../../../api";
import { Card } from "../../ui";
import { CHART_AXIS_TEXT_PIXEL, CHART_COLORS } from "../../../lib/chartPalette";
import { DataState, useAiRoiLoad } from "../shared";
import { money } from "./format";
import { EventDrawer } from "./EventDrawer";

type BarKind = "value" | "run_cost" | "investment" | "net";

export function ValueBridge({
  useCaseId,
  summary,
  scope,
}: {
  useCaseId: string;
  summary: AiRoiSummary;
  scope: Scope;
}) {
  const { ref, size } = useChartSize({ width: 720, height: 280 });
  const [open, setOpen] = useState<BarKind | null>(null);
  const rv = summary.realised_value ?? summary.realised_value_all ?? 0;
  const rc = summary.ai_run_cost ?? summary.run_cost ?? 0;
  const am = summary.amortised_investment ?? 0;
  const net = summary.net_ai_value ?? summary.net_value ?? 0;
  const maxY = Math.max(rv, rc + am + Math.max(net, 0), 1);

  const W = size.width, H = size.height, padB = 44, padT = 12;
  const bw = 120, gap = (W - bw * 4) / 5;
  const y = (v: number) => padT + (1 - v / maxY) * (H - padT - padB);
  const bx = (i: number) => gap + i * (bw + gap);

  const bars: {
    kind: BarKind; label: string; top: number; bottom: number; amount: number;
    color: string; clickable: boolean;
  }[] = [
    { kind: "value", label: "Realised value", top: rv, bottom: 0, amount: rv, color: CHART_COLORS.good, clickable: true },
    { kind: "run_cost", label: "− Run cost", top: rv, bottom: rv - rc, amount: -rc, color: CHART_COLORS.series2, clickable: true },
    { kind: "investment", label: "− Amortised inv.", top: rv - rc, bottom: rv - rc - am, amount: -am, color: CHART_COLORS.series4, clickable: true },
    { kind: "net", label: "Net AI value", top: Math.max(net, 0), bottom: Math.min(net, 0), amount: net, color: CHART_COLORS.other, clickable: false },
  ];

  return (
    <Card title="Value / investment bridge">
      <div data-testid="ai-roi-value-bridge" className="p-5">
        <div ref={ref} className="w-full" style={{ height: 280 }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" className="block font-sans"
          aria-label="Bridge from realised value to net AI value">
          {bars.map((b, i) => {
            const yTop = y(Math.max(b.top, b.bottom));
            const h = Math.max(2, Math.abs(y(b.bottom) - y(b.top)));
            return (
              <g key={b.kind} className={b.clickable ? "cursor-pointer" : undefined}
                onClick={() => b.clickable && setOpen(b.kind)}>
                {i < bars.length - 1 && (
                  <line x1={bx(i)} y1={y(b.bottom)} x2={bx(i + 1) + bw} y2={y(b.bottom)}
                    stroke={CHART_COLORS.grid} strokeWidth={1} strokeDasharray="2 3" />
                )}
                <rect x={bx(i)} y={yTop} width={bw} height={h} rx={2} fill={b.color}
                  fillOpacity={b.clickable ? 0.9 : 0.6} stroke="white" strokeWidth={1.5} />
                <text x={bx(i) + bw / 2} y={H - padB + 16} textAnchor="middle"
                  {...CHART_AXIS_TEXT_PIXEL} fill={CHART_COLORS.ink}>{b.label}</text>
                <text x={bx(i) + bw / 2} y={H - padB + 32} textAnchor="middle"
                  fontSize={12} fontWeight={600} fill={CHART_COLORS.ink} className="num">
                  {money(Math.abs(b.amount))}
                </text>
              </g>
            );
          })}
        </svg>
        </div>
        <p className="mt-1 text-xs text-fg-muted">Click a bar to see its contributing events.</p>
      </div>
      <EventDrawer
        open={open}
        onClose={() => setOpen(null)}
        useCaseId={useCaseId}
        scope={scope}
        kind={open === "investment" ? "investment" : open === "value" ? "value" : null}
        runCostNote={open === "run_cost"}
      />
    </Card>
  );
}
