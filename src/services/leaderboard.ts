import type { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { withSpan } from "@/lib/telemetry";
import { RECENT_MATCH_WINDOW } from "@/services/stats";

/** Columns the leaderboard can sort by. Each has a matching (column DESC, playerId) index. */
export const LEADERBOARD_SORTS = ["trackerScore", "acs", "kd", "winRate"] as const;
export type LeaderboardSort = (typeof LEADERBOARD_SORTS)[number];

export type LeaderboardQuery = {
  sort: LeaderboardSort;
  /** Players need at least this many of their recent matches stored to appear. */
  minMatches: number;
  limit: number;
};

export const LEADERBOARD_DEFAULTS: LeaderboardQuery = { sort: "trackerScore", minMatches: 5, limit: 25 };
const MAX_LIMIT = 100;

export type ParsedLeaderboardQuery = { ok: true; value: LeaderboardQuery } | { ok: false; error: string };

function isSort(value: string): value is LeaderboardSort {
  return (LEADERBOARD_SORTS as readonly string[]).includes(value);
}

/** Reads `sort`, `minMatches`, and `limit`, rejecting anything outside the allowed values. */
export function parseLeaderboardQuery(params: URLSearchParams): ParsedLeaderboardQuery {
  // An empty value means "use the default", the same as for the numeric options.
  const sort = params.get("sort") || LEADERBOARD_DEFAULTS.sort;
  if (!isSort(sort)) {
    return { ok: false, error: `Unknown sort. Use one of: ${LEADERBOARD_SORTS.join(", ")}` };
  }

  const minMatches = readInt(params.get("minMatches"), LEADERBOARD_DEFAULTS.minMatches);
  if (minMatches === null || minMatches < 1 || minMatches > RECENT_MATCH_WINDOW) {
    return { ok: false, error: `minMatches must be a whole number from 1 to ${RECENT_MATCH_WINDOW}` };
  }

  const limit = readInt(params.get("limit"), LEADERBOARD_DEFAULTS.limit);
  if (limit === null || limit < 1 || limit > MAX_LIMIT) {
    return { ok: false, error: `limit must be a whole number from 1 to ${MAX_LIMIT}` };
  }

  return { ok: true, value: { sort, minMatches, limit } };
}

/** Parses a whole number, using the fallback when the value is absent. Returns null for junk like "5x". */
function readInt(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === "") return fallback;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

export type LeaderboardEntry = {
  /** Shared by players whose sort value is exactly equal (1, 2, 2, 4). */
  rank: number;
  name: string;
  tag: string;
  /**
   * False once another player has taken this Riot ID: this one renamed away, so a
   * link by name would open someone else's profile.
   */
  linked: boolean;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  trackerScore: number;
  acs: number;
  kd: number;
  winRate: number;
  headshotPct: number;
  lastMatchAt: string | null;
  updatedAt: string;
};

/**
 * The top players by one stat, read from the precomputed PlayerStats table.
 *
 * One indexed query on PlayerStats, plus one primary-key lookup that Prisma makes
 * for the players' names. Ordering by (stat DESC, playerId) matches the table's
 * indexes, and playerId keeps the order stable between requests.
 * `db` can be a transaction client, such as the MCP server's read-only one.
 */
export function getLeaderboard(
  query: LeaderboardQuery,
  db: Prisma.TransactionClient = prisma,
): Promise<LeaderboardEntry[]> {
  return withSpan("leaderboard.load", { "leaderboard.sort": query.sort }, async (span) => {
    const rows = await db.playerStats.findMany({
      where: { matches: { gte: query.minMatches } },
      orderBy: [{ [query.sort]: "desc" }, { playerId: "asc" }],
      take: query.limit,
      include: { player: { select: { name: true, tag: true, riotIdKey: true } } },
    });
    span.setAttribute("leaderboard.rows", rows.length);

    const entries: LeaderboardEntry[] = [];
    rows.forEach((row, i) => {
      const previous = entries[i - 1];
      const tied = previous !== undefined && rows[i - 1][query.sort] === row[query.sort];
      entries.push({
        rank: tied ? previous.rank : i + 1,
        name: row.player.name,
        tag: row.player.tag,
        linked: row.player.riotIdKey !== null,
        matches: row.matches,
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
        trackerScore: row.trackerScore,
        acs: row.acs,
        kd: row.kd,
        winRate: row.winRate,
        headshotPct: row.headshotPct,
        lastMatchAt: row.lastMatchAt ? row.lastMatchAt.toISOString() : null,
        updatedAt: row.updatedAt.toISOString(),
      });
    });
    return entries;
  });
}
