import { Scope, api } from "../../api";
import { ExecutiveBreakevenPanel } from "../../components/aiRoi/executive/BreakevenPanel";
import { ExecutiveKpiGrid } from "../../components/aiRoi/executive/KpiGrid";
import { ExecutiveLeagueTable } from "../../components/aiRoi/executive/LeagueTable";
import { ExecutiveWhatChanged } from "../../components/aiRoi/executive/WhatChanged";
import { AiRoiPage, DataState, useAiRoiLoad } from "../../components/aiRoi/shared";
import { ExecutiveSkeleton } from "../../components/aiRoi/skeletons";
import { PageId } from "../../nav";

export function AiRoiExecutivePage({
  scope,
  onNavigate,
}: {
  scope: Scope;
  onNavigate: (page: PageId, query?: string) => void;
}) {
  const result = useAiRoiLoad(() => api.aiRoiExecutive(scope), [scope]);
  const d = result.data;
  const s = d?.summary;

  return (
    <AiRoiPage>
      <DataState loading={!d && !result.error} error={result.error} empty={!!d && !s} skeleton={<ExecutiveSkeleton />}>
        {d && s && <div className="flex flex-col gap-4">
          <ExecutiveKpiGrid summary={s} onNavigate={onNavigate} />
          <ExecutiveLeagueTable scope={scope} onNavigate={onNavigate} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ExecutiveBreakevenPanel data={d} scope={scope} onNavigate={onNavigate} />
            <ExecutiveWhatChanged rows={d.what_changed ?? []} />
          </div>
        </div>}
      </DataState>
    </AiRoiPage>
  );
}
