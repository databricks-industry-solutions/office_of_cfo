import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { CloseStatus, TaskSummary } from "../api";
import { PageId } from "../nav";

interface Notice {
  id: string;
  text: string;
  tone: "fail" | "warn" | "ok" | "neutral";
  query?: string;
}

function buildNotices(summary: TaskSummary | null): Notice[] {
  if (!summary) return [];
  const out: Notice[] = [];
  if (summary.overdue > 0)
    out.push({ id: "overdue", tone: "fail", query: "view=list&overdue=1",
      text: `${summary.overdue} task${summary.overdue > 1 ? "s are" : " is"} overdue` });
  if (summary.blocked > 0)
    out.push({ id: "blocked", tone: "warn", query: "view=board",
      text: `${summary.blocked} task${summary.blocked > 1 ? "s" : ""} blocked` });
  if (summary.awaiting_approval > 0)
    out.push({ id: "review", tone: "warn", query: "view=list",
      text: `${summary.awaiting_approval} awaiting approval` });
  if (summary.auto_completed > 0)
    out.push({ id: "auto", tone: "ok", query: "view=list",
      text: `${summary.auto_completed} task${summary.auto_completed > 1 ? "s" : ""} auto-resolved from the data` });
  out.push({ id: "target", tone: "neutral", query: "view=calendar",
    text: summary.days_to_close >= 0
      ? `Close target in ${summary.days_to_close} day${summary.days_to_close === 1 ? "" : "s"}`
      : `Close target passed ${-summary.days_to_close} day${summary.days_to_close === -1 ? "" : "s"} ago` });
  return out;
}

const TONE_DOT: Record<Notice["tone"], string> = {
  fail: "bg-signal-bad", warn: "bg-signal-warn", ok: "bg-signal-good", neutral: "bg-fg-subtle",
};

// Close-notifications bell + dropdown. Lives in the top utility strip.
export default function NotificationsBell({
  status, summary, onNavigate,
}: {
  status: CloseStatus | null;
  summary: TaskSummary | null;
  onNavigate: (p: PageId, query?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const notices = buildNotices(summary);
  const urgent = (summary?.overdue ?? 0) + (summary?.awaiting_approval ?? 0);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label="Notifications"
              className="relative p-2 rounded-lg hover:bg-black/[0.04] transition text-fg-muted ring-1 ring-line">
        <Bell className="w-[18px] h-[18px]" />
        {urgent > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-accent text-white text-[10px] font-semibold flex items-center justify-center">
            {urgent}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-ink-800 rounded-xl shadow-depth ring-1 ring-line z-40">
          <div className="px-4 py-2.5 border-b border-line text-sm font-semibold text-fg">Close notifications</div>
          <div className="px-4 py-2.5 border-b border-line grid grid-cols-3 gap-2 text-center">
            <div>
              <div className={`text-lg font-bold num ${(status?.open_recon_breaks ?? 0) > 0 ? "text-signal-warn" : "text-signal-good"}`}>{status?.open_recon_breaks ?? 0}</div>
              <div className="text-[10px] uppercase tracking-wide text-fg-subtle">Variances</div>
            </div>
            <div>
              <div className={`text-lg font-bold num ${(status?.fail_count ?? 0) > 0 ? "text-signal-bad" : "text-signal-good"}`}>{status?.fail_count ?? 0}</div>
              <div className="text-[10px] uppercase tracking-wide text-fg-subtle">Failing</div>
            </div>
            <div>
              <div className="text-lg font-bold num text-fg">{summary ? `${summary.pct_complete}%` : "—"}</div>
              <div className="text-[10px] uppercase tracking-wide text-fg-subtle">Tasks</div>
            </div>
          </div>
          <ul className="max-h-80 overflow-y-auto divide-y divide-line">
            {notices.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-fg-subtle">You’re all caught up.</li>
            )}
            {notices.map((n) => (
              <li key={n.id}>
                <button onClick={() => { setOpen(false); onNavigate("tasks", n.query); }}
                        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left hover:bg-black/[0.04] transition">
                  <span className={`inline-block w-2 h-2 rounded-full ${TONE_DOT[n.tone]}`} />
                  <span className="text-sm text-fg-muted">{n.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
