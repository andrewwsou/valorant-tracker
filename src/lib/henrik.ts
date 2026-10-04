/**
 * The only module that talks to the HenrikDev VALORANT API.
 *
 * Auth, URL building, caching, and logging live here, so every route behaves
 * the same way and later fixes (timeouts, retries, rate limits) touch one file.
 */
import { nowMs, msSince } from "@/lib/metrics";
import { cacheGetJson, cacheSetJson } from "@/lib/redis";
import type { Region } from "@/lib/riot-id";
import {
  cacheLookups,
  recordRateLimitRemaining,
  upstreamDuration,
  upstreamRequests,
  withSpan,
} from "@/lib/telemetry";

const BASE_URL = "https://api.henrikdev.xyz/valorant";

/** How long each kind of upstream data may be served from the cache. */
export const CACHE_TTL_SECONDS = {
  /** Player card and account level. These only change when the player edits their profile. */
  account: 60 * 60,
  /** Current rank and rank history. These only change after a match, and matches sync at most every 5 minutes. */
  mmr: 5 * 60,
} as const;

/** An upstream response kept as raw text, so routes can pass it through unchanged. */
export type UpstreamResponse = {
  status: number;
  contentType: string;
  body: string;
};

export type CachedUpstreamResponse = UpstreamResponse & { cache: "HIT" | "MISS" };

const enc = encodeURIComponent;

/** Upstream endpoints, used as low-cardinality labels on spans and metrics. */
type Endpoint = "account" | "mmr" | "mmr-history" | "matches";

async function request(endpoint: Endpoint, path: string): Promise<UpstreamResponse> {
  const apiKey = process.env.HENRIKDEV_API_KEY;
  if (!apiKey) throw new Error("HENRIKDEV_API_KEY is not set");

  return withSpan(`henrik.fetch ${endpoint}`, { "henrik.endpoint": endpoint }, async (span) => {
    const t0 = nowMs();
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: apiKey },
      cache: "no-store",
    });
    const body = await res.text();
    const ms = msSince(t0);

    span.setAttributes({ "http.response.status_code": res.status, "henrik.response.bytes": body.length });
    upstreamRequests.add(1, { endpoint, status_code: res.status });
    upstreamDuration.record(ms / 1000, { endpoint });

    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining !== null) {
      span.setAttribute("henrik.ratelimit.remaining", Number(remaining));
      recordRateLimitRemaining(Number(remaining));
    }

    console.info(`[henrik] ${res.status} ${path} ${ms}ms ${Math.round(body.length / 1024)}KB`);
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/json",
      body,
    };
  });
}

/**
 * Cache-aside read: serve from Redis when possible, otherwise call upstream
 * and cache the response if it succeeded. Cache errors never fail the request.
 */
async function cachedRequest(
  endpoint: Endpoint,
  path: string,
  cacheKey: string,
  ttlSeconds: number,
): Promise<CachedUpstreamResponse> {
  return withSpan(`henrik.lookup ${endpoint}`, { "henrik.endpoint": endpoint }, async (span) => {
    try {
      const hit = await cacheGetJson<UpstreamResponse>(cacheKey);
      if (hit) {
        span.setAttribute("cache.hit", true);
        cacheLookups.add(1, { resource: endpoint, result: "hit" });
        return { ...hit, cache: "HIT" as const };
      }
      cacheLookups.add(1, { resource: endpoint, result: "miss" });
    } catch (e) {
      cacheLookups.add(1, { resource: endpoint, result: "error" });
      console.warn(`[cache] read failed for ${cacheKey}:`, e);
    }

    span.setAttribute("cache.hit", false);
    const fresh = await request(endpoint, path);

    if (fresh.status === 200) {
      try {
        await cacheSetJson(cacheKey, fresh, ttlSeconds);
      } catch (e) {
        console.warn(`[cache] write failed for ${cacheKey}:`, e);
      }
    }
    return { ...fresh, cache: "MISS" as const };
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
 * Full match details for recent games. Not cached: the payload is large, and
 * the sync job stores the fields we need in Postgres anyway.
 */
export function getMatches(
  region: Region,
  name: string,
  tag: string,
  opts: { size: number; mode: string },
) {
  const qs = new URLSearchParams({ size: String(opts.size), mode: opts.mode });
  return request("matches", `/v3/matches/${region}/${enc(name)}/${enc(tag)}?${qs}`);
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
