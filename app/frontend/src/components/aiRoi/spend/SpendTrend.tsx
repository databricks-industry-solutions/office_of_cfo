import { useState } from "react";
import { Scope, api } from "../../../api";
import { cn } from "../../../lib/cn";
import { Card, ChartSkeleton, SkeletonRegion } from "../../ui";
import { GroupedBar } from "../charts";
import { useAiRoiLoad } from "../shared";
import { SPEND_GROUP_OPTIONS, SpendGroupBy, prettifyTrendGroup } from "./format";

export function SpendTrend({ scope, groupBy, onGroupBy }: {
  scope: Scope;
  groupBy: SpendGroupBy;
  onGroupBy: (value: SpendGroupBy) => void;
}) {
  const [chartAsTable, setChartAsTable] = useState(false);
  const trend = useAiRoiLoad(
    () => api.aiRoiTimeseries(groupBy, scope), // same group_by as breakdown table
    [groupBy, scope],
  );
  const rows = (trend.data?.series ?? []).map((r) => ({
    period: r.period,
    group: r.group ?? prettifyTrendGroup(r.period),
    value: r.value,
  }));

  return (
    <Card title="AI run cost over time" action={
      <div className="inline-flex overflow-hidden rounded-lg ring-1 ring-line" role="tablist" aria-label="Group spend trend by">
        {SPEND_GROUP_OPTIONS.map((g) => (
          <button
            key={g.value}
            type="button"
            role="tab"
            aria-selected={groupBy === g.value}
            onClick={() => onGroupBy(g.value)}
            className={cn(
              "h-7 px-2.5 text-xs transition",
              groupBy === g.value
                ? "bg-brick text-white"
                : "bg-white text-fg-muted hover:bg-black/[0.04] dark:bg-ink-600 dark:text-fg dark:hover:bg-ink-500",
            )}
          >
            {g.label}
          </button>
        ))}
      </div>
    }>
      {!trend.data && !trend.error ? (
        <SkeletonRegion><ChartSkeleton height={240} /></SkeletonRegion>
      ) : (
      <div data-testid="ai-roi-spend-trend" className="p-5">
        <button
          type="button"
          className="mb-2 text-xs text-fg-muted underline-offset-2 hover:underline"
          onClick={() => setChartAsTable((v) => !v)}
          aria-pressed={chartAsTable}
        >
          {chartAsTable ? "Show chart" : "Show table"}
        </button>
        <GroupedBar
          asTable={chartAsTable}
          rows={rows}
        />
      </div>
      )}
    </Card>
  );
}
