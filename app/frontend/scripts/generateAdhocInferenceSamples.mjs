/**
 * Deterministic ad-hoc inference sample pack for manual accuracy checks.
 * Regenerate: cd app/frontend && npm run samples:adhoc
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../samples/adhoc-inference");

const FLAT_HEADERS = ["Account", "Month", "Amt", "Version", "Region", "Notes"];
const PIVOT_HEADERS = ["Account", "2026-06", "2026-08", "2026-09", "Version"];
const REQUIRED_PERIODS = ["2026-06", "2026-09"];

const FLAT_ROWS = [
  ["Revenue", "2026-06", 1000, "Flash", "EMEA", "Active close month"],
  ["Cost of Revenue", "2026-06", 380, "Flash", "EMEA", "Mapped P&L line"],
  ["Operating Expenses", "2026-06", 300, "Flash", "EMEA", "Controller review"],
  ["Discretionary projects", "2026-06", 40, "Flash", "EMEA", "Unmapped row"],
  ["Revenue", "2026-09", 1030, "Flash", "EMEA", "Clean flat upload"],
  ["Cost of Revenue", "2026-09", 392, "Flash", "EMEA", "Mapped P&L line"],
  ["Operating Expenses", "2026-09", 324, "Flash", "EMEA", "Controller review"],
  ["Discretionary projects", "2026-09", 52, "Flash", "EMEA", "Unmapped row"],
];

const PIVOT_ROWS = [
  ["Revenue", 900, 950, 1030, "Flash"],
  ["Cost of Revenue", 380, 388, 392, "Flash"],
  ["Operating Expenses", 300, 312, 324, "Flash"],
  ["Discretionary projects", 40, 46, 52, "Flash"],
];

const MESSY_ROWS = [
  ["Revenue", "2026-06", 1000, "Flash", "EMEA", "Active close month"],
  ["Cost of Revenue", "2026-06", 380, false, "", "June baseline"],
  ["Operating Expenses", "2026-06", 300, "Flash", "EMEA", ""],
  ["Discretionary projects", "2026-06", 40, "Flash", "EMEA", "Unmapped row"],
  ["Revenue", "9/1/26", "$19,110.00", true, "EMEA", ""],
  ["Cost of Revenue", "2026-09", 392, false, "", "Slash date on row 1 only"],
  ["Operating Expenses", "", 324, "Flash", "EMEA", ""],
  ["Revenue adjustment", "2026-09", "not posted", "Flash", "GLOBAL", "Invalid amount"],
  ["Discretionary projects", "2026-09", 52, "Flash", "EMEA", "Unmapped row"],
];

const README = `# Ad-hoc inference sample pack

Deterministic workbooks for manual datatype / finance-role inference checks on **Ad-hoc analysis**. Regenerate from the repo root:

\`\`\`bash
cd app/frontend
npm run samples:adhoc
\`\`\`

Every file exposes **2026-06** and **2026-09**. Use the stock period picker (**2026-06**, active close) without changing the chrome; **2026-09** remains available for a second pass or multi-month pivot checks.

## Files

| File | Layout | Purpose |
|------|--------|---------|
| \`clean-finance-flash.xlsx\` | Flat | High-confidence inference on canonical headers |
| \`clean-finance-flash.csv\` | Flat | Same grid as the clean XLSX (CSV path) |
| \`monthly-finance-pivot.xlsx\` | Account × month pivot | Period-shaped column headers |
| \`messy-finance-flash.xlsx\` | Flat | Mixed types, empty cells, currency, slash dates, booleans, invalid amount |

## Expected inference (parse step)

### Flat clean (\`clean-finance-flash.xlsx\` / \`.csv\`)

| Column | Data type | Use as | Notes |
|--------|-----------|--------|-------|
| Account | text | metric_id | P&L labels incl. mapped lines |
| Month | date | period | \`2026-06\` and \`2026-09\` rows |
| Amt | number | amount | Plain numeric amounts |
| Version | text | version | \`Flash\` |
| Region | text | ignore | Noise column |
| Notes | text | ignore | Noise column |

**Layout:** \`flat\`. Three mapped P&L rows plus **Discretionary projects** (unmapped).

### Pivot (\`monthly-finance-pivot.xlsx\`)

| Column | Data type | Use as | Notes |
|--------|-----------|--------|-------|
| Account | text | metric_id | Row labels |
| 2026-06 / 2026-08 / 2026-09 | number | period | Header supplies month; cells are amounts |
| Version | text | version | \`Flash\` |

**Layout:** \`account_month_pivot\`. Includes **Discretionary projects** as an unmapped row.

### Messy flat (\`messy-finance-flash.xlsx\`)

| Column | Data type | Use as | Notes |
|--------|-----------|--------|-------|
| Account | text | metric_id | |
| Month | date (mixed confidence) | period | \`2026-06\` rows plus \`9/1/26\` (Sep) and \`2026-09\` |
| Amt | text (low confidence) | amount | \`$19,110.00\`, empty cells, \`not posted\` |
| Version | boolean | version | \`true\` / \`false\` literals |
| Region | text | ignore | Includes empty cells |
| Notes | text | ignore | |

**Run step:** \`not posted\` should surface as an invalid-value exception when Amount is coerced as number. **Discretionary projects** remains unmapped.
`;

function writeFlatXlsx(filename, rows) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([FLAT_HEADERS, ...rows]);
  XLSX.utils.book_append_sheet(book, sheet, "BU Flash");
  XLSX.writeFile(book, path.join(OUT_DIR, filename));
}

function writeFlatCsv(filename, rows) {
  const sheet = XLSX.utils.aoa_to_sheet([FLAT_HEADERS, ...rows]);
  const csv = XLSX.utils.sheet_to_csv(sheet);
  fs.writeFileSync(path.join(OUT_DIR, filename), csv, "utf8");
}

function writePivotXlsx(filename, rows) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([PIVOT_HEADERS, ...rows]);
  XLSX.utils.book_append_sheet(book, sheet, "BU Flash");
  XLSX.writeFile(book, path.join(OUT_DIR, filename));
}

function readWorkbook(filePath) {
  const data = fs.readFileSync(filePath);
  if (filePath.endsWith(".csv")) {
    return XLSX.read(data.toString("utf8"), { type: "string", raw: true });
  }
  return XLSX.read(data, { type: "buffer", cellDates: true });
}

function firstSheetGrid(workbook) {
  const names = workbook.SheetNames;
  if (!names.length) {
    throw new Error("workbook has no sheets");
  }
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[names[0]], {
    header: 1,
    defval: "",
    blankrows: false,
  });
  const nonempty = grid.filter((row) =>
    row.some((cell) => String(cell ?? "").trim() !== ""),
  );
  if (nonempty.length < 2) {
    throw new Error("first sheet is empty");
  }
  return nonempty;
}

function cellText(value) {
  if (value == null) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = (n) => String(n).padStart(2, "0");
    const yyyyMmDd = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    if (
      value.getHours() === 0
      && value.getMinutes() === 0
      && value.getSeconds() === 0
    ) {
      return yyyyMmDd;
    }
    return `${yyyyMmDd}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  return String(value);
}

function headersFromGrid(grid) {
  return grid[0].map(cellText);
}

function gridContainsPeriod(grid, period) {
  for (const row of grid) {
    for (const cell of row) {
      const text = cellText(cell);
      if (text === period || text.includes(period)) {
        return true;
      }
    }
  }
  return false;
}

function periodHeaderCount(headers) {
  return headers.filter((h) => /^\d{4}-\d{2}$/.test(h)).length;
}

function assertFile(filePath, expectations) {
  const workbook = readWorkbook(filePath);
  const grid = firstSheetGrid(workbook);
  const headers = headersFromGrid(grid);

  if (expectations.headers) {
    const same = expectations.headers.every((h, idx) => headers[idx] === h);
    if (!same || headers.length !== expectations.headers.length) {
      throw new Error(`${path.basename(filePath)} headers mismatch: ${headers.join(", ")}`);
    }
  }

  if (expectations.minPeriodHeaders != null) {
    const count = periodHeaderCount(headers);
    if (count < expectations.minPeriodHeaders) {
      throw new Error(`${path.basename(filePath)} expected >= ${expectations.minPeriodHeaders} period headers, got ${count}`);
    }
  }

  for (const period of REQUIRED_PERIODS) {
    if (!gridContainsPeriod(grid, period)) {
      throw new Error(`${path.basename(filePath)} missing ${period} period`);
    }
  }
}

function validatePack() {
  const files = [
    "clean-finance-flash.xlsx",
    "clean-finance-flash.csv",
    "monthly-finance-pivot.xlsx",
    "messy-finance-flash.xlsx",
  ];

  for (const name of files) {
    const filePath = path.join(OUT_DIR, name);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      throw new Error(`${name} is missing or empty`);
    }
  }

  assertFile(path.join(OUT_DIR, "clean-finance-flash.xlsx"), { headers: FLAT_HEADERS });
  assertFile(path.join(OUT_DIR, "clean-finance-flash.csv"), { headers: FLAT_HEADERS });
  assertFile(path.join(OUT_DIR, "monthly-finance-pivot.xlsx"), { minPeriodHeaders: 2 });
  assertFile(path.join(OUT_DIR, "messy-finance-flash.xlsx"), { headers: FLAT_HEADERS });

  const xlsxHeaders = headersFromGrid(firstSheetGrid(readWorkbook(path.join(OUT_DIR, "clean-finance-flash.xlsx"))));
  const csvHeaders = headersFromGrid(firstSheetGrid(readWorkbook(path.join(OUT_DIR, "clean-finance-flash.csv"))));
  if (xlsxHeaders.join("|") !== csvHeaders.join("|")) {
    throw new Error("clean flat XLSX and CSV headers differ");
  }
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  writeFlatXlsx("clean-finance-flash.xlsx", FLAT_ROWS);
  writeFlatCsv("clean-finance-flash.csv", FLAT_ROWS);
  writePivotXlsx("monthly-finance-pivot.xlsx", PIVOT_ROWS);
  writeFlatXlsx("messy-finance-flash.xlsx", MESSY_ROWS);
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), README, "utf8");

  validatePack();
  console.log("Generated and validated 4 ad-hoc inference samples.");
}

main();
