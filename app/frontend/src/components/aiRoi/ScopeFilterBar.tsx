import { X } from "lucide-react";
import { CONSOLIDATED, Scope, api, type AiRoiOrgNode } from "../../api";
import { cn } from "../../lib/cn";
import { useAiRoiLoad } from "./shared";

export function isFilteredAiRoiScope(scope: Scope): boolean {
  return scope.scope_type !== "consolidated";
}

export function clearAiRoiScope(onScope?: (scope: Scope) => void) {
  onScope?.(CONSOLIDATED);
}

export function findAiRoiOrgName(nodes: AiRoiOrgNode[] | undefined, key: string): string | undefined {
  if (!nodes?.length) return undefined;
  for (const node of nodes) {
    if (node.key === key) return node.name;
    const nested = findAiRoiOrgName(node.children, key);
    if (nested) return nested;
  }
  return undefined;
}

export function aiRoiScopeLabel(scope: Scope, tree?: AiRoiOrgNode[]): string {
  if (scope.scope_type === "business_unit") {
    return findAiRoiOrgName(tree, scope.scope_id) ?? scope.scope_id;
  }
  return scope.scope_id;
}

/** Org Explorer L2 tab: when an AI ROI unit is selected, the tab carries the
 *  unit name, a light-blue tint, and a sibling clear control (not inside the tab). */
export function OrgExplorerTopic({
  pageLabel,
  active,
  scope,
  onSelect,
  onClear,
}: {
  pageLabel: string;
  active: boolean;
  scope: Scope;
  onSelect: () => void;
  onClear?: () => void;
}) {
  const filtered = isFilteredAiRoiScope(scope);
  const org = useAiRoiLoad(
    () => (filtered ? api.aiRoiOrg(CONSOLIDATED) : Promise.resolve(null)),
    [filtered, scope.scope_id, scope.scope_type],
  );
  const unit = aiRoiScopeLabel(scope, org.data?.tree);

  return (
    <div
      className="inline-flex items-center gap-0.5 my-1.5"
      data-testid="ai-roi-scope-filter"
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className={cn(
          "inline-flex items-center whitespace-nowrap transition",
          filtered
            ? "gap-1 rounded-md bg-heat-blue/50 px-2 py-1 text-[13px] font-medium text-fg dark:bg-blue-400/10"
            : cn(
              "gap-1 rounded-lg px-3 py-2 text-[13px]",
              active
                ? "bg-ink-700 text-fg ring-1 ring-line font-medium"
                : "text-fg-muted hover:text-fg hover:bg-black/[0.04]",
            ),
        )}
      >
        {pageLabel}
        {filtered && (
          <span className="text-[11px] font-normal text-fg-muted">· {unit}</span>
        )}
      </button>
      {filtered && onClear && (
        <button
          type="button"
          data-testid="ai-roi-scope-clear"
          aria-label="Clear filter"
          onClick={onClear}
          className="grid h-5 w-5 place-items-center rounded text-fg-subtle hover:text-fg"
        >
          <X className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
