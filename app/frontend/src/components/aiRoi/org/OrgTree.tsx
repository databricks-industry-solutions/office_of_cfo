import { KeyboardEvent, useMemo, useState } from "react";
import { AiRoiOrgNode, Scope } from "../../../api";
import { Card, SkeletonRegion } from "../../ui";
import { OrgTreeRowsSkeleton } from "../skeletons";
import { cn } from "../../../lib/cn";
import { money, ratio } from "../shared";

interface Flat {
  node: AiRoiOrgNode;
  depth: number;
}

/** Root plus its direct units only. Product-line desks live on the Breakdown tile. */
function flattenRootUnits(root: AiRoiOrgNode | undefined): Flat[] {
  if (!root) return [];
  return [{ node: root, depth: 0 }, ...(root.children ?? []).map((node) => ({ node, depth: 1 }))];
}

export function OrgTreePanel({
  tree,
  loading,
  scope,
  onScope,
}: {
  tree: AiRoiOrgNode | undefined;
  loading: boolean;
  scope: Scope;
  onScope?: (scope: Scope) => void;
}) {
  const [focus, setFocus] = useState(0);
  const flat = useMemo(() => flattenRootUnits(tree), [tree]);
  const selectedKey =
    scope.scope_type === "business_unit" && scope.scope_id !== "ALL"
      ? scope.scope_id
      : tree?.key;

  const select = (key: string) => {
    if (key === "ROOT") {
      onScope?.({ scope_type: "consolidated", scope_id: "ALL" });
      return;
    }
    onScope?.({ scope_type: "business_unit", scope_id: key });
  };

  const onKey = (e: KeyboardEvent) => {
    if (!flat.length) return;
    const cur = flat[focus];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocus((f) => Math.min(flat.length - 1, f + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocus((f) => Math.max(0, f - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(cur.node.key);
    }
  };

  return (
    <Card title="Org tree — as of period end">
      {loading ? (
        <SkeletonRegion><OrgTreeRowsSkeleton /></SkeletonRegion>
      ) : (
        <div
          role="tree"
          tabIndex={0}
          onKeyDown={onKey}
          aria-label="Organisation tree"
          className="mx-2 mb-2 flex flex-col rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brick/40"
        >
          {flat.map((f, i) => {
            const sel = f.node.key === selectedKey;
            const focused = i === focus;
            // Return on Token Used is NET: break-even is 0, not 1.0.
            const belowBreakEven = f.node.run_rate_rodt != null && f.node.run_rate_rodt < 0;
            return (
              <div
                key={f.node.key}
                role="treeitem"
                aria-selected={sel}
                onClick={() => {
                  setFocus(i);
                  select(f.node.key);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-lg py-1.5 pr-2 text-sm",
                  sel ? "bg-black/[0.06]" : "hover:bg-black/[0.04]",
                  focused && "ring-1 ring-brick/40",
                )}
                style={{ paddingLeft: 8 + f.depth * 16 }}
              >
                <span className="flex-1 truncate font-medium">{f.node.name}</span>
                <span className="num text-xs text-fg-muted">{money(f.node.ai_run_cost ?? f.node.run_cost)}</span>
                <span
                  className={cn(
                    "num w-12 rounded px-1 text-right text-xs",
                    belowBreakEven ? "bg-signal-warn/15 text-signal-warn" : "text-fg-muted",
                  )}
                >
                  {ratio(f.node.run_rate_rodt ?? null)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
