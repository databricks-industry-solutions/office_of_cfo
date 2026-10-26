import { describe, expect, it } from "vitest";
import type { ScenarioPlan } from "../api";
import { planValues, scenarioFromQuery } from "./CashFlow";
import { scenarioFromQuery as spScenarioFromQuery } from "./ScenarioPlanning";

describe("scenario deep links", () => {
  it("reads scenario=<id> from the hash query on both lenses", () => {
    expect(scenarioFromQuery("scenario=scn-123")).toBe("scn-123");
    expect(spScenarioFromQuery("x=1&scenario=scn-9")).toBe("scn-9");
    expect(scenarioFromQuery("")).toBeNull();
    expect(scenarioFromQuery(undefined)).toBeNull();
  });
});

describe("planValues", () => {
  it("flattens stored assumptions to driver values", () => {
    const plan = { assumptions: { debt_draw: { value: 2.5 }, dso: { value: -3 } } } as unknown as ScenarioPlan;
    expect(planValues(plan)).toEqual({ debt_draw: 2.5, dso: -3 });
    expect(planValues(null)).toEqual({});
  });
});
