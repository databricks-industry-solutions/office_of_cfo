export type ModelClass = "frontier" | "open_weights";

export type SubstitutionModel = {
  model_id: string;
  name: string;
  model_class?: string | null;
  run_cost: number;
  ai_run_cost?: number;
  tokens: number;
  total_tokens?: number;
  cost_per_mtok: number | null;
  blended_cost_per_mtok?: number | null;
};

export type SubstitutionScenario =
  | {
      mode: "class";
      sourceClass: ModelClass;
      destinationClass: ModelClass;
      share: number;
    }
  | {
      mode: "model";
      sourceModelId: string;
      destinationModelId: string;
      share: number;
    };

export type SubstitutionImpact = {
  currentRunCost: number;
  projectedRunCost: number;
  change: number;
  currentBlendedCostPerMtok: number;
  projectedBlendedCostPerMtok: number;
  movedTokens: number;
};

function shareFraction(share: number) {
  return Math.max(0, Math.min(100, share)) / 100;
}

export function projectedTokensByModel(
  models: SubstitutionModel[],
  scenario: SubstitutionScenario,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const model of models) next[model.model_id] = modelTokens(model);
  const share = shareFraction(scenario.share);

  if (scenario.mode === "class") {
    if (scenario.sourceClass === scenario.destinationClass) return next;
    const destination = models.filter(
      (model) => modelClass(model) === scenario.destinationClass && modelTokens(model) > 0,
    );
    const destinationTokens = destination.reduce((sum, model) => sum + modelTokens(model), 0);
    if (!destinationTokens) return next;

    let movedTokens = 0;
    for (const model of models) {
      if (modelClass(model) !== scenario.sourceClass) continue;
      const take = modelTokens(model) * share;
      next[model.model_id] -= take;
      movedTokens += take;
    }
    for (const model of destination) {
      next[model.model_id] += movedTokens * (modelTokens(model) / destinationTokens);
    }
    return next;
  }

  if (scenario.sourceModelId === scenario.destinationModelId) return next;
  const source = models.find((model) => model.model_id === scenario.sourceModelId);
  const destination = models.find((model) => model.model_id === scenario.destinationModelId);
  if (!source || !destination) return next;
  const take = modelTokens(source) * share;
  next[source.model_id] -= take;
  next[destination.model_id] += take;
  return next;
}

export function modelClass(model: SubstitutionModel): ModelClass {
  return model.model_class === "frontier" ? "frontier" : "open_weights";
}

export function modelTokens(model: SubstitutionModel): number {
  return model.total_tokens ?? model.tokens;
}

export function modelRate(model: SubstitutionModel): number | null {
  return model.blended_cost_per_mtok ?? model.cost_per_mtok;
}

function modelRunCost(model: SubstitutionModel): number {
  return model.ai_run_cost ?? model.run_cost;
}

export function simulateSubstitution(
  models: SubstitutionModel[],
  scenario: SubstitutionScenario,
): SubstitutionImpact | null {
  const usable = models.filter((model) => modelTokens(model) > 0 && modelRate(model) != null);
  const totalTokens = usable.reduce((sum, model) => sum + modelTokens(model), 0);
  if (!totalTokens) return null;

  const currentRunCost = usable.reduce(
    (sum, model) => sum + modelRunCost(model),
    0,
  );
  const share = shareFraction(scenario.share);
  let movedTokens = 0;
  let removedCost = 0;
  let addedCost = 0;

  if (scenario.mode === "class") {
    if (scenario.sourceClass === scenario.destinationClass) return null;
    const source = usable.filter((model) => modelClass(model) === scenario.sourceClass);
    const destination = usable.filter((model) => modelClass(model) === scenario.destinationClass);
    const destinationTokens = destination.reduce((sum, model) => sum + modelTokens(model), 0);
    if (!source.length || !destinationTokens) return null;

    movedTokens = source.reduce((sum, model) => sum + modelTokens(model) * share, 0);
    removedCost = source.reduce(
      (sum, model) => sum + modelRunCost(model) * share,
      0,
    );
    const destinationCost = destination.reduce(
      (sum, model) => sum + modelRunCost(model),
      0,
    );
    addedCost = movedTokens * (destinationCost / destinationTokens);
  } else {
    if (scenario.sourceModelId === scenario.destinationModelId) return null;
    const source = usable.find((model) => model.model_id === scenario.sourceModelId);
    const destination = usable.find((model) => model.model_id === scenario.destinationModelId);
    if (!source || !destination) return null;

    movedTokens = modelTokens(source) * share;
    removedCost = modelRunCost(source) * share;
    addedCost = movedTokens * (modelRunCost(destination) / modelTokens(destination));
  }

  const projectedRunCost = currentRunCost - removedCost + addedCost;
  return {
    currentRunCost,
    projectedRunCost,
    change: projectedRunCost - currentRunCost,
    currentBlendedCostPerMtok: currentRunCost / (totalTokens / 1_000_000),
    projectedBlendedCostPerMtok: projectedRunCost / (totalTokens / 1_000_000),
    movedTokens,
  };
}
