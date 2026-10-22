import { CircleHelp } from "lucide-react";
import { ReactNode } from "react";
import { AiRoiSummary } from "../../../api";
import { money, ratio } from "../shared";
import { PageId } from "../../../nav";

interface KpiGridProps {
  summary: AiRoiSummary;
  onNavigate: (page: PageId, query?: string) => void;
}

interface KpiProps {
  title: string;
  value: string;
  formula: string;
  sub?: ReactNode;
  onClick?: () => void;
}

function Kpi({ title, value, formula, sub, onClick }: KpiProps) {
  const body = (
    <div className="tile flex h-[118px] flex-col gap-1 p-5 text-left ring-1 ring-line transition-colors hover:bg-black/[0.025]">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{title}</span>
        <CircleHelp className="h-3.5 w-3.5 text-fg-subtle" aria-label={formula}>
          <title>{formula}</title>
        </CircleHelp>
      </div>
      <div className="num text-[28px] font-semibold leading-tight text-fg">{value}</div>
      <div className="mt-auto flex items-center gap-2 text-xs text-fg-muted">{sub}</div>
    </div>
  );
  return onClick
    ? <button type="button" className="block w-full" onClick={onClick}>{body}</button>
    : body;
}

export function ExecutiveKpiGrid({ summary: s, onNavigate }: KpiGridProps) {
  const previousCost = s.previous?.ai_run_cost ?? s.previous?.run_cost;
  const costDelta = previousCost == null ? null : s.run_cost - previousCost;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Kpi
        title="Net run-rate value"
        value={money(s.net_run_rate_value ?? s.net_value)}
        formula="Annualised realised value minus AI run cost"
      />
      <Kpi
        title="Run-rate Return on Token Used"
        value={ratio(s.run_rate_rodt)}
        formula="(Realised value − AI run cost) / AI run cost"
        onClick={() => onNavigate("ai-roi-roi")}
        sub={<>programme <span className="num text-fg">{ratio(s.programme_rodt)}</span></>}
      />
      <Kpi
        title="Cash break-even"
        value={s.cash_breakeven_month == null ? "—" : `${s.cash_breakeven_month}`}
        formula="First month where cumulative value covers cumulative run cost and investment"
        onClick={() => onNavigate("ai-roi-roi")}
        sub={
          <>
            business-case payback <span className="num text-fg">{s.simple_payback_months?.toFixed(1) ?? "—"}</span> mo
            {/* Ramp drag is cash break-even minus business-case payback. Negative
                means break-even came EARLIER than the case, which is good news;
                showing it as "ramp drag -4.5 mo" in the warning colour stated the
                opposite. Only real drag is shown as drag. */}
            {s.ramp_drag_months != null && s.ramp_drag_months > 0.05 && <> · ramp drag <span className="num text-signal-warn">{s.ramp_drag_months.toFixed(1)}</span> mo</>}
          </>
        }
      />
      <Kpi
        title="AI run cost (run-rate)"
        value={money(s.run_cost)}
        formula="MEASURE(Token Run Cost) over the selected scope and period"
        onClick={() => onNavigate("ai-roi-spend")}
        sub={costDelta != null
          ? <span className={costDelta > 0 ? "text-signal-warn" : "text-signal-good"}>
              {costDelta > 0 ? "▲" : "▼"} {money(Math.abs(costDelta))}
            </span>
          : undefined}
      />
    </div>
  );
}
