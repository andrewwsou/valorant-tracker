export type IdleAction = { afterMs: number; run: () => void };

export type Activity = {
  /** A tool call started. Idle clocks stop until every running call ends. */
  begin(): void;
  /** A tool call finished. Once none are running, the idle clocks restart. */
  end(): void;
  /** Cancels every pending idle action, for shutdown. */
  stop(): void;
};

/**
 * Runs each action once the server has gone `afterMs` without a tool call.
 * The clocks start right away, so a server that's never used still idles out.
 *
 * Timers are unref'd: they never keep the process alive on their own.
 */
export function trackActivity(actions: IdleAction[]): Activity {
  let running = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];

  const disarm = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  const arm = () => {
    disarm();
    timers = actions.map((action) => setTimeout(action.run, action.afterMs).unref());
  };

  arm();
  return {
    begin() {
      running++;
      disarm();
    },
    end() {
      running = Math.max(0, running - 1);
      if (running === 0) arm();
    },
    stop: disarm,
  };
}
