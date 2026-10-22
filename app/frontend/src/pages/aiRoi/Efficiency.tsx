import { useMemo, useState } from "react";
import { Scope, api } from "../../api";
import {
  BlendedCostChart,
  findMigrationMarker,
  ModelEconomicsTable,
  WasteSavingsPanel,
} from "../../components/aiRoi/efficiency/EfficiencyPanels";
import { SubstitutionSimulator } from "../../components/aiRoi/efficiency/SubstitutionSimulator";
import { AiRoiPage, DataState, useAiRoiLoad } from "../../components/aiRoi/shared";
import { EfficiencySkeleton } from "../../components/aiRoi/skeletons";
import { Card } from "../../components/ui";

const BLENDED_COST_HELP =
  "Unit-cost trend: what you paid, on average, for one million tokens of AI usage each month. Heavy use of a cheap model pulls the line down; a mix shift toward a frontier model pulls it up.";

function ChartInfo({ text }: { text: string }) {
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label="About this chart"
        aria-describedby="blended-cost-help"
        className="peer inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full ring-1 ring-line text-[11px] font-semibold text-fg-muted hover:bg-black/[0.04]"
      >
        i
      </button>
      <span
        id="blended-cost-help"
        role="tooltip"
        className="pointer-events-none invisible absolute left-0 top-7 z-20 w-72 rounded-xl bg-ink-800 p-3 text-left text-sm font-normal leading-snug text-fg opacity-0 shadow-depth ring-1 ring-line transition-opacity peer-hover:visible peer-hover:opacity-100 peer-focus-visible:visible peer-focus-visible:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

export function AiRoiEfficiencyPage({ scope }: { scope: Scope }) {
  const { data, error } = useAiRoiLoad(() => api.aiRoiEfficiency(scope), [scope]);
  const pts = data?.trend ?? [];
  const migration = useMemo(() => findMigrationMarker(pts), [pts]);
  const [tableView, setTableView] = useState(false);

  return (
    <AiRoiPage>
      <DataState loading={!data && !error} error={error} empty={!!data && !data.models.length} skeleton={<EfficiencySkeleton />}>
        {data && (
          <div className="space-y-4">
            <Card
              title={
                <span className="inline-flex items-center gap-2">
                  Blended cost per Mtok
                  <ChartInfo text={BLENDED_COST_HELP} />
                </span>
              }
              action={
                <button
                  type="button"
                  aria-pressed={tableView}
                  onClick={() => setTableView((open) => !open)}
                  className="text-sm text-fg-muted hover:text-fg hover:underline"
                >
                  {tableView ? "Chart view" : "Table view"}
                </button>
              }
            >
              <BlendedCostChart pts={pts} migration={migration} asTable={tableView} />
            </Card>
            <SubstitutionSimulator models={data.models} />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Card title="Per-model unit economics">
                  <ModelEconomicsTable models={data.models} />
                </Card>
              </div>
              <Card title="Waste & savings">
                <WasteSavingsPanel waste={data.waste} />
              </Card>
            </div>
          </div>
        )}
      </DataState>
    </AiRoiPage>
  );
}
