import { describe, expect, it } from "vitest";
import type { AdhocMapping } from "../api";
import { mappingWarning } from "./adhocMapping";

describe("mappingWarning", () => {
  it("warns when amount role is paired with text data", () => {
    const mapping: AdhocMapping = {
      source: "Revenue",
      target: "amount",
      data_type: "text",
      data_type_confidence: 0.34,
      role_confidence: 0.91,
      user_confirmed_data_type: true,
      user_confirmed_role: false,
    };

    expect(mappingWarning(mapping, "flat")).toBe("Amount usually expects Number, not Text.");
  });

  it("allows numeric period in account-month pivot layouts", () => {
    const mapping: AdhocMapping = {
      source: "Month",
      target: "period",
      data_type: "number",
      data_type_confidence: 0.66,
      role_confidence: 0.82,
      user_confirmed_data_type: false,
      user_confirmed_role: false,
    };

    expect(mappingWarning(mapping, "account_month_pivot")).toBeNull();
  });
});
