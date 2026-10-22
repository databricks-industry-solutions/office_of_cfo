import { describe, expect, it } from "vitest";
import {
  modelRate,
  projectedTokensByModel,
  simulateSubstitution,
  type SubstitutionModel,
} from "./substitution";

const models: SubstitutionModel[] = [
  {
    model_id: "frontier-a",
    name: "Frontier A",
    model_class: "frontier",
    run_cost: 8,
    tokens: 2_000_000,
    cost_per_mtok: 4,
  },
  {
    model_id: "frontier-b",
    name: "Frontier B",
    model_class: "frontier",
    run_cost: 6,
    tokens: 1_000_000,
    cost_per_mtok: 6,
  },
  {
    model_id: "open-c",
    name: "Open C",
    model_class: "open_weights",
    run_cost: 2,
    tokens: 1_000_000,
    cost_per_mtok: 2,
  },
  {
    model_id: "open-d",
    name: "Open D",
    model_class: "open_weights",
    run_cost: 9,
    tokens: 3_000_000,
    cost_per_mtok: 3,
  },
];

describe("simulateSubstitution", () => {
  it("moves class traffic into the destination class current token mix", () => {
    const result = simulateSubstitution(models, {
      mode: "class",
      sourceClass: "frontier",
      destinationClass: "open_weights",
      share: 50,
    });

    expect(result).not.toBeNull();
    expect(result!.movedTokens).toBe(1_500_000);
    expect(result!.currentRunCost).toBe(25);
    expect(result!.projectedRunCost).toBeCloseTo(22.125);
    expect(result!.change).toBeCloseTo(-2.875);
    expect(result!.currentBlendedCostPerMtok).toBeCloseTo(25 / 7);
    expect(result!.projectedBlendedCostPerMtok).toBeCloseTo(22.125 / 7);
  });

  it("moves one model's traffic to one destination model", () => {
    const result = simulateSubstitution(models, {
      mode: "model",
      sourceModelId: "frontier-b",
      destinationModelId: "open-c",
      share: 25,
    });

    expect(result).not.toBeNull();
    expect(result!.movedTokens).toBe(250_000);
    expect(result!.projectedRunCost).toBeCloseTo(24);
    expect(result!.change).toBeCloseTo(-1);
    expect(result!.projectedBlendedCostPerMtok).toBeCloseTo(24 / 7);
  });

  it("rejects an invalid same-model move", () => {
    expect(simulateSubstitution(models, {
      mode: "model",
      sourceModelId: "frontier-a",
      destinationModelId: "frontier-a",
      share: 50,
    })).toBeNull();
  });

  it("uses production token and run-cost overrides consistently", () => {
    const productionModels: SubstitutionModel[] = [
      {
        ...models[0],
        run_cost: 8,
        ai_run_cost: 24,
        tokens: 2_000_000,
        total_tokens: 4_000_000,
        cost_per_mtok: 4,
        blended_cost_per_mtok: 5,
      },
      {
        ...models[2],
        run_cost: 2,
        ai_run_cost: 3,
        tokens: 500_000,
        total_tokens: 1_000_000,
        cost_per_mtok: 2,
        blended_cost_per_mtok: 3,
      },
    ];
    const result = simulateSubstitution(productionModels, {
      mode: "model",
      sourceModelId: "frontier-a",
      destinationModelId: "open-c",
      share: 50,
    });

    expect(result!.currentRunCost).toBe(27);
    expect(result!.movedTokens).toBe(2_000_000);
    expect(result!.projectedRunCost).toBe(21);
    expect(result!.projectedBlendedCostPerMtok).toBeCloseTo(4.2);
    expect(modelRate(productionModels[0])).toBe(5);
  });

  it("returns null for invalid or empty class scenarios", () => {
    expect(simulateSubstitution(models, {
      mode: "class",
      sourceClass: "frontier",
      destinationClass: "frontier",
      share: 50,
    })).toBeNull();
    expect(simulateSubstitution(models.filter((model) => model.model_class === "frontier"), {
      mode: "class",
      sourceClass: "frontier",
      destinationClass: "open_weights",
      share: 50,
    })).toBeNull();
    expect(simulateSubstitution([], {
      mode: "class",
      sourceClass: "frontier",
      destinationClass: "open_weights",
      share: 50,
    })).toBeNull();
  });

  it("leaves cost unchanged when no traffic is moved", () => {
    const result = simulateSubstitution(models, {
      mode: "model",
      sourceModelId: "frontier-a",
      destinationModelId: "open-c",
      share: 0,
    });

    expect(result!.movedTokens).toBe(0);
    expect(result!.change).toBe(0);
    expect(result!.projectedRunCost).toBe(result!.currentRunCost);
  });
});

describe("projectedTokensByModel", () => {
  it("empties the source class when 100% of its traffic is moved", () => {
    const mix = [
      { ...models[0], tokens: 4_000_000 },
      { ...models[2], tokens: 6_000_000 },
    ];
    const next = projectedTokensByModel(mix, {
      mode: "class",
      sourceClass: "frontier",
      destinationClass: "open_weights",
      share: 100,
    });
    expect(next["frontier-a"]).toBe(0);
    expect(next["open-c"]).toBe(10_000_000);
  });

  it("splits class traffic onto destination models in their current mix", () => {
    const next = projectedTokensByModel(models, {
      mode: "class",
      sourceClass: "frontier",
      destinationClass: "open_weights",
      share: 50,
    });
    expect(next["frontier-a"]).toBe(1_000_000);
    expect(next["frontier-b"]).toBe(500_000);
    expect(next["open-c"]).toBe(1_375_000);
    expect(next["open-d"]).toBe(4_125_000);
  });

  it("moves one model's tokens onto the destination model", () => {
    const next = projectedTokensByModel(models, {
      mode: "model",
      sourceModelId: "frontier-b",
      destinationModelId: "open-c",
      share: 25,
    });
    expect(next["frontier-b"]).toBe(750_000);
    expect(next["open-c"]).toBe(1_250_000);
    expect(next["frontier-a"]).toBe(2_000_000);
  });
});
