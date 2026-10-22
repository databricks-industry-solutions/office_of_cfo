import { Fragment, useEffect, useMemo, useState } from "react";
import { api, fmt, CloseStatus, OpexVarianceRow, Scope, TrialBalanceRow } from "../api";
import { Card, ErrorNote, Section, TableSkeleton } from "../components/ui";

const STATEMENTS: { key: string; label: string }[] = [
  { key: "BS", label: "Balance Sheet" },
  { key: "IS", label: "Income Statement" },
];

interface GroupNode {
  group: string;
  rows: TrialBalanceRow[];
  debit: number;
  credit: number;
}

function buildTree(rows: TrialBalanceRow[]): { statement: string; groups: GroupNode[] }[] {
  return STATEMENTS.map(({ key }) => {
    const inStmt = rows.filter((r) => (r.statement || "").toUpperCase() === key);
    const byGroup = new Map<string, TrialBalanceRow[]>();
    for (const r of inStmt) {
      const g = r.account_group || r.fs_line || "Other";
      (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(r);
    }
    const groups: GroupNode[] = [...byGroup.entries()]
      .map(([group, gr]) => ({
        group,
        rows: gr.sort((a, b) => a.account_code.localeCompare(b.account_code)),
        debit: gr.reduce((s, r) => s + (parseFloat(r.debit_balance) || 0), 0),
        credit: gr.reduce((s, r) => s + (parseFloat(r.credit_balance) || 0), 0),
      }))
      .sort((a, b) => a.rows[0].account_code.localeCompare(b.rows[0].account_code));
    return { statement: key, groups };
  }).filter((s) => s.groups.length > 0);
}

export default function TrialBalance({
  status, scope, refreshKey,
}: {
  status: CloseStatus | null;
  scope: Scope;
  refreshKey: number;
}) {
  const [tb, setTb] = useState<TrialBalanceRow[]>([]);
  const [opex, setOpex] = useState<OpexVarianceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Account groups start collapsed (group subtotals visible); expand on click.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, o] = await Promise.all([api.trialBalance(scope), api.opexVariance(scope)]);
        if (!cancelled) { setTb(t); setOpex(o); setError(null); }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Couldn’t load the trial balance.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey, scope]);

  const isGo = status?.close_status === "GO";
  const maxAbsVar = Math.max(1, ...opex.map((o) => Math.abs(parseFloat(o.variance) || 0)));
  const tree = useMemo(() => buildTree(tb), [tb]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <div className="space-y-6">
      {error && <ErrorNote message={error} />}

      <div className={`rounded-xl p-5 shadow-sm ${isGo ? "bg-signal-good" : "bg-signal-bad"} text-white flex items-center justify-between`}>
        <div>
          <div className="text-xs uppercase tracking-wide opacity-80">Data-quality badge</div>
          <div className="text-2xl font-bold mt-1">{status?.close_status ?? "—"}</div>
        </div>
        <div className="text-right text-sm opacity-90">{status?.badge}</div>
      </div>

      <Card title="Trial balance">
        {loading ? (
          <TableSkeleton rows={8} cols={4} />
        ) : (
          <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="text-fg-muted text-left sticky top-0 bg-ink-800 shadow-[0_1px_0_0_#e5e7eb]">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Account</th>
                  <th className="px-5 py-2.5 font-medium">Type</th>
                  <th className="px-5 py-2.5 font-medium text-right">Debit</th>
                  <th className="px-5 py-2.5 font-medium text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {tb.length === 0 && (
                  <tr><td colSpan={4} className="px-5 py-8 text-center text-fg-muted">No balances in this scope.</td></tr>
                )}
                {tree.map(({ statement, groups }) => {
                  const label = STATEMENTS.find((s) => s.key === statement)?.label ?? statement;
                  return (
                    <Fragment key={`s-${statement}`}>
                      <tr className="bg-black/[0.04]">
                        <td colSpan={4} className="px-5 py-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                          {label}
                        </td>
                      </tr>
                      {groups.map((g) => {
                        const key = `${statement}:${g.group}`;
                        const isExpanded = expanded.has(key);
                        return (
                          <Fragment key={`g-${key}`}>
                            <tr className="border-b bg-ink-800 record-row-hover cursor-pointer"
                                onClick={() => toggle(key)}>
                              <td className="px-5 py-2 font-medium" colSpan={2}>
                                <span className="inline-block w-4 text-fg-subtle">{isExpanded ? "▾" : "▸"}</span>
                                {g.group}
                                <span className="text-xs text-fg-subtle ml-2">{g.rows.length}</span>
                              </td>
                              <td className="px-5 py-2 text-right tabular-nums font-medium text-fg">{g.debit ? fmt(g.debit) : ""}</td>
                              <td className="px-5 py-2 text-right tabular-nums font-medium text-fg">{g.credit ? fmt(g.credit) : ""}</td>
                            </tr>
                            {isExpanded && g.rows.map((r) => {
                              const debit = parseFloat(r.debit_balance) || 0;
                              const credit = parseFloat(r.credit_balance) || 0;
                              return (
                                <tr key={r.account_code} className="border-b last:border-0 record-row-hover">
                                  <td className="px-5 py-2 pl-11">
                                    <span className="font-mono text-xs text-fg-muted mr-2">{r.account_code}</span>
                                    {r.account_name}
                                  </td>
                                  <td className="px-5 py-2 text-fg-muted">{r.account_type}</td>
                                  <td className={`px-5 py-2 text-right tabular-nums ${debit < 0 ? "text-signal-bad" : ""}`}>
                                    {debit ? fmt(debit) : ""}
                                  </td>
                                  <td className={`px-5 py-2 text-right tabular-nums ${credit < 0 ? "text-signal-bad" : ""}`}>
                                    {credit ? fmt(credit) : ""}
                                  </td>
                                </tr>
                              );
                            })}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!loading && opex.length > 0 && (
        <Section title="Operating-expense variance to forecast"
                 count={opex.length} defaultOpen={false}>
          <div className="px-5 py-4 space-y-2">
            {opex.slice(0, 8).map((o, i) => {
              const v = parseFloat(o.variance) || 0;
              const unfav = v > 0;
              const pct = Math.round((Math.abs(v) / maxAbsVar) * 100);
              return (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <div className="w-48 shrink-0 truncate">
                    <span className="text-fg">{o.account_name}</span>
                    <span className="text-fg-muted"> · {o.business_unit_name}</span>
                  </div>
                  <div className="flex-1 bg-black/[0.06] rounded h-3 overflow-hidden">
                    <div className={`h-3 ${unfav ? "bg-signal-bad" : "bg-signal-good"}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className={`w-12 shrink-0 text-xs font-medium ${unfav ? "text-signal-bad" : "text-signal-good"}`}>
                    {unfav ? "▲ Unfav" : "▼ Fav"}
                  </div>
                  <div className={`w-28 text-right tabular-nums font-medium ${unfav ? "text-signal-bad" : "text-signal-good"}`}>
                    {unfav ? "+" : "−"}{fmt(Math.abs(v))}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
}
