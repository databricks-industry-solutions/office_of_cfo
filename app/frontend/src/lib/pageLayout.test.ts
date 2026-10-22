import { describe, expect, it } from "vitest";
import { PAGES, PageId } from "../nav";
import { layoutForPage, PAGE_LAYOUT, shellContainerClass } from "./pageLayout";

describe("PAGE_LAYOUT", () => {
  it("assigns a layout mode to every page", () => {
    for (const page of PAGES) {
      expect(PAGE_LAYOUT[page.id], page.id).toMatch(/^(standard|wide|full)$/);
    }
  });

  it("uses wide for dashboards and full for dense tables and graphs", () => {
    expect(layoutForPage("executive")).toBe("wide");
    expect(layoutForPage("dashboard")).toBe("wide");
    expect(layoutForPage("adhoc-analysis")).toBe("wide");
    expect(layoutForPage("trial-balance")).toBe("full");
    expect(layoutForPage("comparative-statements")).toBe("full");
    expect(layoutForPage("financial-statements")).toBe("full");
    expect(layoutForPage("exposure")).toBe("full");
    expect(layoutForPage("inventory-exposure")).toBe("full");
    expect(layoutForPage("settings")).toBe("standard");
  });

  it("falls back to standard for an unknown page id", () => {
    expect(layoutForPage("not-a-page" as PageId)).toBe("standard");
  });
});

describe("shellContainerClass", () => {
  it("applies adaptive gutters and the matching max-width", () => {
    expect(shellContainerClass("standard")).toContain("max-w-[90rem]");
    expect(shellContainerClass("wide")).toContain("max-w-[105rem]");
    expect(shellContainerClass("full")).toContain("max-w-none");
    expect(shellContainerClass("wide")).toContain("px-[var(--app-gutter)]");
  });
});
