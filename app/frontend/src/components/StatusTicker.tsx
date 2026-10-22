import { CloseStatus, TaskSummary } from "../api";

interface Signal { label: string; tone: "good" | "warn" | "bad" | "neutral"; }

const DOT: Record<Signal["tone"], string> = {
  good: "bg-signal-good",
  warn: "bg-signal-warn",
  bad: "bg-signal-bad",
  neutral: "bg-fg-subtle",
};

function buildSignals(status: CloseStatus | null, summary: TaskSummary | null): Signal[] {
  const out: Signal[] = [];
  if (status) {
    out.push({
      label: `Close ${status.close_status ?? "—"}`,
      tone: status.close_status === "GO" ? "good" : "bad",
    });
    out.push({
      label: `${status.open_recon_breaks ?? 0} open variance${status.open_recon_breaks === 1 ? "" : "s"}`,
      tone: (status.open_recon_breaks ?? 0) > 0 ? "warn" : "good",
    });
    out.push({
      label: `${status.fail_count ?? 0} data-quality check${status.fail_count === 1 ? "" : "s"} failing`,
      tone: (status.fail_count ?? 0) > 0 ? "bad" : "good",
    });
    out.push({ label: `${status.adjustments_posted ?? 0} adjustments signed off`, tone: "neutral" });
  }
  if (summary) {
    out.push({ label: `Close ${summary.pct_complete ?? 0}% complete`, tone: "neutral" });
    if (summary.overdue > 0) out.push({ label: `${summary.overdue} tasks overdue`, tone: "bad" });
    if (summary.awaiting_approval > 0) out.push({ label: `${summary.awaiting_approval} awaiting approval`, tone: "warn" });
    out.push({
      label: summary.days_to_close >= 0
        ? `Target close in ${summary.days_to_close} day${summary.days_to_close === 1 ? "" : "s"}`
        : `Target close passed ${-summary.days_to_close}d ago`,
      tone: "neutral",
    });
  }
  return out;
}

/** Thin marquee of live close signals, terminal-style. */
export default function StatusTicker({
  status, summary,
}: {
  status: CloseStatus | null;
  summary: TaskSummary | null;
}) {
  const signals = buildSignals(status, summary);
  if (signals.length === 0) return null;
  const run = [...signals, ...signals]; // duplicate for a seamless loop

  return (
    <div className="relative overflow-hidden border-b border-line bg-ink-900/60 scan">
      <div className="flex whitespace-nowrap animate-marquee py-1.5">
        {run.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-2 px-5 text-[11px] font-mono text-fg-muted">
            <span className={`w-1.5 h-1.5 rounded-full ${DOT[s.tone]}`} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
