import { AlertCircle } from "lucide-react";
import { AiRoiProvenance } from "../../../api";
import { Card, Pill, SkeletonRegion, TableSkeleton } from "../../ui";
import { PairsSkeleton } from "../skeletons";
import { pct } from "../shared";
import { money, pctShare } from "../revenue/format";
import { AI_ROI_LIMITATIONS, AI_ROI_LIMITATIONS_TITLE } from "./limitations";

export function ProvenanceStatusStrip({ data, loading }: { data: AiRoiProvenance | null; loading: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card title="Active provider">
        {loading || !data ? (
          <SkeletonRegion><PairsSkeleton rows={3} /></SkeletonRegion>
        ) : (
          <div className="flex flex-col gap-2 p-5 text-sm">
            <Row k="Provider" v={data.provider} />
            <Row k="Freshness" v={data.freshness.max_event_time?.slice(0, 10) ?? data.freshness.max_event_date?.slice(0, 10) ?? "—"} />
            <Row k="Degraded" v={data.freshness.degraded ? "yes" : "no"} />
            <div className="flex flex-wrap gap-1 pt-1">
              {(data.capabilities ?? []).map((c) => (
                <Pill key={c} value={c} />
              ))}
            </div>
          </div>
        )}
      </Card>
      <Card title="Tagging coverage">
        {loading || !data ? (
          <SkeletonRegion><PairsSkeleton rows={3} /></SkeletonRegion>
        ) : (
          <div className="p-5">
            <div className="num text-3xl font-semibold">{pctShare(data.tagging_coverage ?? 0)}</div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-black/[0.06]">
              <div className="h-full rounded-full bg-brick" style={{ width: `${(data.tagging_coverage ?? 0) * 100}%` }} />
            </div>
            <p className="mt-2 text-xs text-fg-muted">
              Unattributed spend{" "}
              <span className="num text-signal-warn">{money(data.unattributed_cost ?? 0)}</span> — quarantined, never
              allocated pro rata.
            </p>
          </div>
        )}
      </Card>
      <Card title="Hierarchy version">
        {loading || !data ? (
          <SkeletonRegion><PairsSkeleton rows={3} /></SkeletonRegion>
        ) : (
          <div className="flex flex-col gap-2 p-5 text-sm">
            <Row k="As of" v={data.hierarchy_as_of?.slice(0, 10) ?? "—"} />
            <Row k="Resolution" v="period end, non-restating" />
            <div className="pt-1">
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1">Reorganised in period</div>
              {(data.reorganised_units ?? []).length === 0 ? (
                <span className="text-xs text-fg-muted">none</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {(data.reorganised_units ?? []).map((u) => (
                    <span key={String(u)} className="rounded bg-signal-warn/15 px-1.5 py-0.5 font-mono text-[10px] text-signal-warn">
                      {typeof u === "string" ? u : u.org_unit_bk}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

export function ProvenanceRateCard({ data, loading }: { data: AiRoiProvenance | null; loading: boolean }) {
  return (
    <Card title={`Cost model · ${data?.cost_model_version ?? ""}`}>
      {loading || !data ? (
        <SkeletonRegion><TableSkeleton rows={5} cols={4} /></SkeletonRegion>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-line text-xs text-fg-subtle">
              {["Model", "Provider", "$/Mtok in", "$/Mtok out", "$/Mtok cached"].map((h, i) => (
                <th key={h} className={`px-3 py-2 font-medium ${i > 1 ? "text-right" : "text-left"}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data.rate_card ?? []).map((r) => (
              <tr key={r.model_id} className="border-b border-line/60">
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2 text-fg-muted">{r.provider}</td>
                <td className="px-3 py-2 text-right num">{money(r.price_in_per_mtok ?? r.price_input_per_mtok)}</td>
                <td className="px-3 py-2 text-right num">{money(r.price_out_per_mtok ?? r.price_output_per_mtok)}</td>
                <td className="px-3 py-2 text-right num">{money(r.price_cached_in_per_mtok ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-fg-muted">{k}</span>
      <span className="capitalize text-fg">{v}</span>
    </div>
  );
}

export const LINEAGE_METRICS = [
  "ai_run_cost",
  "realised_value",
  "net_run_rate_value",
  "run_rate_rodt",
  "programme_rodt",
  "cash_breakeven_month",
  "simple_payback_months",
  "cache_saving_usd",
  "retry_waste_usd",
  "tagging_coverage",
];

export function ProvenanceLineageViewer({
  metric,
  onMetric,
  lineage,
  loading,
}: {
  metric: string;
  onMetric: (id: string) => void;
  lineage: {
    label: string;
    formula: string;
    unit: string;
    inputs: string[];
    row_count: number;
    confidence_mix: Record<string, number> | string;
  } | null;
  loading: boolean;
}) {
  const mix =
    lineage && typeof lineage.confidence_mix === "object" ? lineage.confidence_mix : {};
  return (
    <Card title="Lineage viewer — where a number comes from">
      <div data-testid="ai-roi-lineage" className="space-y-3 p-5">
        <select
          className="h-8 rounded-lg border border-line bg-transparent px-2 text-sm"
          value={metric}
          onChange={(e) => onMetric(e.target.value)}
          aria-label="Metric lineage selector"
        >
          {LINEAGE_METRICS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {loading || !lineage ? (
          <SkeletonRegion><TableSkeleton rows={4} cols={3} /></SkeletonRegion>
        ) : (
          <>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Formula</div>
              <p className="text-sm">{lineage.formula}</p>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Inputs</div>
                <div className="flex flex-col gap-0.5">
                  {lineage.inputs.map((i) => (
                    <span key={i} className="font-mono text-xs">
                      {i}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Rows fed</div>
                <span className="num text-lg font-semibold">{lineage.row_count.toLocaleString()}</span>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Confidence mix</div>
                {Object.keys(mix).length === 0 ? (
                  <span className="text-xs text-fg-muted">100% metered</span>
                ) : (
                  <div className="flex flex-col gap-0.5 text-xs">
                    {Object.entries(mix)
                      .filter(([, v]) => v > 0)
                      .map(([k, v]) => (
                        <span key={k} className="capitalize">
                          {k} <span className="num text-fg-muted">{pct(v)}</span>
                        </span>
                      ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

export function ProvenanceLimitationsCard() {
  return (
    <Card>
      <div data-testid="ai-roi-limitations" className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <AlertCircle size={16} className="shrink-0 text-fg-muted" />
          <h3 className="text-sm font-semibold">{AI_ROI_LIMITATIONS_TITLE}</h3>
        </div>
        <div className="flex flex-col gap-3 text-sm">
          {AI_ROI_LIMITATIONS.map((item) => (
            <Section key={item.id} title={item.title} body={item.body} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <p className="font-medium text-fg">{title}</p>
      <p className="mt-1 text-xs text-fg-muted">{body}</p>
    </div>
  );
}
