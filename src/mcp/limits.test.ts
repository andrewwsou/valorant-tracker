import { describe, expect, it } from "vitest";
import { CallBudget, HARD_LIMITS, readLimits } from "@/mcp/limits";

describe("readLimits", () => {
  it("uses the hard limits when nothing is set", () => {
    expect(readLimits({})).toEqual(HARD_LIMITS);
  });

  it("lets the environment lower a limit", () => {
    expect(readLimits({ MCP_CALLS_PER_MINUTE: "5", MCP_IDLE_EXIT_MS: "1500" })).toMatchObject({
      callsPerMinute: 5,
      idleExitMs: 1500,
      callsPerSession: HARD_LIMITS.callsPerSession,
    });
  });

  it("never lets the environment raise a limit", () => {
    const limits = readLimits({
      MCP_CALLS_PER_MINUTE: "1000",
      MCP_CALLS_PER_SESSION: "999999",
      MCP_RESULT_BYTES: "10000000",
      MCP_MESSAGE_BYTES: "10000000",
      MCP_QUERY_TIMEOUT_MS: "600000",
      MCP_IDLE_RELEASE_MS: "86400000",
      MCP_IDLE_EXIT_MS: "86400000",
    });
    expect(limits).toEqual(HARD_LIMITS);
  });

  it("ignores values that aren't positive whole numbers", () => {
    for (const junk of ["", "0", "-5", "1.5", "5x", "abc", " 5"]) {
      expect(readLimits({ MCP_CALLS_PER_MINUTE: junk }).callsPerMinute).toBe(HARD_LIMITS.callsPerMinute);
    }
  });
});

describe("CallBudget", () => {
  /** A budget on a clock the test controls. */
  function budget(callsPerMinute: number, callsPerSession: number) {
    let now = 0;
    const b = new CallBudget({ callsPerMinute, callsPerSession }, () => now);
    return { take: () => b.take(), advance: (ms: number) => (now += ms) };
  }

  it("allows calls up to the per-minute limit, then refuses until the window passes", () => {
    const b = budget(3, 100);
    expect([b.take(), b.take(), b.take()]).toEqual([null, null, null]);
    expect(b.take()).toMatch(/at most 3 tool calls per minute/);

    b.advance(59_999);
    expect(b.take()).not.toBeNull();
    b.advance(1);
    expect(b.take()).toBeNull();
  });

  it("refuses every call once the session total is used up, however long it waits", () => {
    const b = budget(100, 2);
    expect([b.take(), b.take()]).toEqual([null, null]);
    b.advance(24 * 60 * 60_000);
    expect(b.take()).toMatch(/at most 2 tool calls per session/);
  });

  it("doesn't count refused calls", () => {
    const b = budget(1, 2);
    expect(b.take()).toBeNull();
    for (let i = 0; i < 10; i++) expect(b.take()).not.toBeNull();
    b.advance(60_000);
    // Only one call was ever accepted, so one of the two per session is left.
    expect(b.take()).toBeNull();
  });
});
