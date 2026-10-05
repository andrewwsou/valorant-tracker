import { prisma } from "@/lib/prisma";
import { cacheDelete, cacheGetJson, cacheSetJson } from "@/lib/redis";
import { riotIdKey } from "@/lib/riot-id";
import { cacheLookups, withSpan } from "@/lib/telemetry";
import { findRecentMatchRows, type MatchRow } from "@/services/match-rows";

export type { MatchRow } from "@/services/match-rows";

export type RecentMatches = {
  player: { id: string; name: string; tag: string; puuid: string | null } | null;
  data: MatchRow[];
  message?: string;
};

const CACHE_TTL_SECONDS = 60;
const NOT_FOUND_TTL_SECONDS = 15;
/** Limits the app asks for, so a sync can clear every cached variant. */
const KNOWN_LIMITS = [10, 25];

/** Keyed by the player's Riot ID key (see riotIdKey), the same one the database looks them up by. */
function recentMatchesKey(key: string, limit: number) {
  return `dbmatches:v3:${key}:limit=${limit}`;
}

/** Clears cached match lists for a Riot ID key. Called after a sync writes new rows. */
export async function invalidateRecentMatches(key: string) {
  await cacheDelete(...KNOWN_LIMITS.map((limit) => recentMatchesKey(key, limit)));
}

/**
 * A player's most recent matches from Postgres, newest first.
 * Cache-aside with a 60-second TTL. Cache errors never fail the read.
 */
export async function getRecentMatches(
  name: string,
  tag: string,
  limit: number,
): Promise<RecentMatches & { cache: "HIT" | "MISS" }> {
  return withSpan("matches.recent", { "matches.limit": limit }, async (span) => {
    const playerKey = riotIdKey(name, tag);
    const key = recentMatchesKey(playerKey, limit);

    try {
      const cached = await cacheGetJson<RecentMatches>(key);
      if (cached) {
        span.setAttributes({ "cache.hit": true, "matches.count": cached.data.length });
        cacheLookups.add(1, { resource: "recent-matches", result: "hit" });
        return { cache: "HIT" as const, ...cached };
      }
      cacheLookups.add(1, { resource: "recent-matches", result: "miss" });
    } catch {
      // Cache trouble never blocks a read: fall through to the database.
      cacheLookups.add(1, { resource: "recent-matches", result: "error" });
    }
    span.setAttribute("cache.hit", false);

    // Any capitalization finds the player who has this Riot ID now.
    const player = await prisma.player.findUnique({
      where: { riotIdKey: playerKey },
      select: { id: true, name: true, tag: true, puuid: true },
    });

    if (!player) {
      const payload: RecentMatches = {
        player: null,
        data: [],
        message: "Player not found. Open their profile to start tracking them.",
      };
      try {
        await cacheSetJson(key, payload, NOT_FOUND_TTL_SECONDS);
      } catch {}
      return { cache: "MISS" as const, ...payload };
    }

    const data = await findRecentMatchRows(prisma, player.id, limit);

    span.setAttribute("matches.count", data.length);
    const payload: RecentMatches = { player, data };
    try {
      await cacheSetJson(key, payload, CACHE_TTL_SECONDS);
    } catch {}
    return { cache: "MISS" as const, ...payload };
  });
}
