import { describe, expect, it } from "vitest";
import {
  buildCoverageMatrix,
  countCombinations,
  defaultPageFor,
  visiblePagesFor,
} from "./discovery.ts";
import { INDUSTRIES } from "../src/lib/industries.ts";
import type { HarnessPersona } from "./types.ts";

// A persona whose declared pages include a globally-hidden page (stress-test),
// an industry-hidden page (inventory-exposure, hidden for software/fsi), a
// normally-visible page (executive), and a bogus page id that must be dropped.
const cfo: HarnessPersona = {
  id: "cfo",
  name: "CFO",
  pages: ["executive", "exposure", "inventory-exposure", "stress-test", "not-a-real-page"],
  default_page: "executive",
};

describe("visiblePagesFor", () => {
  it("drops invalid, globally-hidden, and overlay-hidden pages", () => {
    // consumer shows inventory-exposure in the overlay, but stress-test and
    // inventory-exposure are GLOBALLY hidden from nav → both removed. The bogus
    // id is dropped too.
    expect(visiblePagesFor(cfo, "consumer")).toEqual(["executive", "exposure"]);
  });

  it("keeps the same result for software where inventory is also overlay-hidden", () => {
    expect(visiblePagesFor(cfo, "software")).toEqual(["executive", "exposure"]);
  });
});

describe("defaultPageFor", () => {
  it("uses the configured default when visible", () => {
    const visible = visiblePagesFor(cfo, "consumer");
    expect(defaultPageFor(cfo, visible)).toBe("executive");
  });
  it("falls back to the first visible page when the default is hidden", () => {
    const persona: HarnessPersona = { id: "x", pages: ["exposure"], default_page: "stress-test" };
    const visible = visiblePagesFor(persona, "consumer");
    expect(defaultPageFor(persona, visible)).toBe("exposure");
  });
  it("falls back to executive when nothing is visible", () => {
    expect(defaultPageFor(cfo, [])).toBe("executive");
  });
});

describe("buildCoverageMatrix", () => {
  it("covers every industry and skips personas with no visible pages", () => {
    const empty: HarnessPersona = { id: "ghost", pages: ["stress-test"], default_page: "stress-test" };
    const byIndustry = Object.fromEntries(
      INDUSTRIES.map((i) => [i, [cfo, empty]]),
    );
    const matrix = buildCoverageMatrix(byIndustry);
    // N industries × 1 non-empty persona (ghost is dropped everywhere).
    expect(matrix).toHaveLength(INDUSTRIES.length);
    expect(new Set(matrix.map((m) => m.industry))).toEqual(new Set(INDUSTRIES));
    expect(matrix.every((m) => m.personaId === "cfo")).toBe(true);
    expect(matrix[0].pages).toEqual(["executive", "exposure"]);
  });

  it("counts total combinations across the matrix", () => {
    const byIndustry = { consumer: [cfo] } as const;
    const matrix = buildCoverageMatrix(byIndustry, ["consumer"]);
    expect(countCombinations(matrix)).toBe(2);
  });
});
