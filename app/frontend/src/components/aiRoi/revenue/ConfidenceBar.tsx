import { AiRoiSummary } from "../../../api";
import { Card } from "../../ui";
import { CHART_COLORS } from "../../../lib/chartPalette";
import { money, pctShare, ratio } from "./format";

const GRADES: { key: string; label: string; color: string }[] = [
  { key: "metered", label: "Metered", color: CHART_COLORS.good },
  { key: "attested", label: "Attested", color: CHART_COLORS.series2 },
  { key: "modelled", label: "Modelled", color: CHART_COLORS.series4 },
];

export function ConfidenceBar({ mix }: { mix: Record<string, number> }) {
  const total = GRADES.reduce((s, g) => s + (mix[g.key] ?? 0), 0);
  const modelled = mix.modelled ?? 0;
  return (
    <Card title="Confidence composition">
      <div className="space-y-3 p-5">
        {total === 0 ? (
          <p className="text-sm text-fg-muted">No value in scope for the current confidence filter.</p>
        ) : (
          <>
            <div className="flex h-3 w-full overflow-hidden rounded-full">
              {GRADES.map((g) => {
                const w = (mix[g.key] ?? 0) * 100;
                if (w <= 0) return null;
                return (
                  <div key={g.key} style={{ width: `${w}%`, background: g.color }}
                    title={`${g.label} ${Math.round(w)}%`} />
                );
              })}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
              {GRADES.map((g) => (
                <span key={g.key} className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ background: g.color }} />
                  {g.label} <span className="num text-fg">{pctShare(mix[g.key] ?? 0)}</span>
                </span>
              ))}
            </div>
            {modelled > 0.2 && (
              <p className="text-xs text-signal-warn">Contains modelled assumptions ({pctShare(modelled)} of value).</p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

const RATIOS: { key: keyof Pick<AiRoiSummary, "run_rate_rodt" | "programme_rodt" | "vpmt" | "cost_per_outcome">; label: string; formula: string }[] = [
  { key: "run_rate_rodt", label: "Run-rate Return on Token Used", formula: "(realised value − run cost) / run cost" },
  { key: "programme_rodt", label: "Programme Return on Token Used", formula: "net AI value / fully-loaded cost" },
  { key: "vpmt", label: "Revenue / Mtok", formula: "gross realised revenue per million tokens" },
  { key: "cost_per_outcome", label: "Cost / outcome", formula: "run cost / outcomes" },
];

export function RatioPanel({ summary }: { summary: AiRoiSummary }) {
  return (
    <Card title="Return ratios">
      <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
        {RATIOS.map((r) => (
          <div key={r.key} className="space-y-1" title={r.formula}>
            <div className="text-[11px] uppercase tracking-wide text-fg-subtle">{r.label}</div>
            <div className="text-xl font-bold num text-fg">
              {r.key === "vpmt" || r.key === "cost_per_outcome"
                ? (summary[r.key] == null ? "—" : money(summary[r.key]!))
                : ratio(summary[r.key] ?? null)}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
