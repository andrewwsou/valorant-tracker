import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackActivity } from "@/mcp/activity";

describe("trackActivity", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const release = vi.fn();
    const exit = vi.fn();
    const activity = trackActivity([
      { afterMs: 1_000, run: release },
      { afterMs: 5_000, run: exit },
    ]);
    return { activity, release, exit };
  }

  it("runs each action once the server has idled that long, even if it was never used", () => {
    const { release, exit } = setup();
    vi.advanceTimersByTime(999);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(4_000);
    expect(exit).toHaveBeenCalledOnce();
  });

  it("holds the clocks while a call runs and restarts them in full when it ends", () => {
    const { activity, release, exit } = setup();
    vi.advanceTimersByTime(900);
    activity.begin();
    vi.advanceTimersByTime(60_000);
    expect(release).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    activity.end();
    vi.advanceTimersByTime(999);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_001);
    expect(release).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("waits for the last of several overlapping calls", () => {
    const { activity, exit } = setup();
    activity.begin();
    activity.begin();
    activity.end();
    vi.advanceTimersByTime(10_000);
    expect(exit).not.toHaveBeenCalled();

    activity.end();
    vi.advanceTimersByTime(5_000);
    expect(exit).toHaveBeenCalledOnce();
  });

  it("cancels everything on stop", () => {
    const { activity, release, exit } = setup();
    activity.stop();
    vi.advanceTimersByTime(60_000);
    expect(release).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
