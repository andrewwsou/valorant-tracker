import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));
vi.mock("@/lib/henrik", () => ({ getMatches: vi.fn() }));
vi.mock("@/services/matches", () => ({ invalidateRecentMatches: vi.fn() }));
vi.mock("@/services/player-stats", () => ({ refreshPlayerStats: vi.fn() }));

import { Prisma } from "@/generated/prisma";
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
  uniqueByKey,
} from "@/services/sync";

/** The mocked Prisma client, typed loosely so tests stay readable. */
const db = prisma as unknown as {
  player: Record<"findUnique" | "upsert" | "update", Mock>;
  $executeRaw: Mock;
};

/** Rebuilds the nth raw statement sent, as SQL text plus its bound values. */
function rawStatement(n: number) {
  const [strings, ...values] = db.$executeRaw.mock.calls[n];
  return Prisma.sql(strings as TemplateStringsArray, ...values);
}

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
  return { status: 200, contentType: "application/json", body: JSON.stringify({ data: matches }), cache: "MISS" as const };
}

function upstreamError(status: number, retryAfterSeconds?: number) {
  return { status, contentType: "application/json", body: "{}", cache: "MISS" as const, retryAfterSeconds };
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

  it("stores null for values of the wrong type, so one bad value can't fail the whole batch", () => {
    const odd = {
      metadata: { map: 42, mode: { name: "x" }, game_start: "yesterday" },
      teams: { red: { rounds_won: "13" }, blue: { rounds_won: 1e12 } },
    } as unknown as HenrikMatch;
    expect(toMatchRecord(odd, "na")).toEqual({
      map: null,
      mode: null,
      region: "na",
      startedAt: null,
      roundsRed: null,
      roundsBlue: null,
    });

    const line = toPlayerMatchRecord({
      team: 7,
      damage_made: Number.NaN,
      stats: { kills: "18", deaths: 9.7, assists: null, score: Infinity },
      assets: { agent: { small: ["x"] } },
    } as unknown as HenrikPlayer);
    expect(line).toMatchObject({ team: null, kills: null, deaths: 9, assists: null, score: null, damage: null, agentIcon: null });
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

describe("uniqueByKey", () => {
  it("keeps the last row per key and sorts by key, so batches never deadlock", () => {
    const rows = [
      { id: "m2", v: 1 },
      { id: "m1", v: 2 },
      { id: "m2", v: 3 },
    ];
    expect(uniqueByKey(rows, (r) => r.id)).toEqual([
      { id: "m1", v: 2 },
      { id: "m2", v: 3 },
    ]);
  });
});

describe("syncPlayer", () => {
  beforeEach(() => {
    db.player.findUnique.mockResolvedValue(null);
    db.player.upsert.mockResolvedValue({ id: "player-1" });
    // Like Postgres: the number of rows a batch inserted or updated. Match rows bind
    // 7 values each; stat lines bind 12 (their id is generated in SQL).
    db.$executeRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const perRow = strings[0].includes('"PlayerMatch"') ? 12 : 7;
      return Promise.resolve((values[0] as Prisma.Sql).values.length / perRow);
    });
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

  it("writes every match and the player's stat lines in two statements, then clears the cached list", async () => {
    await expect(syncPlayer(id)).resolves.toEqual({ status: "synced", matchesUpserted: 2, playerMatchesUpserted: 2 });

    expect(db.player.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { puuid: "puuid-me" }, create: { puuid: "puuid-me", name: "Enzo", tag: "YYY" } }),
    );
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    const matches = rawStatement(0);
    expect(matches.sql).toContain('INSERT INTO "Match"');
    expect(matches.sql).toContain('ON CONFLICT ("id") DO UPDATE');
    expect(matches.sql).toContain("::timestamptz AT TIME ZONE 'UTC'");
    expect(matches.values).toEqual(["m1", "Haven", "Competitive", "na", new Date(GAME_START * 1000), 13, 9, "m2", "Haven", "Competitive", "na", new Date(GAME_START * 1000), 13, 9]);

    const lines = rawStatement(1);
    expect(lines.sql).toContain('INSERT INTO "PlayerMatch"');
    expect(lines.sql).toContain('ON CONFLICT ("matchId", "playerId") DO UPDATE');
    expect(lines.values.slice(0, 4)).toEqual(["m1", "player-1", "red", 18]);

    // Stats are rebuilt, and the cooldown armed, only after the stat lines are written.
    expect(refreshPlayerStats).toHaveBeenCalledExactlyOnceWith("player-1", { syncedAt: expect.any(Date) });
    const lastWrite = Math.max(...db.$executeRaw.mock.invocationCallOrder);
    expect(vi.mocked(refreshPlayerStats).mock.invocationCallOrder[0]).toBeGreaterThan(lastWrite);
    expect(invalidateRecentMatches).toHaveBeenCalledWith("Enzo", "YYY");
  });

  it("sends each match once, in a fixed order, even when upstream repeats one", async () => {
    const renamed = match("m2");
    renamed.metadata!.map = "Lotus";
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([match("m2"), match("m1"), renamed]));

    await expect(syncPlayer(id)).resolves.toMatchObject({ matchesUpserted: 2, playerMatchesUpserted: 2 });

    const values = rawStatement(0).values;
    expect([values[0], values[7]]).toEqual(["m1", "m2"]);
    // The last copy wins, like the old row-by-row loop.
    expect(values[8]).toBe("Lotus");
    expect([rawStatement(1).values[0], rawStatement(1).values[12]]).toEqual(["m1", "m2"]);
  });

  it("skips a match whose ID isn't a string", async () => {
    const numbered = match("m1");
    (numbered.metadata as { matchid: unknown }).matchid = 123;
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([numbered, match("m2")]));

    await expect(syncPlayer(id)).resolves.toMatchObject({ matchesUpserted: 1 });
  });

  it("skips matches without an ID and matches the player isn't in", async () => {
    vi.mocked(getMatches).mockResolvedValue(
      upstreamMatches([match("m1"), match(undefined), match("m3", [someoneElse])]),
    );

    await expect(syncPlayer(id)).resolves.toEqual({ status: "synced", matchesUpserted: 2, playerMatchesUpserted: 1 });
  });

  it("sends no statement for an empty batch", async () => {
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([match(undefined)]));

    await expect(syncPlayer(id)).resolves.toEqual({ status: "synced", matchesUpserted: 0, playerMatchesUpserted: 0 });
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("passes upstream errors through, with how long to wait, without writing anything", async () => {
    vi.mocked(getMatches).mockResolvedValue(upstreamError(429, 25));

    await expect(syncPlayer(id)).resolves.toMatchObject({ status: "upstream-error", httpStatus: 429, retryAfterSeconds: 25 });
    expect(db.player.upsert).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("reports an empty match history", async () => {
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([]));

    await expect(syncPlayer(id)).resolves.toEqual({ status: "no-matches" });
  });

  it("doesn't rebuild stats when nothing was written", async () => {
    db.player.findUnique.mockResolvedValueOnce({ lastSyncedAt: new Date() });
    await syncPlayer(id); // skipped by the cooldown
    vi.mocked(getMatches).mockResolvedValue(upstreamError(404));
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
