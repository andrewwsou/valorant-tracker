import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ getUntil: vi.fn(), extendUntil: vi.fn() }));

import {
  admitCall,
  backoffMs,
  clampCooldownMs,
  currentCooldown,
  LIMITS,
  localCooldown,
  noteRemaining,
  noteResult,
  parseResetMs,
  parseRetryAfterMs,
  readRateLimit,
  releaseProbe,
  resetLimitsForTests,
  retryAllowed,
  startCooldown,
} from "@/lib/henrik-limits";
import { extendUntil, getUntil } from "@/lib/redis";

const NOW = Date.parse("2026-10-04T12:00:00Z");

beforeEach(() => {
  resetLimitsForTests();
  vi.mocked(getUntil).mockResolvedValue([null, null]);
  vi.mocked(extendUntil).mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("parseRetryAfterMs", () => {
  it("reads whole seconds", () => {
    expect(parseRetryAfterMs("120", NOW)).toBe(120_000);
    expect(parseRetryAfterMs(" 7 ", NOW)).toBe(7_000);
    expect(parseRetryAfterMs("0", NOW)).toBe(0);
  });

  it("rejects anything that isn't seconds or an HTTP date", () => {
    for (const junk of ["1.5", "-3", "", "abc", "2026-10-04T12:00:30Z"]) {
      expect(parseRetryAfterMs(junk, NOW), junk).toBeNull();
    }
    expect(parseRetryAfterMs(null, NOW)).toBeNull();
  });

  it("reads all three HTTP date formats as UTC", () => {
    expect(parseRetryAfterMs("Sun, 04 Oct 2026 12:00:30 GMT", NOW)).toBe(30_000);
    expect(parseRetryAfterMs("Sunday, 04-Oct-26 12:00:30 GMT", NOW)).toBe(30_000);
    expect(parseRetryAfterMs("Sun Oct  4 12:00:30 2026", NOW)).toBe(30_000);
  });

  it("measures a date against the response's Date header, so clock skew doesn't matter", () => {
    const localClockTwoMinutesAhead = NOW + 120_000;
    expect(parseRetryAfterMs("Sun, 04 Oct 2026 12:00:30 GMT", localClockTwoMinutesAhead, "Sun, 04 Oct 2026 12:00:00 GMT")).toBe(30_000);
  });

  it("never returns a negative wait for a date in the past", () => {
    expect(parseRetryAfterMs("Sun, 04 Oct 2026 11:59:00 GMT", NOW)).toBe(0);
  });
});

describe("parseResetMs", () => {
  it("reads seconds until the window resets, as HenrikDev documents", () => {
    expect(parseResetMs("42", NOW)).toBe(42_000);
    expect(parseResetMs("12.5", NOW)).toBe(12_500);
  });

  it("tolerates epoch seconds and epoch milliseconds", () => {
    expect(parseResetMs(String(NOW / 1000 + 30), NOW)).toBe(30_000);
    expect(parseResetMs(String(NOW + 30_000), NOW)).toBe(30_000);
  });

  it("ignores junk", () => {
    expect(parseResetMs("x", NOW)).toBeNull();
    expect(parseResetMs(null, NOW)).toBeNull();
  });
});

describe("readRateLimit", () => {
  it("reads the budget headers together", () => {
    const headers = new Headers({ "x-ratelimit-remaining": "3", "x-ratelimit-reset": "40", "retry-after": "20" });
    expect(readRateLimit(headers, NOW)).toEqual({ remaining: 3, resetMs: 40_000, retryAfterMs: 20_000 });
    expect(readRateLimit(new Headers(), NOW)).toEqual({ remaining: null, resetMs: null, retryAfterMs: null });
  });
});

describe("clampCooldownMs and backoffMs", () => {
  it("keeps cooldowns between 1 second and 10 minutes, with a minute when unknown", () => {
    expect(clampCooldownMs(null)).toBe(60_000);
    expect(clampCooldownMs(5)).toBe(1_000);
    expect(clampCooldownMs(10_000_000)).toBe(600_000);
    expect(clampCooldownMs(25_000)).toBe(25_000);
  });

  it("waits a random time up to the backoff ceiling (full jitter)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(backoffMs(0)).toBe(0);
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(backoffMs(0)).toBeLessThan(250);
    expect(backoffMs(5)).toBeLessThan(1_000);
  });
});

describe("cooldowns", () => {
  it("starts a cooldown here and shares it through Redis", async () => {
    await startCooldown("rate_limit", NOW + 20_000, "429");

    expect(localCooldown(NOW)).toEqual({ reason: "rate_limit", untilMs: NOW + 20_000 });
    expect(extendUntil).toHaveBeenCalledWith("henrik:v1:cooldown:rate_limit", NOW + 20_000);
    expect(localCooldown(NOW + 20_000)).toBeNull();
  });

  it("never shortens a cooldown", async () => {
    await startCooldown("rate_limit", NOW + 60_000, "429");
    await startCooldown("rate_limit", NOW + 1_000, "remaining_zero");

    expect(localCooldown(NOW)?.untilMs).toBe(NOW + 60_000);
  });

  it("picks up a cooldown another instance started", async () => {
    vi.mocked(getUntil).mockResolvedValue([NOW + 10_000, null]);

    await expect(currentCooldown(NOW)).resolves.toEqual({ reason: "rate_limit", untilMs: NOW + 10_000 });
    // Remembered locally, so the next check doesn't need Redis.
    vi.mocked(getUntil).mockClear();
    await expect(currentCooldown(NOW + 1)).resolves.toMatchObject({ reason: "rate_limit" });
    expect(getUntil).not.toHaveBeenCalled();
  });

  it("falls back to its own cooldowns when Redis is down, in both directions", async () => {
    vi.mocked(getUntil).mockRejectedValue(new Error("redis down"));
    vi.mocked(extendUntil).mockRejectedValue(new Error("redis down"));

    await expect(currentCooldown(NOW)).resolves.toBeNull();
    await startCooldown("outage", NOW + 5_000, "breaker");
    await expect(currentCooldown(NOW)).resolves.toEqual({ reason: "outage", untilMs: NOW + 5_000 });
  });

  it("reports a rate limit before an outage when both are active", async () => {
    await startCooldown("outage", NOW + 30_000, "breaker");
    await startCooldown("rate_limit", NOW + 5_000, "429");

    expect(localCooldown(NOW)?.reason).toBe("rate_limit");
    expect(localCooldown(NOW + 6_000)?.reason).toBe("outage");
  });
});

describe("retryAllowed", () => {
  it("allows a retry while the budget is healthy or unknown", () => {
    expect(retryAllowed(NOW)).toBe(true);
    noteRemaining(LIMITS.retryMinRemaining, 30_000, NOW);
    expect(retryAllowed(NOW)).toBe(true);
  });

  it("refuses a retry when the budget is nearly spent, until that window resets", () => {
    noteRemaining(3, 30_000, NOW);
    expect(retryAllowed(NOW)).toBe(false);
    expect(retryAllowed(NOW + 30_000)).toBe(true);
  });

  it("refuses a retry during a cooldown", async () => {
    await startCooldown("outage", NOW + 5_000, "retry_after");
    expect(retryAllowed(NOW)).toBe(false);
  });
});

describe("circuit breaker", () => {
  it("opens after 5 failed calls in a row", async () => {
    for (let i = 0; i < 4; i++) await noteResult(true, NOW);
    expect(localCooldown(NOW)).toBeNull();

    await noteResult(true, NOW);
    expect(localCooldown(NOW)).toEqual({ reason: "outage", untilMs: NOW + LIMITS.breakerCooldownMs });
    expect(extendUntil).toHaveBeenCalledWith("henrik:v1:cooldown:outage", NOW + LIMITS.breakerCooldownMs);
  });

  it("starts counting again after any answer below 500", async () => {
    for (let i = 0; i < 4; i++) await noteResult(true, NOW);
    await noteResult(false, NOW);
    for (let i = 0; i < 4; i++) await noteResult(true, NOW);

    expect(localCooldown(NOW)).toBeNull();
  });

  it("allows no retries while tripped, and admits one probe at a time", async () => {
    expect(admitCall()).toBe("call");
    for (let i = 0; i < 5; i++) await noteResult(true, NOW);
    const later = NOW + LIMITS.breakerCooldownMs;

    expect(retryAllowed(later)).toBe(false);
    expect(admitCall()).toBe("probe");
    expect(admitCall()).toBe("wait");
    releaseProbe();
    expect(admitCall()).toBe("probe");
    releaseProbe();

    await noteResult(false, later);
    expect(admitCall()).toBe("call");
    expect(retryAllowed(later)).toBe(true);
  });

  it("reopens on the first failure after the cooldown, while the API stays down", async () => {
    for (let i = 0; i < 5; i++) await noteResult(true, NOW);
    const later = NOW + LIMITS.breakerCooldownMs;

    await noteResult(true, later);
    expect(localCooldown(later)).toEqual({ reason: "outage", untilMs: later + LIMITS.breakerCooldownMs });
  });
});
