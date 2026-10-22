import { ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Burndown } from "../api";
import { closeDayIndex } from "../lib/demoCalendar";
import { CHART_AXIS_TEXT_PIXEL, CHART_COLORS } from "../lib/chartPalette";
import { Card } from "./ui";

const COLORS = {
  actual: CHART_COLORS.accent, // where the close actually is
  plan: CHART_COLORS.slate, // the planned path (the commitment)
  ahead: CHART_COLORS.good, // favourable — below plan = ahead of schedule
  behind: CHART_COLORS.bad, // adverse — above plan = behind schedule
  grid: CHART_COLORS.grid,
  today: "rgba(23,25,32,0.28)",
};

const fmtDay = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

// Close-day label: T is month-end (the cutoff), T+n is n business days after.
const tLabel = (t: number) => (t === 0 ? "T" : t > 0 ? `T+${t}` : `T\u2212${-t}`);

// SVG geometry. The plot fills its container: width and height are measured so
// the chart grows to use the full card height (viewBox maps 1:1 to pixels, so
// nothing is distorted).
const padL = 34, padR = 18, padT = 16, padB = 30;

export function CloseBurndown({ data, beforeChart, className }: { data: Burndown; beforeChart?: ReactNode; className?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 780, h: 260 });

  // Track the plot container's pixel size so the chart fills whatever vertical
  // space the (now full-height) card gives it.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setDims({ w: Math.max(320, el.clientWidth), h: Math.max(160, el.clientHeight) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = dims.w, H = dims.h;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const geom = useMemo(() => {
    const pts = data.points;
    const n = pts.length;
    const maxY = Math.max(data.total, 1) * 1.08;
    const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v: number) => padT + (1 - v / maxY) * plotH;

    const line = (sel: (p: typeof pts[number]) => number | null) => {
      const segs: string[] = [];
      let open = false;
      pts.forEach((p, i) => {
        const v = sel(p);
        if (v == null) { open = false; return; }
        segs.push(`${open ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
        open = true;
      });
      return segs.join(" ");
    };

    const actualPath = line((p) => p.actual);
    const plannedPath = line((p) => p.planned);
    const projectedPath = line((p) => p.projected);

    // Signed gap between actual and plan, as coloured bands: green where the
    // actual line sits BELOW the plan (fewer tasks left than planned = ahead),
    // red where it sits ABOVE (behind). Segments that cross the plan are split
    // at the crossing so the colour flips exactly where the schedule verdict does.
    const quad = (xa: number, aTop: number, aBot: number, xb: number, bTop: number, bBot: number) =>
      `M${xa.toFixed(1)},${y(aTop).toFixed(1)} L${xb.toFixed(1)},${y(bTop).toFixed(1)} `
      + `L${xb.toFixed(1)},${y(bBot).toFixed(1)} L${xa.toFixed(1)},${y(aBot).toFixed(1)} Z`;
    const bands: { d: string; behind: boolean }[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a0 = pts[i].actual, a1 = pts[i + 1].actual;
      if (a0 == null || a1 == null) continue;
      const p0 = pts[i].planned, p1 = pts[i + 1].planned;
      const x0 = x(i), x1 = x(i + 1);
      const d0 = a0 - p0, d1 = a1 - p1; // >0 = behind (above plan)
      if ((d0 >= 0 && d1 >= 0) || (d0 <= 0 && d1 <= 0)) {
        bands.push({ d: quad(x0, a0, p0, x1, a1, p1), behind: d0 + d1 > 0 });
      } else {
        const f = d0 / (d0 - d1);            // fraction along the segment to the crossing
        const xm = x0 + f * (x1 - x0);
        const am = a0 + f * (a1 - a0);        // actual == plan at the crossing
        bands.push({ d: quad(x0, a0, p0, xm, am, am), behind: d0 > 0 });
        bands.push({ d: quad(xm, am, am, x1, a1, p1), behind: d1 > 0 });
      }
    }

    // The chart preserves the seeded close-cycle stage while its dates are
    // relabelled. Match "today" by T+n, not the browser-literal `today` date.
    const todayIdx = closeDayIndex(pts, data.today_t);
    const targetIdx = pts.findIndex((p) => p.date === data.target_close_date);
    const cutoffIdx = pts.findIndex((p) => p.t === 0);
    const projIdx = data.projected_finish_date
      ? pts.findIndex((p) => p.date === data.projected_finish_date) : -1;
    const plannedAtToday = todayIdx >= 0 ? pts[todayIdx].planned : null;

    // A handful of evenly spaced date ticks.
    const tickCount = Math.min(6, n);
    const ticks = Array.from({ length: tickCount }, (_, k) =>
      Math.round((k / Math.max(tickCount - 1, 1)) * (n - 1)));

    return { pts, n, x, y, maxY, actualPath, plannedPath, projectedPath, bands,
             todayIdx, targetIdx, cutoffIdx, projIdx, plannedAtToday, ticks };
  }, [data, W, H, plotW, plotH]);

  const projColor = data.on_track ? COLORS.ahead : COLORS.behind;
  // Verdict at today: are we above or below the plan right now?
  const behindToday = geom.plannedAtToday != null && data.remaining > geom.plannedAtToday;
  const todayColor = behindToday ? COLORS.behind : COLORS.ahead;
  const hoverPt = hover != null ? geom.pts[hover] : null;

  return (
    <Card
      title="Close burn-down"
      subtitle="tasks remaining vs plan · business days after month-end (T)"
      className={className}
    >
      {beforeChart && <div className="px-3 pt-2 border-b border-line shrink-0">{beforeChart}</div>}
      <div className="px-3 pt-3 pb-2 flex-1 flex flex-col min-h-0">
        <div ref={wrapRef} className="flex-1 min-h-0 w-full">
        <svg
          width={W} height={H}
          viewBox={`0 0 ${W} ${H}`} className="block font-sans" role="img"
          aria-label="Close burn-down: tasks remaining versus the planned path, shaded as ahead or behind plan, with a projected finish in close-days (T plus n)"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const svgX = ((e.clientX - rect.left) / rect.width) * W;
            const rel = (svgX - padL) / plotW;
            const i = Math.round(rel * (geom.n - 1));
            setHover(Math.max(0, Math.min(geom.n - 1, i)));
          }}
        >
          {/* Horizontal gridlines + y labels (0 .. total). */}
          {[0, 0.5, 1].map((f) => {
            const v = Math.round(data.total * f);
            return (
              <g key={f}>
                <line x1={padL} x2={W - padR} y1={geom.y(v)} y2={geom.y(v)} stroke={COLORS.grid} strokeWidth="1" />
                <text x={padL - 6} y={geom.y(v) + 3} {...CHART_AXIS_TEXT_PIXEL}
                      fill={CHART_COLORS.axis} textAnchor="end">{v}</text>
              </g>
            );
          })}

          {/* Month-end cutoff (T) reference. */}
          {geom.cutoffIdx >= 0 && (
            <line x1={geom.x(geom.cutoffIdx)} x2={geom.x(geom.cutoffIdx)} y1={padT} y2={H - padB}
                  stroke={COLORS.today} strokeWidth="1" strokeDasharray="1 3" opacity="0.5" />
          )}

          {/* Target close reference line. The label flips to stay inside the
              plot: right-aligned near the right edge (where the target usually
              sits), left-aligned near the left edge, centered otherwise. */}
          {geom.targetIdx >= 0 && (() => {
            const tx = geom.x(geom.targetIdx);
            const anchor = tx > W - padR - 32 ? "end" : tx < padL + 32 ? "start" : "middle";
            const labelX = anchor === "end" ? W - padR : anchor === "start" ? padL : tx;
            return (
              <g>
                <line x1={tx} x2={tx} y1={padT} y2={H - padB}
                      stroke={COLORS.behind} strokeWidth="1" strokeDasharray="2 3" opacity="0.5" />
                <text x={labelX} y={padT - 6} fontSize="9" fill={COLORS.behind}
                      textAnchor={anchor} fontWeight="600">
                  Target {tLabel(data.target_t)}
                </text>
              </g>
            );
          })()}

          {/* Today marker. */}
          {geom.todayIdx >= 0 && (
            <line x1={geom.x(geom.todayIdx)} x2={geom.x(geom.todayIdx)} y1={padT} y2={H - padB}
                  stroke={COLORS.today} strokeWidth="1" strokeDasharray="1 3" />
          )}

          {/* Signed ahead/behind bands between actual and plan. */}
          {geom.bands.map((b, i) => (
            <path key={i} d={b.d} fill={b.behind ? COLORS.behind : COLORS.ahead} opacity="0.16" />
          ))}

          {/* Planned path (dashed) — the commitment. */}
          <path d={geom.plannedPath} fill="none" stroke={COLORS.plan} strokeWidth="1.75"
                strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />

          {/* Actual remaining — where we really are. */}
          <path d={geom.actualPath} fill="none" stroke={COLORS.actual} strokeWidth="2.5"
                strokeLinejoin="round" strokeLinecap="round" />

          {/* Projected finish (dashed forecast tail). */}
          <path d={geom.projectedPath} fill="none" stroke={projColor} strokeWidth="2"
                strokeDasharray="4 4" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />

          {/* Projected finish dot + label. */}
          {geom.projIdx >= 0 && (
            <g>
              <circle cx={geom.x(geom.projIdx)} cy={geom.y(0)} r="3.5" fill={projColor} />
              {data.projected_t != null && (
                <text x={geom.x(geom.projIdx)} y={geom.y(0) - 7} fontSize="9" fill={projColor}
                      textAnchor="middle" fontWeight="600">
                  {tLabel(data.projected_t)}
                </text>
              )}
            </g>
          )}

          {/* Today's remaining dot (join of actual + projection). */}
          {geom.todayIdx >= 0 && (
            <circle cx={geom.x(geom.todayIdx)} cy={geom.y(data.remaining)} r="3.5"
                    fill={todayColor} stroke="#fff" strokeWidth="1.5" />
          )}

          {/* X-axis close-day ticks (T, T+n). */}
          {geom.ticks.map((i) => (
            <text key={i} x={geom.x(i)} y={H - 10} {...CHART_AXIS_TEXT_PIXEL}
                  fill={CHART_COLORS.axis} textAnchor="middle">
              {tLabel(geom.pts[i].t)}
            </text>
          ))}

          {/* Hover guide + markers. */}
          {hoverPt && (
            <g>
              <line x1={geom.x(hover!)} x2={geom.x(hover!)} y1={padT} y2={H - padB}
                    stroke={COLORS.today} strokeWidth="1" />
              {hoverPt.actual != null && (
                <circle cx={geom.x(hover!)} cy={geom.y(hoverPt.actual)} r="3" fill={COLORS.actual} />
              )}
              {hoverPt.projected != null && hoverPt.actual == null && (
                <circle cx={geom.x(hover!)} cy={geom.y(hoverPt.projected)} r="3" fill={projColor} />
              )}
              <circle cx={geom.x(hover!)} cy={geom.y(hoverPt.planned)} r="2.5" fill={COLORS.plan} />
            </g>
          )}

          {/* Floating tooltip anchored to the hovered point. */}
          {hoverPt && (() => {
            const isActual = hoverPt.actual != null;
            const valLabel = isActual ? "Remaining" : "Projected";
            const valNum = isActual ? hoverPt.actual! : Math.round(hoverPt.projected ?? 0);
            const valColor = isActual
              ? (hoverPt.actual! > hoverPt.planned ? COLORS.behind : COLORS.ahead)
              : projColor;
            const boxW = 120, boxH = 54;
            const cx = geom.x(hover!);
            const anchorY = geom.y(isActual ? hoverPt.actual! : (hoverPt.projected ?? 0));
            // Flip to the left when close to the right edge.
            const left = cx + boxW + 12 > W - padR;
            const bx = left ? cx - boxW - 10 : cx + 10;
            let by = anchorY - boxH / 2;
            by = Math.max(padT, Math.min(H - padB - boxH, by));
            const tx = bx + 10;
            return (
              <g pointerEvents="none">
                <rect x={bx} y={by} width={boxW} height={boxH} rx="6"
                      fill="#ffffff" stroke={COLORS.grid} strokeWidth="1"
                      style={{ filter: "drop-shadow(0 2px 6px rgba(23,25,32,0.18))" }} />
                <text x={tx} y={by + 15} fontSize="10" fontWeight="700" fill="#171920">
                  {tLabel(hoverPt.t)}
                  <tspan fontSize="9" fontWeight="400" fill={CHART_COLORS.axis}> · {fmtDay(hoverPt.date)}</tspan>
                </text>
                <g>
                  <circle cx={tx + 3} cy={by + 30} r="3" fill={valColor} />
                  <text x={tx + 11} y={by + 33} fontSize="9.5" fill="#4B5058">
                    {valLabel} <tspan fontWeight="600" fill="#171920">{valNum}</tspan>
                  </text>
                </g>
                <g>
                  <circle cx={tx + 3} cy={by + 44} r="3" fill={COLORS.plan} />
                  <text x={tx + 11} y={by + 47} fontSize="9.5" fill="#4B5058">
                    Plan <tspan fontWeight="600" fill="#171920">{Math.round(hoverPt.planned)}</tspan>
                  </text>
                </g>
              </g>
            );
          })()}
        </svg>
        </div>

        <div className="flex items-center justify-between gap-4 flex-wrap px-2 pt-1 shrink-0">
          <Legend projColor={projColor} />
          <p className="text-[11px] text-fg-subtle">
            {hoverPt ? (
              <>
                <span className="font-medium text-fg">{tLabel(hoverPt.t)}</span>
                {" · "}
                {hoverPt.actual != null
                  ? <>remaining <span className="font-semibold num" style={{ color: hoverPt.actual > hoverPt.planned ? COLORS.behind : COLORS.ahead }}>{hoverPt.actual}</span></>
                  : <>projected <span className="font-semibold num" style={{ color: projColor }}>{Math.round(hoverPt.projected ?? 0)}</span></>}
                {" · plan "}<span className="num">{Math.round(hoverPt.planned)}</span>
              </>
            ) : (
              <>
                <span className="font-semibold text-fg num">{data.completed}</span> of{" "}
                <span className="num">{data.total}</span> tasks done ·{" "}
                {data.projected_t != null ? (
                  <>projected finish <span className="font-semibold text-fg">{tLabel(data.projected_t)}</span> vs target <span className="font-semibold text-fg">{tLabel(data.target_t)}</span></>
                ) : (
                  <>no completions yet — projection pending</>
                )}
              </>
            )}
          </p>
        </div>
      </div>
    </Card>
  );
}

function Legend({ projColor }: { projColor: string }) {
  const lineItem = (color: string, label: string, dashed = false) => (
    <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
      <svg width="16" height="6" aria-hidden="true">
        <line x1="0" y1="3" x2="16" y2="3" stroke={color} strokeWidth="2.5"
              strokeDasharray={dashed ? "3 3" : undefined} strokeLinecap="round" />
      </svg>
      {label}
    </span>
  );
  const fillItem = (color: string, label: string) => (
    <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
      <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color, opacity: 0.5 }} />
      {label}
    </span>
  );
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {lineItem(COLORS.actual, "Remaining")}
      {lineItem(COLORS.plan, "Plan", true)}
      {fillItem(COLORS.ahead, "Ahead of plan")}
      {fillItem(COLORS.behind, "Behind plan")}
      {lineItem(projColor, "Projected finish", true)}
    </div>
  );
}
