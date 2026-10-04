import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { playerStats: { findMany: vi.fn() } } }));

import { prisma } from "@/lib/prisma";
import { getLeaderboard, LEADERBOARD_DEFAULTS, parseLeaderboardQuery } from "@/services/leaderboard";

const db = prisma as unknown as { playerStats: { findMany: Mock } };
const parse = (query: string) => parseLeaderboardQuery(new URLSearchParams(query));

/** A PlayerStats row as Prisma returns it, with the player's name included. */
function statsRow(name: string, overrides: Record<string, unknown> = {}) {
  return {
    playerId: `id-${name}`,
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
    totalMatches: 10,
    lastMatchAt: new Date("2026-09-20T18:00:00Z"),
    updatedAt: new Date("2026-10-04T12:00:00Z"),
    player: { name, tag: "NA1" },
    ...overrides,
  };
}

describe("parseLeaderboardQuery", () => {
  it("uses the defaults when nothing is given", () => {
    expect(parse("")).toEqual({ ok: true, value: LEADERBOARD_DEFAULTS });
  });

  it("reads every allowed sort and the numeric options", () => {
    for (const sort of ["trackerScore", "acs", "kd", "winRate"]) {
      expect(parse(`sort=${sort}`)).toMatchObject({ ok: true, value: { sort } });
    }
    expect(parse("minMatches=1&limit=100")).toMatchObject({ ok: true, value: { minMatches: 1, limit: 100 } });
  });

  it("rejects sorts outside the allowlist, so input never picks an arbitrary column", () => {
    for (const sort of ["adr", "playerId", "kd;drop", "ACS"]) {
      expect(parse(`sort=${sort}`).ok, sort).toBe(false);
    }
  });

  it("treats empty values as the defaults", () => {
    expect(parse("sort=&minMatches=&limit=")).toEqual({ ok: true, value: LEADERBOARD_DEFAULTS });
  });

  it("rejects out-of-range or non-numeric limits and minimums", () => {
    for (const query of ["minMatches=0", "minMatches=11", "minMatches=5x", "limit=0", "limit=101", "limit=-3", "limit=2.5"]) {
      expect(parse(query).ok, query).toBe(false);
    }
  });
});

describe("getLeaderboard", () => {
  beforeEach(() => {
    db.playerStats.findMany.mockResolvedValue([]);
  });

  it("runs one query that filters by sample size and matches the (stat DESC, playerId) index", async () => {
    await getLeaderboard({ sort: "acs", minMatches: 5, limit: 25 });

    expect(db.playerStats.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { matches: { gte: 5 } },
      orderBy: [{ acs: "desc" }, { playerId: "asc" }],
      take: 25,
      include: { player: { select: { name: true, tag: true } } },
    });
  });

  it("returns ranked entries with the player's Riot ID and ISO dates", async () => {
    db.playerStats.findMany.mockResolvedValue([statsRow("Ace", { trackerScore: 72 }), statsRow("Tester")]);

    const entries = await getLeaderboard(LEADERBOARD_DEFAULTS);

    expect(entries.map((e) => [e.rank, `${e.name}#${e.tag}`, e.trackerScore])).toEqual([
      [1, "Ace#NA1", 72],
      [2, "Tester#NA1", 57],
    ]);
    expect(entries[0]).toMatchObject({ lastMatchAt: "2026-09-20T18:00:00.000Z", updatedAt: "2026-10-04T12:00:00.000Z" });
    expect(entries[0]).not.toHaveProperty("playerId");
  });

  it("gives exactly tied players the same rank and skips the next one (1, 2, 2, 4)", async () => {
    db.playerStats.findMany.mockResolvedValue([
      statsRow("A", { trackerScore: 80 }),
      statsRow("B", { trackerScore: 70 }),
      statsRow("C", { trackerScore: 70 }),
      statsRow("D", { trackerScore: 60 }),
    ]);

    const ranks = (await getLeaderboard(LEADERBOARD_DEFAULTS)).map((e) => e.rank);

    expect(ranks).toEqual([1, 2, 2, 4]);
  });

  it("compares unrounded values, so near-ties keep distinct ranks", async () => {
    db.playerStats.findMany.mockResolvedValue([statsRow("A", { acs: 250.4 }), statsRow("B", { acs: 250.2 })]);

    const entries = await getLeaderboard({ ...LEADERBOARD_DEFAULTS, sort: "acs" });

    expect(entries.map((e) => e.rank)).toEqual([1, 2]);
  });

  it("handles a player who has never recorded a match time", async () => {
    db.playerStats.findMany.mockResolvedValue([statsRow("A", { lastMatchAt: null })]);

    expect((await getLeaderboard(LEADERBOARD_DEFAULTS))[0].lastMatchAt).toBeNull();
  });
});
