import * as XLSX from "xlsx";

export const MAX_ADHOC_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_ADHOC_ROWS = 50_000;
export const PREVIEW_ROWS = 20;

export type ParsedWorkbook = {
  filename: string;
  sheets: string[];
  selectedSheet: string;
  headers: string[];
  rows: string[][];
  previewRows: string[][];
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const yyyyMmDd = `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
    if (
      value.getHours() === 0
      && value.getMinutes() === 0
      && value.getSeconds() === 0
    ) {
      return yyyyMmDd;
    }
    return `${yyyyMmDd}T${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
  }
  const text = String(value).trim();
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (slash) {
    const month = Number(slash[1]);
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    return `${year}-${pad2(month)}`;
  }
  return String(value);
}

export function parseWorkbook(
  data: ArrayBuffer,
  filename: string,
  sheet?: string,
): ParsedWorkbook {
  if (data.byteLength > MAX_ADHOC_FILE_BYTES) {
    throw new Error("Workbooks are limited to 15 MB.");
  }
  const csv = filename.toLowerCase().endsWith(".csv");
  const workbook = csv
    ? XLSX.read(new TextDecoder().decode(new Uint8Array(data)), { type: "string", raw: true })
    : XLSX.read(new Uint8Array(data), { type: "array", cellDates: true });
  const sheets = workbook.SheetNames;
  if (!sheets.length) throw new Error("The workbook is empty.");
  const selectedSheet = sheet && sheets.includes(sheet) ? sheet : sheets[0];
  const grid = XLSX.utils.sheet_to_json<(string | number | Date)[]>(
    workbook.Sheets[selectedSheet],
    { header: 1, defval: "", raw: !csv, blankrows: false },
  );
  const nonempty = grid.filter((row) => row.some((cell) => cellText(cell).trim() !== ""));
  if (nonempty.length < 2) throw new Error("The selected sheet is empty.");
  const headers = nonempty[0].map(cellText);
  const rows = nonempty.slice(1).map((row) => headers.map((_, idx) => cellText(row[idx])));
  if (rows.length > MAX_ADHOC_ROWS) {
    throw new Error(`Workbooks are limited to ${MAX_ADHOC_ROWS.toLocaleString()} rows.`);
  }
  return {
    filename,
    sheets,
    selectedSheet,
    headers,
    rows,
    previewRows: rows.slice(0, PREVIEW_ROWS),
  };
}
