import { CloseConfig, CloseTask, StatusDef } from "../../api";

// Map a config color token to pill + dot classes (kept small and disciplined).
const COLOR_CLASSES: Record<string, { pill: string; dot: string; soft: string }> = {
  gray: { pill: "bg-black/[0.04] text-fg-muted ring-1 ring-line", dot: "bg-fg-muted", soft: "bg-black/[0.04]" },
  blue: { pill: "bg-blue-500/10 text-blue-600 ring-1 ring-blue-500/25", dot: "bg-blue-500", soft: "bg-blue-500/5" },
  amber: { pill: "bg-signal-warn/10 text-signal-warn ring-1 ring-signal-warn/30", dot: "bg-signal-warn", soft: "bg-signal-warn/5" },
  emerald: { pill: "bg-signal-good/10 text-signal-good ring-1 ring-signal-good/30", dot: "bg-signal-good", soft: "bg-signal-good/5" },
  red: { pill: "bg-signal-bad/10 text-signal-bad ring-1 ring-signal-bad/30", dot: "bg-signal-bad", soft: "bg-signal-bad/5" },
};

export function colorClasses(color: string) {
  return COLOR_CLASSES[color] ?? COLOR_CLASSES.gray;
}

export function statusDef(config: CloseConfig | null, statusId: string): StatusDef {
  const found = config?.statuses.find((s) => s.id === statusId);
  return found ?? { id: statusId, label: statusId, color: "gray", order: 99 };
}

export function orderedStatuses(config: CloseConfig | null): StatusDef[] {
  const list = config?.statuses ?? [];
  return [...list].sort((a, b) => a.order - b.order);
}

export const PRIORITY_META: Record<string, { label: string; dot: string; text: string }> = {
  HIGH: { label: "High", dot: "bg-signal-bad", text: "text-signal-bad" },
  MEDIUM: { label: "Medium", dot: "bg-signal-warn", text: "text-signal-warn" },
  LOW: { label: "Low", dot: "bg-fg-subtle", text: "text-fg-muted" },
};

export function priorityMeta(p: string) {
  return PRIORITY_META[p] ?? PRIORITY_META.MEDIUM;
}

export function initials(name: string | null): string {
  if (!name) return "??";
  return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

export function isOverdue(task: CloseTask, asOf?: string | null): boolean {
  if (task.status === "DONE" || !task.due_date) return false;
  const today = asOf
    ? new Date(asOf.slice(0, 10) + "T00:00:00")
    : new Date(new Date().toDateString());
  return new Date(task.due_date) < today;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const SOURCE_LABEL: Record<string, string> = {
  template: "Checklist", recon: "Reconciliation", dq: "Data quality", manual: "Manual",
};
export function sourceLabel(s: string): string {
  return SOURCE_LABEL[s] ?? s;
}

export function StatusPill({ config, status }: { config: CloseConfig | null; status: string }) {
  const def = statusDef(config, status);
  const c = colorClasses(def.color);
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium ${c.pill}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {def.label}
    </span>
  );
}

export function PriorityTag({ priority }: { priority: string }) {
  const m = priorityMeta(priority);
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${m.text}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

export function Avatar({ name, size = "md" }: { name: string | null; size?: "sm" | "md" }) {
  const dim = size === "sm" ? "w-6 h-6 text-[10px]" : "w-7 h-7 text-xs";
  if (!name) {
    return <span className={`inline-flex items-center justify-center rounded-full bg-black/[0.04] text-fg-subtle font-medium ${dim}`}>—</span>;
  }
  return (
    <span className={`inline-flex items-center justify-center rounded-full bg-gradient-to-br from-accent-400 to-accent-700 text-white font-semibold ${dim}`} title={name}>
      {initials(name)}
    </span>
  );
}

export function OverdueBadge() {
  return (
    <span className="inline-flex items-center text-[11px] font-semibold text-signal-bad bg-signal-bad/10 ring-1 ring-signal-bad/30 px-1.5 py-0.5 rounded">
      Overdue
    </span>
  );
}

export function BlockedBadge({ reason }: { reason?: string | null }) {
  return (
    <span className="inline-flex items-center text-[11px] font-semibold text-signal-warn bg-signal-warn/10 ring-1 ring-signal-warn/30 px-1.5 py-0.5 rounded"
          title={reason || "Blocked"}>
      Blocked
    </span>
  );
}
