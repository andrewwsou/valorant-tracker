import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));
vi.mock("@/lib/henrik", () => ({ getMatches: vi.fn(), rememberUnreadableMatches: vi.fn() }));
vi.mock("@/services/matches", () => ({ invalidateRecentMatches: vi.fn() }));
vi.mock("@/services/player-stats", () => ({ refreshPlayerStats: vi.fn() }));

import { Prisma } from "@/generated/prisma";
import { getMatches, rememberUnreadableMatches } from "@/lib/henrik";
import { MatchV4 } from "@/lib/henrik-schemas";
import { prisma } from "@/lib/prisma";
import type { RiotId } from "@/lib/riot-id";
import { invalidateRecentMatches } from "@/services/matches";
import { refreshPlayerStats } from "@/services/player-stats";
import {
  agentIconUrl,
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
/** Start of the test matches, with the fraction of a second HenrikDev includes. */
const STARTED_AT = "2026-09-30T19:24:10.940Z";
const STARTED_AT_WHOLE_SECONDS = new Date("2026-09-30T19:24:10.000Z");
const JETT = "add6443a-41bd-e414-f6ad-e58d267f4e95";

type RawPlayer = Record<string, unknown>;
type RawMatch = { metadata: Record<string, unknown>; players: RawPlayer[]; teams: unknown };

/** The test player's line, shaped like HenrikDev's v4 match list. */
function me(): RawPlayer {
  return {
    puuid: "puuid-me",
    name: "enzo",
    tag: "yyy",
    team_id: "Red",
    agent: { id: JETT, name: "Jett" },
    stats: {
      kills: 18,
      deaths: 9,
      assists: 7,
      score: 5055,
      headshots: 12,
      bodyshots: 30,
      legshots: 2,
      damage: { dealt: 3100, received: 2000 },
    },
  };
}

const someoneElse: RawPlayer = { puuid: "puuid-other", name: "other", tag: "0001", team_id: "Blue", agent: { name: "Sova" } };

/** A v4 match. A match_id of undefined is left out, like a broken upstream item. */
function match(matchId: string | undefined, players: RawPlayer[] = [me(), someoneElse]): RawMatch {
  return {
    metadata: {
      match_id: matchId,
      map: { id: "map-id", name: "Haven" },
      queue: { id: "competitive", name: "Competitive", mode_type: "Standard" },
      started_at: STARTED_AT,
    },
    players,
    teams: [
      { team_id: "Red", rounds: { won: 13, lost: 9 }, won: true },
      { team_id: "Blue", rounds: { won: 9, lost: 13 }, won: false },
    ],
  };
}

/** A raw match after validation, as the mappers receive it. */
const parsed = (raw: RawMatch) => MatchV4.parse(raw);

function upstreamMatches(matches: RawMatch[]) {
  return { status: 200, contentType: "application/json", body: JSON.stringify({ data: matches }), cache: "MISS" as const };
}

function upstreamError(status: number, retryAfterSeconds?: number) {
  return { status, contentType: "application/json", body: "{}", cache: "MISS" as const, retryAfterSeconds };
}

describe("mapping upstream data", () => {
  it("converts a v4 match into the same columns v3 produced", () => {
    expect(toMatchRecord(parsed(match("m1")), "na")).toEqual({
      map: "Haven",
      mode: "Competitive",
      region: "na",
      // Whole seconds, like v3's game_start, so re-synced rows don't change.
      startedAt: STARTED_AT_WHOLE_SECONDS,
      roundsRed: 13,
      roundsBlue: 9,
    });
  });

  it("stores null for anything the upstream left out or sent with the wrong type", () => {
    const odd = match("m1");
    odd.metadata = { match_id: "m1", map: 42, started_at: "yesterday" };
    odd.teams = "oops";

    expect(toMatchRecord(parsed(odd), "eu")).toEqual({
      map: null,
      mode: null,
      region: "eu",
      startedAt: null,
      roundsRed: null,
      roundsBlue: null,
    });
  });

  it("names the mode from the queue id when the queue name is null", () => {
    const m = match("m1");
    m.metadata.queue = { id: "competitive", name: null };
    expect(toMatchRecord(parsed(m), "na").mode).toBe("Competitive");
  });

  it("matches a team by name in any case, and leaves a missing team's rounds empty", () => {
    const m = match("m1");
    m.teams = [{ team_id: "RED", rounds: { won: 13 } }];
    expect(toMatchRecord(parsed(m), "na")).toMatchObject({ roundsRed: 13, roundsBlue: null });
  });

  it("converts a player's stat line: damage dealt, lowercase team, and the agent's icon", () => {
    expect(toPlayerMatchRecord(parsed(match("m1")).players[0])).toEqual({
      team: "red",
      kills: 18,
      deaths: 9,
      assists: 7,
      score: 5055,
      damage: 3100,
      headshots: 12,
      bodyshots: 30,
      legshots: 2,
      agentIcon: `https://media.valorant-api.com/agents/${JETT}/displayicon.png`,
    });
  });

  it("stores null stats for a player whose stats are missing or of the wrong type", () => {
    const player = { ...me(), team_id: 7, stats: { kills: "18", deaths: 9.7, damage: null }, agent: "Jett" };
    const line = toPlayerMatchRecord(parsed(match("m1", [player])).players[0]);
    expect(line).toMatchObject({ team: null, kills: null, deaths: 9, assists: null, damage: null, agentIcon: null });
  });

  it("builds an agent icon only from an id", () => {
    expect(agentIconUrl(null)).toBeNull();
    expect(agentIconUrl(JETT)).toBe(`https://media.valorant-api.com/agents/${JETT}/displayicon.png`);
  });

  it("finds a player by Riot ID regardless of case", () => {
    expect(findPlayerByRiotId(parsed(match("m1")), "ENZO", "YyY")?.puuid).toBe("puuid-me");
    expect(findPlayerByRiotId(parsed(match("m1")), "nobody", "0000")).toBeUndefined();
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
    expect(matches.values).toEqual(["m1", "Haven", "Competitive", "na", STARTED_AT_WHOLE_SECONDS, 13, 9, "m2", "Haven", "Competitive", "na", STARTED_AT_WHOLE_SECONDS, 13, 9]);

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
    renamed.metadata.map = { name: "Lotus" };
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([match("m2"), match("m1"), renamed]));

    await expect(syncPlayer(id)).resolves.toMatchObject({ matchesUpserted: 2, playerMatchesUpserted: 2 });

    const values = rawStatement(0).values;
    expect([values[0], values[7]]).toEqual(["m1", "m2"]);
    // The last copy wins, like the old row-by-row loop.
    expect(values[8]).toBe("Lotus");
    expect([rawStatement(1).values[0], rawStatement(1).values[12]]).toEqual(["m1", "m2"]);
  });

  it("drops a match it can't identify, stores the rest, and says so in the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const numbered = match("m1");
    numbered.metadata.match_id = 123;
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([numbered, match("m2"), match(undefined)]));

    await expect(syncPlayer(id)).resolves.toMatchObject({ status: "synced", matchesUpserted: 1 });
    expect(rawStatement(0).values[0]).toBe("m2");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("matches: dropped 2 of 3 items"));
  });

  it("keeps a match with one bad value, storing null just for that value", async () => {
    const odd = match("m1");
    (odd.players[0].stats as Record<string, unknown>).kills = "lots";
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([odd]));

    await expect(syncPlayer(id)).resolves.toMatchObject({ matchesUpserted: 1, playerMatchesUpserted: 1 });
    // matchId, playerId, team, then kills.
    expect(rawStatement(1).values.slice(0, 5)).toEqual(["m1", "player-1", "red", null, 9]);
  });

  it("skips matches the player isn't in", async () => {
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([match("m1"), match("m3", [someoneElse])]));

    await expect(syncPlayer(id)).resolves.toEqual({ status: "synced", matchesUpserted: 2, playerMatchesUpserted: 1 });
  });

  it("finds the player in a later match when the first one has no players", async () => {
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([match("m1", []), match("m2")]));

    await expect(syncPlayer(id)).resolves.toMatchObject({ status: "synced", playerMatchesUpserted: 1 });
    expect(db.player.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { puuid: "puuid-me" } }));
  });

  it("reports an answer it can't read at all, and writes nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const body of [JSON.stringify({ data: null }), "not json", JSON.stringify({ data: [match(undefined)] })]) {
      vi.mocked(getMatches).mockResolvedValue({ ...upstreamMatches([]), body });
      await expect(syncPlayer(id), body).resolves.toEqual({ status: "invalid-payload" });
    }
    expect(db.player.upsert).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(refreshPlayerStats).not.toHaveBeenCalled();
  });

  it("remembers a fresh unreadable list, so the next views don't download it again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // A full-size list where no match can be identified.
    const unreadable = upstreamMatches(Array.from({ length: 10 }, () => match(undefined)));
    expect(unreadable.body.length).toBeGreaterThan(512);
    vi.mocked(getMatches).mockResolvedValue(unreadable);

    await expect(syncPlayer(id)).resolves.toEqual({ status: "invalid-payload" });
    expect(rememberUnreadableMatches).toHaveBeenCalledExactlyOnceWith("na", "Enzo", "YYY", "competitive");

    vi.mocked(rememberUnreadableMatches).mockClear();
    vi.mocked(getMatches).mockResolvedValue({ ...unreadable, cache: "HIT" });
    await syncPlayer(id);
    expect(rememberUnreadableMatches).not.toHaveBeenCalled();
  });

  it("reports validation only for fresh answers, not for every view of a cached one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unreadable = { ...upstreamMatches([]), body: JSON.stringify({ data: null }) };

    vi.mocked(getMatches).mockResolvedValue({ ...unreadable, cache: "HIT" });
    await syncPlayer(id);
    expect(warn).not.toHaveBeenCalled();

    vi.mocked(getMatches).mockResolvedValue(unreadable);
    await syncPlayer(id);
    expect(warn).toHaveBeenCalledWith("[henrik] matches response had no readable data");
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
