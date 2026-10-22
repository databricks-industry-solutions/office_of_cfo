import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Surfaces that must use `.record-row-hover` on data/list row shells (not menus/buttons). */
const RECORD_ROW_SURFACES = [
  "components/tasks/TaskList.tsx",
  "pages/Approvals.tsx",
  "pages/TrialBalance.tsx",
  "pages/Reconciliation.tsx",
  "pages/ComparativeStatements.tsx",
  "components/LineageRecordsTable.tsx",
  "pages/InventoryExposure.tsx",
  "pages/CloseSupport.tsx",
  "pages/CompetitorSearch.tsx",
  "pages/ScenarioPlanning.tsx",
  "components/aiRoi/executive/LeagueTable.tsx",
  "components/aiRoi/spend/BreakdownTable.tsx",
  "components/aiRoi/spend/InvocationsTable.tsx",
] as const;

/** Intentionally out of scope: row chrome is a `<button>` (menus/buttons exclusion). */
const SKIPPED_SURFACES = [
  {
    rel: "components/PolicyBreakdown.tsx",
    reason: "Lane and rule breakdown rows are `<button>` list controls, not table row shells.",
  },
] as const;

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/** `<tr …>` lines must not keep ad-hoc Tailwind row hover once migrated. */
function trLinesWithAdHocHover(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.includes("<tr") &&
        /hover:bg-black|dark:hover:bg-white/.test(line) &&
        !line.includes("record-row-hover"),
    );
}

/** Approvals list row shell is a `<div>` wrapper, not `<tr>`. */
function approvalsListRowAdHoc(source: string): boolean {
  return (
    /flex items-center gap-3 px-5 py-3 min-h-\[3\.25rem\][\s\S]*?hover:bg-black/.test(source) &&
    !source.includes("record-row-hover")
  );
}

describe("record-row-hover on list/table surfaces", () => {
  it("requires record-row-hover on each in-scope surface file", () => {
    for (const rel of RECORD_ROW_SURFACES) {
      expect(read(rel), rel).toContain("record-row-hover");
    }
  });

  it("forbids ad-hoc Tailwind hover on <tr> record rows in scope", () => {
    for (const rel of RECORD_ROW_SURFACES) {
      if (rel === "pages/Approvals.tsx") continue;
      const offenders = trLinesWithAdHocHover(read(rel));
      expect(offenders, `${rel} still uses ad-hoc row hover on <tr>`).toEqual([]);
    }
  });

  it("forbids ad-hoc hover on Approvals list row shell div", () => {
    expect(approvalsListRowAdHoc(read("pages/Approvals.tsx"))).toBe(false);
  });

  it("documents surfaces skipped by the buttons/menus exclusion", () => {
    for (const { rel, reason } of SKIPPED_SURFACES) {
      expect(read(rel).length, rel).toBeGreaterThan(0);
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});
