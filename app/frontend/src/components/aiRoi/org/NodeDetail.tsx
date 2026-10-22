import { useEffect, useState } from "react";
import { Scope, api } from "../../../api";
import { Card, ChartSkeleton, SkeletonRegion, TableSkeleton } from "../../ui";
import { StatRowSkeleton } from "../skeletons";
import { cn } from "../../../lib/cn";
import { TrendLine } from "../charts";
import { money, ratio, useAiRoiLoad } from "../shared";

function Stat({ label, value, format }: { label: string; value: number | null | undefined; format: "money" | "ratio" | "months" }) {
  const display =
    value == null ? "—" : format === "money" ? money(value) : format === "ratio" ? ratio(value) : `${value} mo`;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-fg-subtle">{label}</span>
      <span className="num text-lg font-semibold text-fg">{display}</span>
    </div>
  );
}

function RankCard({
  title,
  rows,
  loading,
  highlight,
  onHighlight,
}: {
  title: string;
  rows?: { key: string; label: string; value: number }[];
  loading: boolean;
  highlight: string | null;
  onHighlight: (key: string | null) => void;
}) {
  return (
    <Card title={title}>
      {loading ? (
        <SkeletonRegion><TableSkeleton rows={6} cols={2} /></SkeletonRegion>
      ) : (rows?.length ?? 0) === 0 ? (
        <p className="px-5 py-4 text-sm text-fg-muted">None in scope.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows!.slice(0, 8).map((r) => {
              const active = highlight == null || highlight === r.key;
              return (
                <tr
                  key={r.key}
                  className={cn(
                    "cursor-pointer border-b border-line/60 last:border-0 record-row-hover",
                    !active && "opacity-40",
                    highlight === r.key && "bg-black/[0.04]",
                  )}
                  onClick={() => onHighlight(highlight === r.key ? null : r.key)}
                >
                  <td className="px-5 py-1.5">{r.label}</td>
                  <td className="px-5 py-1.5 text-right num">{money(r.value)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function OrgNodeDetail({ scope, unitLabel }: { scope: Scope; unitLabel?: string }) {
  const { data, error, loading: fetching } = useAiRoiLoad(
    () => api.aiRoiOrgDetail(scope),
    [scope.scope_type, scope.scope_id],
    { keepPrevious: true },
  );
  const initial = !data && !error;
  const summary = data?.summary;
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => { setHighlight(null); }, [scope.scope_id, scope.scope_type]);
  const trendRows = (data?.spend_trend ?? []).map((row) => ({
    period: row.period ?? "",
    key: row.key || row.group || "Total",
    label: row.group || "Total",
    value: row.run_cost,
  }));

  return (
    <div className="flex flex-col gap-4" aria-busy={fetching}>
      <Card title={data?.scope_label ?? "Selected unit"}>
        {initial || !summary ? (
          <SkeletonRegion><StatRowSkeleton /></SkeletonRegion>
        ) : (
          <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
              <Stat label="Run cost" value={summary.ai_run_cost ?? summary.run_cost} format="money" />
              <Stat label="Realised value" value={summary.realised_value} format="money" />
              <Stat label="Run-rate Return on Token Used" value={summary.run_rate_rodt} format="ratio" />
            <Stat label="Break-even" value={summary.cash_breakeven_month} format="months" />
          </div>
        )}
      </Card>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <RankCard
          title={`Breakdown - ${unitLabel || data?.scope_label || "selected unit"}`}
          rows={data?.children}
          loading={fetching}
          highlight={highlight}
          onHighlight={setHighlight}
        />
        <Card title="Trend MoM">
          {fetching ? (
            <SkeletonRegion><ChartSkeleton height={180} /></SkeletonRegion>
          ) : trendRows.length === 0 ? (
            <p className="px-5 py-4 text-sm text-fg-muted">No monthly trend in scope.</p>
          ) : (
            <div className="p-5">
              <TrendLine rows={trendRows} highlight={highlight} onHighlight={setHighlight} />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
