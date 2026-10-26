import { useState } from "react";
import { Scope, api } from "../../api";
import { AiRoiPage, DataState, useAiRoiLoad } from "../../components/aiRoi/shared";
import { SpendSkeleton } from "../../components/aiRoi/skeletons";
import { BreakdownTable } from "../../components/aiRoi/spend/BreakdownTable";
import { GatewayTelemetryPanel } from "../../components/aiRoi/spend/GatewayTelemetry";
import { InvocationsTable } from "../../components/aiRoi/spend/InvocationsTable";
import { SpendTrend } from "../../components/aiRoi/spend/SpendTrend";
import { AnomaliesCard, BudgetCard, ConcentrationCard } from "../../components/aiRoi/spend/SidePanels";
import { SpendGroupBy } from "../../components/aiRoi/spend/format";

export function AiRoiSpendPage({
  scope,
  onScope,
}: {
  scope: Scope;
  onScope?: (scope: Scope) => void;
}) {
  const [groupBy, setGroupBy] = useState<SpendGroupBy>("use_case");
  const summary = useAiRoiLoad(() => api.aiRoiMetricsSummary(scope), [scope]);

  return (
    <AiRoiPage>
      <DataState loading={!summary.data && !summary.error} error={summary.error} skeleton={<SpendSkeleton />}>
        {summary.data && (
          <div className="space-y-4">
            <SpendTrend scope={scope} groupBy={groupBy} onGroupBy={setGroupBy} />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <BreakdownTable scope={scope} groupBy={groupBy} onScope={onScope} />
              </div>
              <div className="flex flex-col gap-4">
                <ConcentrationCard scope={scope} />
                <BudgetCard scope={scope} />
              </div>
            </div>
            <AnomaliesCard scope={scope} />
            <InvocationsTable scope={scope} />
            <GatewayTelemetryPanel />
          </div>
        )}
      </DataState>
    </AiRoiPage>
  );
}
