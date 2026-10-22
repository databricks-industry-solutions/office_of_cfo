import { useEffect, useMemo, useState } from "react";
import { api, fmt, CloseStatus, Scope, StatementLine } from "../api";
import { Button, Card, ErrorNote, TableSkeleton } from "../components/ui";
import {
  buildComparativeTable,
  buildEquityExportTable,
  buildEquityMatrix,
  TableModel,
} from "../lib/financialStatementModels";
import { runGaapChecks } from "../lib/gaapChecks";
import { useOverlay } from "../lib/industry";
import type { Overlay } from "../lib/industries";
import {
  buildBalance,
  buildCashFlow,
  buildEquity,
  buildIncome,
  DisplayRow,
  EquityDisplayRow,
} from "../lib/statementBuilders";
import { resolveStatementNotes } from "../lib/statementNotes";

type StatementKey = "income" | "balance" | "cashflow" | "equity";
type ExportFormat = "pdf" | "xlsx";
type StatementPayloads = Record<StatementKey, StatementLine[]>;
type StatementDisplays = {
  income: DisplayRow[];
  balance: DisplayRow[];
  cashflow: DisplayRow[];
  equity: EquityDisplayRow[];
};

const TABS: { key: StatementKey; label: string; sheet: string }[] = [
  { key: "income", label: "Income Statement", sheet: "Income Statement" },
  { key: "balance", label: "Balance Sheet", sheet: "Balance Sheet" },
  { key: "cashflow", label: "Cash Flow", sheet: "Cash Flow" },
  { key: "equity", label: "Shareholders' Equity", sheet: "Equity" },
];

const EMPTY_STATEMENTS: StatementPayloads = {
  income: [],
  balance: [],
  cashflow: [],
  equity: [],
};

const tabLabel = (ov: Overlay, key: StatementKey, fallback: string) =>
  ov.statementLabels?.[key] ?? fallback;

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : "Couldn’t load the statement.";

function statementTitle(ov: Overlay, key: StatementKey): string {
  const fallback = TABS.find((tab) => tab.key === key)?.label ?? key;
  return tabLabel(ov, key, fallback);
}

function displayTable(
  key: StatementKey,
  displays: StatementDisplays,
  period: string,
  forExport = false,
): TableModel {
  if (key === "equity") {
    return forExport
      ? buildEquityExportTable(displays.equity, period)
      : buildEquityMatrix(displays.equity, "amount");
  }
  return buildComparativeTable(displays[key], period);
}

function StatementTable({ model }: { model: TableModel }) {
  if (model.rows.length === 0) {
    return <div className="px-5 py-8 text-center text-fg-muted">No data in this scope.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-fg-muted">
            {model.headers.map((header, index) => (
              <th key={`${header}-${index}`} className={`px-5 py-2.5 ${index ? "text-right" : "text-left"}`}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row, rowIndex) => {
            if (row.kind === "spacer") {
              return <tr key={`spacer-${rowIndex}`} className="h-3" />;
            }
            if (row.kind === "section") {
              return (
                <tr key={`section-${rowIndex}`} className="bg-black/[0.04]">
                  <td colSpan={model.headers.length} className="px-5 py-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                    {row.cells[0]}
                  </td>
                </tr>
              );
            }
            const bold = row.kind === "total";
            const subtotal = row.kind === "subtotal";
            return (
              <tr
                key={`row-${rowIndex}`}
                className={`border-b last:border-0 ${bold ? "font-semibold text-fg border-t-2 border-line" : subtotal ? "font-medium text-fg" : ""}`}
              >
                {row.cells.map((cell, cellIndex) => {
                  const amount = typeof cell === "number" ? cell : null;
                  return (
                    <td
                      key={cellIndex}
                      className={`px-5 py-2 ${cellIndex ? "text-right tabular-nums" : row.indent ? "pl-9 text-fg-muted" : ""} ${
                        amount != null && amount < 0 ? "text-signal-bad" : ""
                      }`}
                    >
                      {amount == null ? (cell ?? "") : fmt(amount)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function FinancialStatements({
  status, scope, refreshKey,
}: {
  status: CloseStatus | null;
  scope: Scope;
  refreshKey: number;
}) {
  const ov = useOverlay();
  const [tab, setTab] = useState<StatementKey>("income");
  const [statements, setStatements] = useState<StatementPayloads>(EMPTY_STATEMENTS);
  const [errors, setErrors] = useState<Partial<Record<StatementKey, string>>>({});
  const [loading, setLoading] = useState(true);
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStatements(EMPTY_STATEMENTS);
    setErrors({});

    Promise.allSettled([
      api.incomeStatement(scope),
      api.balanceSheet(scope),
      api.cashFlowStatement(scope),
      api.equityStatement(scope),
    ]).then((results) => {
      if (cancelled) return;
      const next = { ...EMPTY_STATEMENTS };
      const nextErrors: Partial<Record<StatementKey, string>> = {};
      const keys: StatementKey[] = ["income", "balance", "cashflow", "equity"];
      results.forEach((result, index) => {
        const key = keys[index];
        if (result.status === "fulfilled") next[key] = result.value;
        else nextErrors[key] = errorMessage(result.reason);
      });
      setStatements(next);
      setErrors(nextErrors);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [scope, refreshKey]);

  const displays = useMemo<StatementDisplays>(() => ({
    income: buildIncome(statements.income, ov),
    balance: buildBalance(statements.balance, ov),
    cashflow: buildCashFlow(statements.cashflow, ov),
    equity: buildEquity(statements.equity, ov),
  }), [statements, ov]);

  const period = status?.period ?? "";
  const scopeLabel = scope.scope_type === "consolidated" ? "Consolidated" : scope.scope_id;
  const contextLabel = `${scopeLabel}${period ? ` · ${period}` : ""}`;
  const activeTitle = statementTitle(ov, tab);
  const activeTable = useMemo(
    () => displayTable(tab, displays, period),
    [tab, displays, period],
  );
  const notes = useMemo(() => resolveStatementNotes(ov.statementNotes), [ov.statementNotes]);
  const checks = useMemo(() => runGaapChecks({
    income: displays.income,
    balance: displays.balance,
    cashflow: displays.cashflow,
    equity: displays.equity,
    period,
  }), [displays, period]);
  const failedKeys = TABS.map((item) => item.key).filter((key) => errors[key]);
  const unavailableKeys = TABS.map((item) => item.key).filter(
    (key) => !!errors[key] || (!loading && displays[key].length === 0),
  );
  const packReady = !loading && unavailableKeys.length === 0;

  const exportTable = (key: StatementKey) => displayTable(key, displays, period, true);
  const exportContext = `${ov.label} · ${scopeLabel}${period ? ` · ${period}` : ""}`;
  const fileStem = `${ov.id}_${scopeLabel.replace(/\s+/g, "-")}_${period || "period"}`;

  const exportXlsx = async (pack: boolean) => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    const keys = pack ? TABS.map((item) => item.key) : [tab];

    for (const key of keys) {
      const model = exportTable(key);
      const title = statementTitle(ov, key);
      const rows = [
        [`${ov.label} — ${title}`],
        [exportContext],
        [],
        model.headers,
        ...model.rows.map((row) => row.cells.map((cell, index) =>
          index === 0 && row.indent && typeof cell === "string" ? `  ${cell}` : cell ?? "")),
      ];
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      sheet["!cols"] = model.headers.map((_, index) => ({ wch: index === 0 ? 42 : 18 }));
      const sheetName = TABS.find((item) => item.key === key)?.sheet ?? title;
      XLSX.utils.book_append_sheet(workbook, sheet, sheetName.slice(0, 31));
    }

    if (pack) {
      const noteRows = [
        [`${ov.label} — Notes to the Financial Statements`],
        [exportContext],
        [],
        ["Note", "Disclosure"],
        ...notes.map((note) => [note.title, note.body]),
      ];
      const noteSheet = XLSX.utils.aoa_to_sheet(noteRows);
      noteSheet["!cols"] = [{ wch: 28 }, { wch: 100 }];
      XLSX.utils.book_append_sheet(workbook, noteSheet, "Notes");
    }

    XLSX.writeFile(workbook, `${fileStem}_${pack ? "financial-statements-pack" : tab}.xlsx`);
  };

  const exportPdf = async (pack: boolean) => {
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const document = new jsPDF();
    const keys = pack ? TABS.map((item) => item.key) : [tab];

    keys.forEach((key, index) => {
      if (index > 0) document.addPage();
      const model = exportTable(key);
      document.setFontSize(14);
      document.setTextColor(0);
      document.text(`${ov.label} — ${statementTitle(ov, key)}`, 14, 18);
      document.setFontSize(9);
      document.setTextColor(110);
      document.text(exportContext, 14, 25);
      document.setTextColor(0);
      autoTable(document, {
        startY: 30,
        head: [model.headers],
        body: model.rows.map((row) => row.cells.map((cell, cellIndex) => {
          if (cellIndex === 0 && row.indent && typeof cell === "string") return `  ${cell}`;
          return typeof cell === "number" ? fmt(cell) : cell ?? "";
        })),
        styles: { fontSize: 8 },
        columnStyles: Object.fromEntries(
          model.headers.slice(1).map((_, index) => [index + 1, { halign: "right" }]),
        ),
        headStyles: { fillColor: [40, 40, 40] },
      });
    });

    if (pack) {
      document.addPage();
      document.setFontSize(14);
      document.text(`${ov.label} — Notes to the Financial Statements`, 14, 18);
      document.setFontSize(9);
      document.setTextColor(110);
      document.text(exportContext, 14, 25);
      document.setTextColor(0);
      autoTable(document, {
        startY: 30,
        head: [["Note", "Disclosure"]],
        body: notes.map((note) => [note.title, note.body]),
        styles: { fontSize: 8, overflow: "linebreak", valign: "top" },
        columnStyles: { 0: { cellWidth: 45 }, 1: { cellWidth: 130 } },
        headStyles: { fillColor: [40, 40, 40] },
      });
    }

    document.save(`${fileStem}_${pack ? "financial-statements-pack" : tab}.pdf`);
  };

  const doExport = async (pack: boolean) => {
    setExporting(true);
    setExportError(null);
    try {
      if (format === "xlsx") await exportXlsx(pack);
      else await exportPdf(pack);
    } catch (error) {
      setExportError(errorMessage(error) || "Couldn’t export the financial statements.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="inline-flex items-center gap-0.5 rounded-lg bg-black/[0.04] p-0.5">
          {TABS.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition ${
                tab === item.key ? "bg-accent text-white shadow-sm" : "text-fg-muted hover:text-fg"
              }`}
            >
              {statementTitle(ov, item.key)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-fg-muted">Export as</label>
          <select
            aria-label="Export format"
            value={format}
            onChange={(event) => setFormat(event.target.value as ExportFormat)}
            className="border border-line rounded-md px-2 py-1.5 text-sm bg-transparent"
          >
            <option value="pdf">PDF</option>
            <option value="xlsx">Excel</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void doExport(false)}
            disabled={loading || exporting || !!errors[tab] || activeTable.rows.length === 0}
          >
            Export tab
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void doExport(true)}
            disabled={!packReady || exporting}
          >
            Export pack
          </Button>
        </div>
      </div>

      {failedKeys.length > 0 && (
        <ErrorNote message={`Some statements could not be loaded: ${failedKeys.map((key) => statementTitle(ov, key)).join(", ")}. Automated checks and pack export are incomplete.`} />
      )}
      {failedKeys.length === 0 && unavailableKeys.length > 0 && (
        <ErrorNote message={`Some statements returned no data: ${unavailableKeys.map((key) => statementTitle(ov, key)).join(", ")}. Automated checks and pack export are incomplete.`} />
      )}
      {errors[tab] && <ErrorNote message={`${activeTitle}: ${errors[tab]}`} />}
      {exportError && <ErrorNote message={`Export failed: ${exportError}`} />}

      <Card title={`${activeTitle} — ${contextLabel}`}>
        {loading ? <TableSkeleton rows={8} cols={tab === "equity" ? 4 : 3} /> : <StatementTable model={activeTable} />}
      </Card>

      <Card title="GAAP close-control proxies">
        <div className="px-5 pt-4 text-sm text-fg-muted">
          These automated close controls are indicators only. They are not a legal certification of GAAP compliance and do not replace professional judgment.
        </div>
        {loading ? (
          <TableSkeleton rows={5} cols={2} />
        ) : (
          <div className="grid gap-3 p-5 md:grid-cols-2">
            {checks.map((check) => {
              const tone = check.status === "pass"
                ? "bg-signal-good/10 text-signal-good ring-signal-good/30"
                : check.status === "fail"
                  ? "bg-signal-bad/10 text-signal-bad ring-signal-bad/30"
                  : "bg-black/[0.04] text-fg-muted ring-line";
              return (
                <div key={check.id} className="rounded-xl border border-line p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium text-sm">{check.label}</div>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ring-1 ${tone}`}>
                      {check.status}
                    </span>
                  </div>
                  <div className="mt-1 text-xs leading-5 text-fg-muted">{check.detail}</div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Notes to the Financial Statements">
        <div className="divide-y divide-line">
          {notes.map((note, index) => (
            <section key={note.id} className="px-5 py-4">
              <h3 className="text-sm font-semibold">{index + 1}. {note.title}</h3>
              <p className="mt-1 text-sm leading-6 text-fg-muted">{note.body}</p>
            </section>
          ))}
        </div>
      </Card>
    </div>
  );
}
