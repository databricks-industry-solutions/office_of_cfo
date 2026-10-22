import { Fragment, useState } from "react";
import { Scope, api, fmtCompact } from "../../../api";
import { cn } from "../../../lib/cn";
import { Card, Skeleton, SkeletonRegion, TableSkeleton } from "../../ui";
import { useAiRoiLoad } from "../shared";

function contextChips(tags?: Record<string, string> | null): { label: string; value: string }[] {
  if (!tags) return [];
  const rank = (k: string) => (k === "asset_class" ? 0 : k === "instrument" ? 1 : k === "strategy" ? 2 : 3);
  return Object.entries(tags)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([k, v]) => ({ label: k.startsWith("greek.") ? k.slice(6) : k, value: v }));
}

export function InvocationsTable({ scope }: { scope: Scope }) {
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const q = useAiRoiLoad(() => api.aiRoiInvocations(cursor, scope), [cursor, scope]);
  const items = q.data?.items ?? [];

  const toggle = (id: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  return (
    <Card title="Raw invocations">
      <div data-testid="ai-roi-invocations" className="overflow-x-auto">
        {!q.data && !q.error ? (
          <SkeletonRegion>
            <TableSkeleton rows={25} cols={8} />
            <div className="flex gap-2 px-5 py-3"><Skeleton className="h-6 w-12 rounded-lg" /><Skeleton className="h-6 w-12 rounded-lg" /></div>
          </SkeletonRegion>
        ) : items.length === 0 && q.data ? (
          <p className="px-5 py-4 text-sm text-fg-muted">No invocation samples in this scope.</p>
        ) : (
          <>
            <table className="w-full text-sm min-w-[48rem]">
              <thead>
                <tr className="border-y border-line text-xs text-fg-subtle">
                  {["Time", "Consumer", "Model", "In", "Out", "Latency", "Status", "Cost"].map((h, i) => (
                    <th key={h} className={`px-3 py-2 font-medium ${i > 2 ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const chips = contextChips(r.request_tags);
                  const open = expanded.has(r.invocation_id);
                  return (
                    <Fragment key={r.invocation_id}>
                      <tr
                        className={cn("border-b border-line/70", chips.length && "cursor-pointer record-row-hover")}
                        onClick={chips.length ? () => toggle(r.invocation_id) : undefined}
                        aria-expanded={chips.length ? open : undefined}
                      >
                        <td className="px-3 py-1.5 text-xs text-fg-muted num">
                          {chips.length ? (
                            <span className="mr-1 inline-block text-fg-subtle" aria-hidden="true">
                              {open ? "▾" : "▸"}
                            </span>
                          ) : null}
                          {r.event_time.replace("T", " ").slice(0, 16)}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-xs">{r.consumer_id}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">{r.model_id}</td>
                        <td className="px-3 py-1.5 text-right num">{r.input_tokens.toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-right num">{r.output_tokens.toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-right num">{r.latency_ms}ms</td>
                        <td className="px-3 py-1.5 text-right num">{r.status_code}</td>
                        <td className="px-3 py-1.5 text-right num">{fmtCompact(r.cost_usd)}</td>
                      </tr>
                      {open && chips.length > 0 && (
                        <tr className="border-b border-line/70 bg-black/[0.02]">
                          <td colSpan={8} className="px-3 py-2">
                            <div className="flex flex-wrap gap-1.5">
                              {chips.map((c) => (
                                <span
                                  key={c.label}
                                  className="inline-flex items-center gap-1 rounded-md ring-1 ring-line px-1.5 py-0.5 text-xs"
                                >
                                  <span className="text-fg-subtle">{c.label}</span>
                                  <span className="font-mono num">{c.value}</span>
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <div className="flex items-center gap-2 px-5 py-3">
              <button
                type="button"
                className="rounded-lg px-3 py-1 text-xs ring-1 ring-line disabled:opacity-40"
                disabled={cursor === 0}
                onClick={() => setCursor(Math.max(0, cursor - 25))}
              >
                Prev
              </button>
              <button
                type="button"
                className="rounded-lg px-3 py-1 text-xs ring-1 ring-line disabled:opacity-40"
                disabled={q.data?.next_cursor == null}
                onClick={() => q.data?.next_cursor != null && setCursor(q.data.next_cursor)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
