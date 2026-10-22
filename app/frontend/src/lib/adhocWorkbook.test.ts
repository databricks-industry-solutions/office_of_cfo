import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { MAX_ADHOC_ROWS, parseWorkbook } from "./adhocWorkbook";

function workbookBytes(sheets: Record<string, (string | number | Date)[][]>): ArrayBuffer {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const out = XLSX.write(book, { type: "array", bookType: "xlsx" });
  const bytes = out instanceof Uint8Array
    ? out
    : new Uint8Array(out as ArrayBuffer);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

describe("parseWorkbook", () => {
  it("reads headers, rows, and sheet names from a flat workbook", () => {
    const parsed = parseWorkbook(
      workbookBytes({
        "BU Flash": [
          ["Account", "Month", "Amt", "Version"],
          ["Revenue", "2026-06", 1030, "Flash"],
          ["Operating Expenses", "2026-06", 324, "Flash"],
        ],
        Notes: [["ignore"]],
      }),
      "emea_flash.xlsx",
    );

    expect(parsed.sheets).toEqual(["BU Flash", "Notes"]);
    expect(parsed.selectedSheet).toBe("BU Flash");
    expect(parsed.headers).toEqual(["Account", "Month", "Amt", "Version"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0][0]).toBe("Revenue");
    expect(parsed.previewRows).toHaveLength(2);
  });

  it("keeps year-month CSV values as YYYY-MM instead of a spreadsheet date", () => {
    const csv = "Account,Month,Amt\nRevenue,2026-06,1030\n";
    const bytes = new TextEncoder().encode(csv);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const parsed = parseWorkbook(copy.buffer, "emea_flash.csv");
    expect(parsed.rows[0][1]).toBe("2026-06");
  });

  it("preserves datetime cells with a time component", () => {
    const parsed = parseWorkbook(
      workbookBytes({
        "BU Flash": [
          ["Account", "When"],
          ["Revenue", new Date(2026, 5, 15, 9, 30, 45)],
        ],
      }),
      "emea_flash.xlsx",
    );

    expect(parsed.rows[0][1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(parsed.rows[0][1]).not.toBe("2026-06");
  });

  it("rejects empty sheets", () => {
    expect(() => parseWorkbook(
      workbookBytes({ Empty: [[], []] }),
      "empty.xlsx",
    )).toThrow(/empty/i);
  });

  it("caps rows at the ad-hoc limit", () => {
    const rows: (string | number)[][] = [["Account", "Amt"]];
    for (let i = 0; i < MAX_ADHOC_ROWS + 5; i += 1) {
      rows.push(["Revenue", i]);
    }
    expect(() => parseWorkbook(
      workbookBytes({ Sheet1: rows }),
      "huge.xlsx",
    )).toThrow(/50,?000/);
  });
});
