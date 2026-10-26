import { AiRoiUseCaseDetail, Scope } from "../../../api";
import { Card } from "../../ui";
import { BreakevenChart } from "../charts";
import { AttributionPolicyCard } from "./AttributionPolicyCard";
import { ConfidenceBar, RatioPanel } from "./ConfidenceBar";
import { DetailKpiGrid } from "./DetailKpiGrid";
import { ValueBridge } from "./ValueBridge";

export function RevenueUseCaseDetail({
  detail,
  scope,
  onBack,
}: {
  detail: AiRoiUseCaseDetail;
  scope: Scope;
  onBack: () => void;
}) {
  const s = detail.summary;
  const hasRevenue =
    (s.realised_value_all ?? 0) > 0
    || detail.value_categories.some((c) => c.amount_usd > 0);

  return (
    <div className="space-y-4">
      <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={onBack}>← Revenue</button>
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-xl font-semibold text-fg">{detail.name}</h2>
        <span className="num text-sm text-fg-muted">{detail.org_unit_bk}</span>
        <span className="rounded bg-black/[0.04] px-2 py-0.5 text-xs uppercase text-fg-muted">{detail.status}</span>
      </div>
      <DetailKpiGrid summary={s} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ValueBridge useCaseId={detail.use_case_id} summary={s} scope={scope} />
        <Card title="Break-even projection">
          <div className="p-5">
            <BreakevenChart
              months={detail.breakeven?.months ?? []}
              crossover={detail.breakeven?.crossover_month}
              paybackMonths={s.simple_payback_months}
              lastActualIndex={detail.breakeven?.last_actual_index}
              bandLow={detail.breakeven?.band_low}
              bandHigh={detail.breakeven?.band_high}
            />
          </div>
        </Card>
      </div>
      <RatioPanel summary={s} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <AttributionPolicyCard policy={detail.attribution_policy} hasRevenueValue={hasRevenue} />
        <ConfidenceBar mix={s.confidence_mix ?? {}} />
      </div>
    </div>
  );
}
