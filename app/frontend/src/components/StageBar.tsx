export type StageState = "done" | "active" | "pending" | "error";

// A stage as a single large square: solid green once the stage is done, an
// animated accent pulse while it's active, a faint outline when queued. Shared by
// the IDP extraction stepper and the company-search progress stepper.
export function StageBar({ label, note, state }: {
  label: string; note: string; state: StageState;
}) {
  const statusText = state === "done" ? "done"
    : state === "active" ? "working"
    : state === "error" ? "failed" : "queued";
  const statusTone = state === "done" ? "text-signal-good"
    : state === "active" ? "text-accent-400 dark:text-fg"
    : state === "error" ? "text-signal-bad" : "text-fg-subtle";
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <span className={`text-sm font-medium truncate ${state === "pending" ? "text-fg-subtle" : "text-fg"}`}>
          {label}
        </span>
        <span className={`text-[10px] uppercase tracking-wide shrink-0 ${statusTone}`}>{statusText}</span>
      </div>
      <div
        className={`h-16 w-full rounded-lg transition-all duration-300 ${
          state === "done" ? "bg-signal-good"
            : state === "error" ? "bg-signal-bad/40"
            : state === "active" ? "bg-accent animate-pulse"
            : "bg-black/[0.04] ring-1 ring-inset ring-line"
        }`}
      />
      <div className="text-[11px] text-fg-subtle mt-1 truncate">{note}</div>
    </div>
  );
}
