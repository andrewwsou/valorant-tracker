/**
 * Rebuilds the PlayerStats row of every player from their stored matches.
 *
 * Safe to run at any time, as often as you like: each row is recomputed (never
 * incremented) under the same per-player lock that live syncs take.
 *
 * Run it once after deploying the migration that adds PlayerStats, against the
 * database you mean, passed explicitly:
 *   DATABASE_URL="postgresql://..." npm run db:backfill-stats
 *
 * Then check that no player is missing a row (should print 0):
 *   SELECT count(*) FROM "Player" p
 *   LEFT JOIN "PlayerStats" s ON s."playerId" = p.id
 *   WHERE s."playerId" IS NULL;
 */

// Makes this file a module, so its main() doesn't clash with other scripts' globals.
export {};

// Refuse to fall back to whatever .env holds: this script writes to the database.
if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL explicitly for the database you want to backfill.");
  process.exit(1);
}

async function main() {
  const target = new URL(process.env.DATABASE_URL!);
  console.log(`Backfilling player stats on ${target.host}${target.pathname}`);

  // Imported after the check, so nothing touches a database before it passes.
  const { prisma } = await import("@/lib/prisma");
  const { refreshPlayerStats } = await import("@/services/player-stats");

  try {
    const players = await prisma.player.findMany({ select: { id: true }, orderBy: { id: "asc" } });
    for (const { id } of players) await refreshPlayerStats(id);
    console.log(`Rebuilt stats for ${players.length} player(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
