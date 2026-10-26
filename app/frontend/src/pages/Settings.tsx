import { useEffect, useRef, useState } from "react";
import { api, CloseConfig, Persona } from "../api";
import { Button, Card, ErrorNote, Section, Select, TableSkeleton } from "../components/ui";
import ApprovalPolicyCard from "../components/ApprovalPolicyCard";
import { useTheme, Theme } from "../lib/theme";
import { useIndustry } from "../lib/industry";
import { getOverlay } from "../lib/industries";
import { useInstalledIndustries } from "../lib/deployment";
import {
  AutosaveMode, AutosaveStatus, createConfigAutosave,
} from "../lib/settingsAutosave";

const COLORS = ["gray", "blue", "amber", "emerald", "red"];

export default function Settings({
  persona, refreshKey, onDataChange,
}: {
  persona: Persona | null;
  refreshKey: number;
  onDataChange: () => void;
}) {
  const [cfg, setCfg] = useState<CloseConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<AutosaveStatus>("idle");
  const onDataChangeRef = useRef(onDataChange);
  onDataChangeRef.current = onDataChange;
  const autosaveRef = useRef<ReturnType<typeof createConfigAutosave<CloseConfig>> | null>(null);
  if (!autosaveRef.current) {
    autosaveRef.current = createConfigAutosave<CloseConfig>({
      debounceMs: 800,
      save: async (data) => {
        await api.saveConfig(data);
        onDataChangeRef.current();
      },
    });
  }

  useEffect(() => {
    let cancelled = false;
    api.closeConfig()
      .then((c) => { if (!cancelled) { setCfg(c); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e?.message || "Couldn’t load configuration."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    const autosave = autosaveRef.current!;
    const unsub = autosave.subscribe(setSaveStatus);
    const flush = () => { void autosave.flush(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsub();
      flush();
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const patch = (p: Partial<CloseConfig>, mode: AutosaveMode = "now") => {
    setCfg((c) => {
      if (!c) return c;
      const next = { ...c, ...p };
      autosaveRef.current?.schedule(next, mode);
      return next;
    });
  };

  if (loading) return <div className="space-y-6"><Card title="Loading"><TableSkeleton rows={5} cols={2} /></Card></div>;
  if (!cfg) return <div className="space-y-6">{error && <ErrorNote message={error} />}</div>;

  return (
    <div className="space-y-6">
      {saveStatus !== "idle" && (
        <div className="fixed bottom-4 right-24 z-30 pointer-events-none">
          <div className="pointer-events-auto text-[11px] rounded-full px-3 py-1.5 ring-1 ring-line bg-ink-900/90 text-fg-muted shadow-sm">
            {saveStatus === "saving" && "Saving…"}
            {saveStatus === "saved" && <span className="text-signal-good">All changes saved</span>}
            {saveStatus === "error" && (
              <span>
                Couldn’t save ·{" "}
                <button type="button" className="underline text-fg" onClick={() => autosaveRef.current?.retry()}>
                  Retry
                </button>
              </span>
            )}
          </div>
        </div>
      )}

      {error && <ErrorNote message={error} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Appearance" className="lg:col-span-2">
          <AppearanceControl />
        </Card>

        <Card title="Industry" className="lg:col-span-2">
          <IndustryControl />
        </Card>

        <Card title="Workstreams">
          <ChipEditor items={cfg.workstreams} onChange={(workstreams) => patch({ workstreams })} placeholder="Add workstream…" />
        </Card>

        <Card title="Reason codes">
          <ChipEditor items={cfg.reason_codes} onChange={(reason_codes) => patch({ reason_codes })} placeholder="Add reason code…" />
        </Card>

        <Card title="Workflow statuses">
          <div className="px-5 py-4 space-y-2">
            {cfg.statuses.sort((a, b) => a.order - b.order).map((s, i) => (
              <div key={s.id} className="flex items-center gap-2">
                <span className="text-xs font-mono text-fg-subtle w-28 truncate">{s.id}</span>
                <input value={s.label}
                       onChange={(e) => {
                         const statuses = [...cfg.statuses];
                         statuses[i] = { ...s, label: e.target.value };
                         patch({ statuses }, "later");
                       }}
                       className="flex-1 border border-line rounded-md px-2.5 py-1.5 text-sm" />
                <Select
                  aria-label="Status color"
                  size="sm"
                  value={s.color}
                  onChange={(color) => {
                    const statuses = [...cfg.statuses];
                    statuses[i] = { ...s, color };
                    patch({ statuses });
                  }}
                  options={COLORS.map((c) => ({ value: c, label: c }))}
                />
              </div>
            ))}
            <p className="text-xs text-fg-subtle pt-1">Statuses appear as Board columns in their order. Renaming is safe; ids stay stable.</p>
          </div>
        </Card>

        <ApprovalPolicyCard persona={persona} refreshKey={refreshKey} onDataChange={onDataChange} />

        <Card title="Automations">
          <div className="px-5 py-4 space-y-2.5">
            {Object.entries(cfg.automations).map(([k, v]) => (
              <label key={k} className="flex items-center justify-between gap-3 text-sm">
                <span className="capitalize text-fg">{k.replace(/_/g, " ")}</span>
                <input type="checkbox" checked={v}
                       onChange={(e) => patch({ automations: { ...cfg.automations, [k]: e.target.checked } })} />
              </label>
            ))}
            <label className="flex items-center justify-between gap-3 text-sm pt-2 border-t">
              <span className="text-fg">Target close (business days after period end)</span>
              <input type="number" value={cfg.target_close_bd} min={0} max={20}
                     onChange={(e) => patch({ target_close_bd: parseInt(e.target.value || "0", 10) }, "later")}
                     className="w-20 border border-line rounded-md px-2 py-1 text-sm" />
            </label>
          </div>
        </Card>

        <Section title="Team" className="lg:col-span-2" defaultOpen={false} count={cfg.team.length || undefined}>
          <div className="px-5 py-4 space-y-2">
            {cfg.team.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={m.name} placeholder="Name"
                       onChange={(e) => { const team = [...cfg.team]; team[i] = { ...m, name: e.target.value }; patch({ team }, "later"); }}
                       className="flex-1 border border-line rounded-md px-2.5 py-1.5 text-sm" />
                <input value={m.role} placeholder="Role"
                       onChange={(e) => { const team = [...cfg.team]; team[i] = { ...m, role: e.target.value }; patch({ team }, "later"); }}
                       className="flex-1 border border-line rounded-md px-2.5 py-1.5 text-sm" />
                <button onClick={() => patch({ team: cfg.team.filter((_, j) => j !== i) })}
                        className="text-fg-subtle hover:text-signal-bad px-2" aria-label="Remove member">✕</button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => patch({ team: [...cfg.team, { name: "", role: "" }] })}>
              + Add team member
            </Button>
          </div>
        </Section>

        <Section title="Task templates" className="lg:col-span-2"
                 defaultOpen={false} count={cfg.task_templates.length || undefined}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-fg-muted text-left">
                <tr className="border-b">
                  <th className="px-5 py-2.5 font-medium">Task</th>
                  <th className="px-5 py-2.5 font-medium">Workstream</th>
                  <th className="px-5 py-2.5 font-medium">Owner</th>
                  <th className="px-5 py-2.5 font-medium">Priority</th>
                  <th className="px-5 py-2.5 font-medium text-right">Due (BD)</th>
                  <th className="px-5 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {cfg.task_templates.map((t, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-5 py-2">
                      <input value={t.name}
                             onChange={(e) => { const a = [...cfg.task_templates]; a[i] = { ...t, name: e.target.value }; patch({ task_templates: a }, "later"); }}
                             className="w-full border border-line rounded px-2 py-1 text-sm" />
                    </td>
                    <td className="px-5 py-2">
                      <Select
                        aria-label="Template workstream"
                        size="sm"
                        value={t.workstream}
                        onChange={(workstream) => { const a = [...cfg.task_templates]; a[i] = { ...t, workstream }; patch({ task_templates: a }); }}
                        options={cfg.workstreams.map((w) => ({ value: w, label: w }))}
                      />
                    </td>
                    <td className="px-5 py-2">
                      <Select
                        aria-label="Template owner"
                        size="sm"
                        value={t.owner}
                        onChange={(owner) => { const a = [...cfg.task_templates]; a[i] = { ...t, owner }; patch({ task_templates: a }); }}
                        options={cfg.team.map((m) => ({ value: m.name, label: m.name }))}
                      />
                    </td>
                    <td className="px-5 py-2">
                      <Select
                        aria-label="Template priority"
                        size="sm"
                        value={t.priority}
                        onChange={(priority) => { const a = [...cfg.task_templates]; a[i] = { ...t, priority }; patch({ task_templates: a }); }}
                        options={[
                          { value: "HIGH", label: "High" },
                          { value: "MEDIUM", label: "Medium" },
                          { value: "LOW", label: "Low" },
                        ]}
                      />
                    </td>
                    <td className="px-5 py-2 text-right">
                      <input type="number" value={t.due_offset_bd}
                             onChange={(e) => { const a = [...cfg.task_templates]; a[i] = { ...t, due_offset_bd: parseInt(e.target.value || "0", 10) }; patch({ task_templates: a }, "later"); }}
                             className="w-16 border border-line rounded px-2 py-1 text-sm text-right" />
                    </td>
                    <td className="px-5 py-2 text-right">
                      <button onClick={() => patch({ task_templates: cfg.task_templates.filter((_, j) => j !== i) })}
                              className="text-fg-subtle hover:text-signal-bad px-2" aria-label="Remove template">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-5 py-3">
              <Button variant="outline" size="sm"
                      onClick={() => patch({ task_templates: [...cfg.task_templates, {
                        name: "New task", workstream: cfg.workstreams[0] ?? "", owner: cfg.team[0]?.name ?? "",
                        priority: "MEDIUM", due_offset_bd: 1, seed_status: "NOT_STARTED" }] })}>
                + Add template
              </Button>
            </div>
          </div>
          <p className="px-5 pb-4 text-xs text-fg-subtle">
            Editing templates affects future periods and any not-yet-seeded tasks. Existing tasks for this period are unchanged.
          </p>
        </Section>
      </div>
    </div>
  );
}

function AppearanceControl() {
  const [theme, setTheme] = useTheme();
  const select = (t: Theme) => setTheme(t);
  const options: { id: Theme; label: string; icon: string }[] = [
    { id: "light", label: "Light", icon: "☀" },
    { id: "dark", label: "Dark", icon: "☾" },
  ];
  return (
    <div className="px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
      <div>
        <div className="text-sm font-medium text-fg">Theme</div>
        <p className="text-xs text-fg-subtle mt-0.5">
          Applies instantly and is remembered on this device.
        </p>
      </div>
      <div className="inline-flex items-center gap-0.5 rounded-lg bg-black/[0.05] p-0.5" role="radiogroup" aria-label="Theme">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={theme === o.id}
            onClick={() => select(o.id)}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-sm font-medium transition ${
              theme === o.id ? "bg-ink-800 text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg"
            }`}
          >
            <span aria-hidden="true">{o.icon}</span>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function IndustryControl() {
  const { industry, setIndustry } = useIndustry();
  const installed = useInstalledIndustries();
  return (
    <div className="px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
      <div>
        <div className="text-sm font-medium text-fg">Vertical</div>
        <p className="text-xs text-fg-subtle mt-0.5">
          Re-skins the whole app — labels, KPIs, and data — for the selected industry.
        </p>
      </div>
      <div className="inline-flex items-center gap-0.5 rounded-lg bg-black/[0.05] p-0.5 flex-wrap" role="radiogroup" aria-label="Industry">
        {installed.map((id) => {
          const active = id === industry;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setIndustry(id)}
              className={`px-3.5 py-1.5 rounded-md text-sm font-medium transition ${
                active ? "bg-ink-800 text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg"
              }`}
            >
              {getOverlay(id).label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChipEditor({
  items, onChange, placeholder,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
}) {
  const [val, setVal] = useState("");
  const add = () => {
    const v = val.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    setVal("");
  };
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap gap-2 mb-3">
        {items.map((it) => (
          <span key={it} className="inline-flex items-center gap-1.5 text-sm bg-black/[0.06] rounded-full px-3 py-1">
            {it}
            <button onClick={() => onChange(items.filter((x) => x !== it))}
                    className="text-fg-subtle hover:text-signal-bad" aria-label={`Remove ${it}`}>✕</button>
          </span>
        ))}
        {items.length === 0 && <span className="text-sm text-fg-subtle">None yet.</span>}
      </div>
      <div className="flex gap-2">
        <input value={val} onChange={(e) => setVal(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") add(); }}
               placeholder={placeholder}
               className="flex-1 border border-line rounded-md px-3 py-1.5 text-sm" />
        <Button variant="outline" size="sm" onClick={add}>Add</Button>
      </div>
    </div>
  );
}
