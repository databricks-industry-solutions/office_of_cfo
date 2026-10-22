import { ArrowDown } from "lucide-react";
import { useState } from "react";
import { AiRoiLeagueRow, Scope, api } from "../../../api";
import { PageId } from "../../../nav";
import { Sparkline } from "../charts";
import { DataState, money, ratio, useAiRoiLoad } from "../shared";
import { LeagueSkeleton } from "../skeletons";

const COLUMNS: {
  key: string;
  label: string;
  align: "left" | "right";
  sortable?: boolean;
  /** Header tooltip: what the column measures. */
  help?: string;
}[] = [
  { key: "name", label: "Use case", align: "left" },
  { key: "ai_run_cost", label: "Run cost", align: "right", sortable: true },
  { key: "realised_value", label: "Realised value", align: "right", sortable: true },
  { key: "run_rate_rodt", label: "Return on Token Used", align: "right", sortable: true },
  { key: "vpmt", label: "Revenue per Mtok", align: "right", sortable: true, help: "Gross realised revenue per million tokens" },
  { key: "cash_breakeven_days", label: "Break-even (days)", align: "right" },
  { key: "variance", label: "Variance (days)", align: "right" },
];

const SORT_LABELS: Record<string, string> = {
  run_rate_rodt: "Return on Token Used",
  ai_run_cost: "run cost",
  realised_value: "realised value",
  vpmt: "revenue per Mtok",
};

function rankRows(rows: AiRoiLeagueRow[]): { top: AiRoiLeagueRow[]; rest: AiRoiLeagueRow[] } {
  const ordered = [...rows].sort((a, b) => {
    const ra = a.run_rate_rodt ?? -Infinity;
    const rb = b.run_rate_rodt ?? -Infinity;
    if (rb !== ra) return rb - ra;
    return (b.realised_value ?? 0) - (a.realised_value ?? 0);
  });
  return { top: ordered.slice(0, 3), rest: ordered.slice(3) };
}

export function ExecutiveLeagueTable({
  scope,
  onNavigate,
}: {
  scope: Scope;
  onNavigate: (page: PageId, query?: string) => void;
}) {
  const [sort, setSort] = useState("run_rate_rodt");
  const result = useAiRoiLoad(() => api.aiRoiLeague(scope, sort), [scope, sort]);
  const rows = result.data?.rows ?? [];
  const { top, rest } = rankRows(rows);

  return (
    <section className="tile ring-1 ring-line" data-testid="ai-roi-league">
      <div className="px-5 py-4">
        <h2 className="text-sm font-normal text-fg">
          ROI league table — ranked by {SORT_LABELS[sort] ?? sort}
        </h2>
      </div>
      <DataState loading={!result.data && !result.error} error={result.error} empty={!!result.data && !rows.length} skeleton={<LeagueSkeleton />}>
        <div className="overflow-x-auto px-5 pb-5">
          <table className="w-full border-collapse text-sm">
            <LeagueHeader sort={sort} setSort={setSort} />
            <LeagueSection title="Top use cases" rows={top} onNavigate={onNavigate} />
            {rest.length > 0 && <LeagueSection title="Bottom use cases" rows={rest} onNavigate={onNavigate} divided />}
          </table>
        </div>
      </DataState>
    </section>
  );
}

function LeagueHeader({ sort, setSort }: { sort: string; setSort: (value: string) => void }) {
  return (
    <thead>
      <tr className="border-y border-line">
        {COLUMNS.map((column) => (
          <th
            key={column.key}
            className={`px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-fg-subtle ${
              column.align === "right" ? "text-right" : "text-left"
            }`}
            title={column.help}
          >
            {column.sortable ? (
              <button
                type="button"
                onClick={() => setSort(column.key)}
                className={`inline-flex items-center gap-1 hover:text-fg ${sort === column.key ? "text-fg" : ""}`}
              >
                {column.label}
                {sort === column.key && <ArrowDown className="h-3 w-3" />}
              </button>
            ) : column.label}
          </th>
        ))}
        <th className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Trend</th>
      </tr>
    </thead>
  );
}

function LeagueSection({
  title,
  rows,
  onNavigate,
  divided = false,
}: {
  title: string;
  rows: AiRoiLeagueRow[];
  onNavigate: (page: PageId, query?: string) => void;
  divided?: boolean;
}) {
  return (
    <tbody>
      {divided && (
        <tr aria-hidden="true">
          <td colSpan={COLUMNS.length + 1} className="h-6 border-b-2 border-line-strong p-0" />
        </tr>
      )}
      <tr>
        <th
          colSpan={COLUMNS.length + 1}
          scope="rowgroup"
          className="bg-black/[0.03] px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-fg-subtle"
        >
          {title}
        </th>
      </tr>
      {rows.map((row) => (
        <LeagueRow key={row.use_case_id} row={row} onNavigate={onNavigate} />
      ))}
    </tbody>
  );
}

function LeagueRow({
  row,
  onNavigate,
}: {
  row: AiRoiLeagueRow;
  onNavigate: (page: PageId, query?: string) => void;
}) {
  const modelled = row.confidence_mix?.modelled ?? 0;
  // Return on Token Used is NET ((value - run cost) / run cost): break-even is 0,
  // not the 1.0 that belongs to the gross profitability index.
  const belowBreakEven = row.run_rate_rodt != null && row.run_rate_rodt < 0;
  const days = row.cash_breakeven_days ?? (row.cash_breakeven_month != null ? row.cash_breakeven_month * 30 : null);
  return (
    <tr
      className="cursor-pointer border-b border-line/70 last:border-b-0 record-row-hover"
      onClick={() => onNavigate("ai-roi-roi", `useCase=${encodeURIComponent(row.use_case_id)}`)}
    >
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${modelled > 0.2 ? "bg-signal-warn" : "bg-fg-subtle/50"}`}
            title={modelled > 0.2 ? `${Math.round(modelled * 100)}% modelled value` : "Predominantly proven value"}
          />
          <span className="text-fg">{row.name}</span>
          {row.status === "sunset" && (
            <span className="rounded bg-black/[0.04] px-1.5 py-0.5 text-[10px] uppercase text-fg-muted">sunset</span>
          )}
        </div>
      </td>
      <td className="num px-3 py-2.5 text-right">{money(row.ai_run_cost)}</td>
      <td className="num px-3 py-2.5 text-right">{money(row.realised_value)}</td>
      <td className={`num px-3 py-2.5 text-right ${belowBreakEven ? "text-signal-warn" : ""}`}>{ratio(row.run_rate_rodt)}</td>
      <td className="num px-3 py-2.5 text-right">{money(row.vpmt)}</td>
      <td className="num px-3 py-2.5 text-right">{days ?? "—"}</td>
      <td className="num px-3 py-2.5 text-right">{row.variance == null ? "—" : row.variance}</td>
      <td className="px-3 py-2.5">
        <div className="flex justify-end"><Sparkline values={row.rodt_trend} /></div>
      </td>
    </tr>
  );
}
