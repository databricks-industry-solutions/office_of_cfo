// Coverage-matrix discovery for the page-latency harness.
//
// This deliberately reuses the *real* application nav rules (`PAGES`,
// `isHiddenFromNav`) and the *real* per-industry overlay (`getOverlay`) so the
// harness measures exactly what a persona can navigate to in the running app —
// no forked copy of the visibility logic to drift out of sync. Pure and
// dependency-free (browser-agnostic) so it can be unit-tested under vitest.

import { INDUSTRIES, getOverlay, type Industry } from "../src/lib/industries.ts";
import { PAGES, isHiddenFromNav, type PageId } from "../src/nav.ts";
import type { CoverageEntry, HarnessPersona } from "./types.ts";

const VALID_PAGES: ReadonlySet<PageId> = new Set(PAGES.map((p) => p.id));

/** The nav-visible pages for a persona under one industry overlay. */
export function visiblePagesFor(
  persona: HarnessPersona,
  industry: Industry,
): PageId[] {
  const overlay = getOverlay(industry);
  return persona.pages
    .filter((p): p is PageId => VALID_PAGES.has(p as PageId))
    .filter((p) => !isHiddenFromNav(p, overlay.hiddenPages));
}

/** The landing page a persona enters on, mirroring App.enterAsPersona. */
export function defaultPageFor(
  persona: HarnessPersona,
  visible: readonly PageId[],
): PageId {
  const configured = persona.default_page as PageId;
  if (VALID_PAGES.has(configured) && visible.includes(configured)) return configured;
  return visible[0] ?? "executive";
}

/**
 * Build the full coverage matrix for the given industries. Personas are keyed by
 * industry because the same roster can expose different pages per overlay (some
 * pages are hidden for some industries). Pass the personas fetched from
 * `GET /api/personas` for each industry (the roster can be industry-invariant,
 * but we accept a per-industry map so an industry-specific roster still works).
 */
export function buildCoverageMatrix(
  personasByIndustry: Partial<Record<Industry, HarnessPersona[]>>,
  industries: readonly Industry[] = INDUSTRIES,
): CoverageEntry[] {
  const matrix: CoverageEntry[] = [];
  for (const industry of industries) {
    const personas = personasByIndustry[industry] ?? [];
    for (const persona of personas) {
      const pages = visiblePagesFor(persona, industry);
      if (pages.length === 0) continue;
      matrix.push({
        industry,
        personaId: persona.id,
        personaName: persona.name,
        pages,
        defaultPage: defaultPageFor(persona, pages),
      });
    }
  }
  return matrix;
}

/** Total (industry, persona, page) combinations in a coverage matrix. */
export function countCombinations(matrix: readonly CoverageEntry[]): number {
  return matrix.reduce((n, e) => n + e.pages.length, 0);
}

export { INDUSTRIES };
export type { Industry, PageId };
