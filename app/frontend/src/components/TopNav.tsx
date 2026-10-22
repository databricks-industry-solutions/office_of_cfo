import { useEffect, useRef, useState } from "react";
import {
  Settings as SettingsIcon, Search, ChevronDown, Check, Sun, Moon, RefreshCw,
} from "lucide-react";
import { useTheme } from "../lib/theme";
import {
  MODULES, MODULE_GROUPS, PAGES, PageId, groupForPage, moduleForGroup,
} from "../nav";
import { Persona, CloseStatus, TaskSummary, OrgTree, PeriodInfo, Scope } from "../api";
import { cn } from "../lib/cn";
import { LayoutMode } from "../lib/pageLayout";
import { useIndustry } from "../lib/industry";
import { ShellContainer } from "./AppShell";
import { useCompany } from "../lib/deployment";
import { nextCollapsedTopic } from "../lib/navCollapse";
import { Select } from "./ui";
import ScopeSwitcher from "./PersonaSwitcher";
import NotificationsBell from "./NotificationsBell";
import { OrgExplorerTopic, clearAiRoiScope } from "./aiRoi/ScopeFilterBar";

const HOTKEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘/" : "Ctrl+/";

/** Light/Dark theme toggle, available to every persona from the top bar. */
function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="p-1.5 rounded-lg transition ring-1 text-fg-muted ring-line hover:bg-black/[0.04] hover:text-fg"
    >
      {isDark ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
    </button>
  );
}

/** Demo reset: rotate to the next reconciliation scenario. Spins while running. */
function DemoResetButton({ onReset }: { onReset: () => Promise<void> }) {
  const [resetting, setResetting] = useState(false);
  return (
    <button
      onClick={async () => {
        if (resetting) return;
        setResetting(true);
        try { await onReset(); } finally { setResetting(false); }
      }}
      disabled={resetting}
      aria-label="Reset demo data"
      title="Reset demo (rotate reconciliation scenario)"
      className="p-1.5 rounded-lg transition ring-1 text-fg-muted ring-line hover:bg-black/[0.04] hover:text-fg disabled:opacity-50"
    >
      <RefreshCw className={cn("w-[18px] h-[18px]", resetting && "animate-spin")} />
    </button>
  );
}

const PAGE_BY_ID = new Map(PAGES.map((p) => [p.id, p]));

/** Global reporting-period picker. Drives the period-aware reporting pages
 *  (Executive, Trial Balance, Statements, Variance, Cash Flow, Exposure, and the
 *  Historical Insights sub-tabs). Shows a single entry gracefully for industries
 *  that have only one period (no history yet). */
function PeriodSwitcher({
  period, periods, onPeriod,
}: {
  period: string;
  periods: PeriodInfo[];
  onPeriod: (p: string) => void;
}) {
  if (!periods || periods.length <= 1) return null;
  const options = periods.map((p) => ({
    value: p.period,
    label: p.month_label || p.period,
    hint: p.is_active_close ? "current" : undefined,
  }));
  return (
    <Select
      aria-label="Reporting period"
      value={period}
      onChange={onPeriod}
      options={options}
      size="sm"
      className="min-w-[132px]"
    />
  );
}

// Brand block: the top-left mark and name. Shows the company the demo was
// installed for (scripts/setup.py --company), or "Office of the CFO" when none is
// configured. Not editable in the app: re-run setup to change it.
function BrandLogo() {
  const company = useCompany();
  return (
    <div className="flex items-center gap-3 px-1 py-1">
      <div className="w-12 h-12 rounded-xl bg-accent grid place-items-center">
        <span className="text-white font-bold text-lg">{company ? company.slice(0, 1).toUpperCase() : "C"}</span>
      </div>
      <div className="leading-tight min-w-0 text-left">
        <div className="text-base font-semibold tracking-tight text-fg whitespace-nowrap truncate max-w-[220px]"
             title={company || undefined}>
          {company || "Office of the CFO"}
        </div>
      </div>
    </div>
  );
}

// Identity chip + menu to change "who am I viewing as".
function PersonaMenu({
  personas, persona, onSelectPersona, onSelectPage, showSettings, settingsActive,
}: {
  personas: Persona[];
  persona: Persona | null;
  onSelectPersona: (id: string) => void;
  onSelectPage: (p: PageId) => void;
  showSettings: boolean;
  settingsActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  if (!persona) return null;
  const initials = persona.label.slice(0, 2).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Switch persona"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2.5 pl-1.5 pr-2 py-1 rounded-lg ring-1 ring-line hover:bg-black/[0.04] transition"
      >
        <div className="w-7 h-7 rounded-full bg-accent grid place-items-center text-white font-bold text-xs">
          {initials}
        </div>
        {/* Every label is stacked in one grid cell so the slot is always as wide
            as the longest persona name — switching seats can't shift the nav. */}
        <span className="hidden lg:grid text-left text-[12px] font-medium">
          {personas.map((p) => (
            <span key={p.id} aria-hidden className="col-start-1 row-start-1 invisible">{p.label}</span>
          ))}
          <span className="col-start-1 row-start-1 text-fg">{persona.label}</span>
        </span>
        <ChevronDown className="w-4 h-4 shrink-0 text-fg-subtle" />
      </button>

      {open && (
        <div role="menu"
             className="absolute right-0 mt-1 z-50 w-max bg-ink-800 rounded-xl shadow-depth ring-1 ring-line py-1">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-fg-subtle">Viewing as</div>
          {personas.map((p) => {
            const active = p.id === persona.id;
            return (
              <button
                key={p.id}
                role="menuitemradio"
                aria-checked={active}
                title={p.title}
                onClick={() => { onSelectPersona(p.id); setOpen(false); }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition",
                  active ? "text-fg bg-black/[0.04]" : "text-fg-muted hover:bg-black/[0.04]"
                )}
              >
                <Check className={cn("w-3.5 h-3.5 shrink-0", active ? "opacity-100 text-fg" : "opacity-0")} />
                <span className="truncate">{p.label}</span>
              </button>
            );
          })}
          {showSettings && (
            <>
              <div className="my-1 border-t border-line" />
              <button
                role="menuitem"
                aria-current={settingsActive ? "page" : undefined}
                onClick={() => { onSelectPage("settings"); setOpen(false); }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition",
                  settingsActive ? "text-fg bg-black/[0.04]" : "text-fg-muted hover:bg-black/[0.04]"
                )}
              >
                <SettingsIcon className="w-3.5 h-3.5 shrink-0" />
                <span>Settings</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function TopNav({
  activePage, onSelectPage, visiblePages, persona, personas, onSelectPersona, onOpenPalette,
  status, summary, org, scope, onScope, period, periods, onPeriod, onNavigate, onReset,
  layoutMode = "wide",
}: {
  activePage: PageId;
  onSelectPage: (p: PageId) => void;
  visiblePages: PageId[];
  persona: Persona | null;
  personas: Persona[];
  onSelectPersona: (id: string) => void;
  onOpenPalette: () => void;
  status: CloseStatus | null;
  summary: TaskSummary | null;
  org: OrgTree | null;
  scope: Scope;
  onScope: (s: Scope) => void;
  period: string;
  periods: PeriodInfo[];
  onPeriod: (p: string) => void;
  onNavigate: (p: PageId, query?: string) => void;
  onReset: () => Promise<void>;
  layoutMode?: LayoutMode;
}) {
  const { overlay } = useIndustry();
  const allowed = new Set(visiblePages);

  // Which module's L2 topic row is collapsed. Only one module is active at a
  // time, so a single id is enough: clicking the active L1 tab toggles it,
  // navigating to a different module resets it back to expanded.
  const [collapsedModule, setCollapsedModule] = useState<string | null>(null);
  // The active L2 topic can independently collapse its L3 page pills.
  const [collapsedTopic, setCollapsedTopic] = useState<string | null>(null);

  const pageLabel = (id: PageId) => overlay.navLabels[id] ?? PAGE_BY_ID.get(id)?.label ?? id;
  const firstVisible = (pages: PageId[]) => pages.find((p) => allowed.has(p));

  // Active topic / module derive from the active page; fall back to the live
  // module so the topic row stays visible on pages outside a group (Settings).
  const activeGroup = groupForPage(activePage);
  const enabledModuleId = MODULES.find((m) => m.enabled)?.id;
  const activeModuleId = (activeGroup && moduleForGroup(activeGroup.id)) ?? enabledModuleId;

  // Level 2: topics for the active module that have at least one visible page.
  const topics = (activeModuleId ? MODULE_GROUPS[activeModuleId] ?? [] : [])
    .map((g) => ({ ...g, visible: g.pages.filter((p) => allowed.has(p)) }))
    .filter((g) => g.visible.length > 0);

  // Level 3: pages inside the active topic (only shown when there are 2+).
  const activePills = activeGroup
    ? activeGroup.pages.filter((p) => allowed.has(p))
    : [];

  useEffect(() => {
    setCollapsedTopic(null);
  }, [activeGroup?.id, activeModuleId]);

  const goToModule = (moduleId: string) => {
    const groups = MODULE_GROUPS[moduleId] ?? [];
    for (const g of groups) {
      const p = firstVisible(g.pages);
      if (p) { onSelectPage(p); return; }
    }
  };

  const goToTopic = (pages: PageId[]) => {
    const p = firstVisible(pages);
    if (p) onSelectPage(p);
  };

  const showSettings = allowed.has("settings");

  return (
    <header className="sticky top-0 z-40 bg-ink-900/85 backdrop-blur-md border-b border-line">
      {/* Utility strip: brand + industry (left), identity/actions (right).
          Sits on its own near-white surface (a hair brighter than the warm
          off-white canvas) and is capped by a gradient hairline that fades at
          the edges, so the top bar reads as a distinct chrome layer. */}
      <div className="relative bg-white/70">
        <ShellContainer mode={layoutMode} className="py-2 flex items-center justify-between gap-4">
        <BrandLogo />

        <div className="flex items-center gap-2">
          <button
            onClick={onOpenPalette}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-fg-muted
                       bg-ink-800/60 hover:bg-ink-700/60 border border-line transition"
          >
            <Search className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Search</span>
            <kbd className="font-mono text-[10px] leading-none text-fg-subtle bg-ink-700 px-1 py-0 rounded border border-line hidden md:inline">
              {HOTKEY}
            </kbd>
          </button>

          <ScopeSwitcher persona={persona} org={org} scope={scope} onScope={onScope} />

          <PeriodSwitcher period={period} periods={periods} onPeriod={onPeriod} />

          <ThemeToggle />

          <NotificationsBell status={status} summary={summary} onNavigate={onNavigate} />

          <DemoResetButton onReset={onReset} />

          <PersonaMenu
            personas={personas}
            persona={persona}
            onSelectPersona={onSelectPersona}
            onSelectPage={onSelectPage}
            showSettings={showSettings}
            settingsActive={activePage === "settings"}
          />
        </div>
        </ShellContainer>

        {/* Stylized divider: a gradient hairline that fades at the viewport edges. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-line-strong to-transparent" />
      </div>

      {/* Level 1: module tabs */}
      <nav aria-label="Modules" className="overflow-x-auto">
        <ShellContainer mode={layoutMode} className="flex items-center gap-1">
        {MODULES.map((m) => {
          const hasTopics = (MODULE_GROUPS[m.id] ?? [])
            .some((g) => g.pages.some((p) => allowed.has(p)));
          // A module is reachable only if it's live AND the current persona has at
          // least one visible page inside it. Enabled-but-empty modules (e.g. FP&A
          // for the Accountant) render locked instead of as a dead-click tab.
          const accessible = m.enabled && hasTopics;
          const active = accessible && m.id === activeModuleId;
          const collapsed = collapsedModule === m.id;
          return (
            <button
              key={m.id}
              onClick={() => {
                if (!accessible) return;
                if (m.id === activeModuleId) {
                  // Toggle the active module's L2 row in place.
                  setCollapsedModule((c) => (c === m.id ? null : m.id));
                } else {
                  // Switching modules always lands expanded.
                  setCollapsedModule(null);
                  setCollapsedTopic(null);
                  goToModule(m.id);
                }
              }}
              disabled={!accessible}
              aria-current={active ? "page" : undefined}
              aria-expanded={active && hasTopics ? !collapsed : undefined}
              title={!m.enabled ? "Coming soon" : !hasTopics ? "Not available for this role" : undefined}
              className={cn(
                "relative flex items-center gap-1 px-3 py-2.5 text-sm whitespace-nowrap transition -mb-px border-b-2",
                active
                  ? "text-fg border-fg font-medium"
                  : accessible
                    ? "text-fg-muted border-transparent hover:text-fg"
                    : "text-fg-subtle/60 border-transparent cursor-not-allowed"
              )}
            >
              {m.label}
              {m.badge && (
                <span className="text-[10px] font-normal tracking-wide text-fg-subtle">
                  {m.badge}
                </span>
              )}
              {active && hasTopics && (
                <ChevronDown
                  className={cn(
                    "w-3.5 h-3.5 shrink-0 transition-transform",
                    collapsed && "-rotate-90"
                  )}
                />
              )}
              {!m.enabled && (
                <span className="ml-1.5 text-[9px] uppercase tracking-wide text-fg-subtle/70 align-middle">soon</span>
              )}
            </button>
          );
        })}
        </ShellContainer>
      </nav>

      {/* Level 2: topic tabs for the active module (collapsible via the L1 tab) */}
      {topics.length > 0 && collapsedModule !== activeModuleId && (
        <nav aria-label="Topics" className="bg-ink-900/40 overflow-x-auto">
          <ShellContainer mode={layoutMode} className="flex items-center gap-1">
          {topics.map((g) => {
            const active = g.id === activeGroup?.id;
            const canCollapsePages = active && g.visible.length > 1;
            const pagesCollapsed = canCollapsePages && collapsedTopic === g.id;
            if (g.id === "ai-roi-org") {
              return (
                <OrgExplorerTopic
                  key={g.id}
                  pageLabel={g.label}
                  active={active}
                  scope={scope}
                  onSelect={() => {
                    setCollapsedTopic((current) =>
                      nextCollapsedTopic(current, g.id, active, g.visible.length)
                    );
                    if (!active) goToTopic(g.visible);
                  }}
                  onClear={() => clearAiRoiScope(onScope)}
                />
              );
            }
            return (
              <button
                key={g.id}
                onClick={() => {
                  setCollapsedTopic((current) =>
                    nextCollapsedTopic(current, g.id, active, g.visible.length)
                  );
                  if (!active) goToTopic(g.visible);
                }}
                aria-current={active ? "page" : undefined}
                aria-expanded={canCollapsePages ? !pagesCollapsed : undefined}
                className={cn(
                  "inline-flex items-center gap-1 px-3 py-2 text-[13px] rounded-lg my-1.5 whitespace-nowrap transition",
                  active
                    ? "bg-ink-700 text-fg ring-1 ring-line font-medium"
                    : "text-fg-muted hover:text-fg hover:bg-black/[0.04]"
                )}
              >
                {g.label}
                {canCollapsePages && (
                  <ChevronDown
                    className={cn(
                      "w-3.5 h-3.5 shrink-0 transition-transform",
                      pagesCollapsed && "-rotate-90"
                    )}
                  />
                )}
              </button>
            );
          })}
          </ShellContainer>
        </nav>
      )}

      {/* Level 3: page pills for the active topic (multi-page topics only).
          Collapses together with the L2 row when the active L1 tab is toggled. */}
      {activePills.length > 1
        && collapsedModule !== activeModuleId
        && collapsedTopic !== activeGroup?.id && (
        <div aria-label="Pages" className="relative overflow-x-auto">
          {/* Stylized divider: a gradient hairline that fades toward the edges. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-line/40 to-transparent" />
          <ShellContainer mode={layoutMode} className="py-2 flex items-center gap-1.5">
          {activePills.map((p) => {
            const active = p === activePage;
            return (
              <button
                key={p}
                onClick={() => onSelectPage(p)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "px-2.5 py-1 text-[12px] rounded-full whitespace-nowrap transition ring-1",
                  active
                    ? "bg-accent text-white ring-accent"
                    : "text-fg-muted ring-line hover:bg-black/[0.04] hover:text-fg"
                )}
              >
                {pageLabel(p)}
              </button>
            );
          })}
          </ShellContainer>
        </div>
      )}
    </header>
  );
}
