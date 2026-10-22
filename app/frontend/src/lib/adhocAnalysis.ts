import type { AdhocAnalysisLine } from "../api";
import type { Overlay } from "./industries";

export function adhocLineLabel(
  lineId: string,
  apiLabel: string,
  overlay: Overlay,
): string {
  if (lineId === "cogs") return overlay.cogsLabel;
  return overlay.statementLabels?.[lineId] ?? apiLabel;
}

export function narrativeBullets(
  lines: AdhocAnalysisLine[],
  totalRows: number,
  unmappedAmount: number,
  overlay: Overlay,
): string[] {
  const largest = lines.reduce<AdhocAnalysisLine | null>(
    (best, line) => !best || Math.abs(line.gap) > Math.abs(best.gap) ? line : best,
    null,
  );
  if (!largest) return [];
  const direction = largest.gap >= 0 ? "above" : "below";
  const label = adhocLineLabel(largest.line_id, largest.line_label, overlay);
  return [
    `The BU flash is ${Math.abs(largest.gap).toLocaleString()} ${direction} the governed close on ${label}.`,
    `${lines.length} mapped lines cover ${Math.round(lines.length / totalRows * 100)}% of the uploaded analysis rows.`,
    `One unmapped line worth ${unmappedAmount.toLocaleString()} remains outside the comparison.`,
  ];
}
