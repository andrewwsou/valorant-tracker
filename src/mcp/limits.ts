/**
 * Hard ceilings for the MCP server. They bound how much work it does and how
 * much text it hands back to the AI client, so a misbehaving agent loop can't
 * make it do unbounded work or flood the client's context.
 *
 * Each one can be lowered with an environment variable, never raised.
 */
export const HARD_LIMITS = {
  /** Tool calls allowed in any 60-second window. */
  callsPerMinute: 30,
  /** Tool calls allowed for the life of one server process. */
  callsPerSession: 300,
  /** Largest tool result, as UTF-8 bytes of JSON (about 4k tokens). */
  resultBytes: 16_384,
  /** Largest message the client may send. A bigger one ends the session. */
  messageBytes: 65_536,
  /** Longest a tool's database work may take, including waiting for a connection. */
  queryTimeoutMs: 5_000,
  /** Database connections close after this long without a tool call. */
  idleReleaseMs: 60_000,
  /** The server exits after this long without a tool call. */
  idleExitMs: 10 * 60_000,
} as const;

export type Limits = { -readonly [K in keyof typeof HARD_LIMITS]: number };

const ENV_NAMES: Record<keyof Limits, string> = {
  callsPerMinute: "MCP_CALLS_PER_MINUTE",
  callsPerSession: "MCP_CALLS_PER_SESSION",
  resultBytes: "MCP_RESULT_BYTES",
  messageBytes: "MCP_MESSAGE_BYTES",
  queryTimeoutMs: "MCP_QUERY_TIMEOUT_MS",
  idleReleaseMs: "MCP_IDLE_RELEASE_MS",
  idleExitMs: "MCP_IDLE_EXIT_MS",
};

/** The limits to run with. An environment value only counts when it's a whole number below the ceiling. */
export function readLimits(env: Record<string, string | undefined> = process.env): Limits {
  const limits = { ...HARD_LIMITS } as Limits;
  for (const key of Object.keys(HARD_LIMITS) as (keyof Limits)[]) {
    const raw = env[ENV_NAMES[key]];
    const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (value > 0 && value < HARD_LIMITS[key]) limits[key] = value;
  }
  return limits;
}

const WINDOW_MS = 60_000;

/** Counts tool calls against the per-minute and per-session caps. */
export class CallBudget {
  private recent: number[] = [];
  private total = 0;

  constructor(
    private readonly limits: Pick<Limits, "callsPerMinute" | "callsPerSession">,
    private readonly now: () => number = Date.now,
  ) {}

  /** Uses up one call, or returns why the call is refused. Refused calls don't count. */
  take(): string | null {
    if (this.total >= this.limits.callsPerSession) {
      return `Call limit reached: this server answers at most ${this.limits.callsPerSession} tool calls per session. Stop calling StatTrack tools; the user can restart the server to reset the limit.`;
    }
    const now = this.now();
    this.recent = this.recent.filter((at) => now - at < WINDOW_MS);
    if (this.recent.length >= this.limits.callsPerMinute) {
      return `Rate limit reached: at most ${this.limits.callsPerMinute} tool calls per minute. Wait a minute before calling StatTrack tools again.`;
    }
    this.recent.push(now);
    this.total++;
    return null;
  }
}
