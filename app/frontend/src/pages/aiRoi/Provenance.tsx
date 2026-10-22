import { useState } from "react";
import { api } from "../../api";
import {
  ProvenanceLimitationsCard,
  ProvenanceLineageViewer,
  ProvenanceRateCard,
  ProvenanceStatusStrip,
} from "../../components/aiRoi/provenance/ProvenancePanels";
import { AiRoiPage, DataState, useAiRoiLoad } from "../../components/aiRoi/shared";
import { ProvenanceSkeleton } from "../../components/aiRoi/skeletons";

export function AiRoiProvenancePage() {
  const { data, error } = useAiRoiLoad(() => api.aiRoiProvenance(), []);
  const [metric, setMetric] = useState("run_rate_rodt");
  const lineage = useAiRoiLoad(() => api.aiRoiProvenanceMetric(metric), [metric]);

  return (
    <AiRoiPage>
      <DataState loading={!data && !error} error={error} skeleton={<ProvenanceSkeleton />}>
        {data && (
          <div className="space-y-4">
            <ProvenanceStatusStrip data={data} loading={false} />
            <ProvenanceRateCard data={data} loading={false} />
            <ProvenanceLineageViewer
              metric={metric}
              onMetric={setMetric}
              lineage={lineage.data ?? null}
              loading={!lineage.data && !lineage.error}
            />
            <ProvenanceLimitationsCard />
          </div>
        )}
      </DataState>
    </AiRoiPage>
  );
}
