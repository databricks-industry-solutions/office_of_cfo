import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CONSOLIDATED, type AiRoiOrgNode, type Scope } from "../../api";
import {
  OrgExplorerTopic,
  aiRoiScopeLabel,
  clearAiRoiScope,
  findAiRoiOrgName,
  isFilteredAiRoiScope,
} from "./ScopeFilterBar";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    api: {
      ...actual.api,
      aiRoiOrg: () => new Promise(() => {}),
    },
  };
});

const tree: AiRoiOrgNode[] = [{
  key: "ROOT",
  name: "Enterprise",
  level: 0,
  run_cost: 0,
  realised_value: 0,
  children: [
    { key: "BU-100", name: "Payments", level: 1, run_cost: 1, realised_value: 1, children: [] },
  ],
}];

const buScope: Scope = { scope_type: "business_unit", scope_id: "BU-100" };

describe("AI ROI scope filter", () => {
  it("treats only non-consolidated scopes as filtered", () => {
    expect(isFilteredAiRoiScope(CONSOLIDATED)).toBe(false);
    expect(isFilteredAiRoiScope(buScope)).toBe(true);
  });

  it("resolves the AI ROI unit name, not the close org id", () => {
    expect(findAiRoiOrgName(tree, "BU-100")).toBe("Payments");
    expect(aiRoiScopeLabel(buScope, tree)).toBe("Payments");
    expect(aiRoiScopeLabel(buScope, tree)).not.toBe("North America");
    expect(aiRoiScopeLabel({ scope_type: "use_case", scope_id: "collections" }, tree)).toBe("collections");
  });

  it("clearAiRoiScope resets to CONSOLIDATED", () => {
    const seen: Scope[] = [];
    clearAiRoiScope((s) => seen.push(s));
    expect(seen).toEqual([CONSOLIDATED]);
  });

  it("does not tint or suffix the Org Explorer tab when consolidated", () => {
    const html = renderToStaticMarkup(
      <OrgExplorerTopic
        pageLabel="Org Explorer"
        active={false}
        scope={CONSOLIDATED}
        onSelect={() => {}}
        onClear={() => {}}
      />,
    );
    expect(html).toContain("Org Explorer");
    expect(html).not.toContain("· ");
    expect(html).not.toContain("bg-heat-blue/50");
    expect(html).not.toContain('data-testid="ai-roi-scope-clear"');
  });

  it("tints the Org Explorer tab, shows the unit, and offers a sibling clear control", () => {
    const html = renderToStaticMarkup(
      <OrgExplorerTopic
        pageLabel="Org Explorer"
        active={false}
        scope={buScope}
        onSelect={() => {}}
        onClear={() => {}}
      />,
    );
    expect(html).toContain('data-testid="ai-roi-scope-filter"');
    expect(html).toContain("bg-heat-blue/50");
    expect(html).not.toContain("ring-blue-400");
    expect(html).toContain("· BU-100");
    expect(html).toContain("text-[11px]");
    expect(html).toContain('data-testid="ai-roi-scope-clear"');
    expect(html).toContain('aria-label="Clear filter"');
    expect(html).toContain("h-3 w-3");
    expect(html).not.toContain("ring-1 ring-line hover:bg-black");
    expect(html).not.toContain("Showing ");
    expect(html).not.toContain("Clear filter</button>");
  });
});
