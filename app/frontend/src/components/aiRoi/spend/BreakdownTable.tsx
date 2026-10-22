import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Scope, api } from "../../../api";
import { cn } from "../../../lib/cn";
import { Card, SkeletonRegion, TableSkeleton } from "../../ui";
import { useAiRoiLoad } from "../shared";
import { Delta } from "./Delta";
import { SpendGroupBy, spendGroupLabel } from "./format";
import { money } from "../shared";

const SCOPE_DIMS = new Map<string, (key: string) => Scope>([
  ["org_unit", (key) => ({ scope_type: "business_unit", scope_id: key })],
  ["use_case", (key) => ({ scope_type: "use_case", scope_id: key })],
]);

function classLabel(value?: string | null) {
  if (value === "frontier") return "Frontier";
  if (value === "open_weights") return "Open weights";
  return value ?? "—";
}

export function BreakdownTable({ scope, groupBy, onScope }: {
  scope: Scope;
  groupBy: SpendGroupBy;
  onScope?: (scope: Scope) => void;
}) {
  const q = useAiRoiLoad(() => api.aiRoiBreakdown(groupBy, scope), [groupBy, scope]);
  const pushable = SCOPE_DIMS.get(groupBy);
  const [classFilter, setClassFilter] = useState<"all" | "frontier" | "open_weights">("all");
  const rows = useMemo(() => {
    const all = q.data?.rows ?? [];
    if (groupBy !== "model" || classFilter === "all") return all;
    return all.filter((r) => (r as { model_class?: string }).model_class === classFilter);
  }, [q.data, groupBy, classFilter]);

  const prefetch = (key: string) => {
    if (!pushable || key === "«unattributed»") return;
    void api.aiRoiMetricsSummary(pushable(key));
  };

  return (
    <Card
      title={`Breakdown by ${spendGroupLabel(groupBy).toLowerCase()}`}
      action={groupBy === "model" ? (
        <select
          value={classFilter}
          onChange={(e) => setClassFilter(e.target.value as typeof classFilter)}
          className="h-7 rounded-lg border border-line bg-transparent px-2 text-xs"
          aria-label="Filter by model class"
        >
          <option value="all">All classes</option>
          <option value="frontier">Frontier</option>
          <option value="open_weights">Open weights</option>
        </select>
      ) : undefined}
    >
      <div data-testid="ai-roi-spend-breakdown" className="overflow-x-auto">
        {!q.data && !q.error ? (
          <SkeletonRegion><TableSkeleton rows={7} cols={4} /></SkeletonRegion>
        ) : q.data && rows.length === 0 ? (
          <p className="px-5 py-4 text-sm text-fg-muted">No spend in this scope.</p>
        ) : (
          <table className="w-full border-collapse text-sm min-w-[36rem]">
            <thead>
              <tr className="border-y border-line text-xs text-fg-subtle">
                <th className="px-4 py-2 text-left font-medium">{spendGroupLabel(groupBy)}</th>
                <th className="px-3 py-2 text-right font-medium">Run cost</th>
                <th className="px-3 py-2 text-right font-medium">MoM</th>
                {groupBy === "model" && <th className="px-3 py-2 text-left font-medium">Class</th>}
                <th className="px-3 py-2 text-left font-medium">Share</th>
                {pushable && <th className="w-8" aria-hidden="true" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const canPush = pushable && r.key !== "«unattributed»";
                return (
                  <tr
                    key={r.key}
                    onMouseEnter={() => prefetch(r.key)}
                    onClick={() => canPush && onScope?.(pushable!(r.key))}
                    className={cn(
                      "border-b border-line/70",
                      canPush && "cursor-pointer record-row-hover",
                    )}
                  >
                    <td className="px-4 py-2">
                      <span className={r.key === "«unattributed»" ? "text-signal-warn" : "font-medium"}>
                        {r.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right num">{money(r.value)}</td>
                    <td className="px-3 py-2 text-right"><Delta value={r.delta} kind="currency" /></td>
                    {groupBy === "model" && (
                      <td className="px-3 py-2 text-xs text-fg-muted">{classLabel((r as { model_class?: string }).model_class)}</td>
                    )}
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-black/[0.06]">
                          <div
                            className="h-full rounded-full bg-brick"
                            style={{ width: `${Math.max(2, Math.round(r.share * 100))}%` }}
                          />
                        </div>
                        <span className="num w-9 text-xs text-fg-subtle">{Math.round(r.share * 100)}%</span>
                      </div>
                    </td>
                    {pushable && (
                      <td className="pr-3 text-right">
                        {canPush && <ChevronRight size={14} className="inline text-fg-muted" aria-hidden="true" />}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}
