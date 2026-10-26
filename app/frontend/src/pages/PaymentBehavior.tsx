import { useEffect, useState } from "react";
import { AlertTriangle, Info, TrendingDown } from "lucide-react";
import { api, PayAnomaly, PayScorecardRow, Scope } from "../api";
import { Card, CardSkeleton, ErrorNote, Skeleton, SkeletonRegion, Sparkline, TableSkeleton } from "../components/ui";
import { useOverlay } from "../lib/industry";

type Ledger = "ar" | "ap";

const fmtMoney = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return v.toFixed(0);
};

const CAT_TONE: Record<string, string> = {
  early: "text-signal-good",
  prompt: "text-fg-muted",
  late: "text-signal-bad",
};

function ScorecardRow({ r }: { r: PayScorecardRow }) {
  const late = r.avg_days_vs_terms > 0;
  const rowTint = r.category === "late" ? "bg-signal-bad/[0.04]"
    : r.category === "early" ? "bg-signal-good/[0.04]" : "";
  // Sparkline colour follows the TREND, not the absolute level: days-vs-terms
  // trending down = paying sooner = improving (green); trending up = worsening
  // (red); roughly flat = neutral.
  const trend = (r.trend ?? []).filter((v) => Number.isFinite(v));
  const trendDelta = trend.length >= 2 ? trend[trend.length - 1] - trend[0] : 0;
  const trendTone = trendDelta > 0.75 ? "text-signal-bad"
    : trendDelta < -0.75 ? "text-signal-good" : "text-fg-subtle";
  return (
    <tr className={`border-t border-line ${rowTint}`}>
      <td className="px-4 py-2.5">
        <div className="text-sm text-fg truncate max-w-[200px]">{r.counterparty}</div>
        <div className="text-[11px] text-fg-subtle num">{r.invoices} inv · {fmtMoney(r.amount)}</div>
      </td>
      <td className="px-3 py-2.5 text-sm text-fg-muted num whitespace-nowrap">Net {r.terms ?? "—"}</td>
      <td className={`px-3 py-2.5 text-sm num font-medium whitespace-nowrap ${late ? "text-signal-bad" : "text-signal-good"}`}>
        {r.avg_days_vs_terms > 0 ? "+" : ""}{r.avg_days_vs_terms} {late ? "late" : "early"}
      </td>
      <td className="px-3 py-2.5 text-sm num text-fg-muted">{r.on_time_pct}%</td>
      <td className="px-3 py-2.5">
        <Sparkline values={r.trend} width={90} height={26} className={trendTone} />
      </td>
    </tr>
  );
}

function AnomalyItem({ a }: { a: PayAnomaly }) {
  const isOverdue = a.type === "overdue";
  const surprising = a.category === "early" || a.category === "prompt";
  const tone = isOverdue
    ? (surprising ? "border-signal-bad/50 bg-signal-bad/[0.05]" : "border-signal-warn/50 bg-signal-warn/[0.04]")
    : a.direction === "early" ? "border-blue-400/50 bg-blue-400/[0.05]"
      : "border-signal-warn/50 bg-signal-warn/[0.04]";
  const Icon = isOverdue ? AlertTriangle : a.direction === "early" ? Info : TrendingDown;
  const iconTone = isOverdue ? (surprising ? "text-signal-bad" : "text-signal-warn")
    : a.direction === "early" ? "text-blue-400" : "text-signal-warn";
  return (
    <div className={`rounded-xl border-l-4 ring-1 ring-line ${tone} px-4 py-3`}>
      <div className="flex items-start gap-2.5">
        <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${iconTone}`} />
        <div className="min-w-0">
          <div className="text-sm text-fg">{a.detail}</div>
          <div className="text-[11px] text-fg-subtle mt-0.5 num">
            baseline {a.baseline_avg > 0 ? "+" : ""}{a.baseline_avg}d ({a.category})
            {a.amount ? ` · ${fmtMoney(a.amount)}` : ""}
            {a.zscore != null ? ` · z=${a.zscore}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PaymentBehavior({
  scope, period, refreshKey,
}: {
  scope: Scope;
  period: string;
  refreshKey: number;
}) {
  const ov = useOverlay();
  const [ledger, setLedger] = useState<Ledger>("ar");
  const [rows, setRows] = useState<PayScorecardRow[]>([]);
  const [anoms, setAnoms] = useState<PayAnomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.paymentBehavior(ledger, scope),
      api.paymentAnomalies(ledger, scope),
    ])
      .then(([sc, an]) => {
        if (cancelled) return;
        setRows(sc.counterparties || []);
        setAnoms(an.anomalies || []);
      })
      .catch(() => { if (!cancelled) setError("Could not load payment behaviour."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey, scope, ledger]);

  const arLabel = ov.exposure.arToggle ?? "Customers · AR";
  const apLabel = ov.exposure.apToggle ?? "Vendors · AP";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="text-sm text-fg-subtle">
          vs their own historical norm · as of {period}
        </div>
        <div className="inline-flex rounded-lg ring-1 ring-line overflow-hidden">
          {(["ar", "ap"] as Ledger[]).map((l) => (
            <button key={l} onClick={() => setLedger(l)}
              className={`px-3 py-1.5 text-sm transition ${
                ledger === l ? "bg-accent text-white" : "text-fg-muted hover:bg-black/[0.04]"}`}>
              {l === "ar" ? arLabel : apLabel}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorNote message={error} />}
      {loading && rows.length === 0 && anoms.length === 0 ? (
        <SkeletonRegion className="grid grid-cols-1 xl:grid-cols-5 gap-5">
          <CardSkeleton className="xl:col-span-3"><TableSkeleton rows={8} cols={5} /></CardSkeleton>
          <CardSkeleton className="xl:col-span-2">
            <div className="p-4 space-y-2.5">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="rounded-xl ring-1 ring-line p-3 space-y-2"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-2.5 w-full" /></div>
              ))}
            </div>
          </CardSkeleton>
        </SkeletonRegion>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">
          {/* I — scorecard */}
          <Card title="Payment Scorecard" className="xl:col-span-3 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-fg-subtle">
                    <th className="px-4 py-2 text-left font-normal">Counterparty</th>
                    <th className="px-3 py-2 text-left font-normal">Terms</th>
                    <th className="px-3 py-2 text-left font-normal">Avg vs terms</th>
                    <th className="px-3 py-2 text-left font-normal">On-time</th>
                    <th className="px-3 py-2 text-left font-normal">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => <ScorecardRow key={r.counterparty} r={r} />)}
                </tbody>
              </table>
              {rows.length === 0 && (
                <div className="px-4 py-8 text-sm text-fg-subtle">No paid history yet for this scope.</div>
              )}
            </div>
          </Card>

          {/* J — anomaly feed */}
          <Card title="Payment anomalies this period" className="xl:col-span-2 p-4">
            <div className="space-y-2.5">
              {anoms.map((a, i) => <AnomalyItem key={`${a.counterparty}-${a.type}-${i}`} a={a} />)}
              {anoms.length === 0 && (
                <div className="text-sm text-fg-subtle py-6 text-center">
                  No counterparties are off their usual pattern this period.
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
