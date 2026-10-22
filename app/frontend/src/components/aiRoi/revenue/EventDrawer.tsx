import { Scope, api } from "../../../api";
import { DataState, useAiRoiLoad } from "../shared";
import { EventListSkeleton } from "../skeletons";
import { money } from "./format";

type BarKind = "value" | "run_cost" | "investment" | "net";

interface EventRow {
  event_date: string;
  category: string;
  amount_usd: number;
  confidence: string;
  source_system: string;
  note?: string;
}

export function EventDrawer({
  open,
  onClose,
  useCaseId,
  scope,
  kind,
  runCostNote,
}: {
  open: BarKind | null;
  onClose: () => void;
  useCaseId: string;
  scope: Scope;
  kind: "value" | "investment" | null;
  runCostNote?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="presentation" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto bg-white shadow-xl ring-1 ring-line"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-sm font-semibold text-fg">
            {runCostNote ? "Run cost" : kind === "investment" ? "Investment events" : "Value events"}
          </h3>
          <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={onClose}>Close</button>
        </div>
        <div className="p-5">
          {runCostNote ? (
            <p className="text-sm text-fg-muted">
              Run cost is metered directly from usage facts — it is not an investment event. See Spend for the per-model breakdown.
            </p>
          ) : kind ? (
            <EventsList useCaseId={useCaseId} scope={scope} kind={kind} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EventsList({ useCaseId, scope, kind }: { useCaseId: string; scope: Scope; kind: "value" | "investment" }) {
  const q = useAiRoiLoad(
    () => api.aiRoiUseCaseEvents(useCaseId, kind, scope),
    [useCaseId, kind, scope],
  );
  const events = (q.data?.events ?? []) as EventRow[];
  return (
    <DataState loading={!q.data && !q.error} error={q.error} empty={!events.length} skeleton={<EventListSkeleton />}>
      <div className="divide-y divide-line">
        {events.map((e, i) => (
          <div key={i} className="flex items-start justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs text-fg-muted">
                <span className="num">{e.event_date}</span>
                <ConfBadge confidence={e.confidence} />
              </div>
              <div className="text-sm capitalize text-fg">{e.category.replace(/_/g, " ")}</div>
              <div className="text-xs text-fg-muted">{e.source_system}{e.note ? ` · ${e.note}` : ""}</div>
            </div>
            <span className="num shrink-0 text-sm">{money(e.amount_usd)}</span>
          </div>
        ))}
      </div>
    </DataState>
  );
}

function ConfBadge({ confidence }: { confidence: string }) {
  const cls = confidence === "modelled"
    ? "bg-signal-warn/15 text-signal-warn"
    : "bg-black/[0.04] text-fg-muted";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${cls}`}>{confidence}</span>;
}
