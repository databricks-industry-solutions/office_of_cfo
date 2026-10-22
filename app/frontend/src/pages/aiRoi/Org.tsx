import { AiRoiOrgNode, CONSOLIDATED, Scope, api } from "../../api";
import { OrgNodeDetail } from "../../components/aiRoi/org/NodeDetail";
import { OrgTreePanel } from "../../components/aiRoi/org/OrgTree";
import { AiRoiPage, DataState, useAiRoiLoad } from "../../components/aiRoi/shared";
import { OrgSkeleton } from "../../components/aiRoi/skeletons";

function unitLabel(tree: AiRoiOrgNode | undefined, scope: Scope): string | undefined {
  if (!tree) return undefined;
  if (scope.scope_type !== "business_unit" || !scope.scope_id || scope.scope_id === "ALL") {
    return tree.name;
  }
  return tree.children?.find((c) => c.key === scope.scope_id)?.name ?? tree.name;
}

export function AiRoiOrgPage({ scope, onScope }: { scope: Scope; onScope?: (scope: Scope) => void }) {
  const { data, error } = useAiRoiLoad(() => api.aiRoiOrg(CONSOLIDATED), []);
  const root = data?.tree[0];

  return (
    <AiRoiPage>
      <DataState loading={!data && !error} error={error} empty={!!data && !data.tree.length} skeleton={<OrgSkeleton />}>
        {data && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(300px,380px)_1fr]">
            <OrgTreePanel tree={root} loading={false} scope={scope} onScope={onScope} />
            <OrgNodeDetail scope={scope} unitLabel={unitLabel(root, scope)} />
          </div>
        )}
      </DataState>
    </AiRoiPage>
  );
}
