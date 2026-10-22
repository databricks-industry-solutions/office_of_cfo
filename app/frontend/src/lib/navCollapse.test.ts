import { describe, expect, it } from "vitest";
import { nextCollapsedTopic } from "./navCollapse";

describe("nextCollapsedTopic", () => {
  it("collapses and re-expands the active multi-page topic", () => {
    expect(nextCollapsedTopic(null, "performance", true, 3)).toBe("performance");
    expect(nextCollapsedTopic("performance", "performance", true, 3)).toBeNull();
  });

  it("clears L3 collapse when switching topics", () => {
    expect(nextCollapsedTopic("performance", "risk", false, 3)).toBeNull();
  });

  it("does not collapse a single-page topic", () => {
    expect(nextCollapsedTopic(null, "overview", true, 1)).toBeNull();
  });
});
