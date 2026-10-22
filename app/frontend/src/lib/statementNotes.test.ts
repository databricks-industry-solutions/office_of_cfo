import { describe, expect, it } from "vitest";
import { DEFAULT_STATEMENT_NOTES, resolveStatementNotes } from "./statementNotes";

describe("statementNotes", () => {
  it("includes going-concern basis in accounting policies", () => {
    const policies = DEFAULT_STATEMENT_NOTES.find((n) => n.id === "accounting_policies");
    expect(policies?.body.toLowerCase()).toContain("going concern");
  });

  it("qualifies taxation note for taxes payable on the balance sheet when applicable", () => {
    const tax = DEFAULT_STATEMENT_NOTES.find((n) => n.id === "taxation");
    expect(tax?.body).toMatch(/taxes payable/i);
    expect(tax?.body).toMatch(/balance sheet/i);
    expect(tax?.body).toMatch(/when applicable/i);
  });

  it("returns default notes when overlay override is omitted", () => {
    expect(resolveStatementNotes()).toHaveLength(DEFAULT_STATEMENT_NOTES.length);
  });
});
