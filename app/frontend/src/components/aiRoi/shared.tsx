import { ReactNode, useEffect, useState } from "react";
import { fmtCompact } from "../../api";
import { ErrorNote, Loading, SkeletonRegion } from "../ui";
import { AI_ROI_LIMITATIONS, AI_ROI_LIMITATIONS_TITLE, SYNTHETIC_DATA_NOTE_ID } from "./provenance/limitations";

export function useAiRoiLoad<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  { keepPrevious = false }: { keepPrevious?: boolean } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    if (!keepPrevious) setData(null);
    setError(""); setLoading(true);
    loader().then((value) => { if (active) { setData(value); setLoading(false); } })
      .catch(() => { if (active) { setError("AI ROI data is temporarily unavailable."); setLoading(false); } });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading };
}

/**
 * Shared AI ROI page shell. Every AI ROI page ends with a quiet "About this data"
 * footnote, so the synthetic-data disclosure and limits stay one click away now
 * that Provenance is out of the nav, without taking a row above the content.
 */
export function AiRoiPage({ children }: { children: ReactNode }) {
  return (
    <div className="ai-roi-surface min-w-0 space-y-5">
      {children}
      <details data-testid="ai-roi-about-toggle">
        <summary className="text-[11px] text-fg-subtle hover:text-fg-muted cursor-pointer select-none">
          About this data
        </summary>
        <AboutThisData />
      </details>
    </div>
  );
}

/** The synthetic-data disclosure first, then the limits, from the same list the
 *  Provenance limitations card renders. */
function AboutThisData() {
  const lead = AI_ROI_LIMITATIONS.find((item) => item.id === SYNTHETIC_DATA_NOTE_ID);
  const limits = AI_ROI_LIMITATIONS.filter((item) => item.id !== SYNTHETIC_DATA_NOTE_ID);
  return (
    <section aria-label="About this data" data-testid="ai-roi-about-data" className="tile ring-1 ring-line mt-2 p-5">
      {lead && (
        <div className="readable-copy">
          <p className="text-sm font-medium text-fg">{lead.title}</p>
          <p className="mt-1 text-xs text-fg-muted">{lead.body}</p>
        </div>
      )}
      <div className="mt-4 border-t border-line pt-4">
        <p className="text-[11px] uppercase tracking-wide text-fg-subtle">{AI_ROI_LIMITATIONS_TITLE}</p>
        <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {limits.map((item) => (
            <div key={item.id}>
              <p className="text-sm font-medium text-fg">{item.title}</p>
              <p className="mt-1 text-xs text-fg-muted">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function DataState({ loading, error, empty, skeleton, children }: {
  loading: boolean; error?: string; empty?: boolean; skeleton?: ReactNode; children: ReactNode;
}) {
  if (loading) {
    return skeleton ? <SkeletonRegion>{skeleton}</SkeletonRegion> : <Loading />;
  }
  if (error) return <ErrorNote message={error} />;
  if (empty) return (
    <div className="tile ring-1 ring-line p-10 text-center text-sm text-fg-muted">
      No data is available for this view.
    </div>
  );
  return <>{children}</>;
}

export const money = fmtCompact;
export const ratio = (v: number | null | undefined) => v == null ? "—" : `${v.toFixed(2)}×`;
export const pct = (v: number | null | undefined) => v == null ? "—" : `${(v * 100).toFixed(0)}%`;
