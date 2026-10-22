// Playwright measurement engine for the page-latency harness.
//
// Impure by nature (drives a real browser). It measures two feature-ready times
// per (industry, persona, page):
//   - cold:  a fresh browser context, deep-linked to the page and entered from
//            the Entrance screen (cold cache, cold in-memory state).
//   - warm:  in-app hash navigation inside an already-entered context.
//
// Feature-ready ends at the page's landmark (see landmarks.ts), never at
// networkidle. API timings, failed requests, and console/page errors are
// captured per measured load. Runs are strictly read-only: every non-GET/HEAD
// call to /api is aborted at the network layer, so no form is ever submitted and
// no scenario, adjustment, approval, extraction, or competitor analysis can fire.

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
} from "playwright";
import { normalizeApiPath } from "./analysis.ts";
import { isReadOnlyRequest } from "./readonly.ts";
import { featureReadyPlan, MAIN_CONTENT, type FeatureReadyPlan } from "./landmarks.ts";
import type {
  ApiTiming,
  ConsoleIssue,
  CoverageEntry,
  PageMeasurement,
  PageSample,
  RequestFailure,
} from "./types.ts";
import type { Industry } from "../src/lib/industries.ts";
import type { PageId } from "../src/nav.ts";

export interface MeasureOptions {
  baseUrl: string;
  samples: number;
  /** Per-phase feature-ready timeout in ms. */
  timeoutMs: number;
  /** Abort non-GET/HEAD /api calls to guarantee read-only runs (default true). */
  blockWrites: boolean;
  headed: boolean;
}

export const DEFAULT_OPTIONS: Omit<MeasureOptions, "baseUrl"> = {
  samples: 3,
  timeoutMs: 30_000,
  blockWrites: true,
  headed: false,
};

interface Collector {
  api: ApiTiming[];
  failures: RequestFailure[];
  consoleIssues: ConsoleIssue[];
  /**
   * In-flight `requestfinished` handlers. The Playwright event fires
   * synchronously but its handler must `await req.response()` to read status,
   * so a sample can be built before those async pushes land. Callers await
   * these before snapshotting so no completed page request is dropped.
   */
  pending: Promise<void>[];
  /** Number of `/api` requests started but not yet finished/failed. */
  inFlight: number;
  /** `Date.now()` of the most recent `/api` request start or completion. */
  lastActivityAt: number;
  /** Whether any `/api` request has been observed for this sample. */
  sawActivity: boolean;
}

function newCollector(): Collector {
  return {
    api: [],
    failures: [],
    consoleIssues: [],
    pending: [],
    inFlight: 0,
    lastActivityAt: 0,
    sawActivity: false,
  };
}

function personaButtonSelector(personaId: string): string {
  return `button[aria-labelledby="persona-${personaId}-label"]`;
}

export async function launchBrowser(headed: boolean): Promise<Browser> {
  return chromium.launch({ headless: !headed });
}

/**
 * Wire request/console listeners into a page. All events are pushed into the
 * `ref.current` collector so the caller can swap collectors between measured
 * loads on a reused (warm) page.
 */
function instrument(page: Page, ref: { current: Collector }): void {
  // Attribute completion/failure to the collector active when the request
  // started. A request from Entrance or a parked page may finish after the ref
  // swaps; event-time attribution would leak it into the next measured page.
  const requestOwners = new WeakMap<Request, Collector>();

  // Track `/api` in-flight so a sample can wait for the page's own data fetches
  // to settle, not merely for the container to mount. On read-only loads the app
  // does no background polling (poll loops only start after write actions we
  // block), so in-flight reliably returns to zero.
  page.on("request", (req) => {
    if (!req.url().includes("/api/")) return;
    const collector = ref.current;
    requestOwners.set(req, collector);
    collector.inFlight += 1;
    collector.lastActivityAt = Date.now();
    collector.sawActivity = true;
  });

  page.on("requestfinished", (req) => {
    const url = req.url();
    if (!url.includes("/api/")) return;
    const collector = requestOwners.get(req) ?? ref.current;
    collector.inFlight = Math.max(0, collector.inFlight - 1);
    collector.lastActivityAt = Date.now();
    const done = (async () => {
      let durationMs = 0;
      try {
        const t = req.timing();
        const end = t.responseEnd >= 0 ? t.responseEnd : 0;
        const startReq = t.requestStart >= 0 ? t.requestStart : 0;
        durationMs = end - startReq;
        if (!(durationMs >= 0)) durationMs = end;
      } catch {
        /* timing unavailable */
      }
      let status = 0;
      try {
        const resp = await req.response();
        status = resp ? resp.status() : 0;
      } catch {
        /* no response */
      }
      const timing: ApiTiming = {
        path: normalizeApiPath(url),
        method: req.method(),
        status,
        durationMs,
      };
      collector.api.push(timing);
      if (status >= 400) {
        collector.failures.push({ url: normalizeApiPath(url), method: req.method(), status });
      }
    })();
    collector.pending.push(done);
  });

  page.on("requestfailed", (req) => {
    const method = req.method();
    const url = req.url();
    if (!url.includes("/api/")) return;
    // Balance the in-flight counter for every /api request, including the writes
    // we deliberately aborted (their `request` event already incremented it).
    const collector = requestOwners.get(req) ?? ref.current;
    collector.inFlight = Math.max(0, collector.inFlight - 1);
    collector.lastActivityAt = Date.now();
    // Writes we deliberately aborted for read-only safety are expected, not
    // defects; only genuine failures of allowed requests (reads + the reviewed
    // computational POSTs) are worth reporting.
    if (!isReadOnlyRequest(method, url)) return;
    collector.failures.push({
      url: normalizeApiPath(url),
      method,
      status: 0,
      errorText: req.failure()?.errorText,
    });
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      ref.current.consoleIssues.push({ kind: "console.error", text: msg.text() });
    }
  });
  page.on("pageerror", (err) => {
    ref.current.consoleIssues.push({ kind: "pageerror", text: err.message });
  });
}

/**
 * Block writes at the network layer so browser runs cannot mutate shared data.
 * Reads and the two reviewed read-only computational POSTs pass through; every
 * other mutating request is aborted before it reaches the server.
 */
async function enforceReadOnly(context: BrowserContext): Promise<void> {
  await context.route("**/api/**", (route) => {
    const req = route.request();
    if (isReadOnlyRequest(req.method(), req.url())) return route.continue();
    return route.abort();
  });
}

/** Prime localStorage so the app boots into the target industry + persona. */
async function primeStorage(
  context: BrowserContext,
  industry: Industry,
  personaId: string,
): Promise<void> {
  await context.addInitScript(
    ([ind, persona]) => {
      try {
        localStorage.setItem("cfo.industry", ind);
        localStorage.setItem("cfo.persona", persona);
      } catch {
        /* ignore */
      }
    },
    [industry, personaId] as const,
  );
}

/**
 * Wait until the page's feature-ready landmark holds: every required element is
 * visible and every loader selector has zero matches. Returns true on timeout.
 */
async function waitFeatureReady(
  page: Page,
  plan: FeatureReadyPlan,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await page.waitForFunction(
      (p: FeatureReadyPlan) => {
        const isVisible = (sel: string): boolean => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            cs.visibility !== "hidden" &&
            cs.display !== "none"
          );
        };
        const isAbsent = (sel: string): boolean =>
          document.querySelectorAll(sel).length === 0;
        return p.requireVisible.every(isVisible) && p.requireAbsent.every(isAbsent);
      },
      plan,
      { timeout: timeoutMs, polling: 50 },
    );
    return false;
  } catch {
    return true;
  }
}

/**
 * Quiet window with zero in-flight `/api` requests that marks the page's data
 * as settled. Loader-less pages (e.g. Executive, Competitor Benchmarking) render
 * their container instantly and fill tiles from post-mount fetches with no
 * detectable skeleton, so container-mount alone under-measures them. This gate
 * waits for those fetches to fire and quiesce.
 */
const SETTLE_QUIET_MS = 400;
/** Poll cadence for the settle gate. */
const SETTLE_POLL_MS = 40;

/** Outcome of the /api settle gate: when activity ceased, and whether it timed out. */
interface SettleResult {
  /** True when the settle window never opened before the deadline. */
  timedOut: boolean;
  /** `Date.now()` of the last observed /api activity (start or finish). */
  lastActivityAt: number;
  /** Whether any /api request was observed. */
  sawActivity: boolean;
}

/**
 * Wait until the sample's collector has no in-flight `/api` request and has been
 * quiet for `SETTLE_QUIET_MS`, bounded by `deadline`. When no request is ever
 * observed (e.g. a prop-driven page rendered from already-cached shell data),
 * the quiet window is measured from `start`, so such pages settle quickly rather
 * than stalling. Returns whether it timed out plus the last-activity timestamp.
 *
 * `quietFloor` is the earliest instant the quiet window may be measured from —
 * pass the DOM-landmark time so pre-mount shell quiet can never satisfy it. A
 * loader-less page's container mounts (DOM landmark) well after the shell went
 * quiet; without this floor the gate would see "quiet since the shell finished"
 * and declare settled *before* the page's own post-mount fetches even fire,
 * missing them. Flooring the window at DOM-ready gives those effects up to
 * `SETTLE_QUIET_MS` to start (React fires effects within a frame of mount, far
 * under that) while never padding the measured time (that uses `lastActivityAt`).
 */
async function waitApiSettle(
  collector: Collector,
  start: number,
  deadline: number,
  quietFloor: number,
): Promise<SettleResult> {
  for (;;) {
    const idleSince = Math.max(collector.lastActivityAt || start, quietFloor);
    if (collector.inFlight === 0 && Date.now() - idleSince >= SETTLE_QUIET_MS) {
      return {
        timedOut: false,
        lastActivityAt: collector.lastActivityAt || start,
        sawActivity: collector.sawActivity,
      };
    }
    if (Date.now() >= deadline) {
      return { timedOut: true, lastActivityAt: collector.lastActivityAt || start, sawActivity: collector.sawActivity };
    }
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
}

/**
 * Resolve the feature-ready time for a sample whose container mounted at
 * `domReadyMs`. The page is ready when both the container is mounted AND its
 * `/api` data has settled; report the later of the two, without the trailing
 * quiet padding. A settle timeout is a genuine feature-ready timeout.
 */
async function resolveFeatureReady(
  collector: Collector,
  start: number,
  domReadyMs: number,
  domTimedOut: boolean,
  timeoutMs: number,
): Promise<{ featureReadyMs: number; timedOut: boolean }> {
  if (domTimedOut) return { featureReadyMs: timeoutMs, timedOut: true };
  // Floor the settle quiet window at the DOM-landmark instant so pre-mount shell
  // quiet cannot satisfy it before the page's own post-mount fetches fire.
  const settle = await waitApiSettle(collector, start, start + timeoutMs, start + domReadyMs);
  if (settle.timedOut) return { featureReadyMs: timeoutMs, timedOut: true };
  const apiReadyMs = settle.sawActivity ? settle.lastActivityAt - start : 0;
  return { featureReadyMs: Math.max(domReadyMs, apiReadyMs), timedOut: false };
}

/**
 * Warm-navigate to `slug` and wait for the page to genuinely remount before
 * trusting readiness. App.tsx remounts `#main-content` per page (`key={page}`),
 * so we snapshot the current container, change the hash, and wait for that
 * element to disconnect before checking the new page's landmark. Without this,
 * a warm sample can match the *previous* page (still mounted) and report an
 * impossibly fast 3–4 ms time. Returns true on timeout.
 */
async function navigateRemount(
  browserPage: Page,
  slug: PageId,
  plan: FeatureReadyPlan,
  timeoutMs: number,
): Promise<boolean> {
  const oldMain = await browserPage.$(MAIN_CONTENT);
  await browserPage.evaluate((s) => {
    window.location.hash = `/${s}`;
  }, slug);
  if (oldMain) {
    try {
      await browserPage.waitForFunction(
        (el) => !(el as Element).isConnected,
        oldMain,
        { timeout: timeoutMs, polling: 25 },
      );
    } catch {
      /* detach never observed; fall through so waitFeatureReady can judge */
    } finally {
      await oldMain.dispose().catch(() => {});
    }
  }
  return waitFeatureReady(browserPage, plan, timeoutMs);
}

/**
 * One cold sample: fresh context, enter the persona, then time the target page.
 * Entrance bootstrap is drained before the clock starts so `/api/personas` and
 * `/api/org` latency is not misattributed to every page. For the persona's home
 * page we enter from `/`, allowing the app to apply its configured default query
 * (for example Accountant's task calendar); other pages use a deep link.
 */
async function measureCold(
  browser: Browser,
  entry: CoverageEntry,
  page: PageId,
  opts: MeasureOptions,
): Promise<PageSample> {
  const context = await browser.newContext();
  const entranceCollector = newCollector();
  const ref = { current: entranceCollector };
  try {
    if (opts.blockWrites) await enforceReadOnly(context);
    await primeStorage(context, entry.industry, entry.personaId);
    const browserPage = await context.newPage();
    instrument(browserPage, ref);

    const plan = featureReadyPlan(page);
    const entranceStart = Date.now();
    const targetUrl = page === entry.defaultPage
      ? `${opts.baseUrl}/`
      : `${opts.baseUrl}/#/${page}`;
    await browserPage.goto(targetUrl, {
      waitUntil: "commit",
      timeout: opts.timeoutMs,
    });
    const personaButton = browserPage.locator(personaButtonSelector(entry.personaId));
    await personaButton.waitFor({ state: "visible", timeout: opts.timeoutMs });
    await waitApiSettle(
      entranceCollector,
      entranceStart,
      entranceStart + opts.timeoutMs,
      entranceStart,
    );
    await Promise.allSettled(entranceCollector.pending);

    // Swap collectors only after Entrance is fully drained. The measured clock
    // now starts at the user's persona-entry action, which mounts the target.
    const collector = newCollector();
    ref.current = collector;
    const start = Date.now();
    await personaButton.click({ timeout: opts.timeoutMs });
    const domTimedOut = await waitFeatureReady(browserPage, plan, opts.timeoutMs);
    const domReadyMs = Date.now() - start;
    // Ready = container mounted AND the page's own /api data has settled. This
    // captures loader-less pages whose KPI fetches fire after mount (and which a
    // fresh cold context would otherwise close before recording).
    const { featureReadyMs, timedOut } = await resolveFeatureReady(
      collector, start, domReadyMs, domTimedOut, opts.timeoutMs,
    );
    // Flush in-flight requestfinished handlers so every completed page request
    // is recorded before we snapshot the sample.
    await Promise.allSettled(collector.pending);
    return {
      mode: "cold",
      featureReadyMs,
      timedOut,
      api: collector.api,
      failures: collector.failures,
      consoleIssues: collector.consoleIssues,
    };
  } finally {
    await context.close();
  }
}

/** One warm sample: hash-navigate an already-entered page and wait feature-ready. */
async function measureWarm(
  browserPage: Page,
  ref: { current: Collector },
  page: PageId,
  opts: MeasureOptions,
): Promise<PageSample> {
  const collector = newCollector();
  ref.current = collector;
  const plan = featureReadyPlan(page);
  const start = Date.now();
  const domTimedOut = await navigateRemount(browserPage, page, plan, opts.timeoutMs);
  const domReadyMs = Date.now() - start;
  // Ready = remounted container AND the page's own /api data has settled, so
  // loader-less pages are not reported at their sub-20ms mount time.
  const { featureReadyMs, timedOut } = await resolveFeatureReady(
    collector, start, domReadyMs, domTimedOut, opts.timeoutMs,
  );
  // Flush in-flight requestfinished handlers before snapshotting the sample.
  await Promise.allSettled(collector.pending);
  return {
    mode: "warm",
    featureReadyMs,
    timedOut,
    api: collector.api,
    failures: collector.failures,
    consoleIssues: collector.consoleIssues,
  };
}

/**
 * Park the warm page on `slug` (a hub other than the page about to be measured),
 * without measuring. Drains the parked page into a throwaway collector — waiting
 * for its `/api` traffic to settle — so no trailing `requestfinished` handler
 * lands in (and contaminates) the next warm sample's fresh collector.
 */
async function parkOn(
  browserPage: Page,
  ref: { current: Collector },
  slug: PageId,
  opts: MeasureOptions,
): Promise<void> {
  const parkCollector = newCollector();
  ref.current = parkCollector;
  const start = Date.now();
  const domTimedOut = await navigateRemount(browserPage, slug, featureReadyPlan(slug), opts.timeoutMs);
  await resolveFeatureReady(parkCollector, start, Date.now() - start, domTimedOut, opts.timeoutMs);
  await Promise.allSettled(parkCollector.pending);
}

/**
 * Measure every page for one (industry, persona) entry: `samples` cold samples
 * per page (fresh contexts) and `samples` warm samples per page (in-app hash
 * navigation inside a single entered context).
 */
export async function measureEntry(
  browser: Browser,
  entry: CoverageEntry,
  opts: MeasureOptions,
): Promise<PageMeasurement[]> {
  const byPage = new Map<PageId, PageMeasurement>();
  for (const page of entry.pages) {
    byPage.set(page, { industry: entry.industry, personaId: entry.personaId, page, cold: [], warm: [] });
  }

  // Cold: fresh context per sample per page.
  for (const page of entry.pages) {
    const m = byPage.get(page)!;
    for (let i = 0; i < opts.samples; i++) {
      m.cold.push(await measureCold(browser, entry, page, opts));
    }
  }

  // Warm: one entered context; hop to each page from a hub so every warm sample
  // is a genuine remount. Hub is the persona's default page unless we're
  // measuring it, in which case we park on an alternate page first.
  const context = await browser.newContext();
  const ref = { current: newCollector() };
  try {
    if (opts.blockWrites) await enforceReadOnly(context);
    await primeStorage(context, entry.industry, entry.personaId);
    const browserPage = await context.newPage();
    instrument(browserPage, ref);
    await browserPage.goto(`${opts.baseUrl}/#/${entry.defaultPage}`, {
      waitUntil: "commit",
      timeout: opts.timeoutMs,
    });
    await browserPage
      .locator(personaButtonSelector(entry.personaId))
      .click({ timeout: opts.timeoutMs });
    // Drain the entered default page's own fetches before the warm loop so its
    // trailing requests never bleed into the first measured sample's collector.
    const entryStart = Date.now();
    const entryDomTimedOut = await waitFeatureReady(
      browserPage,
      featureReadyPlan(entry.defaultPage),
      opts.timeoutMs,
    );
    await resolveFeatureReady(
      ref.current,
      entryStart,
      Date.now() - entryStart,
      entryDomTimedOut,
      opts.timeoutMs,
    );
    await Promise.allSettled(ref.current.pending);

    const hub = entry.defaultPage;
    const alternate = entry.pages.find((p) => p !== hub) ?? hub;
    for (const page of entry.pages) {
      const m = byPage.get(page)!;
      const park = page === hub ? alternate : hub;
      for (let i = 0; i < opts.samples; i++) {
        if (park !== page) await parkOn(browserPage, ref, park, opts);
        m.warm.push(await measureWarm(browserPage, ref, page, opts));
      }
    }
  } finally {
    await context.close();
  }

  return entry.pages.map((p) => byPage.get(p)!);
}
