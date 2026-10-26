import { describe, expect, it } from "vitest";
import {
  AUDIT_HOLD_SECONDS,
  AUDIT_RATE,
  GATE_T,
  LOOP_SECONDS,
  buildFlowGeometry,
  createFlowState,
  stepFlow,
} from "./SignalNetworkBackdrop";

const W = 1440;
const H = 900;
const DT = 1 / 30;

function advance(
  state: ReturnType<typeof createFlowState>,
  geometry: ReturnType<typeof buildFlowGeometry>,
  seconds: number,
) {
  for (let elapsed = 0; elapsed < seconds; elapsed += DT) {
    stepFlow(state, geometry, DT);
  }
}

describe("governed signal flow geometry", () => {
  const g = buildFlowGeometry(W, H);

  it("brings streams in from the left edge and the left half of top and bottom only", () => {
    expect(g.streams).toHaveLength(8);
    const edges = new Set(
      g.streams.map(({ p0 }) =>
        p0.y < 0 ? "top" : p0.y > H ? "bottom" : p0.x < 0 ? "left" : p0.x > W ? "right" : "inside",
      ),
    );
    expect(edges).toEqual(new Set(["top", "bottom", "left"]));
    g.streams.forEach(({ p0 }) => expect(p0.x).toBeLessThan(W / 2));
  });

  it("tangles some streams across each other before they merge", () => {
    const entryOrder = [...g.streams].sort((a, b) => a.p0.y - b.p0.y);
    const controlOrder = [...g.streams].sort((a, b) => a.p1.y - b.p1.y);
    expect(entryOrder).not.toEqual(controlOrder);
  });

  it("gates every stream before it merges into one shared spine", () => {
    expect(g.gates).toHaveLength(8);
    g.streams.forEach((stream, i) => {
      expect(stream.p3).toEqual(g.merge);
      const gate = g.gates[i];
      expect(Math.hypot(gate.x - g.merge.x, gate.y - g.merge.y)).toBeGreaterThan(20);
    });
    expect(GATE_T).toBeLessThan(1);
  });

  it("projects the consolidated line past the right edge", () => {
    expect(g.trunk.p0).toEqual(g.merge);
    expect(g.trunk.p3.x).toBeGreaterThan(W);
  });
});

describe("continuous data inflow", () => {
  it("keeps new packets entering while earlier ones are still consolidating", () => {
    const g = buildFlowGeometry(W, H);
    const state = createFlowState();
    let overlapped = false;
    for (let t = 0; t < LOOP_SECONDS * 20; t += DT) {
      stepFlow(state, g, DT);
      const entering = state.packets.some((p) => !p.onTrunk && p.s < 0.2);
      const consolidated = state.packets.some((p) => p.onTrunk);
      if (entering && consolidated) overlapped = true;
    }
    expect(overlapped).toBe(true);
    expect(state.spawned).toBeGreaterThan(g.streams.length);
  });

  it("holds one exception packet at its gate, then resolves it", () => {
    const g = buildFlowGeometry(W, H);
    const state = createFlowState();
    let held = false;
    for (let t = 0; t < LOOP_SECONDS * 20; t += DT) {
      stepFlow(state, g, DT);
      const exception = state.packets.find((p) => p.amber && p.holdUntil > state.time);
      if (exception) {
        held = true;
        expect(exception.auditSelected).toBe(false);
      }
    }
    expect(held).toBe(true);
  });
});

describe("sampled governance controls", () => {
  it("selects approximately fifteen percent of non-exception packets", () => {
    const g = buildFlowGeometry(W, H);
    const state = createFlowState(42);
    advance(state, g, 800);

    const eligible = state.approachSpawned - state.exceptionsSelected;
    const observedRate = state.auditsSelected / eligible;
    expect(observedRate).toBeGreaterThanOrEqual(AUDIT_RATE - 0.03);
    expect(observedRate).toBeLessThanOrEqual(AUDIT_RATE + 0.03);
  });

  it("holds a sampled packet at its gate for three seconds, then releases it", () => {
    const g = buildFlowGeometry(W, H);
    const state = createFlowState(7);
    let audited = state.packets.find(() => false);

    for (let t = 0; t < 180 && !audited; t += DT) {
      stepFlow(state, g, DT);
      audited = state.packets.find(
        (p) => p.auditSelected && p.auditStarted && p.holdUntil > state.time,
      );
    }

    expect(audited).toBeDefined();
    if (!audited) return;
    expect(audited.s).toBe(GATE_T);
    expect(audited.holdUntil - state.time).toBeGreaterThan(AUDIT_HOLD_SECONDS - 0.1);
    const radius = audited.radius;

    advance(state, g, AUDIT_HOLD_SECONDS - 0.2);
    expect(audited.s).toBe(GATE_T);
    expect(audited.radius).toBe(radius);

    advance(state, g, 0.3);
    expect(audited.s).toBeGreaterThan(GATE_T);
    expect(audited.auditSelected).toBe(false);
  });

  it("never lets two prolonged reviews occupy the same gate", () => {
    const g = buildFlowGeometry(W, H);
    const state = createFlowState(11);
    let sawHeldReview = false;

    for (let t = 0; t < 300; t += 0.1) {
      stepFlow(state, g, 0.1);
      const heldStreams = state.packets
        .filter((p) => p.holdUntil > state.time)
        .map((p) => p.stream);
      sawHeldReview ||= heldStreams.length > 0;
      expect(new Set(heldStreams).size).toBe(heldStreams.length);
    }

    expect(sawHeldReview).toBe(true);
  });

  it("assigns a stable seeded size within the intended range", () => {
    const g = buildFlowGeometry(W, H);
    const state = createFlowState(19);
    advance(state, g, 20);

    const radii = state.packets.map((p) => p.radius);
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(1.7);
    expect(Math.max(...radii)).toBeLessThanOrEqual(3.2);
    expect(new Set(radii.map((radius) => radius.toFixed(2))).size).toBeGreaterThan(5);

    const packet = state.packets[0];
    const radius = packet.radius;
    advance(state, g, 2);
    expect(packet.radius).toBe(radius);
  });

  it("spawns fewer packets and spreads some of them near the junction", () => {
    const g = buildFlowGeometry(W, H);
    const state = createFlowState(5);
    advance(state, g, 60);

    expect(state.spawned).toBeGreaterThan(20);
    expect(state.spawned).toBeLessThan(40);

    const nearJunction = state.packets.filter(
      (p) => p.onTrunk || (!p.onTrunk && p.s >= GATE_T),
    );
    const arriving = state.packets.filter((p) => !p.onTrunk && p.s < 0.2);
    expect(nearJunction.length).toBeGreaterThan(0);
    expect(arriving.length).toBeGreaterThan(0);
  });
});
