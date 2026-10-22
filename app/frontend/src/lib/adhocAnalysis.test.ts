import { describe, expect, it } from "vitest";
import { getOverlay } from "./industries";
import { narrativeBullets } from "./adhocAnalysis";

describe("narrativeBullets", () => {
  it("uses overlay statement labels for the current industry", () => {
    const bullets = narrativeBullets(
      [{
        line_id: "revenue",
        line_label: "Revenue",
        sort_order: 1,
        actual: 100,
        uploaded: 103,
        gap: 3,
        gap_pct: 3,
        favorable: true,
        source_range: "B3:E3",
      }],
      4,
      54,
      getOverlay("fsi"),
    );

    expect(bullets[0]).toContain("Net Interest & Fee Income");
    expect(bullets[0]).not.toContain("on Revenue");
  });
});
