import { useCallback, useEffect, useState } from "react";
import { api, CloseConfig, CloseTask, TaskActivity, TaskAssignee } from "../../api";
import { Button, Select, SelectOption } from "../ui";
import {
  Avatar, BlockedBadge, OverdueBadge, PriorityTag, StatusPill,
  fmtDate, fmtDateTime, isOverdue, orderedStatuses, sourceLabel,
} from "./taskUi";

export default function TaskDrawer({
  task, config, team, asOf, onClose, onChanged,
}: {
  task: CloseTask;
  config: CloseConfig | null;
  team: TaskAssignee[];
  asOf?: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [activity, setActivity] = useState<TaskActivity[]>([]);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState(task.delay_reason ?? "");
  const [busy, setBusy] = useState(false);

  const loadActivity = useCallback(() => {
    api.taskActivity(task.task_id).then(setActivity).catch(() => setActivity([]));
  }, [task.task_id]);

  useEffect(() => { loadActivity(); }, [loadActivity]);
  useEffect(() => { setReason(task.delay_reason ?? ""); }, [task.delay_reason]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); onChanged(); loadActivity(); }
    finally { setBusy(false); }
  };

  const changeStatus = (status: string) =>
    run(() => api.setTaskStatus(task.task_id, status));
  const toggleBlocked = (blocked: boolean) =>
    run(() => api.setTaskStatus(task.task_id, task.status, blocked, blocked ? (reason || null) : null));
  const assign = (assignee: string) =>
    run(() => api.assignTask(task.task_id, assignee));
  const submitComment = async () => {
    if (!comment.trim()) return;
    await run(() => api.addComment(task.task_id, comment));
    setComment("");
  };

  const overdue = isOverdue(task, asOf);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="relative w-full max-w-md bg-ink-800 h-full shadow-xl flex flex-col">
        <div className="px-5 py-4 border-b flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <StatusPill config={config} status={task.status} />
              {overdue && <OverdueBadge />}
              {task.is_blocked && <BlockedBadge reason={task.delay_reason} />}
            </div>
            <h3 className="text-base font-semibold leading-snug">{task.task_name}</h3>
            <div className="text-xs text-fg-muted font-mono mt-0.5">{task.task_id}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-fg-muted hover:text-fg p-1 leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {task.description && <p className="text-sm text-fg">{task.description}</p>}

          <dl className="grid grid-cols-2 gap-y-3 text-sm">
            <Meta label="Workstream" value={task.workstream ?? "—"} />
            <Meta label="Source" value={sourceLabel(task.source)} />
            <Meta label="Due date" value={fmtDate(task.due_date)} tone={overdue ? "fail" : undefined} />
            <Meta label="Priority" value={<PriorityTag priority={task.priority} />} />
            {task.business_unit_id && <Meta label="Entity" value={task.business_unit_id} />}
            {task.linked_ref && <Meta label="Linked" value={<span className="font-mono text-xs">{task.linked_ref}</span>} />}
          </dl>

          <Section title="Owner">
            <div className="flex items-center gap-2">
              <Avatar name={task.assignee} />
              <Select
                aria-label="Assign owner"
                size="sm"
                fullWidth
                className="flex-1"
                disabled={busy}
                value={task.assignee ?? ""}
                onChange={assign}
                placeholder="Unassigned"
                options={[
                  { value: "", label: "Unassigned" },
                  ...team.map((m): SelectOption => ({ value: m.name, label: m.name, hint: m.role })),
                ]}
              />
            </div>
          </Section>

          <Section title="Status">
            <div className="flex flex-wrap gap-1.5">
              {orderedStatuses(config).map((s) => (
                <button key={s.id} disabled={busy || s.id === task.status}
                        onClick={() => changeStatus(s.id)}
                        className={`text-xs px-2.5 py-1 rounded-md border transition ${
                          s.id === task.status
                            ? "bg-accent text-white border-transparent"
                            : "border-line text-fg hover:bg-black/[0.04]"}`}>
                  {s.label}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Blocker">
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={task.is_blocked} disabled={busy}
                       onChange={(e) => toggleBlocked(e.target.checked)} />
                Flag as blocked
              </label>
              <Select
                aria-label="Blocker reason code"
                size="sm"
                fullWidth
                disabled={busy}
                value={reason}
                onChange={setReason}
                placeholder="Reason code…"
                options={(config?.reason_codes ?? []).map((r) => ({ value: r, label: r }))}
              />
              {task.is_blocked && (
                <Button variant="outline" size="sm" disabled={busy}
                        onClick={() => toggleBlocked(true)}>Save reason</Button>
              )}
            </div>
          </Section>

          <Section title="Activity">
            <div className="flex gap-2 mb-3">
              <input value={comment} onChange={(e) => setComment(e.target.value)}
                     onKeyDown={(e) => { if (e.key === "Enter") submitComment(); }}
                     placeholder="Add a comment…"
                     className="flex-1 border border-line rounded-md px-3 py-1.5 text-sm" />
              <Button variant="primary" size="sm" disabled={busy || !comment.trim()} onClick={submitComment}>
                Post
              </Button>
            </div>
            <ul className="space-y-3">
              {activity.length === 0 && <li className="text-xs text-fg-subtle">No activity yet.</li>}
              {activity.map((a) => (
                <li key={a.activity_id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-fg">{a.actor}</span>
                    <span className="text-[11px] uppercase tracking-wide text-fg-subtle">{a.action}</span>
                    <span className="text-[11px] text-fg-subtle ml-auto">{fmtDateTime(a.ts)}</span>
                  </div>
                  {a.detail && <div className="text-sm text-fg-muted">{a.detail}</div>}
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Meta({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "fail" }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className={`mt-0.5 ${tone === "fail" ? "text-signal-bad font-medium" : "text-fg"}`}>{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-2">{title}</div>
      {children}
    </div>
  );
}
