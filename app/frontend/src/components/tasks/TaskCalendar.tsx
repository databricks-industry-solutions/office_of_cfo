import { useState } from "react";
import { CloseConfig, CloseTask, TaskSummary } from "../../api";
import { colorClasses, isOverdue, statusDef } from "./taskUi";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// Parse a date-only ISO string ("YYYY-MM-DD") at local midnight so it lands on
// the intended calendar day regardless of timezone.
function parseDay(iso: string): Date {
  return new Date(iso + "T00:00:00");
}

function initialMonth(tasks: CloseTask[], asOf?: string | null): Date {
  const due = tasks.map((t) => t.due_date).filter(Boolean) as string[];
  if (due.length) {
    due.sort();
    return monthStart(new Date(due[Math.floor(due.length / 2)]));
  }
  if (asOf) return monthStart(parseDay(asOf));
  return monthStart(new Date());
}

export default function TaskCalendar({
  tasks, config, summary, onOpen,
}: {
  tasks: CloseTask[];
  config: CloseConfig | null;
  summary: TaskSummary | null;
  onOpen: (t: CloseTask) => void;
}) {
  const asOf = summary?.today ?? null;
  const [month, setMonth] = useState<Date>(() => initialMonth(tasks, asOf));

  const first = monthStart(month);
  const startDay = first.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const todayStr = asOf
    ? parseDay(asOf).toDateString()
    : new Date().toDateString();

  // Target close date — the same date the Executive KPIs, burn-down and
  // notifications use — surfaced on the calendar as a dedicated marker.
  const target = summary?.target_close_date ? parseDay(summary.target_close_date) : null;
  const targetDay = target
    && target.getFullYear() === month.getFullYear()
    && target.getMonth() === month.getMonth()
    ? target.getDate() : null;
  const targetLabel = target
    ? target.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;

  const byDay = new Map<string, CloseTask[]>();
  for (const t of tasks) {
    if (!t.due_date) continue;
    const d = new Date(t.due_date);
    if (d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth()) {
      const key = String(d.getDate());
      let bucket = byDay.get(key);
      if (!bucket) { bucket = []; byDay.set(key, bucket); }
      bucket.push(t);
    }
  }

  const cells: (number | null)[] = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const monthLabel = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const shift = (delta: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));

  return (
    <div className="bg-ink-800 rounded-xl shadow-sm">
      <div className="px-5 py-3 border-b flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="text-sm font-semibold">{monthLabel}</div>
          {target && targetLabel && (
            <button
              onClick={() => setMonth(monthStart(target))}
              title={`Target close date · ${targetLabel}`}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full
                         bg-signal-bad/10 text-signal-bad ring-1 ring-signal-bad/30 hover:bg-signal-bad/15">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-signal-bad" />
              Target close · {targetLabel}
              {typeof summary?.days_to_close === "number" && (
                <span className="text-signal-bad/70">
                  ({summary.days_to_close >= 0
                    ? `in ${summary.days_to_close}d`
                    : `${-summary.days_to_close}d ago`})
                </span>
              )}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => shift(-1)} aria-label="Previous month"
                  className="px-2 py-1 text-sm border border-line rounded-md hover:bg-black/[0.04]">‹</button>
          <button onClick={() => setMonth(initialMonth(tasks, asOf))}
                  className="px-2 py-1 text-xs border border-line rounded-md hover:bg-black/[0.04]">Today</button>
          <button onClick={() => shift(1)} aria-label="Next month"
                  className="px-2 py-1 text-sm border border-line rounded-md hover:bg-black/[0.04]">›</button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-[11px] uppercase tracking-wide text-fg-subtle border-b">
        {WEEKDAYS.map((w) => <div key={w} className="px-2 py-1.5 text-center">{w}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          if (day === null) return <div key={i} className="min-h-[150px] border-b border-r bg-black/[0.04]/40" />;
          const date = new Date(month.getFullYear(), month.getMonth(), day);
          const isToday = date.toDateString() === todayStr;
          const isTarget = day === targetDay;
          const items = byDay.get(String(day)) ?? [];
          return (
            <div key={i} className={`min-h-[150px] border-b border-r p-1.5 align-top relative ${
              isTarget ? "bg-signal-bad/[0.06] ring-1 ring-inset ring-signal-bad/40" : ""}`}>
              <div className="flex items-center justify-between mb-1">
                <div className={`text-xs inline-flex items-center justify-center w-5 h-5 rounded-full ${
                  isToday ? "bg-accent text-white font-semibold" : "text-fg-muted"}`}>{day}</div>
                {isTarget && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-signal-bad"
                        title="Target close date">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-signal-bad" />
                    Target close
                  </span>
                )}
              </div>
              <div className="space-y-1">
                {items.slice(0, 5).map((t) => {
                  const overdue = isOverdue(t, asOf);
                  const c = colorClasses(overdue ? "red" : statusDef(config, t.status).color);
                  return (
                    <button key={t.task_id} onClick={() => onOpen(t)}
                            title={t.task_name}
                            className={`w-full text-left text-[11px] px-1.5 py-0.5 rounded truncate ${c.pill}`}>
                      {t.task_name}
                    </button>
                  );
                })}
                {items.length > 5 && (
                  <div className="text-[11px] text-fg-subtle px-1">+{items.length - 5} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
