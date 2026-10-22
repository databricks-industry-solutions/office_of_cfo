import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigAutosave } from "./settingsAutosave";

afterEach(() => {
  vi.useRealTimers();
});

function makeSaver() {
  const calls: string[] = [];
  let failNext = false;
  const save = vi.fn(async (value: string) => {
    if (failNext) {
      failNext = false;
      throw new Error("write failed");
    }
    calls.push(value);
  });
  return {
    save,
    calls,
    failOnce() { failNext = true; },
  };
}

describe("createConfigAutosave", () => {
  it("does not persist debounced edits until the quiet period elapses", async () => {
    vi.useFakeTimers();
    const saver = makeSaver();
    const auto = createConfigAutosave({ save: saver.save, debounceMs: 800 });

    auto.schedule("a", "later");
    auto.schedule("ab", "later");
    await vi.advanceTimersByTimeAsync(799);
    expect(saver.save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(saver.calls).toEqual(["ab"]);
  });

  it("persists immediate edits without waiting for the debounce", async () => {
    vi.useFakeTimers();
    const saver = makeSaver();
    const auto = createConfigAutosave({ save: saver.save, debounceMs: 800 });

    auto.schedule("now", "now");
    await Promise.resolve();
    expect(saver.calls).toEqual(["now"]);
  });

  it("writes the latest value after an in-flight save instead of dropping it", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    let n = 0;
    const save = vi.fn(async (value: string) => {
      n += 1;
      if (n === 1) await first;
      order.push(value);
    });
    const auto = createConfigAutosave({ save, debounceMs: 800 });

    auto.schedule("one", "now");
    await Promise.resolve();
    auto.schedule("two", "now");
    release();
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["one", "two"]);
  });

  it("keeps the latest draft after a failed save and retries that draft", async () => {
    const saver = makeSaver();
    const statuses: string[] = [];
    const auto = createConfigAutosave({ save: saver.save, debounceMs: 800 });
    auto.subscribe((status) => statuses.push(status));
    saver.failOnce();

    auto.schedule("draft", "now");
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses).toContain("error");
    expect(saver.calls).toEqual([]);

    auto.retry();
    await Promise.resolve();
    await Promise.resolve();
    expect(saver.calls).toEqual(["draft"]);
    expect(statuses.at(-1)).toBe("saved");
  });

  it("notifies saved only after the queue is empty", async () => {
    vi.useFakeTimers();
    const saver = makeSaver();
    const statuses: string[] = [];
    const auto = createConfigAutosave({ save: saver.save, debounceMs: 800 });
    auto.subscribe((status) => statuses.push(status));

    auto.schedule("x", "later");
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();
    expect(statuses.filter((s) => s === "saving")).toHaveLength(1);
    expect(statuses.at(-1)).toBe("saved");
  });
});
