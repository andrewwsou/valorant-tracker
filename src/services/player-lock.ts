import type { Prisma } from "@/generated/prisma";

/**
 * Locks one player's row until the surrounding transaction ends, so stats
 * refreshes of the same player run one at a time.
 *
 * FOR NO KEY UPDATE, not FOR UPDATE: inserting a PlayerMatch row checks its
 * foreign key with a KEY SHARE lock on the player. FOR UPDATE would block those
 * inserts; FOR NO KEY UPDATE lets them through while still serializing refreshes.
 * e2e/player-stats.spec.ts checks both halves against a real database: a refresh
 * waits for this lock, and a match insert does not.
 */
export async function lockPlayer(tx: Prisma.TransactionClient, playerId: string) {
  await tx.$queryRaw`SELECT id FROM "Player" WHERE id = ${playerId} FOR NO KEY UPDATE`;
}
