import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/henrik", () => ({ getMatches: vi.fn(), getAccount: vi.fn(), rememberUnreadableMatches: vi.fn() }));
vi.mock("@/lib/redis", () => ({ claimLock: vi.fn(), releaseLock: vi.fn(), lockHeld: vi.fn() }));
vi.mock("@/services/matches", () => ({ invalidateRecentMatches: vi.fn() }));
vi.mock("@/services/player-stats", () => ({ refreshPlayerStats: vi.fn() }));

import { Prisma } from "@/generated/prisma";
import { getAccount, getMatches, rememberUnreadableMatches } from "@/lib/henrik";
import { MatchV4 } from "@/lib/henrik-schemas";
import { prisma } from "@/lib/prisma";
import { claimLock, lockHeld, releaseLock } from "@/lib/redis";
import type { RiotId } from "@/lib/riot-id";
import { invalidateRecentMatches } from "@/services/matches";
import { refreshPlayerStats } from "@/services/player-stats";
import {
  agentIconUrl,
  findPlayerByRiotId,
  SYNC_COOLDOWN_MS,
  SYNC_WAIT_MS,
  syncPlayer,
  toMatchRecord,
  toPlayerMatchRecord,
  uniqueByKey,
} from "@/services/sync";

/** The mocked Prisma client, typed loosely so tests stay readable. */
const db = prisma as unknown as {
  player: Record<"findUnique" | "upsert" | "update" | "updateMany", Mock>;
  $executeRaw: Mock;
  $queryRaw: Mock;
  $transaction: Mock;
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

/** The test player's line, shaped like HenrikDev's v4 match list, with HenrikDev's capitalization. */
function me(): RawPlayer {
  return {
    puuid: "puuid-me",
    name: "Enzo",
    tag: "YYY",
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

/** A stored player row, as runSync selects it. */
function stored(overrides: Record<string, unknown> = {}) {
  return { id: "player-1", puuid: "puuid-me", name: "Enzo", tag: "YYY", riotIdKey: "enzo#yyy", lastSyncedAt: null, ...overrides };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe("syncPlayer", () => {
  beforeEach(() => {
    db.player.findUnique.mockResolvedValue(null);
    // The identity write: an interactive transaction over the same mocked client.
    db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
    db.player.updateMany.mockResolvedValue({ count: 0 });
    db.$queryRaw.mockResolvedValue([]);
    db.player.upsert.mockImplementation(({ create }: { create: Record<string, unknown> }) => Promise.resolve(stored(create)));
    // Like Postgres: the number of rows a batch inserted or updated. Match rows bind
    // 7 values each; stat lines bind 12 (their id is generated in SQL).
    db.$executeRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const perRow = strings[0].includes('"PlayerMatch"') ? 12 : 7;
      return Promise.resolve((values[0] as Prisma.Sql).values.length / perRow);
    });
    vi.mocked(claimLock).mockResolvedValue(true);
    vi.mocked(releaseLock).mockResolvedValue(undefined);
    vi.mocked(lockHeld).mockResolvedValue(false);
    vi.mocked(getMatches).mockResolvedValue(upstreamMatches([match("m1"), match("m2")]));
  });

  describe("cooldown and lookup", () => {
    it("skips inside the cooldown, for any capitalization, without calling upstream", async () => {
      db.player.findUnique.mockResolvedValue(stored({ lastSyncedAt: minutesAgo(1) }));

      await expect(syncPlayer({ region: "na", name: "eNZO", tag: "yyy" })).resolves.toMatchObject({
        status: "skipped",
        player: "Enzo#YYY",
      });
      expect(db.player.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { riotIdKey: "enzo#yyy" } }));
      expect(getMatches).not.toHaveBeenCalled();
      expect(claimLock).not.toHaveBeenCalled();
    });

    it("syncs again once the cooldown has passed", async () => {
      db.player.findUnique.mockResolvedValue(stored({ lastSyncedAt: new Date(Date.now() - SYNC_COOLDOWN_MS - 1_000) }));

      await expect(syncPlayer(id)).resolves.toMatchObject({ status: "synced" });
      expect(getMatches).toHaveBeenCalledWith({ region: "na", name: "Enzo", tag: "YYY" }, { size: 10, mode: "competitive" });
    });
  });

  describe("one sync per player at a time", () => {
    it("locks by the Riot ID key, which a new player's first sync doesn't change, then releases the lock", async () => {
      db.player.findUnique.mockResolvedValue(stored());
      await syncPlayer({ region: "na", name: "eNZO", tag: "yyy" });
      expect(claimLock).toHaveBeenCalledWith("sync:v1:claim:riot:enzo#yyy", expect.any(String), 30_000);

      db.player.findUnique.mockResolvedValue(null);
      await syncPlayer({ region: "na", name: "New", tag: "One" });
      expect(claimLock).toHaveBeenLastCalledWith("sync:v1:claim:riot:new#one", expect.any(String), 30_000);

      // A sync by PUUID takes the lock of the row's Riot ID, shared with views of that profile,
      // or the PUUID's own when the row has no Riot ID any more.
      db.player.findUnique.mockResolvedValue(stored());
      await syncPlayer({ region: "na", puuid: "puuid-me" });
      expect(claimLock).toHaveBeenLastCalledWith("sync:v1:claim:riot:enzo#yyy", expect.any(String), 30_000);
      db.player.findUnique.mockResolvedValue(stored({ riotIdKey: null }));
      await syncPlayer({ region: "na", puuid: "puuid-me" });
      expect(claimLock).toHaveBeenLastCalledWith("sync:v1:claim:puuid:puuid-me", expect.any(String), 30_000);

      // Each release names the token its own claim used.
      const tokens = vi.mocked(claimLock).mock.calls.map((c) => c[1]);
      expect(vi.mocked(releaseLock).mock.calls.map((c) => c[1])).toEqual(tokens);
    });

    it("waits for another caller's sync instead of calling upstream, then reports its result", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(claimLock).mockResolvedValue(false);
        vi.mocked(lockHeld).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
        db.player.findUnique.mockResolvedValueOnce(null).mockResolvedValue(stored({ lastSyncedAt: new Date() }));

        const started = Date.now();
        let settledAt = 0;
        const result = syncPlayer(id).finally(() => (settledAt = Date.now()));
        await vi.advanceTimersByTimeAsync(1_000);

        await expect(result).resolves.toMatchObject({ status: "skipped", player: "Enzo#YYY" });
        // It polled until the other sync let go (two 250 ms waits), and only then looked.
        expect(lockHeld).toHaveBeenCalledTimes(3);
        expect(settledAt - started).toBe(500);
        expect(getMatches).not.toHaveBeenCalled();
        expect(releaseLock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives up waiting after 15 seconds and says the sync is still in progress", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(claimLock).mockResolvedValue(false);
        vi.mocked(lockHeld).mockResolvedValue(true);
        let settled = false;

        const result = syncPlayer(id).finally(() => (settled = true));
        await vi.advanceTimersByTimeAsync(SYNC_WAIT_MS - 500);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);

        await expect(result).resolves.toEqual({ status: "in-progress" });
        expect(getMatches).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops waiting as soon as the player is fresh, even if the lock is left behind", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(claimLock).mockResolvedValue(false);
        vi.mocked(lockHeld).mockResolvedValue(true);
        db.player.findUnique.mockResolvedValueOnce(null).mockResolvedValue(stored({ lastSyncedAt: new Date() }));
        let settled = false;

        const result = syncPlayer(id).finally(() => (settled = true));
        await vi.advanceTimersByTimeAsync(1_000);

        expect(settled).toBe(true);
        await expect(result).resolves.toMatchObject({ status: "skipped" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("tries once itself when the sync it waited for ended without fresh data", async () => {
      vi.useFakeTimers();
      try {
        // The other sync failed: it let go, and nothing is fresh. This caller then gets the
        // lock and syncs, which usually answers from the cached failure.
        vi.mocked(claimLock).mockResolvedValueOnce(false).mockResolvedValue(true);
        vi.mocked(lockHeld).mockResolvedValue(false);
        vi.mocked(getMatches).mockResolvedValue(upstreamError(404));

        const result = syncPlayer(id);
        await vi.advanceTimersByTimeAsync(1_000);

        await expect(result).resolves.toMatchObject({ status: "upstream-error", httpStatus: 404 });
        expect(claimLock).toHaveBeenCalledTimes(2);
        expect(getMatches).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("syncs without the lock when Redis is down, and still releases it in case the claim landed", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(claimLock).mockRejectedValue(new Error("timeout"));

      await expect(syncPlayer(id)).resolves.toMatchObject({ status: "synced" });
      expect(getMatches).toHaveBeenCalledOnce();
      // Releasing compares the token, so this is harmless if the claim never landed.
      expect(releaseLock).toHaveBeenCalledOnce();
    });

    it("skips after winning the lock if another sync finished just before", async () => {
      db.player.findUnique.mockResolvedValueOnce(stored()).mockResolvedValue(stored({ lastSyncedAt: new Date() }));

      await expect(syncPlayer(id)).resolves.toMatchObject({ status: "skipped" });
      expect(getMatches).not.toHaveBeenCalled();
      expect(releaseLock).toHaveBeenCalledOnce();
    });

    it("releases the lock even when the sync fails", async () => {
      vi.mocked(getMatches).mockRejectedValue(new Error("boom"));

      await expect(syncPlayer(id)).rejects.toThrow("boom");
      expect(releaseLock).toHaveBeenCalledOnce();
    });
  });

  describe("who the player is", () => {
    it("stores HenrikDev's capitalization, not the URL's, and takes the Riot ID from any other row", async () => {
      await expect(syncPlayer({ region: "na", name: "ENZO", tag: "yyy" })).resolves.toMatchObject({ player: "Enzo#YYY" });

      expect(db.player.updateMany).toHaveBeenCalledWith({
        where: { riotIdKey: "enzo#yyy", OR: [{ puuid: null }, { puuid: { not: "puuid-me" } }] },
        data: { riotIdKey: null },
      });
      expect(db.player.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { puuid: "puuid-me" },
          update: { name: "Enzo", tag: "YYY", riotIdKey: "enzo#yyy" },
          create: { puuid: "puuid-me", name: "Enzo", tag: "YYY", riotIdKey: "enzo#yyy" },
        }),
      );
    });

    it("gives the Riot ID to the list's owner, not a former holder of the name in an older match", async () => {
      // The owner took Enzo#YYY recently, so their matches still show their old name.
      // A former Enzo#YYY appears, under that name, in one older match.
      const owner = { ...me(), puuid: "puuid-owner", name: "Bravo" };
      const former = { ...me(), puuid: "puuid-former" };
      vi.mocked(getMatches).mockResolvedValue(
        upstreamMatches([match("m1", [owner, someoneElse]), match("m2", [owner, former]), match("m3", [owner])]),
      );

      await expect(syncPlayer(id)).resolves.toMatchObject({ status: "synced", player: "Enzo#YYY" });
      expect(db.player.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { puuid: "puuid-owner" } }));
      expect(getAccount).not.toHaveBeenCalled();
    });

    it("isn't fooled by a teammate who shares most of the matches", async () => {
      vi.mocked(getMatches).mockResolvedValue(
        upstreamMatches([match("m1", [me(), someoneElse]), match("m2", [me(), someoneElse]), match("m3", [me()])]),
      );

      await expect(syncPlayer(id)).resolves.toMatchObject({ status: "synced" });
      expect(db.player.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { puuid: "puuid-me" } }));
    });

    it("asks the account endpoint which of a duo in every match owns the Riot ID", async () => {
      // A renamed owner whose duo partner is in all the same matches: neither shows the name asked for.
      const renamed = { ...me(), name: "OldName" };
      vi.mocked(getMatches).mockResolvedValue(upstreamMatches([match("m1", [renamed, someoneElse]), match("m2", [renamed, someoneElse])]));
      vi.mocked(getAccount).mockResolvedValue({
        status: 200,
        contentType: "application/json",
        cache: "HIT",
        body: JSON.stringify({ status: 200, data: { puuid: "puuid-me", name: "Enzo", tag: "YYY", card: {} } }),
      });

      await expect(syncPlayer(id)).resolves.toMatchObject({ status: "synced", player: "Enzo#YYY", playerMatchesUpserted: 2 });
      expect(getAccount).toHaveBeenCalledWith("Enzo", "YYY");
      expect(db.player.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { puuid: "puuid-me" } }));
    });

    it("leaves Riot IDs alone when it can't tell which of a duo owns one", async () => {
      const renamed = { ...me(), name: "OldName" };
      vi.mocked(getMatches).mockResolvedValue(upstreamMatches([match("m1", [renamed, someoneElse])]));
      vi.mocked(getAccount).mockRejectedValue(new Error("timeout"));

      await expect(syncPlayer(id)).resolves.toEqual({ status: "player-not-in-matches" });
      expect(db.player.upsert).not.toHaveBeenCalled();
    });

    it("locks the rows involved in a fixed order before moving the Riot ID", async () => {
      await syncPlayer(id);

      const [sql, ...values] = db.$queryRaw.mock.calls[0];
      expect((sql as string[]).join("?")).toContain('WHERE "riotIdKey" = ? OR puuid = ? ORDER BY id FOR UPDATE');
      expect(values).toEqual(["enzo#yyy", "puuid-me"]);
      expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.player.updateMany.mock.invocationCallOrder[0]);
    });

    it("retries the identity write once after a collision or a deadlock", async () => {
      for (const code of ["P2002", "P2034"]) {
        db.$transaction.mockReset();
        const clash = new Prisma.PrismaClientKnownRequestError("conflict", { code, clientVersion: "6" });
        db.$transaction.mockRejectedValueOnce(clash).mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));

        await expect(syncPlayer(id), code).resolves.toMatchObject({ status: "synced" });
        expect(db.$transaction).toHaveBeenCalledTimes(2);
      }
    });
  });

  describe("by PUUID", () => {
    const target = { region: "eu", puuid: "puuid-me" } as const;

    it("only syncs players it already tracks, without calling upstream for others", async () => {
      await expect(syncPlayer(target)).resolves.toEqual({ status: "not-tracked" });
      expect(db.player.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { puuid: "puuid-me" } }));
      expect(getMatches).not.toHaveBeenCalled();
    });

    it("fetches by PUUID and never changes who the row is", async () => {
      db.player.findUnique.mockResolvedValue(stored({ name: "Enzo", riotIdKey: "enzo#yyy" }));

      await expect(syncPlayer(target)).resolves.toMatchObject({ status: "synced", player: "Enzo#YYY", matchesUpserted: 2 });
      expect(getMatches).toHaveBeenCalledWith({ region: "eu", puuid: "puuid-me" }, { size: 10, mode: "competitive" });
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(invalidateRecentMatches).toHaveBeenCalledWith("enzo#yyy");
    });

    it("skips clearing the cached list of a player whose Riot ID now belongs to someone else", async () => {
      db.player.findUnique.mockResolvedValue(stored({ riotIdKey: null }));

      await expect(syncPlayer(target)).resolves.toMatchObject({ status: "synced" });
      expect(invalidateRecentMatches).not.toHaveBeenCalled();
    });

    it("reports a PUUID that isn't in its own match list", async () => {
      db.player.findUnique.mockResolvedValue(stored());
      vi.mocked(getMatches).mockResolvedValue(upstreamMatches([match("m1", [someoneElse])]));

      await expect(syncPlayer(target)).resolves.toEqual({ status: "player-not-in-matches" });
    });
  });

  describe("writing matches", () => {
    it("writes every match and the player's stat lines in two statements, then clears the cached list", async () => {
      await expect(syncPlayer(id)).resolves.toEqual({
        status: "synced",
        player: "Enzo#YYY",
        matchesUpserted: 2,
        playerMatchesUpserted: 2,
      });

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
      expect(invalidateRecentMatches).toHaveBeenCalledWith("enzo#yyy");
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

    it("stores a match whose entry for the player was unreadable, without a stat line", async () => {
      vi.mocked(getMatches).mockResolvedValue(upstreamMatches([match("m1"), match("m2"), match("m3", [someoneElse])]));

      await expect(syncPlayer(id)).resolves.toMatchObject({ status: "synced", matchesUpserted: 3, playerMatchesUpserted: 2 });
    });

    it("finds the player in a later match when the first one has no players", async () => {
      vi.mocked(getMatches).mockResolvedValue(upstreamMatches([match("m1", []), match("m2")]));

      await expect(syncPlayer(id)).resolves.toMatchObject({ status: "synced", playerMatchesUpserted: 1 });
      expect(db.player.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { puuid: "puuid-me" } }));
    });
  });

  describe("when there's nothing to write", () => {
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
      expect(rememberUnreadableMatches).toHaveBeenCalledExactlyOnceWith({ region: "na", name: "Enzo", tag: "YYY" }, "competitive");

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
      db.player.findUnique.mockResolvedValueOnce(stored({ lastSyncedAt: new Date() }));
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
});
