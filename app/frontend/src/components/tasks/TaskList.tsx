import { Fragment, useMemo, useState } from "react";
import { CloseConfig, CloseTask } from "../../api";
import { Select } from "../ui";
import {
  Avatar, BlockedBadge, OverdueBadge, PriorityTag, StatusPill,
  fmtDate, isOverdue, sourceLabel, statusDef,
} from "./taskUi";

export type GroupBy = "none" | "status" | "owner" | "workstream" | "entity" | "due";
export type SortBy = "due" | "priority" | "status" | "name";

const PRIORITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function groupKey(t: CloseTask, by: GroupBy): string {
  switch (by) {
    case "status": return t.status;
    case "owner": return t.assignee || "Unassigned";
    case "workstream": return t.workstream || "Other";
    case "entity": return t.business_unit_id || "—";
    case "due": return t.due_date ? fmtDate(t.due_date) : "No due date";
    default: return "All tasks";
  }
}

export default function TaskList({
  tasks, config, asOf, onOpen,
}: {
  tasks: CloseTask[];
  config: CloseConfig | null;
  asOf?: string | null;
  onOpen: (t: CloseTask) => void;
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  const [sortBy, setSortBy] = useState<SortBy>("due");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const sorted = useMemo(() => {
    const arr = [...tasks];
    arr.sort((a, b) => {
      if (sortBy === "priority") return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (sortBy === "name") return a.task_name.localeCompare(b.task_name);
      if (sortBy === "status")
        return statusDef(config, a.status).order - statusDef(config, b.status).order;
      const da = a.due_date ? new Date(a.due_date).getTime() : Infinity;
      const db = b.due_date ? new Date(b.due_date).getTime() : Infinity;
      return da - db;
    });
    return arr;
  }, [tasks, sortBy, config]);

  const groups = useMemo(() => {
    const map = new Map<string, CloseTask[]>();
    for (const t of sorted) {
      const k = groupKey(t, groupBy);
      let bucket = map.get(k);
      if (!bucket) { bucket = []; map.set(k, bucket); }
      bucket.push(t);
    }
    // When grouping by status, present groups in the configured status order.
    if (groupBy === "status") {
      return Array.from(map.entries()).sort(
        ([a], [b]) => statusDef(config, a).order - statusDef(config, b).order,
      );
    }
    return Array.from(map.entries());
  }, [sorted, groupBy, config]);

  const COLS = 5;

  return (
    <div className="bg-ink-800 rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-fg-muted">{tasks.length} task{tasks.length === 1 ? "" : "s"}</div>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-xs text-fg-muted">Group</label>
          <Select
            aria-label="Group tasks by"
            size="sm"
            value={groupBy}
            onChange={(v) => setGroupBy(v as GroupBy)}
            options={[
              { value: "status", label: "Status" },
              { value: "owner", label: "Owner" },
              { value: "workstream", label: "Workstream" },
              { value: "entity", label: "Entity" },
              { value: "due", label: "Due date" },
              { value: "none", label: "None" },
            ]}
          />
          <label className="text-xs text-fg-muted ml-2">Sort</label>
          <Select
            aria-label="Sort tasks by"
            size="sm"
            value={sortBy}
            onChange={(v) => setSortBy(v as SortBy)}
            options={[
              { value: "due", label: "Due date" },
              { value: "priority", label: "Priority" },
              { value: "status", label: "Status" },
              { value: "name", label: "Name" },
            ]}
          />
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="px-5 py-12 text-center text-fg-muted text-sm">No tasks match these filters.</div>
      ) : (
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col />
            <col className="w-28" />
            <col className="w-32" />
            <col className="w-24" />
            <col className="w-44" />
          </colgroup>
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide text-fg-subtle">
              <th className="pl-5 pr-3 py-2 font-medium">Task</th>
              <th className="px-3 py-2 font-medium">Priority</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Due</th>
              <th className="px-3 py-2 font-medium">Owner</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([key, rows]) => {
              const isOpen = !collapsed[key];
              const label = groupBy === "status" ? statusDef(config, key).label : key;
              return (
                <Fragment key={key}>
                  {groupBy !== "none" && (
                    <tr className="bg-black/[0.04]">
                      <td colSpan={COLS} className="p-0">
                        <button
                          onClick={() => setCollapsed((c) => ({ ...c, [key]: isOpen }))}
                          className="w-full flex items-center gap-2 px-5 py-2 hover:bg-black/[0.06] transition text-left">
                          <span className={`text-fg-subtle text-xs transition-transform ${isOpen ? "rotate-90" : ""}`}>▸</span>
                          <span className="text-sm font-semibold text-fg">{label}</span>
                          <span className="text-xs text-fg-subtle tabular-nums">{rows.length}</span>
                        </button>
                      </td>
                    </tr>
                  )}
                  {isOpen && rows.map((t) => {
                    const overdue = isOverdue(t, asOf);
                    const done = t.status === "DONE";
                    return (
                      <tr key={t.task_id}
                          onClick={() => onOpen(t)}
                          className={`border-t record-row-hover cursor-pointer ${done ? "opacity-55" : ""}`}>
                        <td className="pl-5 pr-3 py-2.5">
                          <div className={`font-medium flex items-center gap-2 ${done ? "text-fg-muted line-through decoration-fg-subtle" : "text-fg"}`}>
                            <span className="truncate">{t.task_name}</span>
                            {overdue && <OverdueBadge />}
                            {t.is_blocked && <BlockedBadge reason={t.delay_reason} />}
                          </div>
                          <div className="text-xs text-fg-subtle truncate">
                            {t.workstream ?? "—"} · {sourceLabel(t.source)}
                            {t.delay_reason ? ` · ${t.delay_reason}` : ""}
                          </div>
                        </td>
                        <td className="px-3 py-2.5"><PriorityTag priority={t.priority} /></td>
                        <td className="px-3 py-2.5"><StatusPill config={config} status={t.status} /></td>
                        <td className={`px-3 py-2.5 whitespace-nowrap ${overdue ? "text-signal-bad font-medium" : "text-fg-muted"}`}>
                          {fmtDate(t.due_date)}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <Avatar name={t.assignee} size="sm" />
                            <span className="text-xs text-fg-muted hidden md:inline truncate">{t.assignee ?? "Unassigned"}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
