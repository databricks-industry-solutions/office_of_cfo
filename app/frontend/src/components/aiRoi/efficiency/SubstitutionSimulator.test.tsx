import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ClassFlowCurve,
  createSimulatorState,
  flowCurvePath,
  FlowCurve,
  parseShareDraft,
  reduceSimulatorState,
  ShareStepper,
  shareKeyStep,
  SubstitutionSimulator,
} from "./SubstitutionSimulator";
import type { SubstitutionModel } from "./substitution";

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
];

describe("SubstitutionSimulator state", () => {
  it("switches to model mode with a valid default pair", () => {
    const state = reduceSimulatorState(
      createSimulatorState(models),
      { type: "set-mode", mode: "model" },
      models,
    );

    expect(state.mode).toBe("model");
    expect(state.sourceModelId).toBe("frontier-a");
    expect(state.destinationModelId).toBe("open-c");
  });

  it("prevents selecting the source model as destination", () => {
    const modelState = reduceSimulatorState(
      createSimulatorState(models),
      { type: "set-mode", mode: "model" },
      models,
    );
    const unchanged = reduceSimulatorState(
      modelState,
      { type: "set-destination-model", modelId: "frontier-a" },
      models,
    );

    expect(unchanged).toEqual(modelState);
  });

  it("resets mode, direction, and traffic share", () => {
    const changed = {
      ...createSimulatorState(models),
      mode: "model" as const,
      sourceModelId: "frontier-b",
      destinationModelId: "open-c",
      share: 85,
    };

    expect(reduceSimulatorState(changed, { type: "reset" }, models)).toEqual(
      createSimulatorState(models),
    );
  });

  it("reverses class direction from either side", () => {
    const initial = createSimulatorState(models);
    const fromOpenWeights = reduceSimulatorState(
      initial,
      { type: "set-source-class", modelClass: "open_weights" },
      models,
    );
    expect(fromOpenWeights.sourceClass).toBe("open_weights");
    expect(fromOpenWeights.destinationClass).toBe("frontier");

    const toFrontier = reduceSimulatorState(
      initial,
      { type: "set-destination-class", modelClass: "frontier" },
      models,
    );
    expect(toFrontier.sourceClass).toBe("open_weights");
    expect(toFrontier.destinationClass).toBe("frontier");
  });

  it("clamps traffic share to the supported range", () => {
    const initial = createSimulatorState(models);
    expect(reduceSimulatorState(initial, { type: "set-share", share: -10 }, models).share).toBe(0);
    expect(reduceSimulatorState(initial, { type: "set-share", share: 150 }, models).share).toBe(100);
  });
});

describe("share stepper helpers", () => {
  it("parses typed drafts and ignores empty input", () => {
    expect(parseShareDraft("63")).toBe(63);
    expect(parseShareDraft(" 40 ")).toBe(40);
    expect(parseShareDraft("")).toBeNull();
    expect(parseShareDraft("abc")).toBeNull();
  });

  it("maps keys to share steps", () => {
    expect(shareKeyStep("ArrowUp", 50)).toBe(55);
    expect(shareKeyStep("ArrowRight", 50)).toBe(55);
    expect(shareKeyStep("ArrowDown", 50)).toBe(45);
    expect(shareKeyStep("ArrowLeft", 50)).toBe(45);
    expect(shareKeyStep("PageUp", 50)).toBe(75);
    expect(shareKeyStep("Home", 50)).toBe(0);
    expect(shareKeyStep("End", 50)).toBe(100);
    expect(shareKeyStep("a", 50)).toBeNull();
  });
});

describe("SubstitutionSimulator markup", () => {
  it("renders an accessible class flow with impact metrics", () => {
    const html = renderToStaticMarkup(<SubstitutionSimulator models={models} />);

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Simulation level"');
    expect(html).toContain("Move traffic from");
    expect(html).toContain("Move traffic to");
    expect(html).toContain('aria-label="Percentage of source traffic moved"');
    expect(html).toContain("Frontier");
    expect(html).toContain("Open Weights");
    expect(html).toContain("38% of traffic");
    expect(html).toContain("63% of traffic");
    expect(html).not.toContain("75% of traffic");
    expect(html).not.toContain("25% of traffic");
    expect(html).toContain("Projected blended $/Mtok");
    expect(html).toContain("Reset");
    expect(html).toContain("ml-auto");
    expect(html).not.toContain('type="range"');
    expect(html).toContain('role="spinbutton"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('aria-label="Decrease traffic moved"');
    expect(html).toContain('aria-label="Increase traffic moved"');
    expect(html.indexOf('data-testid="ai-roi-simulator"')).toBeLessThan(html.indexOf('role="tablist"'));
    expect(html.indexOf('role="tablist"')).toBeLessThan(html.indexOf(">Reset<"));
    expect(html.indexOf(">Reset<")).toBeLessThan(html.indexOf('id="simulator-flow-panel"'));
    expect(html.indexOf('id="simulator-flow-panel"')).toBeLessThan(html.indexOf('role="spinbutton"'));
    expect(html).not.toContain("<select");
    expect(html).not.toContain(" disabled=");
  });

  it("curves the class arrow from the source card to the destination card", () => {
    const down = renderToStaticMarkup(
      <ClassFlowCurve source="frontier" destination="open_weights" share={50} />,
    );
    const up = renderToStaticMarkup(
      <ClassFlowCurve source="open_weights" destination="frontier" share={50} />,
    );

    expect(down).toContain('d="M0 36 C50 36 50 120 100 120"');
    expect(up).toContain('d="M0 120 C50 120 50 36 100 36"');
    expect(down).toContain("50% moved");
  });

  it("disables the stepper buttons at the limits", () => {
    const atZero = renderToStaticMarkup(
      <ShareStepper share={0} onChange={() => {}} />,
    );
    const atMax = renderToStaticMarkup(
      <ShareStepper share={100} onChange={() => {}} />,
    );
    expect(atZero).toMatch(/aria-label="Decrease traffic moved" disabled=""/);
    expect(atZero).not.toMatch(/aria-label="Increase traffic moved" disabled=""/);
    expect(atMax).toMatch(/aria-label="Increase traffic moved" disabled=""/);
  });

  it("curves between arbitrary model card centers", () => {
    expect(flowCurvePath(48, 220)).toBe("M0 48 C50 48 50 220 100 220");
    expect(flowCurvePath(220, 48)).toBe("M0 220 C50 220 50 48 100 48");
    const html = renderToStaticMarkup(<FlowCurve y1={48} y2={220} height={360} share={50} testId="model-flow-curve" />);
    expect(html).toContain('data-testid="model-flow-curve"');
    expect(html).toContain('d="M0 48 C50 48 50 220 100 220"');
  });
});
