import { money, pct } from "../shared";

export function Delta({ value, kind }: { value: number; kind: "currency" | "percent" }) {
  if (value === 0) return <span className="text-fg-muted">—</span>;
  const positive = value > 0;
  const formatted = kind === "currency" ? money(Math.abs(value)) : pct(Math.abs(value));
  const tone = positive ? "text-signal-good" : "text-signal-bad";
  return (
    <span className={`${tone} num`}>
      {positive ? "+" : "−"}{formatted}
    </span>
  );
}
