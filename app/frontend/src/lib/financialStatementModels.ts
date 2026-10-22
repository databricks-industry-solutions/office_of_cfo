import type {
  DisplayKind,
  DisplayRow,
  EquityDisplayRow,
} from "./statementBuilders";

export type TableCell = string | number | null;
export type TableRowKind = DisplayKind | "spacer";

export interface TableRowModel {
  kind: TableRowKind;
  cells: TableCell[];
  indent?: boolean;
}

export interface TableModel {
  headers: string[];
  rows: TableRowModel[];
}

const EQUITY_CLASSES = [
  { id: "common_stock", label: "Common Stock" },
  { id: "retained_earnings", label: "Retained Earnings" },
  { id: "total", label: "Total" },
] as const;

const EQUITY_MOVEMENTS = ["beginning", "net_income", "dividends", "ending"] as const;

export function priorPeriod(period: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) return "Prior period";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function buildComparativeTable(rows: DisplayRow[], period: string): TableModel {
  const comparative = rows.some((row) => row.priorAmount != null);
  return {
    headers: comparative
      ? ["Line", period || "Current period", priorPeriod(period)]
      : ["Line", "Amount"],
    rows: rows.map((row) => ({
      kind: row.kind,
      cells: comparative
        ? [row.label, row.amount, row.priorAmount ?? null]
        : [row.label, row.amount],
      ...(row.indent ? { indent: true } : {}),
    })),
  };
}

export function buildEquityMatrix(
  rows: EquityDisplayRow[],
  value: "amount" | "priorAmount",
): TableModel {
  return {
    headers: ["Movement", ...EQUITY_CLASSES.map((equityClass) => equityClass.label)],
    rows: EQUITY_MOVEMENTS.map((lineId) => {
      const movementRows = rows.filter((row) => row.lineId === lineId);
      const label =
        movementRows.find((row) => row.equityClass === "total")?.label ??
        movementRows[0]?.label ??
        lineId;
      return {
        kind: lineId === "ending" ? "total" : "line",
        cells: [
          label,
          ...EQUITY_CLASSES.map((equityClass) => {
            const row = movementRows.find((candidate) => candidate.equityClass === equityClass.id);
            return row?.[value] ?? null;
          }),
        ],
      };
    }),
  };
}

export function buildEquityExportTable(
  rows: EquityDisplayRow[],
  period: string,
): TableModel {
  const current = buildEquityMatrix(rows, "amount");
  const prior = buildEquityMatrix(rows, "priorAmount");
  const hasPrior = rows.some((row) => row.priorAmount != null);
  const section = (label: string): TableRowModel => ({
    kind: "section",
    cells: [label, null, null, null],
  });

  return {
    headers: current.headers,
    rows: [
      section(period || "Current period"),
      ...current.rows,
      ...(hasPrior
        ? [
            { kind: "spacer" as const, cells: [null, null, null, null] },
            section(priorPeriod(period)),
            ...prior.rows,
          ]
        : []),
    ],
  };
}
