import { prisma } from "@/lib/prisma";
import { cacheDelete, cacheGetJson, cacheSetJson } from "@/lib/redis";
import { cacheLookups, withSpan } from "@/lib/telemetry";

/** One player's line from one match: the read model behind the match table and all stats. */
export type MatchRow = {
  matchId: string;
  map: string | null;
  mode: string | null;
  region: string | null;
  /** ISO 8601 timestamp. */
  startedAt: string | null;
  roundsRed: number | null;
  roundsBlue: number | null;
  team: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  score: number | null;
  damage: number | null;
  headshots: number | null;
  bodyshots: number | null;
  legshots: number | null;
  agentIcon: string | null;
};

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

    const rows = await prisma.playerMatch.findMany({
      where: { playerId: player.id },
      include: { match: true },
      orderBy: { match: { startedAt: "desc" } },
      take: limit,
    });

    const data: MatchRow[] = rows.map((pm) => ({
      matchId: pm.matchId,
      map: pm.match.map,
      mode: pm.match.mode,
      region: pm.match.region,
      startedAt: pm.match.startedAt ? pm.match.startedAt.toISOString() : null,
      roundsRed: pm.match.roundsRed,
      roundsBlue: pm.match.roundsBlue,
      team: pm.team,
      kills: pm.kills,
      deaths: pm.deaths,
      assists: pm.assists,
      score: pm.score,
      damage: pm.damage,
      headshots: pm.headshots,
      bodyshots: pm.bodyshots,
      legshots: pm.legshots,
      agentIcon: pm.agentIcon,
    }));

    span.setAttribute("matches.count", data.length);
    const payload: RecentMatches = { player, data };
    try {
      await cacheSetJson(key, payload, CACHE_TTL_SECONDS);
    } catch {}
    return { cache: "MISS" as const, ...payload };
  });
}
