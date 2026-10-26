import { AiRoiExecutive } from "../../../api";
import { Card } from "../../ui";
import { money } from "../shared";

export function ExecutiveWhatChanged({ rows }: { rows: NonNullable<AiRoiExecutive["what_changed"]> }) {
  const movers = [...rows]
    .filter((row) => row.delta != null)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3);
  return (
    <Card title="What changed" className="h-full">
      <div data-testid="ai-roi-what-changed" className="flex flex-col gap-2 p-5">
        {!movers.length ? (
          <p className="text-sm text-fg-muted">No prior-period comparison available.</p>
        ) : movers.map((mover) => {
          const rose = mover.delta > 0;
          return (
            <p key={mover.key} className="text-sm text-fg">
              <span>{mover.label}</span> spend{" "}
              <span className={rose ? "text-signal-warn" : "text-signal-good"}>
                {rose ? "rose" : "fell"} {money(Math.abs(mover.delta))}
              </span>{" "}
              vs the prior period, to <span className="num">{money(mover.value)}</span>.
            </p>
          );
        })}
      </div>
    </Card>
  );
}
