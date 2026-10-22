import { ReactNode, useState } from "react";
import { LineageRecord, LineageRecordsPage, LineageRecordStatus, fmt } from "../api";
import { aiRecommendation, LINEAGE_STATUS_COLOR, LINEAGE_STATUS_LABEL } from "../lib/lineageGraph";
import { Pill, TableSkeleton } from "./ui";

const TABS: { id: "" | LineageRecordStatus; label: string }[] = [
  { id: "", label: "All" },
  { id: "success", label: "Successful" },
  { id: "warning", label: "Warnings" },
  { id: "error", label: "Errors" },
];

function fmtTs(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function LineageRecordsTable({
  page, loading, statusFilter, onStatusFilter, onPage, selectionTitle,
  search, onSearch, onClearSelection,
}: {
  page: LineageRecordsPage | null;
  loading: boolean;
  statusFilter: string;
  onStatusFilter: (s: string) => void;
  onPage: (offset: number) => void;
  selectionTitle: string;
  search: string;
  onSearch: (q: string) => void;
  onClearSelection?: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const totals = page?.totals;
  const limit = page?.limit ?? 50;
  const offset = page?.offset ?? 0;
  const total = page?.total ?? 0;

  return (
    <div>
      <div className="px-5 py-3 border-b border-line flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <div className="text-sm font-semibold text-fg truncate">{selectionTitle}</div>
            {onClearSelection && (
              <button type="button" onClick={onClearSelection}
                      className="shrink-0 text-xs text-fg-muted underline">Clear selection</button>
            )}
          </div>
          <div className="text-xs text-fg-muted mt-0.5">
            {totals
              ? `${totals.total.toLocaleString()} records · ${totals.success.toLocaleString()} successful · ${totals.warning.toLocaleString()} warnings · ${totals.error.toLocaleString()} errors`
              : "Select a flow in the Sankey to inspect records."}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input value={search} onChange={(e) => onSearch(e.target.value)}
                 placeholder="Search records…"
                 aria-label="Search record, rule, or entity"
                 className="w-44 focus:w-56 text-xs rounded-lg ring-1 ring-line bg-ink-800 px-2.5 py-1 text-fg placeholder:text-fg-subtle transition-[width] duration-150" />
          <div className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button key={t.id || "all"} type="button"
                    onClick={() => onStatusFilter(t.id)}
                    className={`text-xs px-2.5 py-1 rounded-full ring-1 transition ${
                      statusFilter === t.id
                        ? t.id === "error"
                          ? "bg-signal-bad text-white ring-signal-bad"
                          : "bg-accent text-white ring-accent"
                        : "bg-black/[0.04] text-fg-muted ring-line hover:ring-line-strong"
                    }`}>
              {t.label}
              {totals && (
                <span className="ml-1 tabular-nums opacity-80">
                  {t.id === "" ? totals.total : (totals[t.id] ?? 0)}
                </span>
              )}
            </button>
          ))}
          </div>
        </div>
      </div>
      {loading ? (
        <TableSkeleton rows={8} cols={6} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-fg-muted text-left">
              <tr className="border-b">
                <th className="px-5 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5 font-medium">Record</th>
                <th className="px-5 py-2.5 font-medium">Stage</th>
                <th className="px-5 py-2.5 font-medium">Rule / error</th>
                <th className="px-5 py-2.5 font-medium">Entity</th>
                <th className="px-5 py-2.5 font-medium text-right">Amount</th>
                <th className="px-5 py-2.5 font-medium">Event time</th>
              </tr>
            </thead>
            <tbody>
              {(page?.records ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-fg-muted">
                    {(totals?.total ?? 0) > 0
                      ? "Governed volume is on this band; no sampled rows are in this page. Try another status tab or clear the selection."
                      : "No records match this selection."}
                  </td>
                </tr>
              )}
              {(page?.records ?? []).map((r) => (
                <RecordRows key={r.record_id} r={r} open={open === r.record_id}
                            onToggle={() => setOpen(open === r.record_id ? null : r.record_id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > limit && (
        <div className="px-5 py-3 border-t border-line flex items-center justify-between text-xs text-fg-muted">
          <span className="tabular-nums">
            {offset + 1}–{Math.min(offset + limit, total)} of {total.toLocaleString()}
          </span>
          <div className="flex gap-2">
            <button type="button" disabled={offset <= 0}
                    onClick={() => onPage(Math.max(0, offset - limit))}
                    className="px-2 py-1 rounded ring-1 ring-line disabled:opacity-40">Previous</button>
            <button type="button" disabled={offset + limit >= total}
                    onClick={() => onPage(offset + limit)}
                    className="px-2 py-1 rounded ring-1 ring-line disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

function RecordRows({ r, open, onToggle }: { r: LineageRecord; open: boolean; onToggle: () => void }) {
  const recommendation = aiRecommendation(r);
  return (
    <>
      <tr className="border-b last:border-0 record-row-hover cursor-pointer" onClick={onToggle}>
        <td className="px-5 py-2.5">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: LINEAGE_STATUS_COLOR[r.status] }} />
            <Pill value={LINEAGE_STATUS_LABEL[r.status]} />
          </span>
        </td>
        <td className="px-5 py-2.5 font-mono text-xs">{r.record_id}</td>
        <td className="px-5 py-2.5 text-fg-muted">{r.stage.replace(/_/g, " ")}</td>
        <td className="px-5 py-2.5 text-fg-muted">{r.rule ?? "—"}</td>
        <td className="px-5 py-2.5">{r.entity ?? "—"}</td>
        <td className="px-5 py-2.5 text-right tabular-nums">{r.amount == null ? "—" : fmt(r.amount)}</td>
        <td className="px-5 py-2.5 text-fg-muted">{fmtTs(r.event_ts)}</td>
      </tr>
      {open && (
        <tr className="border-b bg-black/[0.02]">
          <td colSpan={7} className="px-5 py-4">
            <div className={`grid gap-4 text-xs ${recommendation ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
              <EvidenceBlock title="Provenance">
                {Object.entries(r.provenance || {}).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2">
                    <span className="text-fg-subtle">{k}</span>
                    <span className="font-mono text-fg">{String(v)}</span>
                  </div>
                ))}
                {r.message && <p className="mt-2 text-fg-muted">{r.message}</p>}
              </EvidenceBlock>
              <EvidenceBlock title="Quality">
                {(r.issues || []).length === 0 && <p className="text-fg-subtle">No quality findings on this row.</p>}
                {(r.issues || []).map((iss, i) => (
                  <div key={i} className="mb-2">
                    <div className="font-medium">{iss.check_id || iss.dimension}</div>
                    <div className="text-fg-muted">{iss.message}</div>
                  </div>
                ))}
              </EvidenceBlock>
              <EvidenceBlock title="Activity">
                {(r.activity || []).length === 0 && <p className="text-fg-subtle">No related close activity.</p>}
                {(r.activity || []).map((a, i) => (
                  <div key={i} className="mb-2">
                    <div className="flex justify-between gap-2">
                      <span className="font-medium">{a.action}</span>
                      <span className="text-fg-subtle">{fmtTs(a.ts)}</span>
                    </div>
                    <div className="text-fg-muted">{a.actor} · {a.detail}</div>
                  </div>
                ))}
              </EvidenceBlock>
              {recommendation && (
                <EvidenceBlock title="AI recommendation">
                  <p className="text-fg">{recommendation}</p>
                </EvidenceBlock>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function EvidenceBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg ring-1 ring-line p-3">
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-2">{title}</div>
      {children}
    </div>
  );
}
