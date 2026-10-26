import { CloseConfig, CloseTask } from "../../api";
import { Select, SelectOption } from "../ui";

export interface TaskFilters {
  search: string;
  status: string;       // "" = all
  owner: string;        // "" = all
  workstream: string;   // "" = all
  entity: string;       // "" = all
  overdueOnly: boolean;
}

export const EMPTY_FILTERS: TaskFilters = {
  search: "", status: "", owner: "", workstream: "", entity: "", overdueOnly: false,
};

export default function FilterBar({
  config, tasks, filters, onChange,
}: {
  config: CloseConfig | null;
  tasks: CloseTask[];
  filters: TaskFilters;
  onChange: (f: TaskFilters) => void;
}) {
  const owners = Array.from(new Set(tasks.map((t) => t.assignee).filter(Boolean) as string[])).sort();
  const workstreams = config?.workstreams
    ?? Array.from(new Set(tasks.map((t) => t.workstream).filter(Boolean) as string[]));
  const entities = Array.from(new Set(tasks.map((t) => t.business_unit_id).filter(Boolean) as string[])).sort();
  const set = (patch: Partial<TaskFilters>) => onChange({ ...filters, ...patch });
  const active = filters.status || filters.owner || filters.workstream || filters.entity ||
    filters.overdueOnly || filters.search;

  const statusOpts: SelectOption[] = [
    { value: "", label: "All statuses" },
    ...(config?.statuses ?? []).map((s) => ({ value: s.id, label: s.label })),
  ];
  const ownerOpts: SelectOption[] = [
    { value: "", label: "All owners" },
    ...owners.map((o) => ({ value: o, label: o })),
    { value: "__unassigned", label: "Unassigned" },
  ];
  const workstreamOpts: SelectOption[] = [
    { value: "", label: "All workstreams" },
    ...workstreams.map((w) => ({ value: w, label: w })),
  ];
  const entityOpts: SelectOption[] = [
    { value: "", label: "All entities" },
    ...entities.map((e) => ({ value: e, label: e })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={filters.search}
        onChange={(e) => set({ search: e.target.value })}
        placeholder="Search tasks…"
        aria-label="Search tasks"
        className="border border-line rounded-md px-3 py-1.5 text-sm w-44"
      />
      <Select aria-label="Filter by status" size="sm" value={filters.status}
              options={statusOpts} onChange={(v) => set({ status: v })} />
      <label className="flex items-center gap-1.5 text-sm text-fg px-1 cursor-pointer">
        <input type="checkbox" checked={filters.overdueOnly}
               onChange={(e) => set({ overdueOnly: e.target.checked })} />
        Overdue only
      </label>
      <Select aria-label="Filter by owner" size="sm" value={filters.owner}
              options={ownerOpts} onChange={(v) => set({ owner: v })} />
      <Select aria-label="Filter by workstream" size="sm" value={filters.workstream}
              options={workstreamOpts} onChange={(v) => set({ workstream: v })} />
      {entities.length > 0 && (
        <Select aria-label="Filter by entity" size="sm" value={filters.entity}
                options={entityOpts} onChange={(v) => set({ entity: v })} />
      )}
      {active && (
        <button onClick={() => onChange(EMPTY_FILTERS)}
                className="text-xs text-fg-muted hover:text-fg underline underline-offset-2">
          Clear
        </button>
      )}
    </div>
  );
}
