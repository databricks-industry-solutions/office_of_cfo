import { api, CloseConfig, CloseTask } from "../../api";
import {
  Avatar, BlockedBadge, OverdueBadge, PriorityTag,
  colorClasses, fmtDate, isOverdue, orderedStatuses, statusDef,
} from "./taskUi";

export default function TaskBoard({
  tasks, config, asOf, onOpen, onChanged,
}: {
  tasks: CloseTask[];
  config: CloseConfig | null;
  asOf?: string | null;
  onOpen: (t: CloseTask) => void;
  onChanged: () => void;
}) {
  const statuses = orderedStatuses(config);
  const next = (statusId: string): string | null => {
    const i = statuses.findIndex((s) => s.id === statusId);
    return i >= 0 && i < statuses.length - 1 ? statuses[i + 1].id : null;
  };

  const advance = async (t: CloseTask) => {
    const n = next(t.status);
    if (!n) return;
    await api.setTaskStatus(t.task_id, n);
    onChanged();
  };

  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {statuses.map((s) => {
        const col = tasks.filter((t) => t.status === s.id);
        const c = colorClasses(s.color);
        return (
          <div key={s.id} className="w-72 shrink-0">
            <div className="flex items-center gap-2 px-1 mb-2">
              <span className={`inline-block w-2 h-2 rounded-full ${c.dot}`} />
              <span className="text-sm font-medium text-fg">{s.label}</span>
              <span className="text-xs text-fg-subtle">{col.length}</span>
            </div>
            <div className={`rounded-xl p-2 space-y-2 min-h-[120px] ${c.soft}`}>
              {col.length === 0 && (
                <div className="text-xs text-fg-subtle text-center py-6">No tasks</div>
              )}
              {col.map((t) => {
                const overdue = isOverdue(t, asOf);
                const n = next(t.status);
                return (
                  <div key={t.task_id}
                       className="bg-ink-800 rounded-lg shadow-sm border border-line p-3 cursor-pointer hover:shadow transition"
                       onClick={() => onOpen(t)}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm font-medium text-fg leading-snug">{t.task_name}</div>
                      <Avatar name={t.assignee} size="sm" />
                    </div>
                    <div className="text-[11px] text-fg-muted mt-1">{t.workstream ?? "—"}</div>
                    <div className="flex items-center flex-wrap gap-1.5 mt-2">
                      <PriorityTag priority={t.priority} />
                      <span className={`text-xs ${overdue ? "text-signal-bad font-medium" : "text-fg-muted"}`}>· {fmtDate(t.due_date)}</span>
                      {overdue && <OverdueBadge />}
                      {t.is_blocked && <BlockedBadge reason={t.delay_reason} />}
                    </div>
                    {n && (
                      <button
                        onClick={(e) => { e.stopPropagation(); advance(t); }}
                        className="mt-2 w-full text-xs border border-line rounded-md py-1 text-fg-muted hover:bg-black/[0.04] transition">
                        Move to {statusDef(config, n).label} →
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
