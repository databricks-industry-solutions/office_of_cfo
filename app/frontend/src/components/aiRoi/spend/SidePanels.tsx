import { Scope, api } from "../../../api";
import { Card, Skeleton, SkeletonRegion, TableSkeleton } from "../../ui";
import { PairsSkeleton } from "../skeletons";
import { money, pct, useAiRoiLoad } from "../shared";
import { Delta } from "./Delta";

export function ConcentrationCard({ scope }: { scope: Scope }) {
  const q = useAiRoiLoad(() => api.aiRoiMetricsSummary(scope), [scope]);
  const v = q.data?.spend_concentration_top10 ?? null;
  return (
    <Card title="Spend concentration">
      <div data-testid="ai-roi-concentration" className="p-5">
        {!q.data && !q.error ? (
          <SkeletonRegion className="space-y-2">
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-3 w-48" />
          </SkeletonRegion>
        ) : v == null ? (
          <p className="text-sm text-fg-muted">No spend in scope.</p>
        ) : (
          <>
            <div className="text-2xl font-semibold num">{pct(v)}</div>
            <p className="mt-1 text-xs text-fg-muted">held by the ten highest-spending consumers</p>
          </>
        )}
      </div>
    </Card>
  );
}

export function AnomaliesCard({ scope }: { scope: Scope }) {
  const q = useAiRoiLoad(() => api.aiRoiAnomalies(scope), [scope]);
  const rows = (q.data?.anomalies ?? []).slice(0, 6);
  return (
    <Card title="Spend anomalies">
      <div data-testid="ai-roi-anomalies">
        {!q.data && !q.error ? (
          <SkeletonRegion><TableSkeleton rows={4} cols={4} /></SkeletonRegion>
        ) : rows.length === 0 ? (
          <p className="px-5 py-4 text-sm text-fg-muted">
            No anomalies (|z| &gt; 3 and &gt; $500/day) in scope.
          </p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {rows.map((a, i) => (
                <tr key={i} className="border-b border-line/70 last:border-0">
                  <td className="px-5 py-1.5 num text-xs text-fg-muted">{a.usage_date}</td>
                  <td className="px-2 py-1.5 font-mono text-xs">{a.org_unit_bk}</td>
                  <td className="px-2 py-1.5 text-right num">{money(a.cost_usd)}</td>
                  <td className="px-5 py-1.5 text-right text-signal-warn num">z {a.z.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

export function BudgetCard({ scope }: { scope: Scope }) {
  const q = useAiRoiLoad(() => api.aiRoiBudgets(scope), [scope]);
  const b = q.data?.budget_variance;
  if (!q.data && !q.error) {
    return (
      <Card title="Budget variance">
        <SkeletonRegion><div data-testid="ai-roi-budget"><PairsSkeleton rows={5} /></div></SkeletonRegion>
      </Card>
    );
  }
  if (!b) return null;
  return (
    <Card title="Budget variance">
      <div data-testid="ai-roi-budget" className="p-5 space-y-1.5 text-sm">
        <Line k="Budget" v={money(b.budget_usd)} />
        <Line k="Prorated to date" v={money(b.prorated_budget_usd)} />
        <Line k="Actual" v={money(b.actual_usd)} />
        <div className="flex items-center justify-between border-t border-line pt-1.5">
          <span className="text-fg-muted">Variance</span>
          <span className="flex items-center gap-2">
            <Delta value={b.variance_usd} kind="currency" />
            {b.variance_pct != null && (
              <span className="num text-xs text-fg-muted">{pct(b.variance_pct)}</span>
            )}
          </span>
        </div>
        <Line k="Forecast to period end" v={money(b.forecast_period_end_usd)} />
      </div>
    </Card>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-fg-muted">{k}</span>
      <span className="num text-fg">{v}</span>
    </div>
  );
}
