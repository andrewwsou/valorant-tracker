import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { player: { findUnique: vi.fn() }, playerMatch: { findMany: vi.fn() } },
}));
vi.mock("@/lib/redis", () => ({ cacheGetJson: vi.fn(), cacheSetJson: vi.fn(), cacheDelete: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { cacheDelete, cacheGetJson, cacheSetJson } from "@/lib/redis";
import { getRecentMatches, invalidateRecentMatches } from "@/services/matches";

const db = prisma as unknown as {
  player: Record<"findUnique", Mock>;
  playerMatch: Record<"findMany", Mock>;
};

const player = { id: "player-1", name: "enzo", tag: "yyy", puuid: "puuid-me" };

const storedLine = {
  matchId: "m1",
  team: "red",
  kills: 18,
  deaths: 9,
  assists: 7,
  score: 5055,
  damage: 3100,
  headshots: 12,
  bodyshots: 30,
  legshots: 2,
  agentIcon: "agent.png",
  match: {
    map: "Haven",
    mode: "Competitive",
    region: "na",
    startedAt: new Date("2026-10-03T19:44:00.000Z"),
    roundsRed: 13,
    roundsBlue: 3,
  },
};

beforeEach(() => {
  vi.mocked(cacheGetJson).mockResolvedValue(null);
  vi.mocked(cacheSetJson).mockResolvedValue(undefined);
  db.player.findUnique.mockResolvedValue(player);
  db.playerMatch.findMany.mockResolvedValue([storedLine]);
});

describe("getRecentMatches", () => {
  it("serves a cached list without touching the database", async () => {
    vi.mocked(cacheGetJson).mockResolvedValue({ player, data: [] });

    await expect(getRecentMatches("enzo", "yyy", 10)).resolves.toEqual({ cache: "HIT", player, data: [] });
    expect(db.player.findUnique).not.toHaveBeenCalled();
  });

  it("reads the newest matches, flattens them into rows, and caches them for 60 seconds", async () => {
    const result = await getRecentMatches("Enzo", "YYY", 10);

    expect(db.playerMatch.findMany).toHaveBeenCalledWith({
      where: { playerId: "player-1" },
      include: { match: true },
      orderBy: [{ match: { startedAt: "desc" } }, { matchId: "desc" }],
      take: 10,
    });
    expect(result.cache).toBe("MISS");
    expect(result.data).toEqual([
      expect.objectContaining({
        matchId: "m1",
        map: "Haven",
        startedAt: "2026-10-03T19:44:00.000Z",
        roundsRed: 13,
        roundsBlue: 3,
        kills: 18,
      }),
    ]);
    expect(cacheSetJson).toHaveBeenCalledWith("dbmatches:v2:enzo:yyy:limit=10", { player, data: result.data }, 60);
  });

  it("remembers a missing player for only 15 seconds", async () => {
    db.player.findUnique.mockResolvedValue(null);

    await expect(getRecentMatches("ghost", "0000", 10)).resolves.toMatchObject({ player: null, data: [] });
    expect(cacheSetJson).toHaveBeenCalledWith("dbmatches:v2:ghost:0000:limit=10", expect.anything(), 15);
  });

  it("still reads from the database when the cache is down", async () => {
    vi.mocked(cacheGetJson).mockRejectedValue(new Error("redis down"));
    vi.mocked(cacheSetJson).mockRejectedValue(new Error("redis down"));

    await expect(getRecentMatches("enzo", "yyy", 10)).resolves.toMatchObject({ cache: "MISS", player });
  });
});

describe("invalidateRecentMatches", () => {
  it("clears every cached list size for the player", async () => {
    await invalidateRecentMatches("Enzo", "YYY");

    expect(cacheDelete).toHaveBeenCalledWith("dbmatches:v2:enzo:yyy:limit=10", "dbmatches:v2:enzo:yyy:limit=25");
  });
});
