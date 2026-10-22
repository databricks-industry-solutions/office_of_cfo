import { describe, expect, it } from "vitest";
import {
  aiRecommendation,
  bandLayoutValue,
  dimBySearch,
  legacyPageRedirect,
  nodeCaption,
  queryFromSelection,
  selectionLabel,
} from "./lineageGraph";

describe("bandLayoutValue", () => {
  it("damps success volume so large hops do not dominate layout", () => {
    const laid = bandLayoutValue(10_000, "success", 10_000);
    expect(laid).toBe(Math.sqrt(10_000));
    expect(laid).toBeLessThan(10_000);
  });

  it("gives warnings and errors a visual floor without changing the true count", () => {
    const count = 3;
    const laid = bandLayoutValue(count, "error", 10_000);
    expect(laid).toBeGreaterThan(Math.sqrt(count));
    expect(count).toBe(3);
  });

  it("returns 0 for empty bands", () => {
    expect(bandLayoutValue(0, "error", 1000)).toBe(0);
  });
});

describe("nodeCaption", () => {
  it("shows total records and issue mix", () => {
    expect(nodeCaption({ success: 12480, warning: 18, error: 4, unavailable: 0 }))
      .toBe("12,502 records · 18 warn · 4 err");
  });
});

describe("legacyPageRedirect", () => {
  it("maps retired Data & Audit pages onto the unified lineage page", () => {
    expect(legacyPageRedirect("audit-log")).toBe("data-sources");
    expect(legacyPageRedirect("supply-chain")).toBe("data-sources");
    expect(legacyPageRedirect("data-sources")).toBe("data-sources");
    expect(legacyPageRedirect("ai-roi-revenue")).toBe("ai-roi-roi");
    expect(legacyPageRedirect("ai-roi-profitability")).toBe("ai-roi-roi");
    expect(legacyPageRedirect("tasks")).toBe("tasks");
  });
});

describe("queryFromSelection", () => {
  it("sends flow_id and status for a link click", () => {
    expect(queryFromSelection({ kind: "link", linkId: "x", flowId: "ap", status: "error" }))
      .toEqual({ flow_id: "ap", status: "error" });
    expect(queryFromSelection(
      { kind: "link", linkId: "x", flowId: "ap", status: "error" },
      { status: "warning" },
    )).toEqual({ flow_id: "ap", status: "warning" });
    expect(queryFromSelection(
      { kind: "link", linkId: "x", flowId: "ap", status: "error" },
      { status: "" },
    )).toEqual({ flow_id: "ap" });
  });

  it("sends node_id for a node click", () => {
    expect(queryFromSelection({ kind: "node", nodeId: "dom:Accounts Payable" }))
      .toEqual({ node_id: "dom:Accounts Payable" });
  });

  it("omits flow filters for the all-flows view", () => {
    expect(queryFromSelection({ kind: "all" }, { search: "legacy" }))
      .toEqual({ search: "legacy" });
  });
});

describe("selectionLabel", () => {
  it("labels the all-flows view", () => {
    expect(selectionLabel({ kind: "all" })).toBe("All flows");
  });
});

describe("dimBySearch", () => {
  it("dims nothing when search is inactive", () => {
    expect(dimBySearch("gl", null)).toBe(false);
  });

  it("keeps matching flows bright and dims the rest", () => {
    expect(dimBySearch("gl", ["gl"])).toBe(false);
    expect(dimBySearch("ap", ["gl"])).toBe(true);
    expect(dimBySearch("gl", [])).toBe(true);
  });
});

describe("aiRecommendation", () => {
  it("is null unless the row is an error", () => {
    expect(aiRecommendation({ status: "success", rule: "ingestion_schema_reject" })).toBeNull();
    expect(aiRecommendation({ status: "warning", rule: "ingestion_duplicate_key" })).toBeNull();
  });

  it("returns a short rule-specific next step", () => {
    const text = aiRecommendation({ status: "error", rule: "ingestion_schema_reject" });
    expect(text).toMatch(/re-land/i);
    expect((text ?? "").split(/(?<=[.!?])\s+/).filter(Boolean).length).toBeLessThanOrEqual(2);
  });

  it("falls back to stage when the rule is unknown", () => {
    expect(aiRecommendation({ status: "error", rule: "unknown_check", stage: "reconciliation" }))
      .toMatch(/recon/i);
  });
});
