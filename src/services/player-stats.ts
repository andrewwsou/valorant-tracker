import { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { withSpan } from "@/lib/telemetry";
import { findRecentMatchRows } from "@/services/match-rows";
import { lockPlayer } from "@/services/player-lock";
import { computePlayerStats, RECENT_MATCH_WINDOW } from "@/services/stats";

/**
 * Rebuilds one player's PlayerStats row from their stored matches.
 *
 * The row is recomputed from source, never incremented. Re-running a sync that
 * re-saves matches already stored gives the same numbers, so nothing double counts.
 *
 * Everything happens in one short READ COMMITTED transaction:
 *   1. Lock the player's row (FOR NO KEY UPDATE), so refreshes of one player run
 *      one at a time. This mode still lets other transactions insert match rows
 *      that reference the player, because those only need a KEY SHARE lock.
 *   2. Read the newest matches. In READ COMMITTED each statement sees everything
 *      committed before it started, so a refresh that waited for the lock sees the
 *      other sync's rows too. Whichever refresh commits last wins, with complete data.
 *   3. Compute, then upsert the stats row.
 *   4. Optionally arm the sync cooldown (`syncedAt`) in the same commit, so the
 *      cooldown can only start once fresh stats are stored.
 */
export function refreshPlayerStats(playerId: string, opts: { syncedAt?: Date } = {}) {
  return withSpan("stats.refresh", { "stats.player_id": playerId }, (span) =>
    prisma.$transaction(
      async (tx) => {
        await lockPlayer(tx, playerId);

        const rows = await findRecentMatchRows(tx, playerId, RECENT_MATCH_WINDOW);
        const totalMatches = await tx.playerMatch.count({ where: { playerId } });
        const stats = {
          ...computePlayerStats(rows),
          totalMatches,
          lastMatchAt: rows.find((r) => r.startedAt)?.startedAt ?? null,
        };

        await tx.playerStats.upsert({
          where: { playerId },
          create: { playerId, ...stats },
          update: stats,
        });

        if (opts.syncedAt) {
          await tx.player.update({ where: { id: playerId }, data: { lastSyncedAt: opts.syncedAt } });
        }

        span.setAttributes({ "stats.matches": stats.matches, "stats.total_matches": totalMatches });
        return stats;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    ),
  );
}
