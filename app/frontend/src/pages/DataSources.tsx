import { useEffect, useMemo, useState } from "react";
import { api, LineageGraph, LineageRecordsPage, OrgTree, Scope } from "../api";
import { Card, ErrorNote, TableSkeleton } from "../components/ui";
import DataLineageSankey, { LineageLegend } from "../components/DataLineageSankey";
import LineageRecordsTable from "../components/LineageRecordsTable";
import { LineageSelection, queryFromSelection, selectionLabel, LINEAGE_STATUS_COLOR } from "../lib/lineageGraph";

function resolveScope(scope: Scope | undefined, org: OrgTree | null): { regions: string[] | null; label: string } {
  if (!scope || scope.scope_type === "consolidated" || scope.scope_type === "business_line") {
    return { regions: null, label: "" };
  }
  const units = org?.units ?? [];
  if (scope.scope_type === "region") return { regions: [scope.scope_id], label: scope.scope_id };
  if (scope.scope_type === "legal_entity") {
    const hit = units.filter((u) => u.legal_entity_id === scope.scope_id);
    return { regions: [...new Set(hit.map((u) => u.region))], label: hit[0]?.legal_entity_name ?? scope.scope_id };
  }
  if (scope.scope_type === "business_unit") {
    const hit = units.filter((u) => u.business_unit_id === scope.scope_id);
    return { regions: [...new Set(hit.map((u) => u.region))], label: hit[0]?.business_unit_name ?? scope.scope_id };
  }
  return { regions: null, label: "" };
}

function SummaryTiles({ summary }: { summary: LineageGraph["summary"] | undefined }) {
  const tiles: { label: string; value: string; accent: string }[] = [
    { label: "Total", value: (summary?.total ?? 0).toLocaleString(), accent: "#3179C9" },
    { label: "Successful", value: (summary?.success ?? 0).toLocaleString(), accent: LINEAGE_STATUS_COLOR.success },
    { label: "Warnings", value: (summary?.warning ?? 0).toLocaleString(), accent: LINEAGE_STATUS_COLOR.warning },
    { label: "Errors", value: (summary?.error ?? 0).toLocaleString(), accent: LINEAGE_STATUS_COLOR.error },
    { label: "Last ingestion", value: fmtTs(summary?.last_ingestion), accent: "#7C6FE0" },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {tiles.map((t) => (
        <div key={t.label} className="tile relative overflow-hidden ring-1 ring-line px-4 py-3">
          <div className="absolute inset-y-0 left-0 w-[3px]" style={{ background: t.accent }} />
          <div className="pointer-events-none absolute -right-5 -top-6 h-20 w-20 rounded-full blur-2xl opacity-40"
               style={{ background: t.accent }} />
          <div className="relative">
            <div className="text-[11px] uppercase tracking-wide text-fg-subtle flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: t.accent }} />
              {t.label}
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-fg">{t.value}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function fmtTs(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function DataSources({ scope, org, refreshKey }: { scope?: Scope; org?: OrgTree | null; refreshKey: number }) {
  const [graph, setGraph] = useState<LineageGraph | null>(null);
  const [records, setRecords] = useState<LineageRecordsPage | null>(null);
  const [loadingGraph, setLoadingGraph] = useState(true);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<LineageSelection>({ kind: "all" });
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const { regions: scopeRegions, label: scopeLabel } = useMemo(
    () => resolveScope(scope, org ?? null), [scope, org]);

  useEffect(() => {
    let cancelled = false;
    setLoadingGraph(true);
    api.lineageQuality(scope)
      .then((d) => { if (!cancelled) { setGraph(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e?.message || "Couldn’t load lineage."); })
      .finally(() => { if (!cancelled) setLoadingGraph(false); });
    return () => { cancelled = true; };
  }, [refreshKey, scope]);

  useEffect(() => { setOffset(0); }, [selection, statusFilter, search, refreshKey, scope]);

  useEffect(() => {
    let cancelled = false;
    setLoadingRecords(true);
    const extra = queryFromSelection(selection, {
      status: statusFilter,
      search: search || undefined,
      offset: String(offset),
      limit: "50",
    });
    api.lineageQualityRecords(scope, extra)
      .then((d) => { if (!cancelled) { setRecords(d); } })
      .catch((e) => { if (!cancelled) setError(e?.message || "Couldn’t load records."); })
      .finally(() => { if (!cancelled) setLoadingRecords(false); });
    return () => { cancelled = true; };
  }, [refreshKey, scope, selection, statusFilter, search, offset]);

  const summary = graph?.summary;
  const names: Record<string, string> = {};
  for (const f of graph?.flows ?? []) names[f.flow_id] = `${f.source_system} → ${f.domain}`;
  for (const n of graph?.nodes ?? []) names[n.id] = n.name;
  const highlightFlowIds = search.trim()
    ? (records?.matched_flow_ids ?? [...new Set((records?.records ?? []).map((r) => r.flow_id))])
    : null;

  return (
    <div className="space-y-6">
      {error && <ErrorNote message={error} />}
      {graph?.partial && (
        <ErrorNote message="Some governed feeds could not be read. Unavailable bands are shown in gray — this is not a clean close." />
      )}

      <SummaryTiles summary={summary} />

      <Card
        title="Lineage & data quality"
        action={
          <div className="text-xs text-fg-muted tabular-nums">
            {(graph?.systems.length ?? 0)} systems · {(graph?.flows.length ?? 0)} flows
          </div>
        }
      >
        {loadingGraph ? (
          <div className="px-5 py-10"><TableSkeleton rows={6} cols={4} /></div>
        ) : graph ? (
          <>
            <div className="px-5 pt-4 pb-1">
              <DataLineageSankey graph={graph} selection={selection}
                highlightFlowIds={highlightFlowIds}
                onSelect={(s) => {
                setSelection(s);
                if (s.kind === "link") setStatusFilter(s.status);
                else setStatusFilter("");
              }} />
            </div>
            <div className="px-5 py-3 border-t border-line flex flex-wrap items-center justify-between gap-2">
              <LineageLegend />
              {scopeRegions !== null && scopeLabel && (
                <span className="text-xs text-fg-subtle">
                  Records scoped to <span className="text-fg-muted font-medium">{scopeLabel}</span>.
                </span>
              )}
            </div>
          </>
        ) : null}
      </Card>

      <Card>
        <LineageRecordsTable
          page={records}
          loading={loadingRecords}
          statusFilter={statusFilter}
          onStatusFilter={setStatusFilter}
          onPage={setOffset}
          selectionTitle={selectionLabel(selection, names)}
          search={search}
          onSearch={setSearch}
          onClearSelection={selection.kind !== "all"
            ? () => { setSelection({ kind: "all" }); setStatusFilter(""); }
            : undefined}
        />
      </Card>
    </div>
  );
}
