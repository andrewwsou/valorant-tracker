import { prisma } from "@/lib/prisma";
import { cacheDelete, cacheGetJson, cacheSetJson } from "@/lib/redis";
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

function recentMatchesKey(name: string, tag: string, limit: number) {
  return `dbmatches:v2:${name.toLowerCase()}:${tag.toLowerCase()}:limit=${limit}`;
}

/** Clears cached match lists for a player. Called after a sync writes new rows. */
export async function invalidateRecentMatches(name: string, tag: string) {
  await cacheDelete(...KNOWN_LIMITS.map((limit) => recentMatchesKey(name, tag, limit)));
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
    const key = recentMatchesKey(name, tag, limit);

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

    const player = await prisma.player.findUnique({
      where: { name_tag: { name, tag } },
      select: { id: true, name: true, tag: true, puuid: true },
    });

    if (!player) {
      const payload: RecentMatches = {
        player: null,
        data: [],
        message: "Player not found in DB. Run /api/sync first.",
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
