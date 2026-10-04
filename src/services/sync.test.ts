import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    match: { upsert: vi.fn() },
    playerMatch: { upsert: vi.fn() },
  },
}));
vi.mock("@/lib/henrik", () => ({ getMatches: vi.fn() }));
vi.mock("@/services/matches", () => ({ invalidateRecentMatches: vi.fn() }));
vi.mock("@/services/player-stats", () => ({ refreshPlayerStats: vi.fn() }));

import { getMatches, type HenrikMatch, type HenrikPlayer } from "@/lib/henrik";
import { prisma } from "@/lib/prisma";
import type { RiotId } from "@/lib/riot-id";
import { invalidateRecentMatches } from "@/services/matches";
import { refreshPlayerStats } from "@/services/player-stats";
import {
  findPlayerByRiotId,
  SYNC_COOLDOWN_MS,
  syncPlayer,
  toMatchRecord,
  toPlayerMatchRecord,
} from "@/services/sync";

/** The mocked Prisma client, typed loosely so tests stay readable. */
const db = prisma as unknown as {
  player: Record<"findUnique" | "upsert" | "update", Mock>;
  match: Record<"upsert", Mock>;
  playerMatch: Record<"upsert", Mock>;
};

const id: RiotId = { region: "na", name: "Enzo", tag: "YYY" };
const GAME_START = 1_759_500_000;

function me(): HenrikPlayer {
  return {
    puuid: "puuid-me",
    name: "enzo",
    tag: "yyy",
    team: "Red",
    damage_made: 3100,
    stats: { kills: 18, deaths: 9, assists: 7, score: 5055, headshots: 12, bodyshots: 30, legshots: 2 },
    assets: { agent: { small: "agent.png" } },
  };
}

const someoneElse: HenrikPlayer = { puuid: "puuid-other", name: "other", tag: "0001", team: "Blue" };

function match(matchid: string | undefined, players: HenrikPlayer[] = [me(), someoneElse]): HenrikMatch {
  return {
    metadata: { matchid, map: "Haven", mode: "Competitive", game_start: GAME_START },
    players: { all_players: players },
    teams: { red: { rounds_won: 13 }, blue: { rounds_won: 9 } },
  };
}

function upstreamMatches(matches: HenrikMatch[]) {
  return { status: 200, contentType: "application/json", body: JSON.stringify({ data: matches }) };
}

describe("mapping upstream data", () => {
  it("converts a match, turning the start time from seconds into a Date", () => {
    expect(toMatchRecord(match("m1"), "na")).toEqual({
      map: "Haven",
      mode: "Competitive",
      region: "na",
      startedAt: new Date(GAME_START * 1000),
      roundsRed: 13,
      roundsBlue: 9,
    });
  });

  it("stores null for anything the upstream left out", () => {
    expect(toMatchRecord({}, "eu")).toEqual({
      map: null,
      mode: null,
      region: "eu",
      startedAt: null,
      roundsRed: null,
      roundsBlue: null,
    });
  });

  it("converts a player's stat line and lowercases the team", () => {
    expect(toPlayerMatchRecord(me())).toEqual({
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
    });
  });

  it("finds a player by Riot ID regardless of case", () => {
    expect(findPlayerByRiotId(match("m1"), "ENZO", "YyY")?.puuid).toBe("puuid-me");
    expect(findPlayerByRiotId(match("m1"), "nobody", "0000")).toBeUndefined();
  });
});

describe("syncPlayer", () => {
  beforeEach(() => {
    db.player.findUnique.mockResolvedValue(null);
    db.player.upsert.mockResolvedValue({ id: "player-1" });
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([match("m1"), match("m2")]));
  });

  it("skips inside the cooldown without calling upstream", async () => {
    db.player.findUnique.mockResolvedValue({ lastSyncedAt: new Date(Date.now() - 60_000) });

    await expect(syncPlayer(id)).resolves.toMatchObject({ status: "skipped" });
    expect(getMatches).not.toHaveBeenCalled();
  });

  it("syncs again once the cooldown has passed", async () => {
    db.player.findUnique.mockResolvedValue({ lastSyncedAt: new Date(Date.now() - SYNC_COOLDOWN_MS - 1_000) });

    await expect(syncPlayer(id)).resolves.toMatchObject({ status: "synced" });
    expect(getMatches).toHaveBeenCalledWith("na", "Enzo", "YYY", { size: 10, mode: "competitive" });
  });

  it("upserts every match and the player's stat line, then clears the cached list", async () => {
    await expect(syncPlayer(id)).resolves.toEqual({ status: "synced", matchesUpserted: 2, playerMatchesUpserted: 2 });

    expect(db.player.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { puuid: "puuid-me" }, create: { puuid: "puuid-me", name: "Enzo", tag: "YYY" } }),
    );
    expect(db.match.upsert).toHaveBeenCalledTimes(2);
    expect(db.playerMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { matchId_playerId: { matchId: "m1", playerId: "player-1" } } }),
    );
    // Stats are rebuilt, and the cooldown armed, only after the last stat line is written.
    expect(refreshPlayerStats).toHaveBeenCalledExactlyOnceWith("player-1", { syncedAt: expect.any(Date) });
    const lastLineWrite = Math.max(...db.playerMatch.upsert.mock.invocationCallOrder);
    expect(vi.mocked(refreshPlayerStats).mock.invocationCallOrder[0]).toBeGreaterThan(lastLineWrite);
    expect(invalidateRecentMatches).toHaveBeenCalledWith("Enzo", "YYY");
  });

  it("skips matches without an ID and matches the player isn't in", async () => {
    vi.mocked(getMatches).mockResolvedValue(
      upstreamMatches([match("m1"), match(undefined), match("m3", [someoneElse])]),
    );

    await expect(syncPlayer(id)).resolves.toEqual({ status: "synced", matchesUpserted: 2, playerMatchesUpserted: 1 });
  });

  it("passes upstream errors through without writing anything", async () => {
    vi.mocked(getMatches).mockResolvedValue({ status: 429, contentType: "application/json", body: "{}" });

    await expect(syncPlayer(id)).resolves.toMatchObject({ status: "upstream-error", httpStatus: 429 });
    expect(db.player.upsert).not.toHaveBeenCalled();
    expect(db.match.upsert).not.toHaveBeenCalled();
  });

  it("reports an empty match history", async () => {
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([]));

    await expect(syncPlayer(id)).resolves.toEqual({ status: "no-matches" });
  });

  it("doesn't rebuild stats when nothing was written", async () => {
    db.player.findUnique.mockResolvedValueOnce({ lastSyncedAt: new Date() });
    await syncPlayer(id); // skipped by the cooldown
    vi.mocked(getMatches).mockResolvedValue({ status: 404, contentType: "application/json", body: "{}" });
    await syncPlayer(id); // upstream error
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([]));
    await syncPlayer(id); // no matches

    expect(refreshPlayerStats).not.toHaveBeenCalled();
  });

  it("fails, and leaves the cooldown off, when the stats rebuild fails", async () => {
    vi.mocked(refreshPlayerStats).mockRejectedValue(new Error("database down"));

    await expect(syncPlayer(id)).rejects.toThrow("database down");
    expect(db.player.update).not.toHaveBeenCalled();
    expect(invalidateRecentMatches).not.toHaveBeenCalled();
  });

  it("still succeeds when clearing the cache fails", async () => {
    vi.mocked(invalidateRecentMatches).mockRejectedValue(new Error("redis down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(syncPlayer(id)).resolves.toMatchObject({ status: "synced" });
  });
});
