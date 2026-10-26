import { useEffect, useMemo, useRef, useState } from "react";
import { sankey, sankeyJustify, sankeyLinkHorizontal } from "d3-sankey";
import { LineageGraph, LineageGraphLink, LineageGraphNode } from "../api";
import {
  LINEAGE_STATUS_COLOR, LINEAGE_STATUS_LABEL, LineageSelection, LineageStatus,
  bandLayoutValue, dimBySearch, nodeCaption,
} from "../lib/lineageGraph";
import { CHART_COLORS } from "../lib/chartPalette";

const STAGE_COLOR = [CHART_COLORS.seriesA, CHART_COLORS.ink, CHART_COLORS.seriesC, CHART_COLORS.slate];
const STATUSES: LineageStatus[] = ["success", "warning", "error", "unavailable"];

interface SNode {
  id: string;
  name: string;
  stage: number;
  counts: Record<string, number>;
}
interface SLink {
  source: string;
  target: string;
  value: number;
  status: LineageStatus;
  flow_id: string;
  id: string;
  count: number;
}

export default function DataLineageSankey({
  graph,
  selection,
  onSelect,
  highlightFlowIds = null,
}: {
  graph: LineageGraph;
  selection: LineageSelection;
  onSelect: (sel: LineageSelection) => void;
  highlightFlowIds?: string[] | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; l: SLink } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(680, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const height = Math.max(520, graph.nodes.length * 28);

  const layoutGraph = useMemo(() => {
    if (!graph.nodes.length) return null;
    const maxCount = Math.max(1, ...graph.links.map((l) => l.value));
    const nodes: SNode[] = graph.nodes.map((n: LineageGraphNode) => ({
      id: n.id, name: n.name, stage: n.stage, counts: n.counts,
    }));
    const links: SLink[] = graph.links.map((l: LineageGraphLink) => ({
      source: l.source,
      target: l.target,
      value: bandLayoutValue(l.value, l.status, maxCount),
      status: l.status,
      flow_id: l.flow_id,
      id: l.id,
      count: l.value,
    }));
    const layout = sankey<SNode, SLink>()
      .nodeId((n) => n.id)
      .nodeWidth(11)
      .nodePadding(18)
      .nodeAlign(sankeyJustify)
      .extent([[124, 18], [width - 156, height - 18]]);
    return layout({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    });
  }, [graph, width, height]);

  if (!layoutGraph) {
    return <div className="px-5 py-10 text-center text-sm text-fg-subtle">No lineage to display.</div>;
  }

  const linkPath = sankeyLinkHorizontal<SNode, SLink>();
  const selectedLink = selection.kind === "link" ? selection.linkId : null;
  const selectedNode = selection.kind === "node" ? selection.nodeId : null;
  const selectedFlow = selection.kind === "flow" || selection.kind === "link" ? selection.flowId : null;

  const dimLink = (l: any) => {
    if (dimBySearch(l.flow_id, highlightFlowIds)) return true;
    if (highlightFlowIds != null) return false;
    if (selection.kind === "all" && !hover) return false;
    if (hover) return hover !== l.id && hover !== l.source.id && hover !== l.target.id;
    if (selectedLink) return l.id !== selectedLink;
    if (selectedNode) return l.source.id !== selectedNode && l.target.id !== selectedNode;
    if (selectedFlow) return l.flow_id !== selectedFlow;
    return false;
  };

  const brightFlows = highlightFlowIds == null
    ? null
    : new Set(highlightFlowIds);
  const dimNode = (n: any) => {
    if (brightFlows) {
      const onFlow = (layoutGraph.links as any[]).some(
        (l) => !dimBySearch(l.flow_id, highlightFlowIds)
          && (l.source.id === n.id || l.target.id === n.id),
      );
      if (!onFlow) return true;
    }
    return selectedNode ? selectedNode !== n.id : false;
  };

  return (
    <div ref={wrapRef} className="relative w-full overflow-x-auto">
      <svg width={width} height={height} className="block" role="img"
           aria-label="Data lineage from source systems to the consolidated close, colored by quality status">
        <rect width={width} height={height} fill="transparent"
              onClick={() => onSelect({ kind: "all" })} />
        <g fill="none">
          {(layoutGraph.links as any[]).map((l, i) => {
            const dim = dimLink(l);
            const active = hover === l.id || selectedLink === l.id
              || (highlightFlowIds != null && !dimBySearch(l.flow_id, highlightFlowIds));
            const opacity = dim ? 0.06 : active ? 0.72 : 0.38;
            const selectLink = () => {
              if (selectedLink === l.id) onSelect({ kind: "all" });
              else onSelect({ kind: "link", linkId: l.id, flowId: l.flow_id, status: l.status });
            };
            return (
              <path
                key={l.id || i}
                d={linkPath(l) || undefined}
                stroke={LINEAGE_STATUS_COLOR[l.status as LineageStatus]}
                strokeOpacity={opacity}
                strokeWidth={Math.max(1.5, l.width)}
                tabIndex={0}
                role="button"
                aria-label={`${l.flow_id} ${l.status} ${l.count} records`}
                className="transition-[stroke-opacity] duration-150 cursor-pointer focus:outline-none"
                onMouseEnter={(e) => {
                  setHover(l.id);
                  setTip({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY, l });
                }}
                onMouseMove={(e) => setTip((t) => t && { ...t, x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })}
                onMouseLeave={() => { setHover(null); setTip(null); }}
                onClick={(e) => { e.stopPropagation(); selectLink(); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectLink();
                  }
                }}
              />
            );
          })}
        </g>
        <g>
          {(layoutGraph.nodes as any[]).map((n) => {
            const x0 = n.x0 as number, x1 = n.x1 as number, y0 = n.y0 as number, y1 = n.y1 as number;
            const on = selectedNode === n.id || hover === n.id;
            const dim = dimNode(n);
            const leftSide = n.stage === 0;
            const lx = leftSide ? x0 - 8 : x1 + 8;
            const caption = nodeCaption(n.counts as Record<string, number>);
            const selectNode = () => onSelect({ kind: "node", nodeId: n.id });
            return (
              <g key={n.id}
                 tabIndex={0}
                 role="button"
                 aria-label={`${n.name} ${caption}`}
                 onMouseEnter={() => setHover(n.id)}
                 onMouseLeave={() => setHover(null)}
                 onClick={(e) => { e.stopPropagation(); selectNode(); }}
                 onKeyDown={(e) => {
                   if (e.key === "Enter" || e.key === " ") {
                     e.preventDefault();
                     selectNode();
                   }
                 }}
                 className="cursor-pointer">
                <rect x={x0} y={y0} width={x1 - x0} height={Math.max(2, y1 - y0)} rx={2}
                      fill={STAGE_COLOR[n.stage]} opacity={dim && !on ? 0.25 : 0.9}
                      className="transition-opacity duration-150" />
                <text x={lx} y={(y0 + y1) / 2 - 4} textAnchor={leftSide ? "end" : "start"}
                      dominantBaseline="middle" fill="#4B5058" fontSize={11.5} fontWeight={600}
                      style={{ paintOrder: "stroke", stroke: "rgb(var(--c-ink-800))", strokeWidth: 3 } as any}>
                  {n.name}
                </text>
                <text x={lx} y={(y0 + y1) / 2 + 9} textAnchor={leftSide ? "end" : "start"}
                      dominantBaseline="middle" fill="#8B909A" fontSize={10}
                      style={{ paintOrder: "stroke", stroke: "rgb(var(--c-ink-800))", strokeWidth: 3 } as any}>
                  {caption}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      {tip && (
        <div className="pointer-events-none absolute z-10 max-w-xs rounded-lg bg-ink-800 ring-1 ring-line shadow-depth px-3 py-2 text-xs"
             style={{ left: Math.min(tip.x + 14, width - 240), top: tip.y + 12 }}>
          <div className="flex items-center gap-2 font-semibold text-fg">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: LINEAGE_STATUS_COLOR[tip.l.status] }} />
            {LINEAGE_STATUS_LABEL[tip.l.status]}
          </div>
          <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-fg-muted">
            <span className="text-fg-subtle">Flow</span><span>{tip.l.flow_id}</span>
            <span className="text-fg-subtle">Records</span><span className="tabular-nums">{tip.l.count.toLocaleString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function LineageLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-fg-muted">
      {STATUSES.map((h) => (
        <span key={h} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-3.5 rounded-sm" style={{ background: LINEAGE_STATUS_COLOR[h], opacity: 0.7 }} />
          {LINEAGE_STATUS_LABEL[h]}
        </span>
      ))}
      <span className="text-fg-subtle">Ribbon width = record volume · issue bands have a visibility floor</span>
    </div>
  );
}
