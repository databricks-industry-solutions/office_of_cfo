import { useCallback, useEffect, useMemo, useState } from "react";
import { api, CloseConfig, CloseTask, Scope, TaskAssignee, TaskSummary } from "../api";
import { Button, Card, ErrorNote, Select, TableSkeleton } from "../components/ui";
import FilterBar, { EMPTY_FILTERS, TaskFilters } from "../components/tasks/FilterBar";
import TaskList from "../components/tasks/TaskList";
import TaskBoard from "../components/tasks/TaskBoard";
import TaskCalendar from "../components/tasks/TaskCalendar";
import TaskDrawer from "../components/tasks/TaskDrawer";
import { isOverdue } from "../components/tasks/taskUi";

type ViewId = "list" | "board" | "calendar";
const VIEWS: { id: ViewId; label: string }[] = [
  { id: "list", label: "List" },
  { id: "board", label: "Board" },
  { id: "calendar", label: "Calendar" },
];

// Seed the filter bar from URL params so deep links (e.g. from the dashboard's
// task breakdown) land pre-filtered by owner / workstream / entity / status.
function filtersFromParams(params: URLSearchParams): TaskFilters {
  return {
    ...EMPTY_FILTERS,
    status: params.get("status") ?? "",
    owner: params.get("owner") ?? "",
    workstream: params.get("workstream") ?? "",
    entity: params.get("entity") ?? "",
    overdueOnly: params.get("overdue") === "1",
    search: params.get("q") ?? "",
  };
}

export default function Tasks({
  query, scope, onDataChange, refreshKey,
}: {
  query: string;
  scope: Scope;
  onDataChange: () => void;
  refreshKey: number;
}) {
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const [view, setView] = useState<ViewId>(() => (params.get("view") as ViewId) || "list");
  const [tasks, setTasks] = useState<CloseTask[]>([]);
  const [config, setConfig] = useState<CloseConfig | null>(null);
  const [team, setTeam] = useState<TaskAssignee[]>([]);
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [filters, setFilters] = useState<TaskFilters>(() => filtersFromParams(params));
  const [selected, setSelected] = useState<CloseTask | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, c, m, tm] = await Promise.all([
        api.closeTasks(scope), api.closeConfig(), api.taskSummary(scope), api.taskTeam(),
      ]);
      setTasks(t); setConfig(c); setSummary(m); setTeam(tm); setError(null);
      setSelected((sel) => (sel ? t.find((x) => x.task_id === sel.task_id) ?? null : null));
    } catch (e: any) {
      setError(e?.message || "Couldn’t load tasks.");
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  useEffect(() => {
    const v = params.get("view") as ViewId;
    if (v && v !== view) setView(v);
    setFilters((f) => ({ ...f, ...filtersFromParams(params) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const filtered = useMemo(() => tasks.filter((t) => {
    if (filters.status && t.status !== filters.status) return false;
    if (filters.owner === "__unassigned" && t.assignee) return false;
    if (filters.owner && filters.owner !== "__unassigned" && t.assignee !== filters.owner) return false;
    if (filters.workstream && t.workstream !== filters.workstream) return false;
    if (filters.entity && t.business_unit_id !== filters.entity) return false;
    if (filters.overdueOnly && !isOverdue(t, summary?.today)) return false;
    if (filters.search && !`${t.task_name} ${t.workstream ?? ""}`.toLowerCase().includes(filters.search.toLowerCase()))
      return false;
    return true;
  }), [tasks, filters, summary?.today]);

  const changed = useCallback(() => { refresh(); onDataChange(); }, [refresh, onDataChange]);
  const asOf = summary?.today ?? null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap justify-end">
        <Button variant="primary" size="md" onClick={() => setShowNew(true)}>+ New task</Button>
        {summary && <NeedsAttention summary={summary} onPick={(patch) => setFilters({ ...EMPTY_FILTERS, ...patch })} />}
      </div>

      {error && <ErrorNote message={error} />}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex rounded-lg border border-line overflow-hidden">
          {VIEWS.map((v) => (
            <button key={v.id} onClick={() => setView(v.id)}
                    className={`px-3 py-1.5 text-sm transition ${
                      view === v.id ? "bg-accent text-white" : "bg-ink-800 text-fg-muted hover:bg-black/[0.04]"}`}>
              {v.label}
            </button>
          ))}
        </div>
        <FilterBar config={config} tasks={tasks} filters={filters} onChange={setFilters} />
      </div>

      {loading ? (
        <Card title="Loading tasks"><TableSkeleton rows={6} cols={5} /></Card>
      ) : view === "list" ? (
        <TaskList tasks={filtered} config={config} asOf={asOf} onOpen={setSelected} />
      ) : view === "board" ? (
        <TaskBoard tasks={filtered} config={config} asOf={asOf} onOpen={setSelected} onChanged={changed} />
      ) : (
        <TaskCalendar tasks={filtered} config={config} summary={summary} onOpen={setSelected} />
      )}

      {selected && (
        <TaskDrawer task={selected} config={config} team={team} asOf={asOf}
                    onClose={() => setSelected(null)} onChanged={changed} />
      )}

      {showNew && (
        <NewTaskModal config={config} team={team}
                      onClose={() => setShowNew(false)}
                      onCreated={() => { setShowNew(false); changed(); }} />
      )}
    </div>
  );
}

function NeedsAttention({
  summary, onPick,
}: {
  summary: TaskSummary;
  onPick: (patch: Partial<TaskFilters>) => void;
}) {
  const chips: { label: string; n: number; tone: string; patch: Partial<TaskFilters> }[] = [
    { label: "Overdue", n: summary.overdue, tone: "bg-signal-bad/10 text-signal-bad border-signal-bad/30", patch: { overdueOnly: true } },
    { label: "Blocked", n: summary.blocked, tone: "bg-signal-warn/10 text-signal-warn border-signal-warn/30", patch: {} },
    { label: "Awaiting approval", n: summary.awaiting_approval, tone: "bg-signal-warn/10 text-signal-warn border-signal-warn/30", patch: { status: "IN_REVIEW" } },
    { label: "Auto-resolved", n: summary.auto_completed, tone: "bg-signal-good/10 text-signal-good border-signal-good/30", patch: { status: "DONE" } },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <button key={c.label} onClick={() => onPick(c.patch)}
                className={`inline-flex items-center gap-2 text-sm px-3 py-1 rounded-full border ${c.tone}`}>
          <span className="font-semibold tabular-nums">{c.n}</span>
          {c.label}
        </button>
      ))}
    </div>
  );
}

function NewTaskModal({
  config, team, onClose, onCreated,
}: {
  config: CloseConfig | null;
  team: TaskAssignee[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [workstream, setWorkstream] = useState(config?.workstreams[0] ?? "");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true); setErr("");
    try {
      await api.createTask({
        task_name: name.trim(), workstream: workstream || null,
        assignee: assignee || null, priority, due_date: due || null,
      });
      onCreated();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" className="bg-ink-800 rounded-xl shadow-depth ring-1 ring-line w-full max-w-lg">
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h3 className="text-base font-semibold text-fg">New close task</h3>
          <button onClick={onClose} aria-label="Close" className="text-fg-muted hover:text-fg p-1 leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <label className="block">
            <span className="text-xs text-fg-muted">Task name</span>
            <input className="mt-1 w-full border border-line rounded-md px-3 py-2 text-sm"
                   value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs text-fg-muted">Workstream</span>
              <div className="mt-1">
                <Select
                  aria-label="Workstream"
                  fullWidth
                  value={workstream}
                  onChange={setWorkstream}
                  placeholder="Select workstream…"
                  options={(config?.workstreams ?? []).map((w) => ({ value: w, label: w }))}
                />
              </div>
            </label>
            <label className="block">
              <span className="text-xs text-fg-muted">Owner</span>
              <div className="mt-1">
                <Select
                  aria-label="Owner"
                  fullWidth
                  value={assignee}
                  onChange={setAssignee}
                  placeholder="Unassigned"
                  options={[
                    { value: "", label: "Unassigned" },
                    ...team.map((m) => ({ value: m.name, label: m.name })),
                  ]}
                />
              </div>
            </label>
            <label className="block">
              <span className="text-xs text-fg-muted">Priority</span>
              <div className="mt-1">
                <Select
                  aria-label="Priority"
                  fullWidth
                  value={priority}
                  onChange={setPriority}
                  options={[
                    { value: "HIGH", label: "High" },
                    { value: "MEDIUM", label: "Medium" },
                    { value: "LOW", label: "Low" },
                  ]}
                />
              </div>
            </label>
            <label className="block">
              <span className="text-xs text-fg-muted">Due date</span>
              <input type="date" className="mt-1 w-full border border-line rounded-md px-3 py-2 text-sm"
                     value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
          </div>
          {err && <div role="alert" className="text-sm text-signal-bad">{err}</div>}
        </div>
        <div className="px-6 py-4 border-t flex justify-end gap-3">
          <Button variant="outline" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create task"}
          </Button>
        </div>
      </div>
    </div>
  );
}
