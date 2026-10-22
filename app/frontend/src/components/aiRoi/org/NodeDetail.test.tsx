import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OrgNodeDetail } from "./NodeDetail";

vi.mock("../../../api", async () => {
  const actual = await vi.importActual<typeof import("../../../api")>("../../../api");
  return {
    ...actual,
    api: {
      ...actual.api,
      aiRoiOrgDetail: () => new Promise(() => {}),
    },
  };
});

describe("OrgNodeDetail loading", () => {
  it("shows skeleton rows (no loading text) in the breakdown table under the new unit title", () => {
    const html = renderToStaticMarkup(
      <OrgNodeDetail
        scope={{ scope_type: "business_unit", scope_id: "BU-200" }}
        unitLabel="Private Banking"
      />,
    );
    expect(html).toContain("Breakdown - Private Banking");
    expect(html).toContain('class="skeleton');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/>Loading\.\.\.</);
    expect(html).not.toContain("None in scope.");
  });
});
