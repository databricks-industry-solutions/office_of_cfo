import { AiRoiSummary } from "../../../api";
import { money, monthsLabel, ratio } from "./format";

export function DetailKpiGrid({ summary }: { summary: AiRoiSummary }) {
  const cards = [
    { label: "Net AI value", value: money(summary.net_ai_value ?? summary.net_value) },
    {
      label: "Run-rate Return on Token Used",
      value: ratio(summary.run_rate_rodt),
      note: summary.programme_rodt == null ? undefined : `programme ${ratio(summary.programme_rodt)}`,
    },
    { label: "Cash break-even", value: monthsLabel(summary.cash_breakeven_month) },
    { label: "Business-case payback", value: monthsLabel(summary.simple_payback_months) },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="tile ring-1 ring-line p-5">
          <div className="text-[11px] uppercase tracking-wide text-fg-subtle">{c.label}</div>
          <div className="mt-1 text-2xl font-bold num text-fg">{c.value}</div>
          {c.note && <div className="mt-2 text-xs text-fg-muted">{c.note}</div>}
        </div>
      ))}
    </div>
  );
}
