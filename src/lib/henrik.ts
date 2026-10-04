/**
 * The only module that talks to the HenrikDev VALORANT API.
 *
 * Auth, URLs, caching, timeouts, retries, and rate limiting all live here, so
 * every route behaves the same way. Each lookup:
 *   1. serves a cached answer if there is one, including a cached failure;
 *   2. otherwise answers locally while a cooldown is active (see henrik-limits.ts);
 *   3. otherwise calls upstream, with a timeout per attempt, an overall deadline,
 *      and at most one retry for errors that are likely to pass;
 *   4. caches the result: successes for their TTL, not-found for 5 minutes, and
 *      failures for 30 seconds, so repeat views of a broken lookup spend nothing.
 */
import { SpanStatusCode } from "@opentelemetry/api";
import {
  admitCall,
  backoffMs,
  clampCooldownMs,
  currentCooldown,
  LIMITS,
  noteRemaining,
  noteResult,
  readRateLimit,
  releaseProbe,
  retryAllowed,
  startCooldown,
  type Cooldown,
} from "@/lib/henrik-limits";
import { nowMs, msSince } from "@/lib/metrics";
import { cacheGetJson, cacheSetJson } from "@/lib/redis";
import type { Region } from "@/lib/riot-id";
import {
  cacheLookups,
  recordRateLimitRemaining,
  upstreamDuration,
  upstreamFailures,
  upstreamRequests,
  upstreamRetries,
  upstreamShortCircuits,
  withSpan,
} from "@/lib/telemetry";

/** Overridable so end-to-end and load tests can point the app at a mock API. */
const BASE_URL = process.env.HENRIKDEV_BASE_URL ?? "https://api.henrikdev.xyz/valorant";

/** How long each kind of upstream data may be served from the cache. */
export const CACHE_TTL_SECONDS = {
  /** Player card and account level. These only change when the player edits their profile. */
  account: 60 * 60,
  /** Current rank and rank history. These only change after a match, and matches sync at most every 5 minutes. */
  mmr: 5 * 60,
} as const;

/** How long failed lookups are cached, so repeat views don't spend the rate limit on them again. */
export const NEGATIVE_TTL_SECONDS = {
  /** Player not found, or no competitive matches. Matches the sync cooldown. */
  notFound: 5 * 60,
  /** 5xx, timeout, or network error after retrying. Short, because these usually pass. */
  failure: 30,
} as const;

/** Upstream endpoints, used as low-cardinality labels on spans and metrics. */
type Endpoint = "account" | "mmr" | "mmr-history" | "matches";

type Policy = {
  /** Longest one attempt may take, headers and body together. */
  attemptMs: number;
  /** Longest the whole call may take, retries included. */
  deadlineMs: number;
  /** A retry only starts if at least this much time is left. */
  minRetryMs: number;
  /** Whether a timeout or a connection lost mid-body is retried. */
  retryAfterTimeout: boolean;
};

const SMALL: Policy = { attemptMs: 3_000, deadlineMs: 7_000, minRetryMs: 1_000, retryAfterTimeout: true };

/**
 * Timeouts per endpoint. Matches responses are about 7 MB, so they get longer,
 * and a timeout there is never retried: the first try was probably already
 * charged against the rate limit, and a second download wouldn't fit anyway.
 */
const POLICY: Record<Endpoint, Policy> = {
  account: SMALL,
  mmr: SMALL,
  "mmr-history": SMALL,
  matches: { attemptMs: 10_000, deadlineMs: 12_000, minRetryMs: 5_000, retryAfterTimeout: false },
};

/** One retry at most: with 30 requests a minute, retries mostly spend budget other players need. */
const MAX_ATTEMPTS = 2;
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

/** An upstream response kept as raw text, so routes can pass it through unchanged. */
export type UpstreamResponse = {
  status: number;
  contentType: string;
  body: string;
  /** On a 429 or 503: seconds before asking again. Never cached. */
  retryAfterSeconds?: number;
};

export type CachedUpstreamResponse = UpstreamResponse & { cache: "HIT" | "MISS" };

/** How a call ended. Recorded on spans; decides what gets cached. */
type Outcome =
  | "ok"
  | "not_found"
  | "client_error"
  | "rate_limited"
  | "upstream_error"
  | "timeout"
  | "network_error"
  | "short_circuited";

const enc = encodeURIComponent;
const JSON_TYPE = "application/json";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * An error answered by this app instead of HenrikDev, in HenrikDev's own error
 * shape so callers handle both the same way. `details.source` tells them apart.
 */
function localError(status: number, reason: string, message: string, retryAfterSeconds?: number): UpstreamResponse {
  const body = JSON.stringify({
    status,
    errors: [{ code: 0, message, status, details: { source: "stattrack", reason } }],
  });
  return { status, contentType: JSON_TYPE, body, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
}

type Attempt =
  | { kind: "response"; status: number; headers: Headers; contentType: string; body: string }
  /** No usable response. `headers` is set when they arrived before the body failed. */
  | { kind: "timeout" | "network"; detail: string; headers: Headers | null };

/** The error code behind a failed fetch, such as ECONNREFUSED, for logs and metrics. */
function errorCode(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  if (typeof cause?.code === "string") return cause.code;
  return e instanceof Error ? e.name : "unknown";
}

/**
 * One HTTP request. The timeout covers the headers and the whole body: an
 * AbortController fired by a plain timer, because AbortSignal.timeout ignores
 * the fake timers the unit tests use.
 */
function attemptOnce(endpoint: Endpoint, path: string, apiKey: string, timeoutMs: number, attempt: number) {
  const attributes = { "henrik.endpoint": endpoint, "henrik.attempt": attempt + 1, "henrik.timeout_ms": timeoutMs };
  return withSpan(`henrik.fetch ${endpoint}`, attributes, async (span): Promise<Attempt> => {
    if (attempt > 0) span.setAttribute("http.request.resend_count", attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = nowMs();
    let headers: Headers | null = null;

    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        headers: { Authorization: apiKey },
        // Keep no-store: Next.js only forwards `signal` to the real fetch on this path.
        cache: "no-store",
        signal: controller.signal,
      });
      // Counted as soon as the API answers, so a body that fails later still shows up.
      headers = res.headers;
      span.setAttribute("http.response.status_code", res.status);
      upstreamRequests.add(1, { endpoint, status_code: res.status });
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining !== null && Number.isFinite(Number(remaining))) {
        span.setAttribute("henrik.ratelimit.remaining", Number(remaining));
        recordRateLimitRemaining(Number(remaining));
      }

      const body = await res.text();
      span.setAttribute("henrik.response.bytes", body.length);
      console.info(`[henrik] ${res.status} ${path} ${msSince(t0)}ms ${Math.round(body.length / 1024)}KB`);
      return {
        kind: "response",
        status: res.status,
        headers: res.headers,
        contentType: res.headers.get("content-type") ?? JSON_TYPE,
        body,
      };
    } catch (e) {
      const kind = controller.signal.aborted ? "timeout" : "network";
      const detail = kind === "timeout" ? "timeout" : errorCode(e);
      // "body": the API answered but the body didn't arrive. Those attempts are already
      // in stattrack.upstream.requests; the rest never got an answer at all.
      const phase = headers ? "body" : "before_response";
      span.setAttributes({ "error.type": detail, "henrik.failure.phase": phase });
      span.setStatus({ code: SpanStatusCode.ERROR, message: detail });
      upstreamFailures.add(1, { endpoint, error_type: detail, phase });
      console.warn(`[henrik] ${kind} ${path} after ${msSince(t0)}ms (${detail})`);
      return { kind, detail, headers };
    } finally {
      clearTimeout(timer);
      // Every attempt, failed ones included, so timeouts show up as the latency they cost.
      upstreamDuration.record(msSince(t0) / 1000, { endpoint });
    }
  });
}

/**
 * Sleeps before a retry, then makes sure no cooldown started meanwhile, on this
 * instance or another. Returns false if the retry should not be sent after all.
 */
async function waitToRetry(endpoint: Endpoint, reason: string, waitMs: number): Promise<boolean> {
  await sleep(waitMs);
  if (await currentCooldown(Date.now())) return false;
  upstreamRetries.add(1, { endpoint, reason });
  return true;
}

/**
 * Calls upstream under the endpoint's policy. Rate-limit headers are recorded on
 * every response before deciding anything else, a 429 starts the shared cooldown,
 * and failures feed the circuit breaker. Throws only when the API key is missing.
 */
async function callUpstream(endpoint: Endpoint, path: string): Promise<{ res: UpstreamResponse; outcome: Outcome; attempts: number }> {
  const apiKey = process.env.HENRIKDEV_API_KEY;
  if (!apiKey) throw new Error("HENRIKDEV_API_KEY is not set");

  const policy = POLICY[endpoint];
  const deadline = Date.now() + policy.deadlineMs;

  for (let attempt = 0; ; attempt++) {
    const timeoutMs = Math.max(1, Math.min(policy.attemptMs, deadline - Date.now()));
    const result = await attemptOnce(endpoint, path, apiKey, timeoutMs, attempt);
    const now = Date.now();
    const attempts = attempt + 1;

    // Record the budget this response reports first, so a retry is decided with it:
    // a 5xx that says the budget is spent must not be retried.
    const limits = result.headers ? readRateLimit(result.headers, now) : null;
    if (limits) {
      noteRemaining(limits.remaining, limits.resetMs, now);
      // Stop before the API has to say no: a spent budget pauses calls until it resets.
      if (limits.remaining !== null && limits.remaining <= 0) {
        await startCooldown("rate_limit", now + clampCooldownMs(limits.resetMs), "remaining_zero");
      }
    }
    const timeLeft = () => deadline - Date.now();
    const mayRetry = () => attempt + 1 < MAX_ATTEMPTS && timeLeft() >= policy.minRetryMs && retryAllowed(Date.now());

    if (result.kind !== "response") {
      // A connection that never got an answer is safe to retry. A timeout or a body cut
      // off midway may already have been charged, so only small endpoints retry it.
      const retryable = result.kind === "network" && !result.headers ? true : policy.retryAfterTimeout;
      if (
        retryable &&
        mayRetry() &&
        (await waitToRetry(endpoint, result.kind, Math.min(backoffMs(attempt), timeLeft() - policy.minRetryMs)))
      ) {
        continue;
      }
      await noteResult(true, now);
      return result.kind === "timeout"
        ? { res: localError(504, "timeout", "HenrikDev did not answer in time"), outcome: "timeout", attempts }
        : { res: localError(502, result.detail, "Couldn't reach HenrikDev"), outcome: "network_error", attempts };
    }

    const { status } = result;
    const res: UpstreamResponse = { status, contentType: result.contentType, body: result.body };

    if (status === 429) {
      // Never retried: wait as long as the API asks, and make every instance wait too.
      const waitMs = clampCooldownMs(
        limits!.retryAfterMs === null && limits!.resetMs === null
          ? null
          : Math.max(limits!.retryAfterMs ?? 0, limits!.resetMs ?? 0),
      );
      await startCooldown("rate_limit", now + waitMs, "429");
      await noteResult(false, now);
      return { res: { ...res, retryAfterSeconds: Math.ceil(waitMs / 1000) }, outcome: "rate_limited", attempts };
    }

    if (status >= 500) {
      const retryAfterMs = limits!.retryAfterMs;
      if (status === 503 && retryAfterMs !== null && retryAfterMs >= LIMITS.outageRetryAfterMs) {
        const waitMs = clampCooldownMs(retryAfterMs);
        await startCooldown("outage", now + waitMs, "retry_after");
        await noteResult(true, now);
        return { res: { ...res, retryAfterSeconds: Math.ceil(waitMs / 1000) }, outcome: "upstream_error", attempts };
      }
      const waitMs = retryAfterMs ?? backoffMs(attempt);
      if (
        RETRYABLE_STATUS.has(status) &&
        mayRetry() &&
        waitMs <= timeLeft() - policy.minRetryMs &&
        (await waitToRetry(endpoint, "5xx", waitMs))
      ) {
        continue;
      }
      await noteResult(true, now);
      // Passed on when the API said how long to wait, so callers can wait as asked.
      const retryAfterSeconds = retryAfterMs !== null ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : undefined;
      return { res: retryAfterSeconds ? { ...res, retryAfterSeconds } : res, outcome: "upstream_error", attempts };
    }

    await noteResult(false, now);
    const outcome: Outcome = status === 404 ? "not_found" : status >= 200 && status < 300 ? "ok" : "client_error";
    return { res, outcome, attempts };
  }
}

/** An answer given locally because a cooldown is active. Costs no upstream budget. */
function shortCircuit(cooldown: Cooldown, nowMs: number): UpstreamResponse {
  const seconds = Math.max(1, Math.ceil((cooldown.untilMs - nowMs) / 1000));
  return cooldown.reason === "rate_limit"
    ? localError(429, "rate_limit_cooldown", `Paused to stay under the HenrikDev rate limit. Try again in ${seconds}s.`, seconds)
    : localError(503, "outage_cooldown", `HenrikDev looks unavailable. Try again in ${seconds}s.`, seconds);
}

/** True for a small `{"data":[]}`-style body: a player with no matches in this mode. */
function hasEmptyData(body: string): boolean {
  if (body.length > 512) return false;
  try {
    const data = (JSON.parse(body) as { data?: unknown }).data;
    return Array.isArray(data) && data.length === 0;
  } catch {
    return false;
  }
}

/** How long to cache a result, in seconds, or null to not cache it. */
function ttlFor(endpoint: Endpoint, res: UpstreamResponse, outcome: Outcome, okTtlSeconds: number | null): number | null {
  // An answer that says when to come back is about this moment. A cooldown already
  // keeps calls away; a cached copy would outlive the wait and lose its Retry-After.
  if (res.retryAfterSeconds) return null;
  switch (outcome) {
    case "ok":
      if (res.status !== 200) return null;
      if (okTtlSeconds !== null) return okTtlSeconds;
      return endpoint === "matches" && hasEmptyData(res.body) ? NEGATIVE_TTL_SECONDS.notFound : null;
    case "not_found":
      return NEGATIVE_TTL_SECONDS.notFound;
    case "upstream_error":
    case "timeout":
    case "network_error":
      return NEGATIVE_TTL_SECONDS.failure;
    default:
      // A 429 or a short-circuit is about the budget, not this player: caching it per key
      // would keep a player blocked long after the cooldown ends. 4xx means fix the request.
      return null;
  }
}

/** A cached value only counts if it has the shape this module writes. */
function isUpstreamResponse(value: unknown): value is UpstreamResponse {
  const v = value as UpstreamResponse | null;
  return typeof v?.status === "number" && typeof v.body === "string" && typeof v.contentType === "string";
}

/** Cache errors are logged by name only: Upstash error messages can include the cached value. */
const errorSummary = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message.slice(0, 120)}` : String(e));

/**
 * Cache-aside read: serve from Redis when possible, otherwise call upstream
 * (unless a cooldown is active) and cache the outcome. Cache errors never fail
 * the request. `okTtlSeconds` null means successes aren't cached.
 */
async function cachedRequest(
  endpoint: Endpoint,
  path: string,
  cacheKey: string,
  okTtlSeconds: number | null,
): Promise<CachedUpstreamResponse> {
  return withSpan(`henrik.lookup ${endpoint}`, { "henrik.endpoint": endpoint }, async (span) => {
    const started = Date.now();
    // Issued in the same tick, so Upstash sends both reads in one pipelined request.
    const [hit, cooldown] = await Promise.all([
      cacheGetJson<unknown>(cacheKey).catch((e) => {
        cacheLookups.add(1, { resource: endpoint, result: "error" });
        console.warn(`[cache] read failed for ${cacheKey}: ${errorSummary(e)}`);
        return "error" as const;
      }),
      currentCooldown(started),
    ]);

    if (hit !== "error" && isUpstreamResponse(hit)) {
      const result = hit.status === 200 ? "hit" : "negative_hit";
      span.setAttributes({ "cache.hit": true, "cache.result": result });
      cacheLookups.add(1, { resource: endpoint, result });
      return { status: hit.status, contentType: hit.contentType, body: hit.body, cache: "HIT" as const };
    }
    if (hit !== "error") cacheLookups.add(1, { resource: endpoint, result: "miss" });
    span.setAttributes({ "cache.hit": false, "cache.result": hit === "error" ? "error" : "miss" });

    if (cooldown) {
      span.setAttributes({
        "henrik.outcome": "short_circuited",
        "henrik.short_circuit.reason": cooldown.reason,
        "henrik.cooldown.until_ms": cooldown.untilMs,
      });
      upstreamShortCircuits.add(1, { endpoint, reason: cooldown.reason });
      return { ...shortCircuit(cooldown, Date.now()), cache: "MISS" as const };
    }

    // Half-open breaker: one probe at a time tests the API; the rest wait for its answer.
    const admission = admitCall();
    if (admission === "wait") {
      const probe: Cooldown = { reason: "outage", untilMs: Date.now() + LIMITS.probeWaitMs };
      span.setAttributes({ "henrik.outcome": "short_circuited", "henrik.short_circuit.reason": "probe" });
      upstreamShortCircuits.add(1, { endpoint, reason: "probe" });
      return { ...shortCircuit(probe, Date.now()), cache: "MISS" as const };
    }

    let called: Awaited<ReturnType<typeof callUpstream>>;
    try {
      called = await callUpstream(endpoint, path);
    } finally {
      if (admission === "probe") releaseProbe();
    }
    const { res, outcome, attempts } = called;
    span.setAttributes({ "henrik.outcome": outcome, "henrik.attempts": attempts, "henrik.probe": admission === "probe" });
    if (outcome === "timeout" || outcome === "network_error" || outcome === "upstream_error") {
      span.setStatus({ code: SpanStatusCode.ERROR, message: outcome });
    }

    const ttl = ttlFor(endpoint, res, outcome, okTtlSeconds);
    if (ttl !== null) {
      try {
        // retryAfterSeconds is about this moment, so it's never stored.
        await cacheSetJson(cacheKey, { status: res.status, contentType: res.contentType, body: res.body }, ttl);
      } catch (e) {
        console.warn(`[cache] write failed for ${cacheKey}: ${errorSummary(e)}`);
      }
    }
    return { ...res, cache: "MISS" as const };
  });
}

/** Builds a versioned cache key. Riot IDs are case-insensitive, so parts are lowercased. */
function cacheKey(...parts: string[]): string {
  return ["henrik", "v1", ...parts.map((p) => p.toLowerCase())].join(":");
}

/** Account details, including the player card images. */
export function getAccount(name: string, tag: string) {
  return cachedRequest(
    "account",
    `/v1/account/${enc(name)}/${enc(tag)}`,
    cacheKey("account", name, tag),
    CACHE_TTL_SECONDS.account,
  );
}

/** Current rank and peak rank. */
export function getMmr(region: Region, name: string, tag: string) {
  return cachedRequest(
    "mmr",
    `/v2/mmr/${region}/${enc(name)}/${enc(tag)}`,
    cacheKey("mmr", region, name, tag),
    CACHE_TTL_SECONDS.mmr,
  );
}

/** Rank change for each recent competitive match. */
export function getMmrHistory(region: Region, name: string, tag: string) {
  return cachedRequest(
    "mmr-history",
    `/v1/mmr-history/${region}/${enc(name)}/${enc(tag)}`,
    cacheKey("mmr-history", region, name, tag),
    CACHE_TTL_SECONDS.mmr,
  );
}

/**
 * Full match details for recent games. Successful responses aren't cached: the
 * payload is several megabytes, and the sync job stores what we need in
 * Postgres anyway. Failures and empty histories are, like every other lookup.
 */
export function getMatches(
  region: Region,
  name: string,
  tag: string,
  opts: { size: number; mode: string },
) {
  const qs = new URLSearchParams({ size: String(opts.size), mode: opts.mode });
  return cachedRequest(
    "matches",
    `/v3/matches/${region}/${enc(name)}/${enc(tag)}?${qs}`,
    cacheKey("matches", region, name, tag, opts.mode),
    null,
  );
}

/* ------------------------------------------------------------------------ */
/* Response types. Every field is optional because the API is third-party   */
/* and unofficial: code must handle missing fields instead of trusting them. */
/* ------------------------------------------------------------------------ */

export type HenrikPlayer = {
  puuid?: string;
  name?: string;
  tag?: string;
  team?: string;
  damage_made?: number;
  stats?: {
    kills?: number;
    deaths?: number;
    assists?: number;
    score?: number;
    headshots?: number;
    bodyshots?: number;
    legshots?: number;
  };
  assets?: { agent?: { small?: string } };
};

export type HenrikMatch = {
  metadata?: {
    matchid?: string;
    map?: string;
    mode?: string;
    /** Unix timestamp in seconds. */
    game_start?: number;
  };
  players?: { all_players?: HenrikPlayer[] };
  teams?: {
    red?: { rounds_won?: number };
    blue?: { rounds_won?: number };
  };
};

/** `data` from the account endpoint. */
export type HenrikAccount = {
  card?: { small?: string; large?: string; wide?: string };
};

/** `data` from the MMR (current rank) endpoint. */
export type HenrikMmr = {
  current_data?: { currenttierpatched?: string; images?: { small?: string; large?: string } };
  highest_rank?: { patched_tier?: string; season?: string };
};

/** One entry of `data` from the MMR history endpoint. */
export type HenrikMmrHistoryEntry = {
  match_id?: string;
  currenttier_patched?: string;
  images?: { small?: string; large?: string };
  mmr_change_to_last_game?: number;
};
