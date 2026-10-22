import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdhocMapping } from "../api";
import { AdhocColumnInference, AdhocInferenceStrip } from "./AdhocColumnInference";

describe("AdhocColumnInference", () => {
  it("renders dual inference controls and confidence copy", () => {
    const mapping: AdhocMapping = {
      source: "Revenue",
      target: "metric_id",
      data_type: "text",
      data_type_confidence: 0.98,
      role_confidence: 0.94,
      user_confirmed_data_type: false,
      user_confirmed_role: false,
    };

    const markup = renderToStaticMarkup(
      <AdhocColumnInference
        mapping={mapping}
        layoutKind="flat"
        sampleValues={["2026-06", "2026-07", "2026-08"]}
        onChange={() => {}}
      />,
    );

    expect(markup).toContain('<option value="number">Number</option>');
    expect(markup).toContain('<option value="datetime">Date &amp; time</option>');
    expect(markup).toContain('<option value="amount">Amount</option>');
    expect(markup).toContain("Data type");
    expect(markup).toContain("98% confidence");
    expect(markup).toContain("Use as");
    expect(markup).toContain("94% confidence");
    expect(markup).toContain("Revenue");
    expect(markup).toContain("flex-none");
  });

  it("keeps column cards in one horizontally scrollable row", () => {
    const markup = renderToStaticMarkup(
      <AdhocInferenceStrip>
        <div>Account</div>
        <div>Month</div>
      </AdhocInferenceStrip>,
    );

    expect(markup).toContain("flex-nowrap");
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("max-w-full");
    expect(markup).toContain("min-w-0");
    expect(markup).not.toContain("grid-cols");
  });
});
