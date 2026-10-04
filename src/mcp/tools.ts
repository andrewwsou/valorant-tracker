/**
 * What each MCP tool reads and returns. Every function takes the read-only
 * transaction it runs in, reuses the same queries and formulas as the website,
 * and returns compact JSON with numbers rounded the way the site shows them.
 */
import { z } from "zod";
import type { Prisma } from "@/generated/prisma";
import { getLeaderboard, LEADERBOARD_DEFAULTS, LEADERBOARD_SORTS } from "@/services/leaderboard";
import { findRecentMatchRows } from "@/services/match-rows";
import { matchStats, RECENT_MATCH_WINDOW } from "@/services/stats";

type Db = Prisma.TransactionClient;

/** What a tool found: data to return, or a short message saying why there is none. */
export type ToolAnswer = { ok: true; data: unknown } | { ok: false; message: string };

/** Fewer than the website's 100, to keep answers small. */
export const MAX_LEADERBOARD_ROWS = 25;

const riotId = z
  .string()
  .trim()
  // No control characters: Postgres rejects some (like NUL), and no Riot ID has them.
  .regex(/^[^#\p{Cc}]{1,16}#[^#\p{Cc}]{1,5}$/u, "Use the form Name#TAG, for example TenZ#NA1")
  .describe("Riot ID as Name#TAG, for example TenZ#NA1. Not case-sensitive.");

export const leaderboardInput = z.object({
  sort: z
    .enum(LEADERBOARD_SORTS)
    .default(LEADERBOARD_DEFAULTS.sort)
    .describe(
      "Stat to rank by: trackerScore (0-100 overall rating), acs (combat score per round), kd (kills per death), winRate (% of decided matches won)",
    ),
  minMatches: z
    .number()
    .int()
    .min(1)
    .max(RECENT_MATCH_WINDOW)
    .default(LEADERBOARD_DEFAULTS.minMatches)
    .describe("Only include players with at least this many recent matches stored"),
  limit: z.number().int().min(1).max(MAX_LEADERBOARD_ROWS).default(10).describe("How many players to return"),
});

export const playerInput = z.object({ riotId });

export const recentMatchesInput = z.object({
  riotId,
  limit: z.number().int().min(1).max(RECENT_MATCH_WINDOW).default(5).describe("How many matches, newest first"),
});

type PlayerRef = { id: string; name: string; tag: string; lastSyncedAt: Date | null };

const label = (p: { name: string; tag: string }) => `${p.name}#${p.tag}`;

const notTracked = (id: string): ToolAnswer => ({
  ok: false,
  message: `No tracked player named ${id}. A player is tracked once their profile has been opened on the StatTrack site.`,
});

/**
 * Finds a player by Riot ID: an exact match first (uses the unique index), then
 * ignoring case, because Riot IDs aren't case-sensitive. If rows differing only
 * in case exist, the most recently synced one wins.
 */
async function findPlayer(db: Db, id: string): Promise<PlayerRef | null> {
  const [name, tag] = id.split("#").map((part) => part.trim());
  const exact = await db.player.findUnique({
    where: { name_tag: { name, tag } },
    select: { id: true, name: true, tag: true, lastSyncedAt: true },
  });
  if (exact) return exact;

  // lower() = lower() rather than Prisma's case-insensitive mode, which uses ILIKE,
  // where "_" and "%" in a name would act as wildcards.
  const [match] = await db.$queryRaw<PlayerRef[]>`
    SELECT id, name, tag, "lastSyncedAt" FROM "Player"
    WHERE lower(name) = lower(${name}) AND lower(tag) = lower(${tag})
    ORDER BY "lastSyncedAt" DESC NULLS LAST
    LIMIT 1`;
  return match ?? null;
}

export async function leaderboardAnswer(db: Db, input: z.output<typeof leaderboardInput>): Promise<ToolAnswer> {
  const entries = await getLeaderboard(input, db);
  return {
    ok: true,
    data: {
      sort: input.sort,
      minMatches: input.minMatches,
      players: entries.map((e) => ({
        rank: e.rank,
        player: label(e),
        matches: e.matches,
        wins: e.wins,
        losses: e.losses,
        draws: e.draws,
        trackerScore: e.trackerScore,
        acs: Math.round(e.acs),
        kd: Number(e.kd.toFixed(2)),
        winRate: Math.round(e.winRate),
        headshotPct: Math.round(e.headshotPct),
      })),
    },
  };
}

export async function playerStatsAnswer(db: Db, input: z.output<typeof playerInput>): Promise<ToolAnswer> {
  const player = await findPlayer(db, input.riotId);
  if (!player) return notTracked(input.riotId);

  const stats = await db.playerStats.findUnique({ where: { playerId: player.id } });
  if (!stats) {
    return { ok: false, message: `${label(player)} is tracked but has no stats yet. They appear after their next sync.` };
  }

  return {
    ok: true,
    data: {
      player: label(player),
      matches: stats.matches,
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      winRate: Math.round(stats.winRate),
      trackerScore: stats.trackerScore,
      kd: Number(stats.kd.toFixed(2)),
      acs: Math.round(stats.acs),
      adr: Math.round(stats.adr),
      headshotPct: Math.round(stats.headshotPct),
      totalStoredMatches: stats.totalMatches,
      lastMatchAt: stats.lastMatchAt?.toISOString() ?? null,
      lastSyncedAt: player.lastSyncedAt?.toISOString() ?? null,
    },
  };
}

export async function recentMatchesAnswer(db: Db, input: z.output<typeof recentMatchesInput>): Promise<ToolAnswer> {
  const player = await findPlayer(db, input.riotId);
  if (!player) return notTracked(input.riotId);

  const rows = await findRecentMatchRows(db, player.id, input.limit);
  return {
    ok: true,
    data: {
      player: label(player),
      matches: rows.map((row) => {
        const s = matchStats(row);
        return {
          startedAt: row.startedAt,
          map: row.map,
          mode: row.mode,
          result: s.result,
          score: s.score,
          kills: row.kills,
          deaths: row.deaths,
          assists: row.assists,
          acs: s.acs,
          adr: s.adr,
          headshotPct: s.headshotPct,
        };
      }),
    },
  };
}
