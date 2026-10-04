import type { Prisma } from "@/generated/prisma";

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

/**
 * A player's newest stored matches, flattened into rows. Uncached.
 *
 * The profile page and the PlayerStats refresh both read through this one query,
 * so they always pick the same matches. `db` can be a transaction client.
 * matchId breaks ties between equal start times, so repeated reads agree.
 */
export async function findRecentMatchRows(
  db: Prisma.TransactionClient,
  playerId: string,
  limit: number,
): Promise<MatchRow[]> {
  const rows = await db.playerMatch.findMany({
    where: { playerId },
    include: { match: true },
    orderBy: [{ match: { startedAt: "desc" } }, { matchId: "desc" }],
    take: limit,
  });

  return rows.map((pm) => ({
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
}
