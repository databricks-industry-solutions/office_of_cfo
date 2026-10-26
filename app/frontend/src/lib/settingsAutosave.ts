export type AutosaveStatus = "idle" | "saving" | "saved" | "error";
export type AutosaveMode = "now" | "later";

export function createConfigAutosave<T>(opts: {
  save: (value: T) => Promise<void>;
  debounceMs?: number;
}) {
  const debounceMs = opts.debounceMs ?? 800;
  let pending: T | undefined;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(status: AutosaveStatus) => void>();
  let status: AutosaveStatus = "idle";

  const emit = (next: AutosaveStatus) => {
    status = next;
    listeners.forEach((listener) => listener(next));
  };

  const clearTimer = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = async () => {
    clearTimer();
    if (inFlight || pending === undefined) return;
    const snapshot = pending;
    pending = undefined;
    inFlight = true;
    emit("saving");
    try {
      await opts.save(snapshot);
      inFlight = false;
      if (pending !== undefined) {
        if (timer) return;
        await flush();
        return;
      }
      emit("saved");
    } catch {
      inFlight = false;
      if (pending === undefined) pending = snapshot;
      emit("error");
    }
  };

  return {
    schedule(value: T, mode: AutosaveMode) {
      pending = value;
      if (mode === "later") {
        clearTimer();
        timer = setTimeout(() => { void flush(); }, debounceMs);
        return;
      }
      void flush();
    },
    flush,
    retry() { void flush(); },
    subscribe(listener: (status: AutosaveStatus) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get status() { return status; },
    dispose() {
      clearTimer();
      listeners.clear();
    },
  };
}
