import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  api, fmt, AnalysisScope, AnalysisScopeId, CloseDocument, CompetitorBenchmark,
  ContractObligation, KpiTrendPoint, RunStage, RunStatus,
} from "../api";
import { Button, Card, ErrorNote, PageHeading, Pill, Section, Select } from "../components/ui";
import { RuleOf40Visual } from "../components/benchmarkCharts";
import { CHART_COLORS } from "../lib/chartPalette";

// Metrics where a lower value is better (working-capital days). Everything else
// (margins) is higher-is-better; revenue is scale context, not a verdict.
const LOWER_BETTER = new Set(["DSO", "DIO", "CCC"]);
const NEUTRAL = new Set(["Revenue ($B)"]);

const RISK_TONE: Record<string, string> = {
  HIGH: "bg-signal-bad/10 text-signal-bad ring-1 ring-signal-bad/30",
  MEDIUM: "bg-signal-warn/10 text-signal-warn ring-1 ring-signal-warn/30",
  LOW: "bg-signal-good/10 text-signal-good ring-1 ring-signal-good/30",
};

function fmtMetric(v: number | null, unit: string): string {
  if (v == null) return "—";
  if (unit === "%") return `${v}%`;
  if (unit === "days") return `${Math.round(v)} d`;
  if (unit === "$B") return `$${v}B`;
  return `${v}`;
}

function Cite({ file, page }: { file: string; page: number }) {
  return <span className="text-[11px] text-fg-subtle font-mono">{file} · p.{page}</span>;
}

export default function CloseSupport() {
  const [docs, setDocs] = useState<CloseDocument[]>([]);
  const [benchmarks, setBenchmarks] = useState<CompetitorBenchmark[]>([]);
  const [obligations, setObligations] = useState<ContractObligation[]>([]);
  const [trend, setTrend] = useState<KpiTrendPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Results (visuals + tables) only appear once a run has completed, and are
  // cleared the moment a new run starts.
  const [showResults, setShowResults] = useState(false);
  const [flash, setFlash] = useState(false);
  // Which scope the last completed run covered — gates which result cards show.
  const [lastScope, setLastScope] = useState<AnalysisScopeId>("all");
  const resultsRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [d, b, o, t] = await Promise.allSettled([
      api.closeDocuments(), api.closeBenchmarks(), api.closeObligations(), api.kpiTrend(),
    ]);
    if (d.status === "fulfilled") setDocs(d.value);
    if (b.status === "fulfilled") setBenchmarks(b.value);
    if (o.status === "fulfilled") setObligations(o.value);
    if (t.status === "fulfilled") setTrend(t.value);
    if (d.status === "rejected" && b.status === "rejected" && o.status === "rejected") {
      setError("Couldn’t load Close Support data.");
    }
  }, []);

  // A new run wipes the previous results so nothing stale shows while it runs.
  const handleExtractionStart = useCallback(() => {
    setShowResults(false);
    setFlash(false);
    setError(null);
    setDocs([]);
    setBenchmarks([]);
    setObligations([]);
  }, []);

  // On completion: load the fresh data, reveal it, scroll to it, and flash.
  const handleExtractionDone = useCallback(async (scope: AnalysisScopeId) => {
    setLastScope(scope);
    await load();
    setShowResults(true);
    setFlash(true);
    requestAnimationFrame(() =>
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    window.setTimeout(() => setFlash(false), 2000);
  }, [load]);

  const competitors = [...new Set(benchmarks.map((b) => b.competitor))].sort();
  // Our YoY revenue growth (for the Rule-of-40 scatter), from the KPI trend —
  // same calc the Executive page uses. Competitors' growth comes from extraction.
  const usGrowth = (() => {
    const rev = trend.map((p) => parseFloat(p.revenue)).filter((v) => Number.isFinite(v));
    if (rev.length < 2 || !rev[0]) return null;
    return Math.round(((rev[rev.length - 1] - rev[0]) / rev[0]) * 1000) / 10;
  })();

  const deltaTone = (m: CompetitorBenchmark): string => {
    if (m.delta == null || NEUTRAL.has(m.metric)) return "text-fg-muted";
    // delta = their - ours. We're ahead when ours is on the better side.
    const weAreAhead = LOWER_BETTER.has(m.metric) ? m.delta > 0 : m.delta < 0;
    return weAreAhead ? "text-signal-good" : "text-signal-bad";
  };

  // Show only the cards for the side(s) the run actually covered.
  const showBenchmarks = lastScope === "all" || lastScope === "filings";
  const showContracts = lastScope === "all" || lastScope === "contracts";

  return (
    <div className="space-y-4 pb-16">
      <PageHeading
        eyebrow="Intelligent Document Processing"
        title="Competitive Benchmarking"
      />

      {error && <ErrorNote message={error} />}

      <LiveExtraction onStart={handleExtractionStart} onComplete={handleExtractionDone} />

      {!showResults && (
        <div className="rounded-2xl glass ring-1 ring-line px-5 py-10 text-center text-sm text-fg-subtle">
          Run an analysis above to extract and visualize the documents.
        </div>
      )}

      {showResults && (
        <div
          ref={resultsRef}
          className={`space-y-4 scroll-mt-4 rounded-2xl transition-shadow duration-700 ${flash ? "ring-2 ring-signal-good/50" : "ring-0"}`}
        >
          {showBenchmarks && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <RuleOf40Visual benchmarks={benchmarks} usGrowth={usGrowth} />
              <PeerRankVisual benchmarks={benchmarks} />
            </div>
          )}
          {showContracts && <RiskVisual obligations={obligations} />}

          {showBenchmarks && (
          <Section
            title="Competitor benchmarks"
            subtitle="extracted from filings vs our close"
            count={benchmarks.length}
            tone="default"
            defaultOpen={false}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-fg-muted text-left">
                  <tr className="border-b border-line">
                    <th className="px-5 py-2.5 font-medium">Metric</th>
                    <th className="px-5 py-2.5 font-medium text-right">Competitor</th>
                    <th className="px-5 py-2.5 font-medium text-right">Us</th>
                    <th className="px-5 py-2.5 font-medium text-right">Δ</th>
                    <th className="px-5 py-2.5 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {competitors.map((c) => {
                    const rows = benchmarks.filter((b) => b.competitor === c);
                    return (
                      <Fragment key={c}>
                        <tr className="bg-black/[0.03]">
                          <td colSpan={5} className="px-5 pt-3 pb-1 text-xs uppercase tracking-wide text-fg-muted font-semibold">{c}</td>
                        </tr>
                        {rows.map((m) => (
                          <tr key={c + m.metric} className="border-b border-line last:border-0 record-row-hover">
                            <td className="px-5 py-2 text-fg-muted">{m.metric}</td>
                            <td className="px-5 py-2 text-right tabular-nums text-fg">{fmtMetric(m.their_value, m.unit)}</td>
                            <td className="px-5 py-2 text-right tabular-nums text-fg-muted">{fmtMetric(m.our_value, m.unit)}</td>
                            <td className={`px-5 py-2 text-right tabular-nums font-medium ${deltaTone(m)}`}>
                              {m.delta == null ? "—" : `${m.delta > 0 ? "+" : ""}${fmtMetric(m.delta, m.unit)}`}
                            </td>
                            <td className="px-5 py-2"><Cite file={m.source_file} page={m.source_page} /></td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                  {competitors.length === 0 && (
                    <tr><td colSpan={5} className="px-5 py-8 text-center text-fg-muted">No benchmarks extracted.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Section>
          )}

          {showContracts && (
          <Section
            title="Contract obligations"
            subtitle="renewal dates, terms & risk"
            count={obligations.length}
            tone="default"
            defaultOpen={false}
          >
            <div className="px-5 py-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
              {obligations.map((o) => (
                <div key={o.contract_id} className="rounded-lg border border-line p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-fg truncate">{o.counterparty}</div>
                      <div className="text-[11px] text-fg-subtle font-mono">{o.contract_id} · {o.category}</div>
                    </div>
                    <Pill value={o.risk_level} className={RISK_TONE[o.risk_level] ?? RISK_TONE.LOW} />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                    <Field label="Renewal" value={`${o.renewal_date}${o.auto_renew ? " (auto)" : ""}`} tone={o.auto_renew ? "warn" : undefined} />
                    <Field label="Annual value" value={o.annual_value != null ? fmt(o.annual_value) : "—"} />
                    <Field label="Payment terms" value={o.payment_terms || "—"} />
                    <Field label="Liability" value={o.liability || "—"} tone={/uncapp/i.test(o.liability || "") ? "bad" : undefined} />
                  </div>
                  {o.risk_note && <p className="mt-3 text-xs text-fg-muted leading-relaxed">{o.risk_note}</p>}
                  {o.obligations.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {o.obligations.map((ob, i) => (
                        <li key={i} className="text-[11px] text-fg-muted flex gap-1.5"><span className="text-fg-subtle">•</span>{ob}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 pt-2 border-t border-line"><Cite file={o.source_file} page={o.source_page} /></div>
                </div>
              ))}
              {obligations.length === 0 && (
                <div className="col-span-full px-1 py-8 text-center text-fg-muted text-sm">No contracts analyzed.</div>
              )}
            </div>
          </Section>
          )}

          <Section title="Source documents" subtitle="the governed unstructured inputs" count={docs.length} defaultOpen={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-fg-muted text-left">
                  <tr className="border-b border-line">
                    <th className="px-5 py-2.5 font-medium">Document</th>
                    <th className="px-5 py-2.5 font-medium">Type</th>
                    <th className="px-5 py-2.5 font-medium">Party</th>
                    <th className="px-5 py-2.5 font-medium text-right">Pages</th>
                  </tr>
                </thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.filename} className="border-b border-line last:border-0 record-row-hover">
                      <td className="px-5 py-2 font-mono text-[12px] text-fg-muted">{d.filename}</td>
                      <td className="px-5 py-2"><Pill value={d.doc_type} className="bg-black/[0.04] text-fg-muted ring-1 ring-line" /></td>
                      <td className="px-5 py-2 text-fg-muted">{d.counterparty}</td>
                      <td className="px-5 py-2 text-right tabular-nums text-fg-muted">{d.pages}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, tone }: { label: string; value: string; tone?: "warn" | "bad" }) {
  const t = tone === "bad" ? "text-signal-bad" : tone === "warn" ? "text-signal-warn" : "text-fg";
  return (
    <div className="flex flex-col">
      <span className="text-fg-subtle">{label}</span>
      <span className={`font-medium ${t}`}>{value}</span>
    </div>
  );
}

type EntityMetrics = { name: string; m: Record<string, number>; isUs: boolean };

// Pivot the flat benchmark rows into per-entity metric maps ("Us" from our_value,
// each competitor from their_value).
function pivotBenchmarks(benchmarks: CompetitorBenchmark[]): EntityMetrics[] {
  const comps: Record<string, Record<string, number>> = {};
  const us: Record<string, number> = {};
  for (const b of benchmarks) {
    if (b.their_value != null) (comps[b.competitor] ||= {})[b.metric] = b.their_value;
    if (b.our_value != null) us[b.metric] = b.our_value;
  }
  return [
    { name: "Us", m: us, isUs: true },
    ...Object.entries(comps).map(([name, m]) => ({ name, m, isUs: false })),
  ];
}

// Filings visual #2 — "how we rank vs peers": one position-bullet per metric.
// Each track spans the peer set's range with a peer-average tick and an Us dot;
// tracks are oriented so RIGHT is always better, regardless of the metric.
const RANK_METRICS: { metric: string; unit: "%" | "d"; better: "high" | "low" }[] = [
  { metric: "Gross margin", unit: "%", better: "high" },
  { metric: "Operating margin", unit: "%", better: "high" },
  { metric: "Net margin", unit: "%", better: "high" },
  { metric: "DSO", unit: "d", better: "low" },
  { metric: "DIO", unit: "d", better: "low" },
  { metric: "DPO", unit: "d", better: "high" },
  { metric: "CCC", unit: "d", better: "low" },
];

const fmtVal = (v: number, unit: "%" | "d") => (unit === "%" ? `${Math.round(v * 10) / 10}%` : `${Math.round(v)} d`);

function PeerRankVisual({ benchmarks }: { benchmarks: CompetitorBenchmark[] }) {
  const entities = pivotBenchmarks(benchmarks);
  const us = entities.find((e) => e.isUs);
  const peers = entities.filter((e) => !e.isUs);

  const rows = RANK_METRICS.map((cfg) => {
    const usVal = us?.m[cfg.metric];
    const peerVals = peers.map((p) => p.m[cfg.metric]).filter((v): v is number => v != null);
    if (usVal == null || peerVals.length === 0) return null;
    const all = [usVal, ...peerVals];
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const span = hi - lo || 1;
    // Raw 0..1 then oriented so "better" is to the right.
    const orient = (v: number) => {
      const raw = (v - lo) / span;
      return (cfg.better === "high" ? raw : 1 - raw) * 100;
    };
    const peerAvg = peerVals.reduce((s, v) => s + v, 0) / peerVals.length;
    const peerLo = Math.min(...peerVals), peerHi = Math.max(...peerVals);
    const isBetter = (v: number) => (cfg.better === "high" ? v > usVal : v < usVal);
    const rank = 1 + all.filter(isBetter).length;
    const aheadOfAvg = cfg.better === "high" ? usVal >= peerAvg : usVal <= peerAvg;
    // Peer range as a bar (min..max in oriented space; ends may swap on flip).
    const a = orient(peerLo), b = orient(peerHi);
    return {
      ...cfg, usVal, peerAvg, rank, n: all.length, aheadOfAvg,
      usPos: orient(usVal), avgPos: orient(peerAvg),
      rangeLo: Math.min(a, b), rangeHi: Math.max(a, b),
    };
  }).filter((r): r is NonNullable<typeof r> => r != null);

  if (rows.length === 0) {
    return (
      <Card title="How we rank vs peers" subtitle="benchmark position">
        <div className="px-5 py-10 text-center text-sm text-fg-subtle">No benchmark data yet — run an analysis.</div>
      </Card>
    );
  }

  const wins = rows.filter((r) => r.aheadOfAvg).length;

  return (
    <Card title="How we rank vs peers" subtitle="position in the peer set · right is better">
      <div className="px-5 py-4 space-y-3">
        {rows.map((r) => (
          <div key={r.metric} className="flex items-center gap-3 text-xs">
            <div className="w-28 shrink-0">
              <div className="text-fg-muted">{r.metric}</div>
              <div className="text-[10px] text-fg-subtle num">#{r.rank} of {r.n}</div>
            </div>
            <div className="relative h-5 flex-1">
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-black/[0.06]" />
              <div
                className="absolute top-1/2 -translate-y-1/2 h-1 rounded-full bg-black/[0.08]"
                style={{ left: `${r.rangeLo}%`, width: `${Math.max(2, r.rangeHi - r.rangeLo)}%` }}
                title="peer range"
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 w-px h-3 bg-fg-muted"
                style={{ left: `${r.avgPos}%` }}
                title={`peer average ${fmtVal(r.peerAvg, r.unit)}`}
              />
              <div
                className="absolute top-1/2 w-3 h-3 rounded-full ring-2 ring-black/40 shadow"
                style={{
                  left: `${r.usPos}%`,
                  transform: "translate(-50%, -50%)",
                  backgroundColor: r.aheadOfAvg ? CHART_COLORS.good : CHART_COLORS.bad,
                }}
                title={`Us ${fmtVal(r.usVal, r.unit)}`}
              />
            </div>
            <div className="w-24 shrink-0 text-right num tabular-nums">
              <span className="text-fg font-semibold">{fmtVal(r.usVal, r.unit)}</span>
              <span className="text-fg-subtle"> vs {fmtVal(r.peerAvg, r.unit)}</span>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] pt-1 text-fg-subtle">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: CHART_COLORS.good }} />us (ahead)</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: CHART_COLORS.bad }} />us (behind)</span>
          <span className="flex items-center gap-1.5"><span className="w-px h-3 bg-fg-muted" />peer avg</span>
          <span className="flex items-center gap-1.5"><span className="w-4 h-1 rounded-full bg-black/[0.08]" />peer range</span>
        </div>
        <p className="text-[11px] text-fg-subtle">
          Ahead of the peer average on <span className="font-semibold text-signal-good">{wins}</span> of {rows.length} metrics.
        </p>
      </div>
    </Card>
  );
}

// Headline visual for the contracts side: risk distribution, value at risk,
// and the nearest renewal — the "obligations at a glance".
function RiskVisual({ obligations }: { obligations: ContractObligation[] }) {
  const total = obligations.length;
  const counts: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  let valueAtRisk = 0;
  let nextRenewal: { date: string; who: string } | null = null;
  for (const o of obligations) {
    const lvl = (o.risk_level || "LOW").toUpperCase();
    counts[lvl] = (counts[lvl] ?? 0) + 1;
    if (lvl === "HIGH" && o.annual_value) valueAtRisk += o.annual_value;
    if (o.renewal_date && (!nextRenewal || o.renewal_date < nextRenewal.date)) {
      nextRenewal = { date: o.renewal_date, who: o.counterparty };
    }
  }
  const segs = [
    { k: "HIGH", n: counts.HIGH, cls: "bg-signal-bad" },
    { k: "MEDIUM", n: counts.MEDIUM, cls: "bg-signal-warn" },
    { k: "LOW", n: counts.LOW, cls: "bg-signal-good" },
  ];

  if (total === 0) {
    return (
      <Card title="Contract risk profile" subtitle="by obligation">
        <div className="px-5 py-10 text-center text-sm text-fg-subtle">
          No contracts analyzed yet — run an analysis.
        </div>
      </Card>
    );
  }

  return (
    <Card title="Contract risk profile" subtitle={`${total} contracts`}>
      <div className="px-5 py-4 space-y-4">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-black/[0.04]">
          {segs.map((s) => (s.n > 0 ? (
            <div key={s.k} className={s.cls} style={{ width: `${(s.n / total) * 100}%`, opacity: 0.85 }} />
          ) : null))}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          {segs.map((s) => (
            <span key={s.k} className="flex items-center gap-1.5 text-fg-muted">
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${s.cls}`} />
              {s.k} <span className="font-semibold text-fg num">{s.n}</span>
            </span>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4 pt-1">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Value at risk</div>
            <div className="text-2xl font-bold num text-signal-bad">{valueAtRisk > 0 ? fmt(valueAtRisk) : "—"}</div>
            <div className="text-[11px] text-fg-subtle mt-0.5">annual value in HIGH-risk contracts</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Next renewal</div>
            <div className="text-2xl font-bold num text-fg">{nextRenewal?.date ?? "—"}</div>
            <div className="text-[11px] text-fg-subtle mt-0.5 truncate">{nextRenewal?.who ?? ""}</div>
          </div>
        </div>
      </div>
    </Card>
  );
}

// --- Live extraction: point at a folder, re-run the IDP pipeline on demand ---
// Parsing is pre-computed at build time, so a live run is just the extraction
// (ai_extract + ai_query). The "Parsing" stage is held on screen for a minimum
// dwell so it reads as live parsing even though it resolves in sub-second.
const STAGES: { id: RunStage; label: string; note: string }[] = [
  { id: "parsing", label: "Parsing", note: "reading documents" },
  { id: "extracting", label: "Extracting", note: "ai_extract + ai_query" },
  { id: "materializing", label: "Materializing", note: "governed tables" },
];
const PARSE_MIN_MS = 3500;

const STAGE_IDX: Record<RunStage, number> = {
  idle: -1, parsing: 0, extracting: 1, materializing: 2, done: 3, error: -1,
};

function LiveExtraction({ onStart, onComplete }: { onStart: () => void; onComplete: (scope: AnalysisScopeId) => void }) {
  const [scopes, setScopes] = useState<AnalysisScope[]>([]);
  const [scope, setScope] = useState<AnalysisScopeId>("all");
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [, forceTick] = useState(0);
  // Uploads are always tagged as competitor filings (the type selector was removed).
  const uploadType = "filing" as const;
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);
  const parseUntilRef = useRef(0);
  const doneRef = useRef(false);
  const lastIdxRef = useRef(0);
  const runScopeRef = useRef<AnalysisScopeId>("all");

  const refreshScopes = useCallback(() => {
    api.analysisScopes().then(setScopes).catch(() => {});
  }, []);

  useEffect(() => {
    refreshScopes();
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [refreshScopes]);

  const selected = scopes.find((s) => s.scope === scope);
  const backendStage: RunStage = status?.stage ?? "idle";

  // Hold "parsing" on screen for the minimum dwell even if the backend races
  // ahead — the theatrical bit. Real extraction is long enough that later
  // stages still show their true duration.
  let visualStage: RunStage = backendStage;
  if (running && Date.now() < parseUntilRef.current
      && (backendStage === "extracting" || backendStage === "materializing" || backendStage === "done")) {
    visualStage = "parsing";
  }
  const idx = visualStage === "error" ? lastIdxRef.current : STAGE_IDX[visualStage];
  if (visualStage !== "error" && idx >= 0) lastIdxRef.current = idx;

  const stopPolling = () => {
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
  };

  const poll = useCallback(async () => {
    let s: RunStatus;
    try {
      s = await api.runStatus();
    } catch {
      return;
    }
    setStatus(s);
    forceTick((t) => t + 1);
    if (s.stage === "error" && !doneRef.current) {
      doneRef.current = true;
      stopPolling();
      setRunning(false);
      setRunError(s.error || "Extraction failed.");
    } else if (s.stage === "done" && !doneRef.current) {
      doneRef.current = true;
      stopPolling();
      setRunning(false);
      setUploaded(null);
      refreshScopes();
      onComplete(runScopeRef.current);
    }
  }, [onComplete, refreshScopes]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!f) return;
    setRunError(null);
    setUploading(true);
    try {
      const res = await api.uploadDoc(f, uploadType);
      setUploaded(res.filename);
      setScope(uploadType === "filing" ? "filings" : "contracts");
      refreshScopes();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function handleRun() {
    setRunError(null);
    setStatus(null);
    doneRef.current = false;
    lastIdxRef.current = 0;
    parseUntilRef.current = Date.now() + PARSE_MIN_MS;
    try {
      await api.runExtraction(scope);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Couldn’t start the run.");
      return;
    }
    runScopeRef.current = scope; // remember which side(s) this run covered
    onStart(); // clear any previous results while this run is in flight
    setRunning(true);
    stopPolling();
    pollRef.current = window.setInterval(poll, 1500);
    // Re-render once the parsing dwell elapses so the stepper can advance.
    window.setTimeout(() => forceTick((t) => t + 1), PARSE_MIN_MS + 50);
    poll();
  }

  const isDone = !running && backendStage === "done";
  const docCount = status?.docs || selected?.pdf_count || 0;

  return (
    <Card tone="quiet">
      <div className="px-5 py-3 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Analysis scope"
            mono
            value={scope}
            disabled={running}
            onChange={(v) => setScope(v as AnalysisScopeId)}
            className="min-w-0 flex-1 max-w-md"
            options={scopes.map((s) => ({ value: s.scope, label: s.path }))}
          />
          <Button variant="primary" onClick={handleRun} disabled={running || scopes.length === 0}>
            {running ? "Analyzing…" : "Run analysis"}
          </Button>
          <span className="text-[11px] text-fg-subtle whitespace-nowrap">
            {selected ? `${selected.pdf_count} PDFs` : "—"}
            {selected && selected.scope !== "all" ? " · this category" : ""}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={handleUpload} />
            <Button variant="neutral" size="sm" onClick={() => fileRef.current?.click()} disabled={running || uploading}>
              {uploading ? "Uploading…" : "Upload PDF"}
            </Button>
          </div>
        </div>

        {uploaded && !running && (
          <div className="text-xs text-signal-good num">✓ Added {uploaded} — click Run analysis to extract it</div>
        )}
        {runError && <ErrorNote message={runError} />}

        {running && (
          <div className="rounded-xl bg-black/[0.03] ring-1 ring-line px-4 py-3">
            <div className="flex items-stretch gap-4">
              {STAGES.map((st, i) => {
                const state: StageState =
                  visualStage === "error" && i === lastIdxRef.current ? "error"
                    : i < idx ? "done"
                    : i === idx ? "active"
                    : "pending";
                return <StageBar key={st.id} label={st.label} note={st.note} state={state} />;
              })}
            </div>
            <div className="mt-2 text-xs text-fg-muted num">
              {visualStage === "parsing" ? `Reading ${docCount} documents…`
                : visualStage === "extracting" ? `Extracting from ${docCount} documents…`
                : visualStage === "materializing" ? "Writing governed tables…"
                : ""}
            </div>
          </div>
        )}

        {isDone && (
          <div className="flex items-center gap-2 rounded-lg bg-signal-good/10 ring-1 ring-signal-good/30 px-3 py-1.5 text-xs text-signal-good num">
            <span aria-hidden="true">✓</span>
            <span>
              Extraction complete — {status?.docs ?? docCount} documents · {status?.benchmarks ?? 0} benchmark rows · {status?.obligations ?? 0} obligations.
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}

type StageState = "done" | "active" | "pending" | "error";

// A stage as a single large square: solid green once the stage is done, an
// animated accent pulse while it's active, a faint outline when queued.
function StageBar({ label, note, state }: {
  label: string; note: string; state: StageState;
}) {
  const statusText = state === "done" ? "done"
    : state === "active" ? "working"
    : state === "error" ? "failed" : "queued";
  const statusTone = state === "done" ? "text-signal-good"
    : state === "active" ? "text-accent-400 dark:text-fg"
    : state === "error" ? "text-signal-bad" : "text-fg-subtle";
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <span className={`text-sm font-medium truncate ${state === "pending" ? "text-fg-subtle" : "text-fg"}`}>
          {label}
        </span>
        <span className={`text-[10px] uppercase tracking-wide shrink-0 ${statusTone}`}>{statusText}</span>
      </div>
      <div
        className={`h-16 w-full rounded-lg transition-all duration-300 ${
          state === "done" ? "bg-signal-good"
            : state === "error" ? "bg-signal-bad/40"
            : state === "active" ? "bg-accent animate-pulse"
            : "bg-black/[0.04] ring-1 ring-inset ring-line"
        }`}
      />
      <div className="text-[11px] text-fg-subtle mt-1 truncate">{note}</div>
    </div>
  );
}
