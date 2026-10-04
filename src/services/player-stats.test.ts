import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => {
  const tx = {
    $queryRaw: vi.fn(),
    playerMatch: { findMany: vi.fn(), count: vi.fn() },
    playerStats: { upsert: vi.fn() },
    player: { update: vi.fn() },
  };
  return { prisma: { $transaction: vi.fn(), tx } };
});

import { prisma } from "@/lib/prisma";
import { refreshPlayerStats } from "@/services/player-stats";

/** The mocked client. `$transaction(fn)` runs fn with `tx`, like an interactive transaction. */
const db = prisma as unknown as {
  $transaction: Mock;
  tx: {
    $queryRaw: Mock;
    playerMatch: { findMany: Mock; count: Mock };
    playerStats: { upsert: Mock };
    player: { update: Mock };
  };
};

/** A stored stat line as Prisma returns it (PlayerMatch with its Match included). */
function storedLine(matchId: string, startedAt: string | null, won: boolean) {
  return {
    matchId,
    team: "red",
    kills: 20,
    deaths: 16,
    assists: 5,
    score: 5000,
    damage: 3200,
    headshots: 10,
    bodyshots: 25,
    legshots: 5,
    agentIcon: null,
    match: {
      map: "Haven",
      mode: "Competitive",
      region: "na",
      startedAt: startedAt ? new Date(startedAt) : null,
      roundsRed: won ? 13 : 7,
      roundsBlue: won ? 7 : 13,
    },
  };
}

// The e2e fixture's shape: 6 newer wins, then 4 older losses, newest first.
const fixtureLines = Array.from({ length: 10 }, (_, i) =>
  storedLine(`m${10 - i}`, new Date(Date.UTC(2026, 8, 20, 18 - i)).toISOString(), i < 6),
);

beforeEach(() => {
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db.tx));
  db.tx.$queryRaw.mockResolvedValue([{ id: "player-1" }]);
  db.tx.playerMatch.findMany.mockResolvedValue(fixtureLines);
  db.tx.playerMatch.count.mockResolvedValue(42);
  db.tx.playerStats.upsert.mockResolvedValue({});
  db.tx.player.update.mockResolvedValue({});
});

describe("refreshPlayerStats", () => {
  it("locks the player, reads, then writes, in that order, inside a READ COMMITTED transaction", async () => {
    await refreshPlayerStats("player-1");

    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "ReadCommitted" });
    const [sqlParts, playerId] = db.tx.$queryRaw.mock.calls[0];
    expect(sqlParts.join("?")).toContain("FOR NO KEY UPDATE");
    expect(playerId).toBe("player-1");

    const order = [
      db.tx.$queryRaw.mock.invocationCallOrder[0],
      db.tx.playerMatch.findMany.mock.invocationCallOrder[0],
      db.tx.playerStats.upsert.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("stores the same numbers the profile page shows for the same matches", async () => {
    const stats = await refreshPlayerStats("player-1");

    expect(stats).toMatchObject({
      matches: 10,
      wins: 6,
      losses: 4,
      draws: 0,
      kd: 1.25,
      acs: 250,
      adr: 160,
      winRate: 60,
      headshotPct: 25,
      trackerScore: 57,
      totalMatches: 42,
      lastMatchAt: "2026-09-20T18:00:00.000Z",
    });
    expect(db.tx.playerMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { playerId: "player-1" }, take: 10 }),
    );
    expect(db.tx.playerStats.upsert).toHaveBeenCalledWith({
      where: { playerId: "player-1" },
      create: { playerId: "player-1", ...stats },
      update: stats,
    });
  });

  it("is idempotent: the same stored matches always produce the same row", async () => {
    await refreshPlayerStats("player-1");
    await refreshPlayerStats("player-1");

    const [first, second] = db.tx.playerStats.upsert.mock.calls;
    expect(second).toEqual(first);
  });

  it("arms the sync cooldown in the same transaction only when asked to", async () => {
    await refreshPlayerStats("player-1");
    expect(db.tx.player.update).not.toHaveBeenCalled();

    const syncedAt = new Date("2026-10-04T12:00:00Z");
    await refreshPlayerStats("player-1", { syncedAt });
    expect(db.tx.player.update).toHaveBeenCalledWith({ where: { id: "player-1" }, data: { lastSyncedAt: syncedAt } });
    expect(db.tx.player.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      db.tx.playerStats.upsert.mock.invocationCallOrder[1],
    );
  });

  it("uses the newest match that has a start time for lastMatchAt", async () => {
    db.tx.playerMatch.findMany.mockResolvedValue([storedLine("m0", null, true), ...fixtureLines.slice(0, 9)]);

    expect((await refreshPlayerStats("player-1")).lastMatchAt).toBe("2026-09-20T18:00:00.000Z");
  });

  it("writes zeros for a player with no stored matches", async () => {
    db.tx.playerMatch.findMany.mockResolvedValue([]);
    db.tx.playerMatch.count.mockResolvedValue(0);

    expect(await refreshPlayerStats("player-1")).toMatchObject({
      matches: 0,
      kd: 0,
      acs: 0,
      winRate: 0,
      trackerScore: 0,
      totalMatches: 0,
      lastMatchAt: null,
    });
  });

  it("propagates a failure so the caller can fail the sync", async () => {
    db.tx.playerStats.upsert.mockRejectedValue(new Error("deadlock detected"));

    await expect(refreshPlayerStats("player-1")).rejects.toThrow("deadlock detected");
  });
});
