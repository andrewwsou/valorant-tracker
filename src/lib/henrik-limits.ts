/**
 * Rate-limit and outage bookkeeping for the HenrikDev client. Nothing here calls
 * the API: it reads response headers, decides whether a retry is affordable, and
 * keeps the cooldowns that stop every app instance from calling upstream while
 * the budget is spent or the API is down.
 *
 * Cooldowns live in Redis so all instances share them, with an in-process copy
 * checked first. If Redis is down, each instance falls back to its own copy.
 */
import { extendUntil, getUntil } from "@/lib/redis";
import { recordCooldownUntil, upstreamCooldowns } from "@/lib/telemetry";

export type CooldownReason = "rate_limit" | "outage";
export type Cooldown = { reason: CooldownReason; untilMs: number };
export type CooldownTrigger = "429" | "remaining_zero" | "retry_after" | "breaker";

export const LIMITS = {
  /** Cooldown when the API says it's rate limited but not for how long. */
  defaultCooldownMs: 60_000,
  minCooldownMs: 1_000,
  maxCooldownMs: 600_000,
  /** A retry costs budget, so it's only allowed while at least this much is left. */
  retryMinRemaining: 10,
  /** Failed calls in a row (5xx, timeouts, network errors) that open the circuit breaker. */
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
  /** While a half-open probe is out, other lookups are told to try again in this long. */
  probeWaitMs: 5_000,
  /** A 503 asking us to wait at least this long pauses every call, not just this one. */
  outageRetryAfterMs: 10_000,
} as const;

const COOLDOWN_KEYS: Record<CooldownReason, string> = {
  rate_limit: "henrik:v1:cooldown:rate_limit",
  outage: "henrik:v1:cooldown:outage",
};

/* ------------------------------------------------------------------------ */
/* Header parsing                                                           */
/* ------------------------------------------------------------------------ */

const IMF_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC850_DATE = /^[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;

/** Epoch ms of an HTTP date in any of the three formats RFC 9110 allows, or NaN. */
function parseHttpDate(value: string): number {
  if (IMF_DATE.test(value) || RFC850_DATE.test(value)) return Date.parse(value);
  // asctime carries no zone; RFC 9110 says it's UTC.
  if (ASCTIME_DATE.test(value)) return Date.parse(`${value} GMT`);
  return NaN;
}

/**
 * Milliseconds to wait from a Retry-After header: whole seconds, or an HTTP
 * date. A date is measured against the response's own Date header when there is
 * one, so a skewed local clock doesn't stretch or shrink the wait.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number, serverDate?: string | null): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d{1,9}$/.test(v)) return Number(v) * 1000;
  // Not Date.parse(v) directly: it accepts things like "1.5" as a date.
  const at = parseHttpDate(v);
  if (Number.isNaN(at)) return null;
  const reference = serverDate ? parseHttpDate(serverDate.trim()) : NaN;
  return Math.max(0, at - (Number.isNaN(reference) ? nowMs : reference));
}

/** Milliseconds until the window resets. HenrikDev sends seconds; epoch values are tolerated too. */
export function parseResetMs(value: string | null, nowMs: number): number | null {
  if (value === null || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  if (n > 1e12) return Math.max(0, n - nowMs); // epoch ms
  if (n > 1e9) return Math.max(0, n * 1000 - nowMs); // epoch seconds
  return n * 1000;
}

export type RateLimitHeaders = { remaining: number | null; resetMs: number | null; retryAfterMs: number | null };

export function readRateLimit(headers: Headers, nowMs: number): RateLimitHeaders {
  const remainingRaw = headers.get("x-ratelimit-remaining");
  const remaining = remainingRaw !== null && /^-?\d+$/.test(remainingRaw.trim()) ? Number(remainingRaw) : null;
  return {
    remaining,
    resetMs: parseResetMs(headers.get("x-ratelimit-reset"), nowMs),
    retryAfterMs: parseRetryAfterMs(headers.get("retry-after"), nowMs, headers.get("date")),
  };
}

/** Keeps a cooldown between 1 second and 10 minutes, with a minute when the length is unknown. */
export function clampCooldownMs(ms: number | null): number {
  if (ms === null || !Number.isFinite(ms)) return LIMITS.defaultCooldownMs;
  return Math.min(LIMITS.maxCooldownMs, Math.max(LIMITS.minCooldownMs, ms));
}

/** Exponential backoff with full jitter: a random wait up to min(cap, base * 2^retry). */
export function backoffMs(retry: number, baseMs = 250, capMs = 1_000): number {
  return Math.random() * Math.min(capMs, baseMs * 2 ** retry);
}

/* ------------------------------------------------------------------------ */
/* Shared state                                                             */
/* ------------------------------------------------------------------------ */

const localUntil: Record<CooldownReason, number> = { rate_limit: 0, outage: 0 };
let lastRemaining: { value: number; validUntilMs: number } | null = null;
let consecutiveFailures = 0;
let probeInFlight = false;

/** This instance's own view of the active cooldown. A rate limit outranks an outage. */
export function localCooldown(nowMs: number): Cooldown | null {
  for (const reason of ["rate_limit", "outage"] as const) {
    if (localUntil[reason] > nowMs) return { reason, untilMs: localUntil[reason] };
  }
  return null;
}

/** The active cooldown, from this instance first, then from Redis. Redis errors count as no cooldown. */
export async function currentCooldown(nowMs: number): Promise<Cooldown | null> {
  const local = localCooldown(nowMs);
  if (local) return local;
  try {
    const [rateLimit, outage] = await getUntil(COOLDOWN_KEYS.rate_limit, COOLDOWN_KEYS.outage);
    if (rateLimit !== null) remember("rate_limit", rateLimit);
    if (outage !== null) remember("outage", outage);
  } catch {
    // Fail open: without Redis, this instance's own cooldowns still apply.
  }
  return localCooldown(nowMs);
}

function remember(reason: CooldownReason, untilMs: number) {
  localUntil[reason] = Math.max(localUntil[reason], untilMs);
  recordCooldownUntil(localUntil[reason]);
}

/** Starts or extends a cooldown here and in Redis. Never shortens one. Never throws. */
export async function startCooldown(reason: CooldownReason, untilMs: number, trigger: CooldownTrigger) {
  remember(reason, untilMs);
  upstreamCooldowns.add(1, { trigger });
  try {
    await extendUntil(COOLDOWN_KEYS[reason], untilMs);
  } catch (e) {
    console.warn(`[henrik] couldn't share the ${reason} cooldown:`, e instanceof Error ? e.name : e);
  }
}

/** Remembers the budget left, until the window it belongs to resets. */
export function noteRemaining(remaining: number | null, resetMs: number | null, nowMs: number) {
  if (remaining === null) return;
  lastRemaining = { value: remaining, validUntilMs: nowMs + (resetMs ?? LIMITS.defaultCooldownMs) };
}

/** True once enough calls failed in a row to open the breaker, until one succeeds. */
const breakerTripped = () => consecutiveFailures >= LIMITS.breakerThreshold;

/**
 * A retry is allowed outside any cooldown, while the budget isn't nearly spent,
 * and never while the breaker is tripped: a half-open probe gets one try.
 */
export function retryAllowed(nowMs: number): boolean {
  if (localCooldown(nowMs) || breakerTripped()) return false;
  return lastRemaining === null || lastRemaining.validUntilMs <= nowMs || lastRemaining.value >= LIMITS.retryMinRemaining;
}

/**
 * Decides whether a lookup may call upstream when no cooldown is active.
 * Normally every call may. Once the breaker's cooldown has run out (half-open),
 * one call at a time on this instance goes as a probe and the rest wait for its
 * answer. Returns "probe" for that call, which must call releaseProbe() when done.
 */
export function admitCall(): "call" | "probe" | "wait" {
  if (!breakerTripped()) return "call";
  if (probeInFlight) return "wait";
  probeInFlight = true;
  return "probe";
}

export function releaseProbe() {
  probeInFlight = false;
}

/**
 * Counts failed calls in a row for the circuit breaker. Any answer below 500
 * resets the count. Once open, the probe after the cooldown either closes it or
 * reopens it straight away, so a still-down API costs this instance one call per
 * cooldown instead of four per page view.
 */
export async function noteResult(failed: boolean, nowMs: number) {
  if (!failed) {
    consecutiveFailures = 0;
    return;
  }
  consecutiveFailures++;
  if (consecutiveFailures >= LIMITS.breakerThreshold) {
    await startCooldown("outage", nowMs + LIMITS.breakerCooldownMs, "breaker");
  }
}

/** Clears all in-process state. Tests only. */
export function resetLimitsForTests() {
  localUntil.rate_limit = 0;
  localUntil.outage = 0;
  lastRemaining = null;
  consecutiveFailures = 0;
  probeInFlight = false;
}
