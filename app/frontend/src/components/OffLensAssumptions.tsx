import { DriverDef } from "../api";

/**
 * Read-only chips for assumptions that ARE set on a scenario but whose driver is
 * not among the levers this page edits. A scenario is one shared object across the
 * FP&A lenses (Scenario Planning emphasises the P&L levers; Cash Flow adds the
 * financing/investing ones), so a lever set on one lens must never be silently
 * hidden on the other — we surface it here, read-only, instead of dropping it.
 */
export function OffLensAssumptions({
  drivers, assumptions, editableIds,
}: {
  drivers: DriverDef[];
  assumptions: Record<string, number>;
  /** Driver ids this page renders as editable levers. */
  editableIds: Set<string>;
}) {
  const items = drivers
    .filter((d) => !editableIds.has(d.id) && (assumptions[d.id] ?? 0) !== 0)
    .map((d) => {
      const v = assumptions[d.id];
      return { id: d.id, label: d.label, text: `${v > 0 ? "+" : ""}${v} ${d.unit}` };
    });
  if (items.length === 0) return null;

  return (
    <div className="mt-3 rounded-lg bg-ink-700/40 ring-1 ring-line px-3 py-2">
      <div className="text-[11px] text-fg-subtle mb-1.5">
        Also in this scenario <span className="text-fg-muted">(set on another lens · read-only here)</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => (
          <span key={it.id}
                className="inline-flex items-center gap-1 rounded-md bg-ink-800 ring-1 ring-line px-2 py-0.5 text-[11px]">
            <span className="text-fg-muted">{it.label}</span>
            <span className="num tabular-nums text-fg">{it.text}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
