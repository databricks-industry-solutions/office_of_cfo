import {
  Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, Component, ErrorInfo, ReactNode,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { forceCollide } from "d3-force-3d";
import {
  Search, ArrowRight, X, Building2, Users, Landmark, ShieldAlert, Minus, Plus, CheckCircle2, ChevronRight,
} from "lucide-react";
import {
  api, ExposureDimension, ExposureMetric, ExposureSummary, GraphEdge, GraphNode, Persona, RaiseReviewsResult, fmt,
} from "../api";
import { PageId } from "../nav";
import { CHART_COLORS } from "../lib/chartPalette";
import { cn } from "../lib/cn";
import { PageHeading, Skeleton, SkeletonRegion } from "../components/ui";
import { useOverlay } from "../lib/industry";

const pluralize = (s: string) => (s.endsWith("y") ? `${s.slice(0, -1)}ies` : `${s}s`);

const ForceGraph2D = lazy(() => import("react-force-graph-2d"));
type ForceGraphMethods = any;

class GraphErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(_e: Error, _info: ErrorInfo) { /* shown below */ }
  render() {
    if (this.state.error) {
      return (
        <div className="absolute inset-0 grid place-items-center text-fg-subtle text-sm p-8 text-center">
          <div>
            <div className="text-fg-muted font-medium mb-1">Graph engine failed to initialize</div>
            <div className="text-fg-subtle text-xs font-mono">{String(this.state.error.message || this.state.error)}</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const ENTITY_COLOR = CHART_COLORS.seriesA;
const FLAGGED_COLOR = CHART_COLORS.bad;
const MUTED_COLOR = CHART_COLORS.slate;
const withAlpha = (hex: string, opacity: number) =>
  `${hex}${Math.round(opacity * 255).toString(16).padStart(2, "0")}`;

/** Read the active theme at draw time (canvas colors can't use CSS). */
const isDark = () => document.documentElement.classList.contains("dark");

const METRIC_OPTIONS: { id: ExposureMetric; label: string }[] = [
  { id: "amount", label: "By $ exposure" },
  { id: "txn", label: "By invoice volume" },
];

// Whole-dollar currency (no decimals) for the concentration review panel.
const fmt0 = (v: number | null | undefined) =>
  (v ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

type Phase = "idle" | "scanning" | "assess" | "act" | "done";
const SCAN_MS = 2600;
const STEPS: { id: Phase; label: string }[] = [
  { id: "scanning", label: "Scan" },
  { id: "assess", label: "Assess" },
  { id: "act", label: "Act" },
  { id: "done", label: "Confirm" },
];

type FGNode = GraphNode & {
  vx?: number; vy?: number; fx?: number; fy?: number; radius?: number; fillColor?: string;
  tx?: number; ty?: number; // organized (concentric) target position
  mx?: number; my?: number; // messy (pre-detection) start position
};
type FGLink = Omit<GraphEdge, "source" | "target"> & { source: string | FGNode; target: string | FGNode };
const idOf = (v: string | FGNode) => (typeof v === "string" ? v : v.id);


const GRAPH_SKELETON_NODES: [number, number, number][] = [
  [50, 48, 44], [28, 30, 22], [72, 28, 26], [22, 66, 18], [78, 68, 20],
  [40, 78, 16], [62, 82, 14], [14, 44, 12], [86, 46, 14], [56, 18, 12],
];

/** Network-shaped placeholder: a hub with satellite nodes where the graph will draw. */
function GraphSkeleton() {
  return (
    <SkeletonRegion label="Loading exposure" className="absolute inset-0">
      {GRAPH_SKELETON_NODES.map(([x, y, size], i) => (
        <Skeleton
          key={i}
          className="absolute rounded-full"
          style={{ left: `${x}%`, top: `${y}%`, width: size, height: size, transform: "translate(-50%, -50%)" }}
        />
      ))}
    </SkeletonRegion>
  );
}

export default function ExposureNetwork({
  persona, onNavigate, refreshKey,
}: {
  persona: Persona | null;
  onNavigate: (p: PageId, query?: string) => void;
  refreshKey: number;
}) {
  const ov = useOverlay();
  const fgRef = useRef<ForceGraphMethods | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridH, setGridH] = useState(0);
  const [dimension, setDimension] = useState<ExposureDimension>("customer");
  const [metric, setMetric] = useState<ExposureMetric>("amount");
  const [minCount, setMinCount] = useState(3);
  const [graph, setGraph] = useState<{ nodes: FGNode[]; links: FGLink[] } | null>(null);
  const [summary, setSummary] = useState<ExposureSummary>({});
  const [threshold, setThreshold] = useState(0);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [phase, setPhase] = useState<Phase>("idle");
  const [scanProgress, setScanProgress] = useState(0);
  const scanRef = useRef<number | null>(null);
  const prevParamsRef = useRef<string>("");
  const phaseRef = useRef<Phase>("idle");
  const [hasFitted, setHasFitted] = useState(false);
  const [raising, setRaising] = useState(false);
  const [raiseResult, setRaiseResult] = useState<RaiseReviewsResult | null>(null);
  const [raiseError, setRaiseError] = useState<string | null>(null);

  const noun = dimension === "customer" ? pluralize(ov.exposure.noun) : pluralize(ov.exposure.vendorNoun);
  const action = ov.exposure.action;
  const actionPlural = pluralize(action);
  const book = dimension === "customer" ? "AR" : "AP";
  const canAct = persona?.can_post === true;
  const revealed = phase === "assess" || phase === "act" || phase === "done";

  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Load + deterministic concentric layout. Background refreshes (refreshKey)
  // update the graph data quietly; only a real parameter change (dimension /
  // minCount) shows the loader, re-fits the camera, and resets the workflow.
  useEffect(() => {
    let cancelled = false;
    const paramsKey = `${dimension}:${minCount}:${metric}`;
    const paramsChanged = prevParamsRef.current !== paramsKey;
    prevParamsRef.current = paramsKey;
    if (paramsChanged) setLoading(true);
    api.exposureGraph(dimension, minCount, metric).then((g) => {
      if (cancelled) return;
      const nodes = g.nodes.map((n) => prepareNode(n));
      const entities = nodes.filter((n) => n.type === "entity");
      const cps = nodes.filter((n) => n.type === "counterparty");
      const ENTITY_RADIUS = 300, CP_OUTER = 720, CP_INNER = 600;
      // Compute the organized (concentric) target for every node …
      entities.forEach((e, i) => {
        const a = (i / Math.max(1, entities.length)) * 2 * Math.PI - Math.PI / 2;
        e.tx = ENTITY_RADIUS * Math.cos(a);
        e.ty = ENTITY_RADIUS * Math.sin(a);
      });
      cps.forEach((c, i) => {
        const a = (i / Math.max(1, cps.length)) * 2 * Math.PI - Math.PI / 2 + Math.PI / Math.max(1, cps.length);
        const r = i % 2 === 0 ? CP_OUTER : CP_INNER;
        c.tx = r * Math.cos(a);
        c.ty = r * Math.sin(a);
      });
      // … then place them. Before detection (idle) the network is a messy blob;
      // if a background refresh lands mid-workflow, keep the organized layout.
      if (phaseRef.current === "idle") scatterMessy(nodes);
      else nodes.forEach((n) => { n.x = n.fx = n.mx = n.tx ?? 0; n.y = n.fy = n.my = n.ty ?? 0; });
      setGraph({ nodes, links: g.links.map((e) => ({ ...e, source: e.source, target: e.target } as FGLink)) });
      setSummary(g.summary || {});
      setThreshold(g.threshold || 0);
      setFlaggedIds(new Set(g.converge_targets || []));
      setError(null);
      if (paramsChanged) setHasFitted(false);
    }).catch((e: any) => {
      if (!cancelled) setError(e?.message || "Couldn’t load the exposure graph.");
    }).finally(() => { if (!cancelled && paramsChanged) setLoading(false); });
    return () => { cancelled = true; };
  }, [dimension, minCount, metric, refreshKey]);

  // The interactive workflow (scan → assess → act → confirm) only resets when
  // the user changes what's being analysed — never on a background refresh.
  useEffect(() => {
    cancelScan();
    setPhase("idle");
    setScanProgress(0);
    setSelectedId(null);
    setRaiseResult(null);
    setRaiseError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimension, minCount, metric]);

  useEffect(() => {
    if (!graph || !fgRef.current) return;
    const t = setTimeout(() => {
      try {
        const collide = forceCollide((n: any) => {
          const labelHalfW = ((n.label?.length || 10) * 5.5) / 2;
          return Math.max(48, labelHalfW + (n.radius || 8) + 12);
        });
        fgRef.current?.d3Force?.("collide", collide);
        fgRef.current?.d3Force?.("charge")?.strength(0);
        fgRef.current?.d3Force?.("link")?.strength(0);
      } catch { /* no-op */ }
    }, 80);
    return () => clearTimeout(t);
  }, [graph]);

  useEffect(() => {
    const update = () => {
      if (!containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    };
    update();
    window.addEventListener("resize", update);
    // ResizeObserver catches layout shifts the window "resize" event misses
    // (e.g. the StepBar mounting, sidebar collapse) so the canvas always
    // matches its tile and never spills past it.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    return () => { window.removeEventListener("resize", update); ro?.disconnect(); };
  }, []);

  // Fit the whole network into the tile so the user never has to zoom or pan
  // to see it. We refit whenever the data or the canvas size changes.
  const fitView = useCallback(() => {
    try { fgRef.current?.zoomToFit(500, 48); } catch { /* no-op */ }
  }, []);

  useEffect(() => {
    if (!graph || size.w === 0 || phase === "scanning") return;
    const t = setTimeout(fitView, 120);
    return () => clearTimeout(t);
  }, [graph, size.w, size.h, phase, fitView]);

  // Size the graph/panel row to exactly fill the space left below whatever sits
  // above it (heading, error banner, and — after detection — the Scan→Act
  // StepBar), so the whole page fits without scrolling. Measuring the row's live
  // top makes this adapt automatically when the StepBar mounts/unmounts.
  useLayoutEffect(() => {
    const measure = () => {
      if (!gridRef.current) return;
      const top = gridRef.current.getBoundingClientRect().top;
      setGridH(Math.max(360, Math.floor(window.innerHeight - top - 24)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [phase, error]);

  const cancelScan = () => { if (scanRef.current != null) { cancelAnimationFrame(scanRef.current); scanRef.current = null; } };

  // Step 1: scan sweep. Nodes ease from their messy blob into the organized
  // concentric rings while the sweep runs, then we auto-advance into Assess.
  const runScan = useCallback(() => {
    cancelScan();
    setSelectedId(null);
    setPhase("scanning");
    setScanProgress(0);
    setHasFitted(false); // re-fit the camera to the organized layout when the morph ends
    const nodes = graph?.nodes ?? [];
    // Freeze the current positions as the animation's messy origin.
    nodes.forEach((n) => { n.mx = n.x ?? n.mx ?? 0; n.my = n.y ?? n.my ?? 0; });
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / SCAN_MS);
      const e = easeInOutCubic(k);
      for (const n of nodes) {
        const tx = n.tx ?? 0, ty = n.ty ?? 0, mx = n.mx ?? 0, my = n.my ?? 0;
        n.fx = n.x = mx + (tx - mx) * e;
        n.fy = n.y = my + (ty - my) * e;
      }
      setScanProgress(k);
      if (k < 1) scanRef.current = requestAnimationFrame(tick);
      else {
        for (const n of nodes) { n.fx = n.x = n.tx ?? 0; n.fy = n.y = n.ty ?? 0; }
        scanRef.current = null;
        setPhase("assess");
      }
    };
    scanRef.current = requestAnimationFrame(tick);
  }, [graph]);

  useEffect(() => () => cancelScan(), []);

  // Keep the force engine repainting during the morph (it is otherwise frozen).
  useEffect(() => {
    if (phase === "scanning") { try { fgRef.current?.d3ReheatSimulation?.(); } catch { /* no-op */ } }
  }, [phase]);

  const reset = () => {
    cancelScan();
    if (graph?.nodes) scatterMessy(graph.nodes);
    setHasFitted(false);
    try { fgRef.current?.d3ReheatSimulation?.(); } catch { /* no-op */ }
    setPhase("idle");
    setScanProgress(0);
    setSelectedId(null);
    setRaiseResult(null);
    setRaiseError(null);
  };

  const raise = useCallback(async () => {
    if (!canAct || raising) return;
    setRaising(true);
    setRaiseError(null);
    try {
      const res = await api.raiseConcentrationReviews(dimension, minCount, metric);
      setRaiseResult(res);
      setPhase("done");
    } catch (e: any) {
      setRaiseError(e?.message || "Couldn’t raise reviews.");
    } finally {
      setRaising(false);
    }
  }, [canAct, raising, dimension, minCount, metric]);

  const counterpartyCount = summary.counterparty_count ?? 0;

  const metricVal = useCallback(
    (n: FGNode) => (metric === "txn" ? n.properties?.txn_count ?? 0 : n.properties?.exposure ?? 0),
    [metric]);

  const flaggedNodes = useMemo(
    () => (graph?.nodes ?? [])
      .filter((n) => n.type === "counterparty" && n.properties?.flagged)
      .sort((a, b) => metricVal(b) - metricVal(a)),
    [graph, metricVal]);

  const selectedNode = useMemo(() => graph?.nodes.find((n) => n.id === selectedId) || null, [graph, selectedId]);
  // Flagged counterparties expand inline in the review list; structural nodes
  // (legal entity / consolidated) still open the detail side panel.
  const selectedIsFlagged = !!selectedNode && selectedNode.type === "counterparty" && !!selectedNode.properties?.flagged;

  const related = useMemo(() => {
    if (!graph || !selectedNode) return [] as { node: FGNode; weight: number }[];
    const isCp = selectedNode.type === "counterparty";
    return graph.links
      .filter((l) => l.type === "exposed_to" &&
        (isCp ? idOf(l.target) === selectedNode.id : idOf(l.source) === selectedNode.id))
      .map((l) => {
        const other = graph.nodes.find((n) => n.id === (isCp ? idOf(l.source) : idOf(l.target)));
        return other ? { node: other, weight: l.weight } : null;
      })
      .filter((x): x is { node: FGNode; weight: number } => !!x)
      .sort((a, b) => b.weight - a.weight);
  }, [graph, selectedNode]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <PageHeading
          eyebrow={ov.pageCopy.exposure?.eyebrow ?? "Concentration Risk"}
          title={ov.pageCopy.exposure?.title ?? "Counterparty Exposure Network"}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-lg ring-1 ring-line overflow-hidden text-sm">
            {(["customer", "vendor"] as ExposureDimension[]).map((d) => (
              <button key={d} onClick={() => setDimension(d)}
                      className={cn("px-3 py-2 transition", dimension === d ? "bg-accent/15 text-accent-400 dark:text-fg" : "text-fg-muted hover:bg-black/[0.04]")}>
                {d === "customer"
                  ? (ov.exposure.arToggle ?? "Customers · AR")
                  : (ov.exposure.apToggle ?? "Vendors · AP")}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg ring-1 ring-line overflow-hidden text-sm">
            {METRIC_OPTIONS.map((m) => (
              <button key={m.id} onClick={() => setMetric(m.id)}
                      title="Choose how counterparties are ranked and flagged"
                      className={cn("px-3 py-2 transition", metric === m.id ? "bg-accent/15 text-accent-400 dark:text-fg" : "text-fg-muted hover:bg-black/[0.04]")}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-lg ring-1 ring-line px-2 py-1 text-sm">
            <span className="text-fg-subtle text-xs mr-1">Flag top</span>
            <button aria-label="Fewer" onClick={() => setMinCount((n) => Math.max(1, n - 1))}
                    className="p-1 rounded hover:bg-black/[0.06] text-fg-muted"><Minus className="w-3.5 h-3.5" /></button>
            <span className="num w-5 text-center text-fg">{minCount}</span>
            <button aria-label="More" onClick={() => setMinCount((n) => Math.min(15, n + 1))}
                    className="p-1 rounded hover:bg-black/[0.06] text-fg-muted"><Plus className="w-3.5 h-3.5" /></button>
          </div>
          {phase === "idle" ? (
            <button onClick={runScan} disabled={loading || counterpartyCount === 0}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/15 text-accent-400 dark:text-fg ring-1 ring-accent/30 hover:bg-accent/25 transition text-sm font-medium disabled:opacity-40">
              <Search className="w-4 h-4" /> Run detection
            </button>
          ) : (
            <button onClick={reset}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-black/[0.06] text-fg-muted ring-1 ring-line hover:ring-line-strong transition text-sm">
              Reset
            </button>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="text-sm bg-signal-bad/10 text-signal-bad rounded-lg px-4 py-3 ring-1 ring-signal-bad/30">{error}</div>
      )}

      {phase !== "idle" && <StepBar phase={phase} />}

      <div ref={gridRef} className="grid grid-cols-12 gap-4" style={{ height: gridH || undefined }}>
        <div className="col-span-12 lg:col-span-8">
          <div ref={containerRef} className="tile relative ring-1 ring-line overflow-hidden h-full">
            <div className="exposure-grid absolute inset-0 opacity-30 pointer-events-none" />

            {graph && size.w > 0 && (
              <GraphErrorBoundary>
                <Suspense fallback={<GraphSkeleton />}>
                  <ForceGraph2D
                    ref={fgRef as any}
                    width={size.w}
                    height={size.h}
                    graphData={graph as any}
                    backgroundColor="rgba(0,0,0,0)"
                    cooldownTicks={phase === "scanning" ? Infinity : 1}
                    cooldownTime={phase === "scanning" ? SCAN_MS + 600 : 15000}
                    d3AlphaDecay={phase === "scanning" ? 0 : 0.5}
                    d3VelocityDecay={0.9}
                    onEngineStop={() => { if (hasFitted) return; fitView(); setHasFitted(true); }}
                    linkCurvature={0.12}
                    enableNodeDrag
                    enableZoomInteraction
                    enablePanInteraction
                    linkColor={(l: any) => linkColor(l, hoverId, selectedId, revealed, flaggedIds)}
                    linkWidth={(l: any) => linkWidth(l, hoverId, selectedId)}
                    onNodeClick={(n: any) => setSelectedId(n.id === selectedId ? null : n.id)}
                    onNodeHover={(n: any) => { setHoverId(n?.id ?? null); document.body.style.cursor = n ? "pointer" : ""; }}
                    nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) =>
                      drawNode(node as FGNode, ctx, globalScale, hoverId, selectedId, revealed)}
                    nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
                      ctx.fillStyle = color;
                      ctx.beginPath();
                      ctx.arc(node.x, node.y, ((node as any).radius || 8) + 4, 0, 2 * Math.PI);
                      ctx.fill();
                    }}
                  />
                </Suspense>
              </GraphErrorBoundary>
            )}

            <div className="absolute bottom-4 left-4 glass rounded-lg ring-1 ring-line p-3 text-[11px] space-y-1.5">
              <div className="text-[10px] font-mono uppercase tracking-widest text-fg-subtle mb-1">Legend</div>
              <LegendRow color={ENTITY_COLOR} label="Legal entity" />
              <LegendRow color={FLAGGED_COLOR} label={`Flagged (top ${minCount} by ${metric === "txn" ? "invoices" : "$"})`} />
              <LegendRow color={MUTED_COLOR} label="Below threshold" />
            </div>

            <AnimatePresence>
              {phase === "scanning" && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="absolute inset-0 pointer-events-none overflow-hidden">
                  <div className="absolute top-0 bottom-0" style={{
                    left: `calc(${scanProgress * 100}% - 200px)`, width: "240px",
                    background: `linear-gradient(90deg, ${withAlpha(CHART_COLORS.accent, 0)} 0%, ${withAlpha(CHART_COLORS.accent, 0.05)} 30%, ${withAlpha(CHART_COLORS.accent, 0.16)} 80%, ${withAlpha(CHART_COLORS.accent, 0.28)} 100%)`,
                  }} />
                  <div className="absolute top-0 bottom-0" style={{
                    left: `${scanProgress * 100}%`, width: "3px", background: withAlpha(CHART_COLORS.accent, 0.9),
                    boxShadow: `0 0 32px 8px ${withAlpha(CHART_COLORS.accent, 0.6)}`,
                  }} />
                  <div className="absolute top-4 left-4 glass rounded-lg ring-1 ring-accent/30 px-3 py-2 min-w-[170px]">
                    <div className="text-[9px] font-mono uppercase tracking-widest text-fg-subtle">{cap(noun)} scanned</div>
                    <div className="text-lg font-mono font-semibold tabular-nums text-accent-400 dark:text-fg leading-none mt-1">
                      {Math.round(scanProgress * counterpartyCount)}<span className="text-fg-subtle"> / {counterpartyCount}</span>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {loading && <GraphSkeleton />}
          </div>
        </div>

        <div className="col-span-12 lg:col-span-4">
          {selectedNode && !selectedIsFlagged ? (
            <NodePanel node={selectedNode} related={related} dimension={dimension} onClose={() => setSelectedId(null)} />
          ) : (
            <ReviewPanel
              phase={phase} dimension={dimension} metric={metric} noun={noun} book={book}
              action={action} actionPlural={actionPlural}
              summary={summary} threshold={threshold} flagged={flaggedNodes}
              expandedId={selectedIsFlagged ? selectedId : null} expandedRelated={related}
              canAct={canAct} raising={raising} raiseResult={raiseResult} raiseError={raiseError}
              onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
              onGoAct={() => setPhase("act")} onRaise={raise} onNavigate={onNavigate}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================ helpers

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Scatter nodes into an organic, tangled blob (the pre-detection "messy" state).
// Positions are stored on both fx/fy (so they stay put) and mx/my (the morph origin).
function scatterMessy(nodes: FGNode[]) {
  const SPREAD = 760;
  nodes.forEach((n) => {
    const ang = Math.random() * 2 * Math.PI;
    const rad = SPREAD * Math.sqrt(Math.random());
    const mx = rad * Math.cos(ang);
    const my = rad * Math.sin(ang);
    n.mx = mx; n.my = my;
    n.x = n.fx = mx; n.y = n.fy = my;
  });
}

function prepareNode(n: GraphNode): FGNode {
  let radius = 8;
  let fillColor: string = MUTED_COLOR;
  if (n.type === "entity") { radius = 13; fillColor = ENTITY_COLOR; }
  else { radius = 9; fillColor = n.properties?.flagged ? FLAGGED_COLOR : MUTED_COLOR; }
  return { ...n, radius, fillColor };
}

function linkColor(l: any, hoverId: string | null, selectedId: string | null, revealed: boolean, flaggedIds: Set<string>) {
  const sid = idOf(l.source), tid = idOf(l.target);
  const active = hoverId || selectedId;
  if (active && (sid === active || tid === active)) return withAlpha(CHART_COLORS.accent, 0.55);
  if (revealed && l.type === "exposed_to" && flaggedIds.has(tid)) return withAlpha(CHART_COLORS.bad, 0.4);
  return isDark() ? "rgba(255,255,255,0.12)" : "rgba(23,25,32,0.10)";
}

function linkWidth(l: any, hoverId: string | null, selectedId: string | null) {
  const sid = idOf(l.source), tid = idOf(l.target);
  const active = hoverId || selectedId;
  let base = 0.6 + Math.log(1 + (l.weight || 1)) * 0.16;
  if (active && (sid === active || tid === active)) base *= 1.9;
  return base;
}

function drawNode(
  node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number,
  hoverId: string | null, selectedId: string | null, revealed: boolean,
) {
  const x = node.x as number, y = node.y as number;
  const isActive = node.id === hoverId || node.id === selectedId;
  const isFlagged = !!node.properties?.flagged;
  const r = node.radius || 8;

  // Before detection runs the whole network is dimmed — nothing is highlighted.
  // Once revealed, flagged counterparties pop and the rest fade back.
  let bodyAlpha = 1;
  let color = node.fillColor || MUTED_COLOR;
  if (!revealed) {
    color = MUTED_COLOR;
    bodyAlpha = node.type === "entity" ? 0.32 : 0.2;
  } else if (node.type === "counterparty") {
    color = isFlagged ? FLAGGED_COLOR : MUTED_COLOR;
    bodyAlpha = isFlagged ? 1 : 0.28;
  }

  ctx.save();
  ctx.globalAlpha = bodyAlpha;

  if (isActive || (revealed && isFlagged)) {
    ctx.beginPath();
    ctx.arc(x, y, r + (isFlagged ? 7 : 8), 0, 2 * Math.PI);
    ctx.fillStyle = withAlpha(isFlagged ? CHART_COLORS.bad : CHART_COLORS.accent, isFlagged ? 0.16 : 0.14);
    ctx.fill();
  }

  const grad = ctx.createRadialGradient(x - r * 0.25, y - r * 0.25, r * 0.1, x, y, r);
  grad.addColorStop(0, lighten(color, 0.22)); grad.addColorStop(1, color);
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = grad; ctx.fill();
  ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.28)" : "rgba(23,25,32,0.22)"; ctx.lineWidth = 0.8; ctx.stroke();

  const showLabel = node.type !== "counterparty" || isActive || (revealed && isFlagged) || globalScale > 1.5;
  if (showLabel) {
    const fontSize = Math.max(10, 11 / globalScale);
    ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const label = node.label;
    const tw = ctx.measureText(label).width;
    const padX = 7, padY = 4;
    const pillH = fontSize + padY * 2, pillW = tw + padX * 2, ly = y + r + 8;
    drawRoundedRect(ctx, x - pillW / 2, ly, pillW, pillH, pillH / 2);
    const dark = isDark();
    ctx.fillStyle = dark
      ? (isActive ? "rgba(40,44,52,0.98)" : "rgba(40,44,52,0.9)")
      : (isActive ? "rgba(255,255,255,0.98)" : "rgba(255,255,255,0.9)");
    ctx.fill();
    ctx.strokeStyle = isActive ? withAlpha(CHART_COLORS.accent, 0.5) : (dark ? "rgba(255,255,255,0.16)" : "rgba(23,25,32,0.12)");
    ctx.lineWidth = 0.8; ctx.stroke();
    ctx.fillStyle = dark ? "rgba(232,234,239,0.95)" : "rgba(30,35,43,0.95)";
    ctx.fillText(label, x, ly + pillH / 2);
  }
  ctx.restore();
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function lighten(hex: string, amt: number): string {
  let r = 0, g = 0, b = 0;
  if (hex.startsWith("#")) {
    const v = hex.replace("#", "");
    const full = v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
    r = parseInt(full.slice(0, 2), 16); g = parseInt(full.slice(2, 4), 16); b = parseInt(full.slice(4, 6), 16);
  }
  r = Math.min(255, Math.round(r + (255 - r) * amt));
  g = Math.min(255, Math.round(g + (255 - g) * amt));
  b = Math.min(255, Math.round(b + (255 - b) * amt));
  return `rgb(${r},${g},${b})`;
}

function StepBar({ phase }: { phase: Phase }) {
  const idx = STEPS.findIndex((s) => s.id === phase);
  return (
    <div className="tile p-3 ring-1 ring-line">
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => {
          const isActive = i === idx;
          const isDone = i < idx;
          return (
            <div key={s.id} className="flex items-center gap-2 flex-1 min-w-0">
              <div className={cn("flex-1 min-w-0 px-3 py-2 rounded-lg ring-1",
                isActive ? "ring-accent/50 bg-accent/10" : isDone ? "ring-signal-good/30 bg-signal-good/10" : "ring-line bg-ink-900/30")}>
                <div className="flex items-center gap-2">
                  <span className={cn("w-5 h-5 rounded-full grid place-items-center text-[10px] font-mono shrink-0",
                    isActive ? "bg-accent/25 text-accent-400 dark:text-fg ring-1 ring-accent/50"
                      : isDone ? "bg-signal-good/15 text-signal-good ring-1 ring-signal-good/40"
                        : "bg-ink-700 text-fg-subtle ring-1 ring-line")}>
                    {isDone ? "✓" : i + 1}
                  </span>
                  <span className={cn("text-[11px] font-semibold",
                    isActive ? "text-accent-400 dark:text-fg" : isDone ? "text-signal-good" : "text-fg-muted")}>{s.label}</span>
                </div>
              </div>
              {i < STEPS.length - 1 && <ArrowRight className={cn("w-3.5 h-3.5 shrink-0", i < idx ? "text-signal-good/60" : "text-fg-subtle")} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" | "warn" }) {
  const c = tone === "bad" ? "text-signal-bad" : tone === "warn" ? "text-signal-warn" : "text-fg";
  return (
    <div className="rounded-lg bg-ink-900/50 ring-1 ring-line p-2.5">
      <div className="text-[9px] font-mono uppercase tracking-widest text-fg-subtle">{label}</div>
      <div className={cn("num text-base font-semibold mt-0.5", c)}>{value}</div>
    </div>
  );
}

function ReviewPanel({
  phase, dimension, metric, noun, book, action, actionPlural, summary, threshold, flagged, expandedId, expandedRelated,
  canAct, raising, raiseResult, raiseError,
  onSelect, onGoAct, onRaise, onNavigate,
}: {
  phase: Phase; dimension: ExposureDimension; metric: ExposureMetric; noun: string; book: string;
  action: string; actionPlural: string;
  summary: ExposureSummary; threshold: number; flagged: FGNode[];
  expandedId: string | null; expandedRelated: { node: FGNode; weight: number }[];
  canAct: boolean; raising: boolean; raiseResult: RaiseReviewsResult | null; raiseError: string | null;
  onSelect: (id: string) => void; onGoAct: () => void; onRaise: () => void;
  onNavigate: (p: PageId, query?: string) => void;
}) {
  if (phase === "idle" || phase === "scanning") {
    return (
      <div className="tile p-5 ring-1 ring-line h-full flex flex-col">
        <div className="text-[10px] font-mono uppercase tracking-widest text-fg-subtle mb-2">Concentration review</div>
        <div className="flex-1 grid place-items-center text-fg-subtle text-sm text-center px-4">
          {phase === "scanning" ? "Scanning the book…" : `Run detection to flag the largest single-name ${noun} across entities.`}
        </div>
      </div>
    );
  }

  const k = summary.flagged_count ?? flagged.length;
  return (
    <div className="tile p-5 ring-1 ring-line h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <ShieldAlert className="w-4 h-4 text-signal-bad" />
        <div className="text-sm font-semibold text-fg">Concentration review</div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Flagged exposure" value={fmt0(summary.flagged_exposure ?? 0)} tone="bad" />
        <Stat label={`% of ${book}`} value={`${(summary.pct_of_total ?? 0).toFixed(1)}%`} tone="warn" />
        <Stat label={`Flagged ${noun}`} value={`${k}`} />
        <Stat label="Entities exposed" value={`${summary.entities_exposed ?? 0}`} />
      </div>
      <div className="text-[11px] text-fg-subtle mt-2">
        {metric === "txn"
          ? `Threshold: ≥ ${threshold} invoices (top ${summary.min_count ?? k} by invoices)`
          : `Threshold: exposure ≥ ${fmt0(threshold)} (top ${summary.min_count ?? k} by $)`}
      </div>

      <div className="text-[10px] font-mono uppercase tracking-widest text-fg-subtle mt-4 mb-2">
        Flagged {noun} <span className="text-fg-subtle">· tap to expand</span>
      </div>
      <div className="space-y-1.5 overflow-y-auto pr-1 flex-1 min-h-0">
        {flagged.map((n) => {
          const isOpen = n.id === expandedId;
          return (
            <div key={n.id}>
              <button onClick={() => onSelect(n.id)} aria-expanded={isOpen}
                      className={cn("w-full flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-ink-900/40 ring-1 transition text-left",
                        isOpen ? "ring-accent/40 bg-accent/5" : "ring-line hover:ring-line-strong")}>
                <ChevronRight className={cn("w-3 h-3 shrink-0 text-fg-subtle transition-transform", isOpen && "rotate-90 text-accent-400 dark:text-fg-muted")} />
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: FLAGGED_COLOR }} />
                <span className="flex-1 truncate text-fg">{n.label}</span>
                <span className="num text-fg-muted">
                  {metric === "txn" ? `${n.properties?.txn_count ?? 0} inv` : fmt0(n.properties?.exposure ?? 0)}
                </span>
                <span className="num text-fg-subtle text-[10px] w-8 text-right">{n.properties?.entities_touched ?? 0}e</span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                    <div className="mt-1.5 mb-1 ml-2 pl-3 border-l border-accent/25 space-y-2">
                      <div className="grid grid-cols-3 gap-2">
                        <Stat label="Exposure" value={fmt0(n.properties?.exposure ?? 0)} tone="bad" />
                        <Stat label="Entities" value={`${n.properties?.entities_touched ?? expandedRelated.length}`} />
                        <Stat label="% of book" value={`${(n.properties?.pct_of_total ?? 0).toFixed(2)}%`} />
                      </div>
                      <div className="text-[10px] font-mono uppercase tracking-widest text-fg-subtle">
                        Exposure across entities · {expandedRelated.length}
                      </div>
                      <div className="space-y-1">
                        {expandedRelated.slice(0, 40).map((e) => (
                          <div key={e.node.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-ink-900/40 ring-1 ring-line">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: e.node.fillColor }} />
                            <span className="flex-1 truncate text-fg-muted">{e.node.label}</span>
                            <span className="num text-fg-muted text-[10px]">{fmt0(e.weight)}</span>
                          </div>
                        ))}
                        {expandedRelated.length === 0 && <div className="text-fg-subtle text-xs px-2">No exposure rows.</div>}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* Act / confirm */}
      <div className="mt-4 pt-4 border-t border-line">
        {raiseResult ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 text-sm text-signal-good">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                Raised <span className="num font-semibold">{raiseResult.count}</span> {raiseResult.count === 1 ? action : actionPlural}
                {raiseResult.skipped.length > 0 && <span className="text-fg-subtle"> · {raiseResult.skipped.length} already open</span>}.
              </span>
            </div>
            <div className="flex gap-2">
              <button onClick={() => onNavigate("tasks")}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-600 transition">
                View Tasks <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => onNavigate("data-sources")}
                      className="px-3 py-2 rounded-lg bg-black/[0.06] text-fg ring-1 ring-line hover:ring-line-strong transition text-sm">
                Lineage & Data Quality
              </button>
            </div>
          </div>
        ) : canAct ? (
          <>
            <button onClick={phase === "act" ? onRaise : onGoAct} disabled={raising}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent-600 transition disabled:opacity-50">
              {raising ? "Raising…" : phase === "act" ? `Raise ${k} ${k === 1 ? action : actionPlural}` : "Review & act →"}
            </button>
            <p className="text-[11px] text-fg-subtle mt-2">
              Creates a HIGH-priority {action} task per flagged {dimension}, assigned into the close-task workflow with a full audit trail.
            </p>
            {raiseError && <p className="text-xs text-signal-bad mt-2">{raiseError}</p>}
          </>
        ) : (
          <div className="text-[12px] text-fg-muted bg-black/[0.04] rounded-lg px-3 py-2.5 ring-1 ring-line">
            Consolidated oversight view. The <span className="text-fg font-medium">Controller</span> raises the {actionPlural} from here; they land on the Accountant’s Tasks board.
          </div>
        )}
      </div>
    </div>
  );
}

function NodePanel({
  node, related, dimension, onClose,
}: {
  node: FGNode; related: { node: FGNode; weight: number }[]; dimension: ExposureDimension; onClose: () => void;
}) {
  const isCp = node.type === "counterparty";
  const Icon = isCp ? (dimension === "customer" ? Users : Landmark) : Building2;
  const touched = node.properties?.entities_touched ?? related.length;
  return (
    <motion.div key={node.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.18 }}
                className="tile p-5 ring-1 ring-line h-full flex flex-col">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg grid place-items-center"
             style={{ background: `${node.fillColor}26`, color: node.fillColor, border: `1px solid ${node.fillColor}55` }}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-mono uppercase tracking-widest text-fg-subtle">
            {node.type === "entity" ? "legal entity" : dimension}
          </div>
          <div className="text-sm font-semibold text-fg truncate">{node.label}</div>
        </div>
        <button onClick={onClose} className="text-fg-subtle hover:text-fg"><X className="w-4 h-4" /></button>
      </div>

      {isCp && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Stat label="Exposure" value={fmt(node.properties?.exposure ?? 0)} tone={node.properties?.flagged ? "bad" : undefined} />
          <Stat label="Entities" value={`${touched}`} />
          <Stat label="% of book" value={`${(node.properties?.pct_of_total ?? 0).toFixed(2)}%`} />
        </div>
      )}

      <div className="text-[10px] font-mono uppercase tracking-widest text-fg-subtle mb-2 mt-4">
        {isCp ? "Exposure across entities" : `Top ${dimension}s · ${related.length}`}
      </div>
      <div className="space-y-1.5 overflow-y-auto pr-1 flex-1 min-h-0">
        {related.slice(0, 40).map((e) => (
          <div key={e.node.id} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-ink-900/40 ring-1 ring-line">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: e.node.fillColor }} />
            <span className="flex-1 truncate text-fg-muted">{e.node.label}</span>
            <span className="num text-fg-muted text-[10px]">{fmt(e.weight)}</span>
          </div>
        ))}
        {related.length === 0 && <div className="text-fg-subtle text-xs">No exposure rows.</div>}
      </div>
    </motion.div>
  );
}

function LegendRow({ color, label, shape = "circle" }: { color: string; label: string; shape?: "circle" | "square" }) {
  return (
    <div className="flex items-center gap-2 text-fg-muted">
      <span className={shape === "square" ? "w-2.5 h-2.5 rounded-sm" : "w-2.5 h-2.5 rounded-full"} style={{ background: color }} />
      {label}
    </div>
  );
}
