import { ArrowRight, Minus, Plus, RotateCcw } from "lucide-react";
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/cn";
import { Card } from "../../ui";
import { money, unitPrice } from "../revenue/format";
import {
  type ModelClass,
  type SubstitutionModel,
  modelClass,
  modelRate,
  modelTokens,
  projectedTokensByModel,
  simulateSubstitution,
} from "./substitution";

export type SimulatorMode = "class" | "model";

export type SimulatorState = {
  mode: SimulatorMode;
  sourceClass: ModelClass;
  destinationClass: ModelClass;
  sourceModelId: string;
  destinationModelId: string;
  share: number;
};

export type SimulatorAction =
  | { type: "set-mode"; mode: SimulatorMode }
  | { type: "set-source-class"; modelClass: ModelClass }
  | { type: "set-destination-class"; modelClass: ModelClass }
  | { type: "set-source-model"; modelId: string }
  | { type: "set-destination-model"; modelId: string }
  | { type: "set-share"; share: number }
  | { type: "reset" };

function usableModels(models: SubstitutionModel[]) {
  return models.filter((model) => modelTokens(model) > 0 && modelRate(model) != null);
}

export function createSimulatorState(models: SubstitutionModel[]): SimulatorState {
  const usable = usableModels(models);
  const source = usable.find((model) => modelClass(model) === "frontier") ?? usable[0];
  const destination = usable.find(
    (model) => modelClass(model) === "open_weights" && model.model_id !== source?.model_id,
  ) ?? usable.find((model) => model.model_id !== source?.model_id);
  return {
    mode: "class",
    sourceClass: "frontier",
    destinationClass: "open_weights",
    sourceModelId: source?.model_id ?? "",
    destinationModelId: destination?.model_id ?? "",
    share: 50,
  };
}

export function reduceSimulatorState(
  state: SimulatorState,
  action: SimulatorAction,
  models: SubstitutionModel[],
): SimulatorState {
  if (action.type === "reset") return createSimulatorState(models);
  if (action.type === "set-mode") {
    const defaults = createSimulatorState(models);
    return action.mode === "class"
      ? { ...state, mode: "class", sourceClass: "frontier", destinationClass: "open_weights" }
      : {
          ...state,
          mode: "model",
          sourceModelId: defaults.sourceModelId,
          destinationModelId: defaults.destinationModelId,
        };
  }
  if (action.type === "set-source-class") {
    return {
      ...state,
      sourceClass: action.modelClass,
      destinationClass: action.modelClass === "frontier" ? "open_weights" : "frontier",
    };
  }
  if (action.type === "set-destination-class") {
    return {
      ...state,
      destinationClass: action.modelClass,
      sourceClass: action.modelClass === "frontier" ? "open_weights" : "frontier",
    };
  }
  if (action.type === "set-source-model") {
    return action.modelId === state.destinationModelId ? state : { ...state, sourceModelId: action.modelId };
  }
  if (action.type === "set-destination-model") {
    return action.modelId === state.sourceModelId ? state : { ...state, destinationModelId: action.modelId };
  }
  return { ...state, share: Math.max(0, Math.min(100, action.share)) };
}

function classLabel(value: ModelClass) {
  return value === "frontier" ? "Frontier" : "Open Weights";
}

function trafficLabel(tokens: number, total: number) {
  return total ? `${Math.round((tokens / total) * 100)}% of traffic` : "No traffic";
}

function FlowCard({
  label,
  detail,
  rate,
  selected,
  disabled,
  onClick,
  className,
  anchor,
}: {
  label: string;
  detail: string;
  rate: number | null;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  anchor?: "source" | "destination";
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      data-flow-anchor={anchor}
      onClick={onClick}
      className={cn(
        "w-full rounded-xl px-3 py-2.5 text-left ring-1 transition",
        className,
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        selected
          ? "bg-black/[0.06] text-fg ring-line-strong"
          : "bg-ink-800 text-fg-muted ring-line hover:bg-black/[0.04]",
        disabled && "cursor-not-allowed opacity-30",
      )}
    >
      <span className="block truncate text-sm font-semibold">{label}</span>
      <span className="mt-1 flex items-center justify-between gap-2 text-[11px] text-fg-subtle">
        <span>{detail}</span>
        <span className="num shrink-0">{unitPrice(rate)}/Mtok</span>
      </span>
    </button>
  );
}

const CLASS_ORDER: ModelClass[] = ["frontier", "open_weights"];
const CLASS_CARD_HEIGHT = 72;
const CLASS_CARD_GAP = 12;
const CLASS_STACK_HEIGHT = CLASS_CARD_HEIGHT * 2 + CLASS_CARD_GAP;
const MODEL_STACK_HEIGHT = 360;

function classCardCenter(value: ModelClass) {
  return CLASS_ORDER.indexOf(value) * (CLASS_CARD_HEIGHT + CLASS_CARD_GAP) + CLASS_CARD_HEIGHT / 2;
}

const SHARE_STEP = 5;
const SHARE_PAGE_STEP = 25;

export function parseShareDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

export function shareKeyStep(key: string, share: number): number | null {
  switch (key) {
    case "ArrowUp":
    case "ArrowRight":
      return share + SHARE_STEP;
    case "ArrowDown":
    case "ArrowLeft":
      return share - SHARE_STEP;
    case "PageUp":
      return share + SHARE_PAGE_STEP;
    case "PageDown":
      return share - SHARE_PAGE_STEP;
    case "Home":
      return 0;
    case "End":
      return 100;
    default:
      return null;
  }
}

export function ShareStepper({
  share,
  onChange,
  className,
  style,
}: {
  share: number;
  onChange: (share: number) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const parsed = draft == null ? null : parseShareDraft(draft);
    if (parsed != null) onChange(parsed);
    setDraft(null);
  };
  const stepButton = "grid h-6 w-6 place-items-center rounded-full text-fg-muted transition hover:bg-black/[0.06] hover:text-fg disabled:pointer-events-none disabled:opacity-30";
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 rounded-full bg-ink-800 p-1 text-sm font-semibold text-fg ring-1 ring-line", className)}
      style={style}
    >
      <button
        type="button"
        aria-label="Decrease traffic moved"
        disabled={share <= 0}
        onClick={() => onChange(share - SHARE_STEP)}
        className={stepButton}
      >
        <Minus size={13} aria-hidden="true" />
      </button>
      <span className="flex items-baseline px-1">
        <input
          type="text"
          inputMode="numeric"
          role="spinbutton"
          aria-label="Percentage of source traffic moved"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={share}
          aria-valuetext={`${share}% moved`}
          value={draft ?? String(share)}
          onFocus={(event) => event.target.select()}
          onChange={(event) => setDraft(event.target.value.replace(/\D/g, "").slice(0, 3))}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
              return;
            }
            if (event.key === "Escape") {
              setDraft(null);
              return;
            }
            const next = shareKeyStep(event.key, share);
            if (next == null) return;
            event.preventDefault();
            setDraft(null);
            onChange(next);
          }}
          className="num w-[3ch] rounded bg-transparent text-right focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        />
        <span>%&nbsp;moved</span>
      </span>
      <button
        type="button"
        aria-label="Increase traffic moved"
        disabled={share >= 100}
        onClick={() => onChange(share + SHARE_STEP)}
        className={stepButton}
      >
        <Plus size={13} aria-hidden="true" />
      </button>
    </span>
  );
}

export function flowCurvePath(y1: number, y2: number) {
  return `M0 ${y1} C50 ${y1} 50 ${y2} 100 ${y2}`;
}

/** Curved ribbon from a source card (left) to a destination card (right). */
export function FlowCurve({
  y1,
  y2,
  height,
  share,
  onShareChange,
  testId,
}: {
  y1: number;
  y2: number;
  height: number;
  share: number;
  onShareChange?: (share: number) => void;
  testId?: string;
}) {
  const path = flowCurvePath(y1, y2);
  return (
    <div className="relative -mx-4 h-full" data-testid={testId} style={{ height }}>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="absolute left-0 top-0 h-full w-[calc(100%-12px)]"
        aria-hidden="true"
      >
        <path
          d={path}
          fill="none"
          stroke="var(--c-efficiency-line)"
          strokeOpacity="0.28"
          strokeWidth={6 + share * 0.2}
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={path}
          fill="none"
          stroke="var(--c-efficiency-line)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <svg
        viewBox="0 0 14 18"
        width="14"
        height="18"
        className="absolute right-0"
        style={{ top: y2 - 9 }}
        aria-hidden="true"
      >
        <path d="M0 0 L14 9 L0 18 Z" fill="var(--c-efficiency-line)" />
      </svg>
      {onShareChange ? (
        <ShareStepper
          share={share}
          onChange={onShareChange}
          className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 shadow-sm"
          style={{ top: (y1 + y2) / 2 }}
        />
      ) : (
        <span
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-800 px-3 py-1 text-sm font-semibold text-fg ring-1 ring-line"
          style={{ top: (y1 + y2) / 2 }}
        >
          {share}% moved
        </span>
      )}
    </div>
  );
}

export function ClassFlowCurve({
  source,
  destination,
  share,
  onShareChange,
}: {
  source: ModelClass;
  destination: ModelClass;
  share: number;
  onShareChange?: (share: number) => void;
}) {
  return (
    <div className="hidden md:block">
      <FlowCurve
        y1={classCardCenter(source)}
        y2={classCardCenter(destination)}
        height={CLASS_STACK_HEIGHT}
        share={share}
        onShareChange={onShareChange}
        testId="class-flow-curve"
      />
    </div>
  );
}

function MeasuredFlowCurve({
  share,
  onShareChange,
  sourceId,
  destinationId,
}: {
  share: number;
  onShareChange: (share: number) => void;
  sourceId: string;
  destinationId: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState<{ y1: number; y2: number } | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const canvas = box.closest("[data-flow-canvas]");
    if (!(canvas instanceof HTMLElement)) return;

    const measure = () => {
      const source = canvas.querySelector('[data-flow-anchor="source"]');
      const dest = canvas.querySelector('[data-flow-anchor="destination"]');
      if (!(source instanceof HTMLElement) || !(dest instanceof HTMLElement)) return;
      const origin = box.getBoundingClientRect();
      const from = source.getBoundingClientRect();
      const to = dest.getBoundingClientRect();
      setGeom({
        y1: from.top + from.height / 2 - origin.top,
        y2: to.top + to.height / 2 - origin.top,
      });
    };

    canvas.querySelector('[data-flow-anchor="source"]')?.scrollIntoView({ block: "nearest" });
    canvas.querySelector('[data-flow-anchor="destination"]')?.scrollIntoView({ block: "nearest" });
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    const scrolls = [...canvas.querySelectorAll("[data-flow-scroll]")];
    scrolls.forEach((node) => {
      node.addEventListener("scroll", measure, { passive: true });
      observer.observe(node);
    });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      scrolls.forEach((node) => node.removeEventListener("scroll", measure));
      window.removeEventListener("resize", measure);
    };
  }, [sourceId, destinationId]);

  return (
    <div
      ref={boxRef}
      data-testid="model-flow-curve"
      className="relative hidden md:block"
      style={{ height: MODEL_STACK_HEIGHT }}
    >
      {geom && (
        <FlowCurve
          y1={geom.y1}
          y2={geom.y2}
          height={MODEL_STACK_HEIGHT}
          share={share}
          onShareChange={onShareChange}
        />
      )}
    </div>
  );
}

function ImpactTile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "good" | "warn";
}) {
  return (
    <div className="rounded-xl bg-black/[0.025] px-4 py-4 text-center ring-1 ring-line">
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle">{label}</div>
      <div
        className={cn(
          "num mt-1.5 text-2xl font-semibold",
          tone === "good" ? "text-signal-good" : tone === "warn" ? "text-signal-warn" : "text-fg",
        )}
      >
        {value}
      </div>
      {detail && <div className="num mt-1 text-xs text-fg-subtle">{detail}</div>}
    </div>
  );
}

export function SubstitutionSimulator({ models }: { models: SubstitutionModel[] }) {
  const usable = useMemo(() => usableModels(models), [models]);
  const signature = usable.map((model) => model.model_id).join("|");
  const [state, setState] = useState<SimulatorState>(() => createSimulatorState(usable));
  useEffect(() => setState(createSimulatorState(usable)), [signature]);
  const dispatch = (action: SimulatorAction) => {
    setState((current) => reduceSimulatorState(current, action, usable));
  };

  if (usable.length < 2) {
    return (
      <Card title="Substitution simulator">
        <p className="p-5 text-sm text-fg-muted">Needs at least two models with traffic in scope.</p>
      </Card>
    );
  }

  const totalTokens = usable.reduce((sum, model) => sum + modelTokens(model), 0);
  const scenario = state.mode === "class"
    ? {
        mode: "class" as const,
        sourceClass: state.sourceClass,
        destinationClass: state.destinationClass,
        share: state.share,
      }
    : {
        mode: "model" as const,
        sourceModelId: state.sourceModelId,
        destinationModelId: state.destinationModelId,
        share: state.share,
      };
  const projectedTokens = projectedTokensByModel(usable, scenario);
  const classStats = (value: ModelClass) => {
    const members = usable.filter((model) => modelClass(model) === value);
    const tokens = members.reduce((sum, model) => sum + (projectedTokens[model.model_id] ?? 0), 0);
    const cost = members.reduce(
      (sum, model) => sum + (modelTokens(model) / 1_000_000) * (modelRate(model) ?? 0),
      0,
    );
    const currentTokens = members.reduce((sum, model) => sum + modelTokens(model), 0);
    return { tokens, rate: currentTokens ? cost / (currentTokens / 1_000_000) : null };
  };
  const impact = simulateSubstitution(usable, scenario);
  const sourceLabel = state.mode === "class"
    ? classLabel(state.sourceClass)
    : usable.find((model) => model.model_id === state.sourceModelId)?.name ?? "Source";
  const destinationLabel = state.mode === "class"
    ? classLabel(state.destinationClass)
    : usable.find((model) => model.model_id === state.destinationModelId)?.name ?? "Destination";

  const modeTabs = (
    <div
      role="tablist"
      aria-label="Simulation level"
      className="inline-flex shrink-0 rounded-lg bg-black/[0.035] p-1 ring-1 ring-line"
    >
      {(["class", "model"] as SimulatorMode[]).map((mode) => (
        <button
          key={mode}
          type="button"
          role="tab"
          id={`simulator-tab-${mode}`}
          aria-controls="simulator-flow-panel"
          aria-selected={state.mode === mode}
          tabIndex={state.mode === mode ? 0 : -1}
          onClick={() => dispatch({ type: "set-mode", mode })}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition",
            state.mode === mode ? "bg-ink-800 text-fg ring-1 ring-line" : "text-fg-muted hover:text-fg",
          )}
        >
          {mode === "class" ? "Class move" : "Model move"}
        </button>
      ))}
    </div>
  );

  const setShare = (share: number) => dispatch({ type: "set-share", share });

  const resetButton = (
    <button
      type="button"
      onClick={() => dispatch({ type: "reset" })}
      className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-muted hover:text-fg"
    >
      <RotateCcw size={13} aria-hidden="true" />
      Reset
    </button>
  );

  const renderClassCards = (side: "source" | "destination") => (
    <div className="flex flex-col" style={{ gap: CLASS_CARD_GAP }}>
      {CLASS_ORDER.map((value) => {
        const stats = classStats(value);
        const selected = side === "source" ? state.sourceClass === value : state.destinationClass === value;
        return (
          <FlowCard
            key={value}
            label={classLabel(value)}
            detail={trafficLabel(stats.tokens, totalTokens)}
            rate={stats.rate}
            selected={selected}
            className="h-[72px]"
            anchor={selected ? side : undefined}
            onClick={() => dispatch({
              type: side === "source" ? "set-source-class" : "set-destination-class",
              modelClass: value,
            })}
          />
        );
      })}
    </div>
  );

  const renderModelCards = (side: "source" | "destination") => (
    <div data-flow-scroll className="h-[360px] space-y-3 overflow-y-auto pr-1">
      {(["frontier", "open_weights"] as ModelClass[]).map((value) => (
        <div key={value}>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
            {classLabel(value)}
          </div>
          <div className="space-y-1.5">
            {usable.filter((model) => modelClass(model) === value).map((model) => {
              const selectedId = side === "source" ? state.sourceModelId : state.destinationModelId;
              const oppositeId = side === "source" ? state.destinationModelId : state.sourceModelId;
              return (
                <FlowCard
                  key={model.model_id}
                  label={model.name}
                  detail={trafficLabel(projectedTokens[model.model_id] ?? 0, totalTokens)}
                  rate={modelRate(model)}
                  selected={selectedId === model.model_id}
                  disabled={oppositeId === model.model_id}
                  anchor={selectedId === model.model_id ? side : undefined}
                  onClick={() => dispatch({
                    type: side === "source" ? "set-source-model" : "set-destination-model",
                    modelId: model.model_id,
                  })}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <Card title="Substitution simulator">
      <div data-testid="ai-roi-simulator" className="space-y-5 p-5">
        <div className="flex items-center gap-3">
          {modeTabs}
          {resetButton}
        </div>
        <div
          id="simulator-flow-panel"
          role="tabpanel"
          aria-labelledby={`simulator-tab-${state.mode}`}
          tabIndex={0}
          className="rounded-2xl bg-black/[0.018] p-4 ring-1 ring-line"
        >
          <div
            data-flow-canvas
            className="grid gap-4 md:grid-cols-[minmax(190px,0.9fr)_minmax(180px,1.2fr)_minmax(190px,0.9fr)]"
          >
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                Move traffic from
              </div>
              {state.mode === "class" ? renderClassCards("source") : renderModelCards("source")}
            </div>
            <div>
              <div aria-hidden="true" className="invisible mb-2 text-[11px] font-semibold uppercase tracking-wide">
                Flow
              </div>
              {state.mode === "class" ? (
                <ClassFlowCurve
                  source={state.sourceClass}
                  destination={state.destinationClass}
                  share={state.share}
                  onShareChange={setShare}
                />
              ) : (
                <MeasuredFlowCurve
                  share={state.share}
                  onShareChange={setShare}
                  sourceId={state.sourceModelId}
                  destinationId={state.destinationModelId}
                />
              )}
              <div className="flex flex-col items-center gap-2 text-sm font-medium text-fg-muted md:hidden">
                <div className="flex items-center gap-2">
                  <span className="max-w-[40vw] truncate">{sourceLabel}</span>
                  <ArrowRight size={14} aria-hidden="true" />
                  <span className="max-w-[40vw] truncate">{destinationLabel}</span>
                </div>
                <ShareStepper share={state.share} onChange={setShare} />
              </div>
            </div>
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                Move traffic to
              </div>
              {state.mode === "class" ? renderClassCards("destination") : renderModelCards("destination")}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-live="polite">
          {impact && (
            <>
            <ImpactTile label="Current run cost" value={money(impact.currentRunCost)} />
            <ImpactTile
              label="Projected run cost"
              value={money(impact.projectedRunCost)}
              tone={impact.change <= 0 ? "good" : "warn"}
            />
            <ImpactTile
              label={impact.change <= 0 ? "Savings" : "Increase"}
              value={money(Math.abs(impact.change))}
              detail={`${state.share}% of source traffic`}
              tone={impact.change <= 0 ? "good" : "warn"}
            />
            <ImpactTile
              label="Projected blended $/Mtok"
              value={unitPrice(impact.projectedBlendedCostPerMtok)}
              detail={`${unitPrice(impact.currentBlendedCostPerMtok)} current`}
              tone={impact.change <= 0 ? "good" : "warn"}
            />
            </>
          )}
        </div>
        <p className="text-xs text-fg-muted">
          Projected figures preserve token volume and change only the model cost mix.
        </p>
      </div>
    </Card>
  );
}
