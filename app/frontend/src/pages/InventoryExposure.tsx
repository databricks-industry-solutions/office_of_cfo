import { useEffect, useMemo, useState } from "react";
import { api, fmt, InventoryExposureRow, Scope } from "../api";
import { Card, ErrorNote, TableSkeleton } from "../components/ui";
import { useOverlay } from "../lib/industry";

const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v) || 0);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export default function InventoryExposure({
  scope, refreshKey,
}: {
  scope: Scope;
  refreshKey: number;
}) {
  const ov = useOverlay();
  const copy = ov.inventoryExposureCopy ?? { title: "Inventory Exposure", noun: "inventory" };
  const [rows, setRows] = useState<InventoryExposureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.inventoryExposure(scope)
      .then((r) => { if (!cancelled) { setRows(r); setError(null); } })
      .catch((e: any) => { if (!cancelled) setError(e?.message || "Couldn’t load inventory exposure."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope, refreshKey]);

  const totals = useMemo(() => {
    let total = 0, slow = 0, supplier = 0, items = 0;
    for (const r of rows) {
      total += num(r.total_inventory);
      slow += num(r.slow_moving_value);
      supplier += num(r.supplier_managed_value);
      items += num(r.item_count);
    }
    return { total, slow, supplier, items };
  }, [rows]);

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Tile label={`Total ${copy.noun}`} value={fmt(totals.total)} sub={`${totals.items} items on hand`} tone="ink" />
        <Tile label="Slow-moving exposure" value={fmt(totals.slow)}
              sub={`${pct(totals.slow, totals.total)}% of ${copy.noun}`} tone="warn" />
        <Tile label="Supplier-managed exposure" value={fmt(totals.supplier)}
              sub={`${pct(totals.supplier, totals.total)}% of ${copy.noun}`} tone="blue" />
      </section>

      <Card title={`${copy.title} by business unit`}>
        {loading ? (
          <TableSkeleton rows={5} cols={4} />
        ) : error ? (
          <div className="p-5"><ErrorNote message={error} /></div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-fg-muted text-sm">No {copy.noun} in this scope.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-fg-muted text-left">
                <tr className="border-b">
                  <th className="px-5 py-2.5 font-medium">Business unit</th>
                  <th className="px-5 py-2.5 font-medium text-right">Total {copy.noun}</th>
                  <th className="px-5 py-2.5 font-medium text-right">Slow-moving</th>
                  <th className="px-5 py-2.5 font-medium text-right">Supplier-managed</th>
                  <th className="px-5 py-2.5 font-medium w-40">At-risk share</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const total = num(r.total_inventory);
                  const slow = num(r.slow_moving_value);
                  const supplier = num(r.supplier_managed_value);
                  const atRiskPct = pct(Math.max(slow, supplier), total);
                  return (
                    <tr key={r.business_unit_id} className="border-b last:border-0 record-row-hover">
                      <td className="px-5 py-3">
                        <div className="font-medium">{r.business_unit_name}</div>
                        <div className="text-xs text-fg-muted">{r.region}</div>
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums">{fmt(total)}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-signal-warn">{fmt(slow)}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{fmt(supplier)}</td>
                      <td className="px-5 py-3">
                        <div className="h-2 rounded-full bg-black/[0.06] overflow-hidden">
                          <div className="h-full bg-signal-warn" style={{ width: `${atRiskPct}%` }} />
                        </div>
                        <div className="text-[10px] text-fg-subtle mt-1 num">{atRiskPct}% at risk</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line font-semibold text-fg">
                  <td className="px-5 py-3">Total</td>
                  <td className="px-5 py-3 text-right tabular-nums">{fmt(totals.total)}</td>
                  <td className="px-5 py-3 text-right tabular-nums text-signal-warn">{fmt(totals.slow)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{fmt(totals.supplier)}</td>
                  <td className="px-5 py-3"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Tile({
  label, value, sub, tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "ink" | "warn" | "blue";
}) {
  const accent = tone === "warn" ? "text-signal-warn" : tone === "blue" ? "text-accent-400 dark:text-fg" : "text-fg";
  return (
    <div className="rounded-xl p-5 shadow-sm bg-ink-800 ring-1 ring-line">
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className={`text-2xl font-bold num mt-1 ${accent}`}>{value}</div>
      <div className="text-xs text-fg-muted mt-1">{sub}</div>
    </div>
  );
}
