import { AiRoiDimension, Scope, api } from "../../api";
import { ExecutiveBreakevenPanel } from "../../components/aiRoi/executive/BreakevenPanel";
import { ExecutiveLeagueTable } from "../../components/aiRoi/executive/LeagueTable";
import { ProfitabilityRanking } from "../../components/aiRoi/revenue/ProfitabilityRanking";
import { RevenueAttributionBlock } from "../../components/aiRoi/revenue/RevenueAttribution";
import { RevenueUseCaseDetail } from "../../components/aiRoi/revenue/RevenueDetail";
import { mergePageQuery, revenueDimensionFromQuery, useCaseFromQuery } from "../../components/aiRoi/revenue/pageQuery";
import { AiRoiPage, DataState, useAiRoiLoad } from "../../components/aiRoi/shared";
import { BREAKEVEN_ASPECT, UseCaseDetailSkeleton } from "../../components/aiRoi/skeletons";
import { CardSkeleton, ChartSkeleton, SkeletonRegion } from "../../components/ui";
import { PageId } from "../../nav";

export function AiRoiRoiPage({
  scope, hashQuery, onNavigate,
}: {
  scope: Scope; hashQuery: string;
  onNavigate: (page: PageId, query?: string) => void;
}) {
  const useCase = useCaseFromQuery(hashQuery);
  const dimension = revenueDimensionFromQuery(hashQuery, "use_case");
  const executive = useAiRoiLoad(() => api.aiRoiExecutive(scope), [scope]);
  const detail = useAiRoiLoad(
    () => (useCase ? api.aiRoiUseCase(useCase, scope) : Promise.resolve(null)),
    [useCase, scope],
  );

  const setDimension = (dim: AiRoiDimension) => {
    onNavigate("ai-roi-roi", mergePageQuery(hashQuery, { dim, useCase: null }));
  };

  const openUseCase = (id: string) => {
    onNavigate("ai-roi-roi", mergePageQuery(hashQuery, { useCase: id, dim: dimension }));
  };

  if (useCase) {
    return (
      <AiRoiPage>
        <DataState loading={!detail.data && !detail.error} error={detail.error} skeleton={<UseCaseDetailSkeleton />}>
          {detail.data && (
            <RevenueUseCaseDetail
              detail={detail.data}
              scope={scope}
              onBack={() => onNavigate("ai-roi-roi", mergePageQuery(hashQuery, { useCase: null }))}
            />
          )}
        </DataState>
      </AiRoiPage>
    );
  }

  return (
    <AiRoiPage>
      <div className="space-y-4">
        <RevenueAttributionBlock scope={scope} dimension={dimension} onDimension={setDimension} />
        <ProfitabilityRanking scope={scope} />
        <ExecutiveLeagueTable
          scope={scope}
          onNavigate={(page, query) => {
            if (page === "ai-roi-roi" && query?.startsWith("useCase=")) {
              const id = decodeURIComponent(query.slice("useCase=".length));
              openUseCase(id);
              return;
            }
            onNavigate(page, query);
          }}
        />
        {executive.data ? (
          <ExecutiveBreakevenPanel data={executive.data} scope={scope} onNavigate={onNavigate} showRoiLink={false} />
        ) : !executive.error && (
          <SkeletonRegion><CardSkeleton action><ChartSkeleton aspectRatio={BREAKEVEN_ASPECT} /></CardSkeleton></SkeletonRegion>
        )}
      </div>
    </AiRoiPage>
  );
}
