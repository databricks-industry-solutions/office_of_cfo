import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, CompanyCandidate, CompetitorNote, MetricCatalogResponse, SearchBenchmark,
  SearchRunStatus, SearchStage, SearchTrendRow,
} from "../api";
import { Button, Card, ErrorNote, Section } from "../components/ui";
import { BenchmarkTrendChart, PeerRankVisual, RuleOf40Visual } from "../components/benchmarkCharts";
import { StageBar, StageState } from "../components/StageBar";
import { useCompany } from "../lib/deployment";
import {
  DEFAULT_METRIC_CATALOG,
  MetricCatalog,
  metaFor,
  presentMetrics,
  uniqueMetrics,
} from "../lib/benchmarkCoverage";

// Company-search benchmarking (Competitors benchmarking). Search listed
// companies -> stage a selection of them -> on Run, resolve each to a public
// filing (ESEF / SEC EDGAR), compute curated sparse metrics, and render the
// reused charts + an AI positioning note. Fully isolated from the Close
// Support / IDP tab (its own API + tables). Analysis only runs on the button.

const STAGES: { id: SearchStage; label: string; note: string }[] = [
  { id: "resolving", label: "Resolving", note: "company → filing" },
  { id: "fetching", label: "Fetching", note: "public XBRL filing" },
  { id: "computing", label: "Computing", note: "metrics + AI note" },
  { id: "writing", label: "Writing", note: "governed tables" },
];
const STAGE_IDX: Record<SearchStage, number> = {
  idle: -1, resolving: 0, fetching: 1, computing: 2, writing: 3, done: 4, error: -1,
};

const FLAG: Record<string, string> = {
  NL: "🇳🇱", BE: "🇧🇪", LU: "🇱🇺", FR: "🇫🇷", DE: "🇩🇪", ES: "🇪🇸", IT: "🇮🇹",
  SE: "🇸🇪", IE: "🇮🇪", GB: "🇬🇧", US: "🇺🇸", CH: "🇨🇭", DK: "🇩🇰", FI: "🇫🇮", NO: "🇳🇴",
};

const candId = (c: CompanyCandidate) => `${c.source}:${c.key}`;

function fmtMetric(v: number | null, unit: string): string {
  if (v == null) return "—";
  if (unit === "%") return `${v}%`;
  if (unit === "days") return `${Math.round(v)} d`;
  if (unit.endsWith("B")) return `${unit.slice(0, -1)}${v}B`;
  return `${v}`;
}

export default function CompetitorSearch() {
  // The company we're benchmarking: the one the demo was installed for
  // (scripts/setup.py --company). Empty only when the app runs without one.
  const customer = useCompany();
  // Suggested peers of that customer. null means "still deriving" (the request is
  // in flight); [] means nothing public survived validation — show the license
  // prompt instead of inventing industry substitutes.
  const [peerPicks, setPeerPicks] = useState<string[] | null>(null);

  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<CompanyCandidate[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searching, setSearching] = useState(false);

  // Staged (pending) selection — companies chosen but not yet analyzed.
  const [selected, setSelected] = useState<CompanyCandidate[]>([]);

  const [benchmarks, setBenchmarks] = useState<SearchBenchmark[]>([]);
  const [trends, setTrends] = useState<SearchTrendRow[]>([]);
  const [notes, setNotes] = useState<CompetitorNote[]>([]);
  const [usGrowth, setUsGrowth] = useState<number | null>(null);

  const [status, setStatus] = useState<SearchRunStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [addingName, setAddingName] = useState<string | null>(null);
  const [batchPos, setBatchPos] = useState<{ i: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  // Visuals only appear after an analysis completes in this session — the page
  // starts clean (and stays clean while a run is in flight), even if the isolated
  // tables still hold results from a previous session.
  const [showResults, setShowResults] = useState(false);
  // Competitors analyzed in the MOST RECENT run. The results, peer set, and
  // staging dedup are all scoped to these, so the charts reflect only the current
  // search — each run replaces this set (the isolated Delta tables persist rows
  // across runs, so we filter them down to this run's picks).
  const [sessionPeers, setSessionPeers] = useState<Set<string>>(() => new Set());
  const [catalog, setCatalog] = useState<MetricCatalog>(DEFAULT_METRIC_CATALOG);
  // Companies in this run that were served from Delta cache (quiet UX hint).
  const [cachedPeers, setCachedPeers] = useState<string[]>([]);

  const pollRef = useRef<number | null>(null);
  const debRef = useRef<number | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [b, tr, n, t, cat] = await Promise.allSettled([
      api.searchBenchmarks(), api.searchTrends(), api.searchNotes(), api.kpiTrend(),
      api.metricCatalog(),
    ]);
    if (b.status === "fulfilled") setBenchmarks(b.value);
    if (tr.status === "fulfilled") setTrends(tr.value);
    if (n.status === "fulfilled") setNotes(n.value);
    if (t.status === "fulfilled") {
      const rev = t.value.map((p) => parseFloat(p.revenue)).filter((v) => Number.isFinite(v));
      setUsGrowth(rev.length >= 2 && rev[0]
        ? Math.round(((rev[rev.length - 1] - rev[0]) / rev[0]) * 1000) / 10 : null);
    }
    if (cat.status === "fulfilled") {
      const c = cat.value as MetricCatalogResponse;
      if (c?.metrics?.length) setCatalog(c);
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (debRef.current) window.clearTimeout(debRef.current);
    };
  }, [load]);

  // Derive the chips once the configured company is known. The server asks the
  // model for that company's peers; the repo carries no list of its own.
  useEffect(() => {
    setPeerPicks(null);
    if (!customer) return;
    let cancelled = false;
    api.competitorPeerSuggestions()
      .then((r) => { if (!cancelled) setPeerPicks(r.picks); })
      // The endpoint already degrades to an empty list, so a rejection here is a
      // transport failure: fall back rather than leaving the row spinning.
      .catch(() => { if (!cancelled) setPeerPicks([]); });
    return () => { cancelled = true; };
  }, [customer]);

  // Run-scoped views of the persisted tables (see sessionPeers above): only
  // competitors from the current run feed the visuals and the peer set.
  const sessionBenchmarks = benchmarks.filter((b) => sessionPeers.has(b.competitor));
  // Trends keep the synthetic "Us" series plus the peers from the current run.
  const sessionTrends = trends.filter((t) => t.competitor === "Us" || sessionPeers.has(t.competitor));
  const sessionNotes = notes.filter((n) => sessionPeers.has(n.competitor));
  const peers = [...new Set(sessionBenchmarks.map((b) => b.competitor))].sort();

  // Stage a candidate for analysis (does NOT run). Deduped against the pending
  // selection and against companies already benchmarked this session.
  const stageCandidate = useCallback((c: CompanyCandidate) => {
    setDropdownOpen(false);
    setCandidates([]);
    setError(null);
    // Clear the typed text — the picked company now shows as a highlighted pill
    // inside the search bar. Keep focus so the user can type the next one.
    setQ("");
    requestAnimationFrame(() => inputRef.current?.focus());
    setSelected((prev) => {
      if (prev.some((x) => candId(x) === candId(c))) return prev;
      if (peers.includes(c.name)) return prev;
      return [...prev, c];
    });
  }, [peers]);

  const removeStaged = (c: CompanyCandidate) =>
    setSelected((prev) => prev.filter((x) => candId(x) !== candId(c)));

  // Search-as-you-type (debounced). Two chars minimum.
  function onQueryChange(value: string) {
    setQ(value);
    setDropdownOpen(true);
    if (debRef.current) window.clearTimeout(debRef.current);
    if (value.trim().length < 2) { setCandidates([]); setSearching(false); return; }
    setSearching(true);
    debRef.current = window.setTimeout(async () => {
      try {
        setCandidates((await api.competitorSearch(value.trim())).candidates);
      } catch {
        setCandidates([]);
      } finally {
        setSearching(false);
      }
    }, 260);
  }

  // Quick-pick chip: resolve the best candidate for the name and stage it.
  async function onQuickPick(name: string) {
    if (running) return;
    setError(null);
    try {
      const { candidates: cands, notice } = await api.competitorSearch(name);
      if (cands.length === 0) { setError(notice ?? `Couldn’t resolve ${name}.`); return; }
      stageCandidate(cands[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Couldn’t resolve ${name}.`);
    }
  }

  // Analyze one company: POST /add, then poll run-status to completion.
  // Resolves to { competitor, cached } so the batch can track cache hits.
  const addOne = useCallback((c: CompanyCandidate) => new Promise<{ competitor: string | null; cached: boolean }>((resolve, reject) => {
    setStatus(null);
    api.addCompetitor({ source: c.source, key: c.key, name: c.name })
      .then(() => {
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = window.setInterval(async () => {
          let s: SearchRunStatus;
          try { s = await api.competitorRunStatus(); } catch { return; }
          setStatus(s);
          if (s.stage === "done") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            resolve({ competitor: s.competitor ?? null, cached: !!s.cached });
          } else if (s.stage === "error") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            reject(new Error(s.error || "Analysis failed."));
          }
        }, 1200);
      })
      .catch(reject);
  }), []);

  // Run the staged selection sequentially (the backend allows one run at a time).
  // Results stay hidden until the ENTIRE run finishes, then reveal all at once.
  // A company that fails to analyze is skipped (not aborted) — the run continues
  // and we surface a note naming the ones that failed. The staged pills stay in
  // the search bar so the analyzed peer set stays visible.
  async function runBatch() {
    if (selected.length === 0 || running) return;
    setError(null);
    setFlash(false);
    setRunning(true);
    setShowResults(false);
    setCachedPeers([]);
    const queue = [...selected];
    const failed: { name: string; reason: string }[] = [];
    const analyzedThisRun = new Set<string>();
    const fromCache: string[] = [];
    let succeeded = 0;
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      setBatchPos({ i: i + 1, total: queue.length });
      setAddingName(c.name);
      try {
        const { competitor, cached } = await addOne(c);
        if (competitor) {
          succeeded += 1;
          analyzedThisRun.add(competitor);
          if (cached) fromCache.push(competitor);
        }
      } catch (e) {
        failed.push({ name: c.name, reason: e instanceof Error ? e.message : "analysis failed" });
      }
    }
    setSessionPeers(analyzedThisRun);
    setCachedPeers(fromCache);
    await load();
    setRunning(false);
    setAddingName(null);
    setBatchPos(null);
    if (failed.length) {
      const detail = failed.map((f) => `${f.name} (${f.reason})`).join("; ");
      setError(
        succeeded > 0
          ? `Couldn’t analyze ${detail} — showing the rest.`
          : `Couldn’t analyze ${detail}.`,
      );
    }
    if (succeeded > 0) {
      setShowResults(true);
      setFlash(true);
      window.setTimeout(() => setFlash(false), 2000);
    }
  }

  const competitors = peers;
  const backendStage: SearchStage = status?.stage ?? "idle";
  const idx = STAGE_IDX[backendStage];

  // The filing each competitor's numbers came from, so every column in Compare
  // can be traced back to its public source.
  const sourceByCompetitor = new Map(
    sessionBenchmarks.filter((b) => b.source_url).map((b) => [b.competitor, b.source_url]),
  );

  const matrixMetrics = useMemo(
    () => presentMetrics(sessionBenchmarks, catalog),
    [sessionBenchmarks, catalog],
  );
  const companyOnly = useMemo(
    () => uniqueMetrics(sessionBenchmarks, catalog),
    [sessionBenchmarks, catalog],
  );

  // Per-metric unit: prefer a peer row's unit (currency symbol on Revenue).
  const unitFor = (metric: string): string => {
    const row = sessionBenchmarks.find((b) => b.metric === metric && b.unit);
    return row?.unit ?? metaFor(metric, catalog).unit;
  };

  const cellFor = (metric: string, competitor: string): number | null => {
    const row = sessionBenchmarks.find((b) => b.metric === metric && b.competitor === competitor);
    return row?.their_value ?? null;
  };

  const usFor = (metric: string): number | null => {
    const row = sessionBenchmarks.find((b) => b.metric === metric && b.our_value != null);
    return row?.our_value ?? null;
  };

  const deltaTone = (metric: string, their: number | null, our: number | null): string => {
    if (their == null || our == null) return "text-fg-muted";
    const meta = metaFor(metric, catalog);
    if (meta.better === "neutral") return "text-fg-muted";
    const delta = their - our;
    const weAreAhead = meta.better === "low" ? delta > 0 : delta < 0;
    return weAreAhead ? "text-signal-good" : "text-signal-bad";
  };

  // Show visuals only after the run has fully completed — never while analyzing.
  const resultsVisible = showResults && !running && sessionBenchmarks.length > 0;

  // Only derived peers become chips. An empty validated set means the company has
  // no peers with public structured filings; the search box still works.
  const suggestions = peerPicks ?? [];

  return (
    <div className="space-y-4 pb-16">
      {/* Hero search — elevated so the autocomplete overlays the content below,
          but kept below the sticky nav header (z-40) so the L1/L2 menus always
          stay in front when the page scrolls. */}
      <Card tone="quiet" className="relative z-30">
        <div className="px-5 py-5 space-y-4">
          <p className="text-xs text-fg-subtle">
            Search listed companies, build a peer set, then run the analysis — an agent pulls each one's
            latest public filing (EU ESEF / SEC EDGAR) and benchmarks it against us. No documents to upload.
          </p>

          <div className="relative">
            <div className="flex items-start gap-2">
              {/* Token input: selected companies stay as highlighted pills inside the bar. */}
              <div
                onClick={() => inputRef.current?.focus()}
                className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 min-h-[42px] bg-black/[0.04] ring-1 ring-line
                           rounded-lg px-2.5 py-1.5 cursor-text focus-within:ring-2 focus-within:ring-accent/40"
              >
                <span className="text-fg-subtle self-center pl-0.5">⌕</span>
                {selected.map((c) => (
                  <span key={candId(c)} className="inline-flex items-center gap-1.5 text-xs pl-2 pr-1 py-1 rounded-full
                                                    bg-accent/15 ring-1 ring-accent/40 text-accent-300">
                    <span>{FLAG[c.country] ?? "🏳️"}</span>
                    <span className="max-w-[12rem] truncate">{c.name}</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeStaged(c); }}
                      disabled={running}
                      aria-label={`Remove ${c.name}`}
                      className="w-4 h-4 grid place-items-center rounded-full text-accent-300/80 hover:bg-accent/30 hover:text-white transition disabled:opacity-40"
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <input
                  ref={inputRef}
                  value={q}
                  onChange={(e) => onQueryChange(e.target.value)}
                  onFocus={() => candidates.length > 0 && setDropdownOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && candidates.length > 0) stageCandidate(candidates[0]);
                    if (e.key === "Escape") setDropdownOpen(false);
                    if (e.key === "Backspace" && q === "" && selected.length > 0) removeStaged(selected[selected.length - 1]);
                  }}
                  placeholder={selected.length ? "Add another company…" : "Search a listed company by name or ticker…"}
                  className="flex-1 min-w-[10rem] bg-transparent py-1 text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
                />
              </div>
              <Button
                variant="neutral"
                disabled={candidates.length === 0}
                onClick={() => candidates.length > 0 && stageCandidate(candidates[0])}
              >
                Add
              </Button>
              {selected.length > 0 && (
                <Button variant="primary" disabled={running} onClick={runBatch}>
                  {running
                    ? `Analyzing${batchPos ? ` ${batchPos.i}/${batchPos.total}` : ""}…`
                    : `Run analysis (${selected.length})`}
                </Button>
              )}
            </div>

            {dropdownOpen && q.trim().length >= 2 && (
              <div className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto rounded-xl bg-ink-800 ring-1 ring-line shadow-depth py-1">
                {searching && candidates.length === 0 && (
                  <div className="px-4 py-3 text-sm text-fg-subtle">Searching…</div>
                )}
                {!searching && candidates.length === 0 && (
                  <div className="px-4 py-3 text-sm text-fg-subtle">No matches — try the full legal name.</div>
                )}
                {candidates.map((c) => {
                  const staged = selected.some((x) => candId(x) === candId(c));
                  const already = peers.includes(c.name);
                  return (
                    <button
                      key={candId(c)}
                      type="button"
                      disabled={staged || already}
                      onClick={() => stageCandidate(c)}
                      className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-black/[0.05] transition disabled:opacity-40"
                    >
                      <span className="text-base shrink-0">{FLAG[c.country] ?? "🏳️"}</span>
                      <span className="flex-1 min-w-0 truncate text-sm text-fg">{c.name}</span>
                      <span className="text-[11px] font-mono text-fg-subtle shrink-0">
                        {staged ? "added ✓" : already ? "in peer set" : `${c.ticker ? `${c.ticker} · ` : ""}${c.detail}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Suggestions are peers of the configured company. Without one there is
              nothing to be a peer OF, so we say how to set it instead of offering a
              generic list. */}
          {!customer ? (
            <p className="text-[11px] text-fg-subtle">
              No company configured, so there are no peer suggestions. Re-run setup with --company to set one.
            </p>
          ) : peerPicks === null ? (
            <p className="text-[11px] text-fg-subtle">Finding peers for {customer}…</p>
          ) : suggestions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-fg-subtle">Peers of {customer}:</span>
              {suggestions.map((name) => (
                <button
                  key={name}
                  type="button"
                  disabled={running}
                  onClick={() => onQuickPick(name)}
                  className="text-xs px-2.5 py-1 rounded-full bg-black/[0.05] ring-1 ring-line text-fg-muted
                             hover:bg-black/[0.08] hover:text-fg transition disabled:opacity-50"
                >
                  {name}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-fg-subtle">
              No public peers found for {customer} — to search private peers, update your license
            </p>
          )}

        </div>
      </Card>

      {error && <ErrorNote message={error} />}

      {/* Progress stepper */}
      {running && (
        <Card tone="quiet">
          <div className="px-5 py-4">
            <div className="flex items-stretch gap-4">
              {STAGES.map((st, i) => {
                const state: StageState =
                  backendStage === "error" ? (i === 0 ? "error" : "pending")
                    : i < idx ? "done"
                    : i === idx ? "active"
                    : "pending";
                return <StageBar key={st.id} label={st.label} note={st.note} state={state} />;
              })}
            </div>
            <div className="mt-2 text-xs text-fg-muted num">
              {addingName ? `Analyzing ${addingName}${batchPos ? ` (${batchPos.i} of ${batchPos.total})` : ""} — ` : ""}
              {status?.cached
                ? "loaded from cache"
                : backendStage === "resolving" ? "resolving the company to a public filer…"
                : backendStage === "fetching" ? `fetching ${status?.source ?? ""} filing…`
                : backendStage === "computing" ? "computing benchmark metrics + AI note…"
                : backendStage === "writing" ? "writing governed tables…"
                : ""}
            </div>
          </div>
        </Card>
      )}

      {!resultsVisible && !running && (
        <div className="rounded-2xl glass ring-1 ring-line px-5 py-12 text-center text-sm text-fg-subtle">
          Search companies above, build your peer set, then run the analysis.
        </div>
      )}

      {resultsVisible && (
        <div
          ref={resultsRef}
          className={`space-y-4 scroll-mt-4 rounded-2xl transition-shadow duration-700 ${flash ? "ring-2 ring-signal-good/50" : "ring-0"}`}
        >
          {cachedPeers.length > 0 && (
            <p className="text-[11px] text-fg-subtle px-1">
              Loaded from cache: {cachedPeers.join(", ")}
            </p>
          )}

          <BenchmarkTrendChart trends={sessionTrends} catalog={catalog} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RuleOf40Visual benchmarks={sessionBenchmarks} usGrowth={usGrowth} />
            <PeerRankVisual benchmarks={sessionBenchmarks} catalog={catalog} />
          </div>

          {sessionNotes.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {sessionNotes.map((n) => (
                <div key={n.competitor} className="rounded-2xl glass ring-1 ring-line px-4 py-3.5">
                  <div className="flex items-start gap-2.5">
                    <span className="text-accent-400 dark:text-fg-muted mt-0.5 shrink-0" aria-hidden="true">✦</span>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-fg">{n.competitor}</div>
                      <p className="text-sm text-fg-muted leading-relaxed mt-0.5">{n.note}</p>
                      <div className="text-[11px] text-fg-subtle font-mono mt-1.5">{n.source}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <Section
            title="Compare"
            subtitle="metrics found across this run · — means not reported"
            count={matrixMetrics.length}
            tone="default"
            defaultOpen
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-fg-muted text-left">
                  <tr className="border-b border-line">
                    <th className="px-5 py-2.5 font-medium sticky left-0 bg-[var(--color-surface,rgba(255,255,255,0.92))] backdrop-blur-sm">Metric</th>
                    <th className="px-5 py-2.5 font-medium text-right">Us</th>
                    {competitors.map((c) => {
                      const url = sourceByCompetitor.get(c);
                      return (
                        <th key={c} className="px-5 py-2.5 font-medium text-right whitespace-nowrap">
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              title={`${c} — view the filing these figures came from`}
                              className="text-accent-400 dark:text-fg hover:underline"
                            >
                              {c.split(" ")[0]} ↗
                            </a>
                          ) : c.split(" ")[0]}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {matrixMetrics.map((metric) => {
                    const unit = unitFor(metric);
                    const our = usFor(metric);
                    const only = companyOnly.find((u) => u.metric === metric);
                    return (
                      <tr key={metric} className="border-b border-line last:border-0 record-row-hover">
                        <td className="px-5 py-2 text-fg-muted sticky left-0 bg-[var(--color-surface,rgba(255,255,255,0.92))] backdrop-blur-sm">
                          {metric}
                          {only && (
                            <span className="ml-2 text-[10px] text-fg-subtle">only {only.entity === "Us" ? "Us" : only.entity.split(" ")[0]}</span>
                          )}
                        </td>
                        <td className="px-5 py-2 text-right tabular-nums text-fg-muted">{fmtMetric(our, unit)}</td>
                        {competitors.map((c) => {
                          const their = cellFor(metric, c);
                          return (
                            <td key={c} className={`px-5 py-2 text-right tabular-nums ${deltaTone(metric, their, our)}`}>
                              {fmtMetric(their, unit)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>

          {companyOnly.length > 0 && (
            <Section
              title="Company-only metrics"
              subtitle="found for a single entity in this run · not plotted"
              count={companyOnly.length}
              tone="default"
              defaultOpen={false}
            >
              <ul className="px-5 py-3 space-y-2 text-sm">
                {companyOnly.map(({ metric, entity }) => {
                  const unit = unitFor(metric);
                  const val = entity === "Us"
                    ? usFor(metric)
                    : cellFor(metric, entity);
                  return (
                    <li key={metric} className="flex items-baseline justify-between gap-4 border-b border-line last:border-0 py-1.5">
                      <span className="text-fg-muted">
                        {metric}
                        <span className="text-[11px] text-fg-subtle ml-2">only {entity === "Us" ? "Us" : entity}</span>
                      </span>
                      <span className="tabular-nums text-fg">{fmtMetric(val, unit)}</span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
