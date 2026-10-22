import { useMemo } from "react";
import { AiRoiDimension, Scope, api } from "../../../api";
import { Card } from "../../ui";
import { useOverlay } from "../../../lib/industry";
import { DataState, useAiRoiLoad } from "../shared";
import { BarListSkeleton } from "../skeletons";
import { money, pctShare } from "./format";

export function RevenueAttributionBlock({
  scope,
  dimension,
  onDimension,
}: {
  scope: Scope;
  dimension: AiRoiDimension;
  onDimension: (dim: AiRoiDimension) => void;
}) {
  const dims = useOverlay().aiRoi.revenueDimensions;
  const active = dims.find((d) => d.id === dimension) ?? dims[0];
  const breakdown = useAiRoiLoad(
    () => api.aiRoiValueBreakdown(dimension, scope),
    [dimension, scope],
  );
  const rows = breakdown.data?.rows ?? [];
  const maxValue = useMemo(
    () => Math.max(...rows.map((r) => r.value), 0, 1),
    [rows],
  );

  return (
    <div>
      <Card
        title={`Attributed revenue by ${active?.label.toLowerCase() ?? dimension}`}
        action={
          <div role="tablist" aria-label="Attribution dimension"
            className="inline-flex gap-0.5 rounded-xl bg-black/[0.04] p-0.5">
            {dims.map((d) => (
              <button
                key={d.id}
                type="button"
                role="tab"
                aria-selected={d.id === dimension}
                onClick={() => onDimension(d.id as AiRoiDimension)}
                className={`rounded-lg px-2.5 py-1 text-xs transition ${
                  d.id === dimension ? "bg-white text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        }
      >
        <DataState loading={!breakdown.data && !breakdown.error}
          error={breakdown.error} empty={!!breakdown.data && !rows.length}
          skeleton={<BarListSkeleton />}>
          <div data-testid="ai-roi-attribution" className="p-5">
            <ul className="flex flex-col gap-2.5">
              {rows.map((r) => (
                <li key={r.key}
                  className="grid grid-cols-[minmax(9rem,15rem)_1fr_auto] items-center gap-3">
                  <span className="truncate text-sm font-medium" title={r.label}>{r.label}</span>
                  <div className="relative h-5 rounded bg-black/[0.04]">
                    <div
                      className="absolute inset-y-0 left-0 rounded-r bg-brick/80"
                      style={{ width: `${Math.max(0, Math.min(1, r.value / maxValue)) * 100}%` }}
                    />
                  </div>
                  <span className="flex items-baseline gap-3 justify-end">
                    <span className="num w-20 text-right text-sm">{money(r.value)}</span>
                    <span className="num w-12 text-right text-xs text-fg-muted">{pctShare(r.share)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </DataState>
      </Card>
    </div>
  );
}
