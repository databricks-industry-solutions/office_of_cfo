import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { api, setActivePersona, setActivePeriod, CloseStatus, CONSOLIDATED, OrgTree, Persona, PeriodInfo, Scope, TaskSummary } from "./api";
import { PAGES, PageDef, PageId, isHiddenFromNav, landingPageForPersonaSwitch, personaEntryDestination } from "./nav";
import { useIndustry } from "./lib/industry";
import { legacyPageRedirect } from "./lib/lineageGraph";
import TopNav from "./components/TopNav";
import { AppShell, PageViewport } from "./components/AppShell";
import CommandPalette from "./components/CommandPalette";
import Entrance from "./components/Entrance";
import { layoutForPage } from "./lib/pageLayout";
import Executive from "./pages/Executive";
import Dashboard from "./pages/Dashboard";
import Tasks from "./pages/Tasks";
import TrialBalance from "./pages/TrialBalance";
import Reconciliation from "./pages/Reconciliation";
import FinancialStatements from "./pages/FinancialStatements";
import ComparativeStatements from "./pages/ComparativeStatements";
import Approvals from "./pages/Approvals";
import StressTest from "./pages/StressTest";
import ScenarioPlanning from "./pages/ScenarioPlanning";
import CashFlow from "./pages/CashFlow";
import ThirteenWeekCash from "./pages/ThirteenWeekCash";
import MarketInsights from "./pages/MarketInsights";
import ExposureNetwork from "./pages/ExposureNetwork";
import InventoryExposure from "./pages/InventoryExposure";
import CloseSupport from "./pages/CloseSupport";
import CompetitorSearch from "./pages/CompetitorSearch";
import HistoricalInsights from "./pages/HistoricalInsights";
import AdhocAnalysis from "./pages/AdhocAnalysis";
import PaymentBehavior from "./pages/PaymentBehavior";
import DataSources from "./pages/DataSources";
import Settings from "./pages/Settings";
import GenieWindow from "./components/GenieWindow";
import {
  AiRoiEfficiencyPage, AiRoiExecutivePage, AiRoiOrgPage,
  AiRoiRoiPage, AiRoiSpendPage,
} from "./pages/AiRoi";
const VALID_PAGES = new Set(PAGES.map((p) => p.id));
const PERSONA_KEY = "cfo.persona";
const SCOPE_KEY = "cfo.scope";

function pageFromHash(): PageId {
  const slug = legacyPageRedirect(window.location.hash.replace(/^#\/?/, "").split("?")[0]);
  return VALID_PAGES.has(slug as PageId) ? (slug as PageId) : "executive";
}

function queryFromHash(): string {
  const idx = window.location.hash.indexOf("?");
  return idx >= 0 ? window.location.hash.slice(idx + 1) : "";
}

function defaultScopeFor(p: Persona): Scope {
  if (p.scope_locked && p.scope_type === "consolidated") return CONSOLIDATED;
  if (p.scope_default) return { scope_type: p.scope_type, scope_id: p.scope_default };
  return CONSOLIDATED;
}

export default function App() {
  const { industry, overlay } = useIndustry();
  const [entered, setEntered] = useState(false);
  const [savedPersonaId] = useState(() => localStorage.getItem(PERSONA_KEY));
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaLoadError, setPersonaLoadError] = useState<string | null>(null);
  const [personaLoadAttempt, setPersonaLoadAttempt] = useState(0);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [org, setOrg] = useState<OrgTree | null>(null);
  const [scope, setScope] = useState<Scope>(CONSOLIDATED);
  // Global reporting period. "" means the active close (endpoint default). The
  // period picker (TopNav) drives the period-aware reporting pages; close-workflow
  // pages ignore it. Periods are per-industry, so this resets on industry switch.
  const [period, setPeriod] = useState<string>("");
  const [periods, setPeriods] = useState<PeriodInfo[]>([]);
  const [activeClose, setActiveClose] = useState<string>("");

  const [activePage, setActivePage] = useState<PageId>(pageFromHash);
  const [hashQuery, setHashQuery] = useState<string>(queryFromHash);
  const [status, setStatus] = useState<CloseStatus | null>(null);
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const [paletteOpen, setPaletteOpen] = useState(false);

  const visiblePages = useMemo<PageId[]>(
    () => (persona
      ? (persona.pages as PageId[]).filter((p) => VALID_PAGES.has(p) && !isHiddenFromNav(p, overlay.hiddenPages))
      : []),
    [persona, overlay]);

  const visiblePageDefs = useMemo<PageDef[]>(
    () => visiblePages.map((id) => PAGES.find((p) => p.id === id)).filter((p): p is PageDef => !!p),
    [visiblePages]);

  const navigate = useCallback((p: PageId, query = "") => {
    setActivePage(p);
    setHashQuery(query);
    const target = query ? `/${p}?${query}` : `/${p}`;
    if (window.location.hash.replace(/^#/, "") !== target) window.location.hash = target;
  }, []);

  useEffect(() => {
    const onHash = () => {
      const raw = window.location.hash.replace(/^#\/?/, "");
      const qIdx = raw.indexOf("?");
      const slugPart = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
      const query = qIdx >= 0 ? raw.slice(qIdx + 1) : "";
      const canonical = legacyPageRedirect(slugPart);
      if (canonical !== slugPart) {
        const target = query ? `/${canonical}?${query}` : `/${canonical}`;
        if (window.location.hash.replace(/^#/, "") !== target) {
          window.location.replace(`#${target}`);
        }
        return;
      }
      setActivePage(pageFromHash());
      setHashQuery(queryFromHash());
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Command palette hotkey (Cmd/Ctrl + /). Genie owns Cmd/Ctrl+K separately.
  useEffect(() => {
    if (!entered) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entered]);

  // Load personas + org tree once, then restore the saved persona/scope.
  useEffect(() => {
    (async () => {
      setPersonaLoadError(null);
      try {
        const [{ personas: ps }, tree] = await Promise.all([api.personas(), api.orgTree()]);
        setPersonas(ps);
        setOrg(tree);
        const savedId = localStorage.getItem(PERSONA_KEY);
        const initial = ps.find((p) => p.id === savedId) ?? ps[0] ?? null;
        setPersona(initial);
        if (initial) setActivePersona(initial.id);
        if (initial) {
          const savedScope = localStorage.getItem(SCOPE_KEY);
          setScope(savedScope ? JSON.parse(savedScope) : defaultScopeFor(initial));
        }
      } catch (e) {
        console.error(e);
        setPersonaLoadError("Roles are temporarily unavailable. Check your connection and try again.");
      }
    })();
  }, [personaLoadAttempt]);

  // Each industry has its OWN org (entity names differ; BU/region/LE ids stay
  // stable so the active scope stays valid). Refetch the org tree when the
  // industry changes so the scope switcher shows the right names.
  const firstIndustry = useRef(true);
  useEffect(() => {
    if (firstIndustry.current) { firstIndustry.current = false; return; }
    api.orgTree().then(setOrg).catch(() => {});
  }, [industry]);

  // Available periods per industry (feeds the picker). Reset the selection to the
  // active close whenever the industry changes, since periods differ per industry.
  useEffect(() => {
    let cancelled = false;
    setPeriod("");
    api.periods()
      .then((r) => { if (!cancelled) { setPeriods(r.periods || []); setActiveClose(r.active || ""); } })
      .catch(() => { if (!cancelled) { setPeriods([]); setActiveClose(""); } });
    return () => { cancelled = true; };
  }, [industry]);

  // Push the selected period into the API layer (rides on every scope-aware
  // request) and reload the period-aware pages. First run only registers it.
  const firstPeriod = useRef(true);
  useEffect(() => {
    setActivePeriod(period);
    if (firstPeriod.current) { firstPeriod.current = false; return; }
    setRefreshKey((k) => k + 1);
  }, [period]);

  const changePeriod = useCallback((p: string) => {
    setPeriod(p === activeClose ? "" : p);
  }, [activeClose]);

  const selectPersona = useCallback((id: string) => {
    const p = personas.find((x) => x.id === id);
    if (!p) return;
    setPersona(p);
    setActivePersona(id);
    localStorage.setItem(PERSONA_KEY, id);
    const s = defaultScopeFor(p);
    setScope(s);
    localStorage.setItem(SCOPE_KEY, JSON.stringify(s));
    // Keep the user in the same place when the new persona can see it; otherwise
    // prefer the same nav group / module before falling back to that persona's home.
    const home = (VALID_PAGES.has(p.default_page as PageId)
      ? (p.default_page as PageId)
      : ((p.pages[0] as PageId) ?? "executive"));
    const available = (p.pages as PageId[]).filter(
      (pg) => VALID_PAGES.has(pg) && !isHiddenFromNav(pg, overlay.hiddenPages));
    const landing = landingPageForPersonaSwitch(activePage, available, home);
    const query = landing === activePage
      ? hashQuery
      : (landing === home ? (p.default_query ?? "") : "");
    navigate(landing, query);
  }, [personas, navigate, activePage, hashQuery, overlay]);

  const enterAsPersona = useCallback((id: string) => {
    const p = personas.find((candidate) => candidate.id === id);
    if (!p) return;

    setPersona(p);
    setActivePersona(id);
    localStorage.setItem(PERSONA_KEY, id);

    const nextScope = defaultScopeFor(p);
    setScope(nextScope);
    localStorage.setItem(SCOPE_KEY, JSON.stringify(nextScope));

    const available = (p.pages as PageId[]).filter(
      (pageId) => VALID_PAGES.has(pageId) && !isHiddenFromNav(pageId, overlay.hiddenPages),
    );
    const configuredHome = p.default_page as PageId;
    const home = VALID_PAGES.has(configuredHome) && available.includes(configuredHome)
      ? configuredHome
      : (available[0] ?? "executive");
    const rawSlug = window.location.hash.replace(/^#\/?/, "").split("?")[0];
    const slug = legacyPageRedirect(rawSlug);
    const requested = VALID_PAGES.has(slug as PageId) ? (slug as PageId) : null;
    const destination = personaEntryDestination(
      requested,
      queryFromHash(),
      available,
      home,
      p.default_query ?? "",
    );

    setEntered(true);
    navigate(destination.page, destination.query);
  }, [personas, overlay, navigate]);

  const changeScope = useCallback((s: Scope) => {
    setScope(s);
    localStorage.setItem(SCOPE_KEY, JSON.stringify(s));
  }, []);

  const refreshAll = useCallback(async () => {
    setStatusLoading(true);
    setRefreshKey((k) => k + 1);
    try {
      const [s, t] = await Promise.all([
        api.closeStatus(scope),
        api.taskSummary(scope).catch(() => null),
      ]);
      setStatus(s);
      setSummary(t);
    } catch (e) {
      console.error(e);
    } finally {
      setStatusLoading(false);
    }
    // `industry` is a dependency so switching industry re-fetches status/summary
    // and bumps refreshKey, which makes every page reload with the new labels.
  }, [scope, industry]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  // Guard: never render a page the current persona can't see.
  const page: PageId = visiblePages.includes(activePage)
    ? activePage
    : (VALID_PAGES.has(persona?.default_page as PageId) ? (persona!.default_page as PageId) : visiblePages[0]);

  if (!entered) {
    return (
      <Entrance
        personas={personas}
        savedId={savedPersonaId}
        loadError={personaLoadError}
        onEnter={enterAsPersona}
        onRetry={() => setPersonaLoadAttempt((attempt) => attempt + 1)}
      />
    );
  }

  const layout = layoutForPage(page);

  return (
    <AppShell>
      <TopNav activePage={page} onSelectPage={(p) => navigate(p)}
              visiblePages={visiblePages} persona={persona}
              personas={personas} onSelectPersona={selectPersona}
              onOpenPalette={() => setPaletteOpen(true)}
              status={status} summary={summary}
              org={org} scope={scope} onScope={changeScope} onNavigate={navigate}
              period={period || activeClose} periods={periods} onPeriod={changePeriod}
              layoutMode={layout} />
      <div className="flex-1 min-w-0 flex flex-col">
        <motion.main
          key={page}
          id="main-content"
          tabIndex={-1}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="flex-1 min-h-0 flex flex-col outline-none"
        >
          <PageViewport mode={layout}>
          {page === "executive" && <Executive scope={scope} persona={persona} org={org} onNavigate={navigate} refreshKey={refreshKey} />}
          {page === "dashboard" && <Dashboard status={status} summary={summary} scope={scope} org={org} persona={persona} onNavigate={navigate} refreshKey={refreshKey} />}
          {page === "tasks" && <Tasks query={hashQuery} scope={scope} onDataChange={refreshAll} refreshKey={refreshKey} />}
          {page === "trial-balance" && <TrialBalance status={status} scope={scope} refreshKey={refreshKey} />}
          {page === "reconciliation" && <Reconciliation scope={scope} persona={persona} onDataChange={refreshAll} refreshKey={refreshKey} />}
          {page === "financial-statements" && <FinancialStatements status={status} scope={scope} refreshKey={refreshKey} />}
          {page === "comparative-statements" && <ComparativeStatements status={status} scope={scope} persona={persona} refreshKey={refreshKey} />}
          {page === "approvals" && <Approvals persona={persona} onDataChange={refreshAll} refreshKey={refreshKey} />}
          {page === "stress-test" && <StressTest scope={scope} org={org} refreshKey={refreshKey} />}
          {page === "market-insights" && <MarketInsights refreshKey={refreshKey} onNavigate={navigate} />}
          {page === "scenario-planning" && <ScenarioPlanning refreshKey={refreshKey} persona={persona} />}
          {page === "cash-flow" && <CashFlow refreshKey={refreshKey} />}
          {page === "thirteen-week-cash" && <ThirteenWeekCash refreshKey={refreshKey} />}
          {page === "exposure" && <ExposureNetwork persona={persona} onNavigate={navigate} refreshKey={refreshKey} />}
          {page === "inventory-exposure" && <InventoryExposure scope={scope} refreshKey={refreshKey} />}
          {page === "close-support" && <CloseSupport />}
          {page === "close-support-2" && <CompetitorSearch />}
          {page === "historical-insights" && <HistoricalInsights scope={scope} period={period || activeClose} refreshKey={refreshKey} />}
          {page === "adhoc-analysis" && <AdhocAnalysis scope={scope} period={period || activeClose} refreshKey={refreshKey} />}
          {page === "payment-behavior" && <PaymentBehavior scope={scope} period={period || activeClose} refreshKey={refreshKey} />}
          {page === "data-sources" && <DataSources scope={scope} org={org} refreshKey={refreshKey} />}
          {page === "ai-roi-executive" && <AiRoiExecutivePage scope={scope} onNavigate={navigate} />}
          {page === "ai-roi-spend" && <AiRoiSpendPage scope={scope} onScope={changeScope} />}
          {page === "ai-roi-roi" && <AiRoiRoiPage scope={scope} hashQuery={hashQuery} onNavigate={navigate} />}
          {page === "ai-roi-org" && <AiRoiOrgPage scope={scope} onScope={changeScope} />}
          {page === "ai-roi-efficiency" && <AiRoiEfficiencyPage scope={scope} />}
          {page === "settings" && <Settings persona={persona} refreshKey={refreshKey} onDataChange={refreshAll} />}
          </PageViewport>
        </motion.main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)}
                      pages={visiblePageDefs} onSelect={(p) => navigate(p)} />
      <GenieWindow />
    </AppShell>
  );
}
