import { useEffect, useRef } from "react";

const NAVY = "43, 76, 126";
const AMBER = "169, 138, 52";
export const LOOP_SECONDS = 16;
export const GATE_T = 0.62;
export const AUDIT_RATE = 0.15;
export const AUDIT_HOLD_SECONDS = 3;
const PACKET_SPEED = 5.25;
const EXCEPTION_HOLD = 2;
const WARM_UP_SECONDS = 80;
const GATE_QUEUE_OFFSET = 0.018;
const SPAWN_GAP_MIN = 1.385;
const SPAWN_GAP_SPAN = 1.23;

function spawnPlacement(rand: () => number) {
  const roll = rand();
  if (roll < 0.42) {
    return { s: rand() * 0.14, onTrunk: false, passedGate: false };
  }
  if (roll < 0.72) {
    return { s: 0.2 + rand() * (GATE_T - 0.28), onTrunk: false, passedGate: false };
  }
  if (roll < 0.88) {
    return { s: GATE_T + 0.08 + rand() * 0.26, onTrunk: false, passedGate: true };
  }
  return { s: rand() * 0.22, onTrunk: true, passedGate: true };
}

interface Point {
  x: number;
  y: number;
}

interface Curve {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
  length: number;
}

export interface FlowGeometry {
  width: number;
  height: number;
  streams: Curve[];
  gates: Point[];
  merge: Point;
  trunk: Curve;
  markers: number[];
}

interface Packet {
  stream: number;
  s: number;
  onTrunk: boolean;
  passedGate: boolean;
  amber: boolean;
  auditSelected: boolean;
  auditStarted: boolean;
  holdUntil: number;
  radius: number;
}

export interface FlowState {
  time: number;
  packets: Packet[];
  spawned: number;
  auditsSelected: number;
  exceptionsSelected: number;
  approachSpawned: number;
  nextSpawn: number;
  lastException: number;
  gateFlash: number[];
  markerFlash: number[];
  rand: () => number;
}

// Normalized entry point and first control point for each source stream.
// Entries sit just outside the left edge or the left half of the top/bottom
// edges; control points that cross the centre line tangle streams into a knot.
const STREAMS: [Point, Point][] = [
  [{ x: -0.04, y: 0.12 }, { x: 0.3, y: 0.1 }],
  [{ x: -0.04, y: 0.38 }, { x: 0.34, y: 0.66 }],
  [{ x: -0.04, y: 0.66 }, { x: 0.34, y: 0.3 }],
  [{ x: -0.04, y: 0.9 }, { x: 0.3, y: 0.92 }],
  [{ x: 0.14, y: -0.04 }, { x: 0.3, y: 0.72 }],
  [{ x: 0.4, y: -0.04 }, { x: 0.42, y: 0.28 }],
  [{ x: 0.2, y: 1.04 }, { x: 0.36, y: 0.26 }],
  [{ x: 0.44, y: 1.04 }, { x: 0.46, y: 0.74 }],
];
const MERGE: Point = { x: 0.6, y: 0.5 };
const TRUNK: [Point, Point, Point] = [
  { x: 0.72, y: 0.5 },
  { x: 0.87, y: 0.46 },
  { x: 1.04, y: 0.4 },
];
const MARKERS = [0.45, 0.65, 0.85];

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pointOn(c: Omit<Curve, "length">, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x,
    y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y,
  };
}

function curve(p0: Point, p1: Point, p2: Point, p3: Point): Curve {
  const base = { p0, p1, p2, p3 };
  let length = 0;
  let prev = p0;
  for (let i = 1; i <= 32; i += 1) {
    const next = pointOn(base, i / 32);
    length += Math.hypot(next.x - prev.x, next.y - prev.y);
    prev = next;
  }
  return { ...base, length };
}

export function buildFlowGeometry(width: number, height: number): FlowGeometry {
  const px = (p: Point): Point => ({ x: p.x * width, y: p.y * height });
  const merge = px(MERGE);
  const approach = px({ x: MERGE.x - 0.12, y: MERGE.y });
  const streams = STREAMS.map(([entry, control]) => curve(px(entry), px(control), approach, merge));
  return {
    width,
    height,
    streams,
    gates: streams.map((stream) => pointOn(stream, GATE_T)),
    merge,
    trunk: curve(merge, px(TRUNK[0]), px(TRUNK[1]), px(TRUNK[2])),
    markers: MARKERS,
  };
}

export function createFlowState(seed = 20260930): FlowState {
  return {
    time: 0,
    packets: [],
    spawned: 0,
    auditsSelected: 0,
    exceptionsSelected: 0,
    approachSpawned: 0,
    nextSpawn: 0,
    lastException: -LOOP_SECONDS / 2,
    gateFlash: STREAMS.map(() => 0),
    markerFlash: MARKERS.map(() => 0),
    rand: mulberry32(seed),
  };
}

export function stepFlow(state: FlowState, geometry: FlowGeometry, dt: number) {
  state.time += dt;
  const now = state.time;
  const decay = Math.exp(-dt * 1);
  state.gateFlash = state.gateFlash.map((v) => v * decay);
  state.markerFlash = state.markerFlash.map((v) => v * decay);

  state.nextSpawn -= dt;
  if (state.nextSpawn <= 0) {
    const place = spawnPlacement(state.rand);
    const amber = !place.passedGate && now - state.lastException >= LOOP_SECONDS;
    if (amber) state.lastException = now;
    const auditSelected = !amber && !place.passedGate && state.rand() < AUDIT_RATE;
    state.packets.push({
      stream: Math.floor(state.rand() * STREAMS.length),
      s: place.s,
      onTrunk: place.onTrunk,
      passedGate: place.passedGate,
      amber,
      auditSelected,
      auditStarted: false,
      holdUntil: 0,
      radius: 1.7 + state.rand() * 1.5,
    });
    state.spawned += 1;
    if (!place.passedGate) state.approachSpawned += 1;
    if (auditSelected) state.auditsSelected += 1;
    if (amber) state.exceptionsSelected += 1;
    state.nextSpawn = SPAWN_GAP_MIN + state.rand() * SPAWN_GAP_SPAN;
  }

  state.packets = state.packets.filter((packet) => {
    if (packet.holdUntil > now) return true;
    if (packet.amber && packet.holdUntil > 0) {
      packet.amber = false;
      packet.holdUntil = 0;
      state.gateFlash[packet.stream] = 1;
    } else if (packet.auditSelected && packet.auditStarted && packet.holdUntil > 0) {
      packet.auditSelected = false;
      packet.holdUntil = 0;
      state.gateFlash[packet.stream] = 1;
    }

    const path = packet.onTrunk ? geometry.trunk : geometry.streams[packet.stream];
    const next = packet.s + (PACKET_SPEED * dt) / path.length;

    if (!packet.onTrunk) {
      if (!packet.passedGate && next >= GATE_T) {
        const needsHold = packet.amber || packet.auditSelected;
        const gateOccupied = needsHold && state.packets.some(
          (other) =>
            other !== packet &&
            other.stream === packet.stream &&
            other.holdUntil > now,
        );
        if (gateOccupied) {
          packet.s = GATE_T - GATE_QUEUE_OFFSET;
          return true;
        }

        packet.passedGate = true;
        packet.s = GATE_T;
        if (packet.amber) {
          packet.holdUntil = now + EXCEPTION_HOLD;
          return true;
        }
        if (packet.auditSelected) {
          packet.auditStarted = true;
          packet.holdUntil = now + AUDIT_HOLD_SECONDS;
          return true;
        }
        state.gateFlash[packet.stream] = 1;
        return true;
      }
      if (next >= 1) {
        packet.onTrunk = true;
        packet.s = 0;
        return true;
      }
      packet.s = next;
      return true;
    }

    geometry.markers.forEach((t, i) => {
      if (packet.s < t && next >= t) state.markerFlash[i] = 1;
    });
    packet.s = next;
    return packet.s < 1;
  });
}

function draw(context: CanvasRenderingContext2D, g: FlowGeometry, state: FlowState) {
  context.clearRect(0, 0, g.width, g.height);
  context.lineCap = "round";

  const envelope: Point[] = [];
  const lower: Point[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const t = 0.35 + (0.65 * i) / 24;
    const p = pointOn(g.trunk, t);
    const spread = (t - 0.35) * 0.09 * g.height;
    envelope.push({ x: p.x, y: p.y - spread });
    lower.unshift({ x: p.x, y: p.y + spread });
  }
  context.beginPath();
  [...envelope, ...lower].forEach((p, i) => (i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)));
  context.closePath();
  context.fillStyle = `rgba(${NAVY}, 0.05)`;
  context.fill();

  context.lineWidth = 1;
  context.strokeStyle = `rgba(${NAVY}, 0.2)`;
  g.streams.forEach((c) => {
    context.beginPath();
    context.moveTo(c.p0.x, c.p0.y);
    context.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y);
    context.stroke();
  });

  const trunk = g.trunk;
  const trunkStroke = context.createLinearGradient(trunk.p0.x, 0, trunk.p3.x, 0);
  trunkStroke.addColorStop(0, `rgba(${NAVY}, 0.5)`);
  trunkStroke.addColorStop(1, `rgba(${NAVY}, 0.12)`);
  context.lineWidth = 1.6;
  context.strokeStyle = trunkStroke;
  context.beginPath();
  context.moveTo(trunk.p0.x, trunk.p0.y);
  context.bezierCurveTo(trunk.p1.x, trunk.p1.y, trunk.p2.x, trunk.p2.y, trunk.p3.x, trunk.p3.y);
  context.stroke();

  g.markers.forEach((t, i) => {
    const p = pointOn(trunk, t);
    context.lineWidth = 1.2;
    context.strokeStyle = `rgba(${NAVY}, ${0.3 + 0.55 * state.markerFlash[i]})`;
    context.beginPath();
    context.moveTo(p.x, p.y - 6);
    context.lineTo(p.x, p.y + 6);
    context.stroke();
  });

  const heldAudits = new Set(
    state.packets
      .filter((p) => p.auditSelected && p.auditStarted && p.holdUntil > state.time)
      .map((p) => p.stream),
  );
  const heldExceptions = new Set(
    state.packets
      .filter((p) => p.amber && p.holdUntil > state.time)
      .map((p) => p.stream),
  );
  g.gates.forEach((gate, i) => {
    const heldAudit = heldAudits.has(i);
    const heldException = heldExceptions.has(i);
    const color = heldException ? AMBER : NAVY;
    const pulse = heldAudit ? 0.5 + 0.5 * Math.sin(state.time * Math.PI * 2) : 0;
    context.lineWidth = 1;
    context.strokeStyle = `rgba(${color}, ${0.55 + 0.35 * pulse})`;
    context.fillStyle = `rgba(${color}, ${0.12 + 0.7 * Math.max(state.gateFlash[i], pulse)})`;
    context.beginPath();
    context.arc(gate.x, gate.y, 4 + pulse * 3, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  });

  context.lineWidth = 1.2;
  context.strokeStyle = `rgba(${NAVY}, 0.55)`;
  context.beginPath();
  context.arc(g.merge.x, g.merge.y, 5.5, 0, Math.PI * 2);
  context.stroke();

  state.packets.forEach((packet) => {
    const path = packet.onTrunk ? g.trunk : g.streams[packet.stream];
    const p = pointOn(path, packet.s);
    const fade = packet.onTrunk
      ? Math.min(1, (1 - packet.s) / 0.15)
      : Math.min(1, packet.s / 0.08);
    const color = packet.amber ? AMBER : NAVY;
    const glowRadius = packet.radius * 4.2;
    const glow = context.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowRadius);
    glow.addColorStop(0, `rgba(${color}, ${0.35 * fade})`);
    glow.addColorStop(1, `rgba(${color}, 0)`);
    context.fillStyle = glow;
    context.beginPath();
    context.arc(p.x, p.y, glowRadius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = `rgba(${color}, ${0.85 * fade})`;
    context.beginPath();
    context.arc(p.x, p.y, packet.radius, 0, Math.PI * 2);
    context.fill();
  });
}

export default function SignalNetworkBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const state = createFlowState();
    let geometry = buildFlowGeometry(1, 1);
    let frameId = 0;
    let previous = performance.now();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      geometry = buildFlowGeometry(canvas.clientWidth, canvas.clientHeight);
      if (reducedMotion.matches) draw(context, geometry, state);
    };

    const animate = (time: number) => {
      stepFlow(state, geometry, Math.min(0.05, (time - previous) / 1000));
      previous = time;
      draw(context, geometry, state);
      frameId = requestAnimationFrame(animate);
    };

    resize();
    for (let t = 0; t < WARM_UP_SECONDS; t += 1 / 30) stepFlow(state, geometry, 1 / 30);
    if (reducedMotion.matches) {
      state.gateFlash = state.gateFlash.map(() => 0.6);
      draw(context, geometry, state);
    } else {
      frameId = requestAnimationFrame(animate);
    }
    window.addEventListener("resize", resize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div
      className="entrance-signal-network"
      data-testid="entrance-signal-network"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="entrance-signal-canvas" />
    </div>
  );
}
