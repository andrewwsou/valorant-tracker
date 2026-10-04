import { execSync, spawn } from "node:child_process";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "../src/generated/prisma";
import { lockPlayer } from "../src/services/player-lock";
import { appEnv, MOCK_API_URL, SYNC_AUTH } from "./env.mjs";
import { PLAYER } from "./fixtures.mjs";

// These tests check the PlayerStats table directly in the test database, so they
// can prove properties a page can't show: idempotency, concurrency, and locking.

const db = new PrismaClient({ datasourceUrl: appEnv.DATABASE_URL });
test.afterAll(() => db.$disconnect());

/** What the fixture's 10 matches must produce (the same numbers the profile shows). */
const FIXTURE_STATS = {
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
};

const testPlayer = () => db.player.findUniqueOrThrow({ where: { puuid: PLAYER.puuid }, include: { stats: true } });

/** Clears the cooldown, then syncs the test player through the API. */
async function syncNow(request: APIRequestContext) {
  await db.player.update({ where: { puuid: PLAYER.puuid }, data: { lastSyncedAt: null } });
  return request.post("/api/sync?name=Tester&tag=E2E", { headers: SYNC_AUTH });
}

test.beforeEach(async ({ page }) => {
  // Viewing the profile syncs the player when needed.
  await page.goto("/player/Tester/E2E");
  await expect(page.locator("tbody tr")).toHaveCount(10);
});

test("a sync stores the same stats the profile page shows", async () => {
  expect((await testPlayer()).stats).toMatchObject(FIXTURE_STATS);
});

test("match times are stored exactly, even when the database session isn't in UTC", async () => {
  // e2e/serve.mjs sets the test database's time zone to America/Los_Angeles.
  const [{ timezone }] = await db.$queryRaw<{ timezone: string }[]>`SELECT current_setting('TimeZone') AS timezone`;
  expect(timezone).toBe("America/Los_Angeles");

  const newest = await db.match.findUniqueOrThrow({ where: { id: "e2e-match-01" } });
  expect(newest.startedAt?.toISOString()).toBe("2026-09-20T18:00:00.000Z");
});

test("teammates syncing the same matches at once never deadlock or double count", async ({ request }) => {
  // Rival plays in every one of Tester's matches, so both syncs write the same Match rows.
  // Rival's list comes in the opposite order, so unsorted batches would lock those rows
  // in opposite orders, which is how two writers deadlock.
  const rival = { name: "Rival", tag: "OPP", puuid: "e2e-puuid-rival" };
  await fetch(`${MOCK_API_URL}/__script`, {
    method: "POST",
    body: JSON.stringify({ endpoint: "matches", name: rival.name, steps: [{ as: "Tester", reverse: true, times: 10 }] }),
  });
  try {
    for (let round = 0; round < 5; round++) {
      await db.player.updateMany({ where: { puuid: { in: [PLAYER.puuid, rival.puuid] } }, data: { lastSyncedAt: null } });
      const responses = await Promise.all([
        request.post("/api/sync?name=Tester&tag=E2E", { headers: SYNC_AUTH }),
        request.post(`/api/sync?name=${rival.name}&tag=${rival.tag}`, { headers: SYNC_AUTH }),
      ]);
      for (const res of responses) expect(res.status(), `round ${round + 1}: ${await res.text()}`).toBe(200);
    }

    expect(await db.match.count({ where: { id: { startsWith: "e2e-match-" } } })).toBe(10);
    for (const puuid of [PLAYER.puuid, rival.puuid]) {
      const player = await db.player.findUniqueOrThrow({ where: { puuid } });
      expect(await db.playerMatch.count({ where: { playerId: player.id } })).toBe(10);
    }
  } finally {
    // Leave the other specs only the fixture players they expect.
    await db.player.deleteMany({ where: { puuid: rival.puuid } });
    await fetch(`${MOCK_API_URL}/__reset`, { method: "POST" });
  }
});

test("re-syncing matches that are already stored changes nothing but the timestamp", async ({ request }) => {
  const before = (await testPlayer()).stats!;

  const res = await syncNow(request);
  expect(await res.json()).toMatchObject({ ok: true, skipped: false, matchesUpserted: 10 });

  const after = await testPlayer();
  expect(await db.playerMatch.count({ where: { playerId: after.id } })).toBe(10);
  expect(after.stats).toMatchObject(FIXTURE_STATS);
  expect(after.stats!.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
});

test("concurrent syncs of one player neither fail nor double count", async ({ request }) => {
  await db.player.update({ where: { puuid: PLAYER.puuid }, data: { lastSyncedAt: null } });

  const responses = await Promise.all(
    Array.from({ length: 3 }, () => request.post("/api/sync?name=Tester&tag=E2E", { headers: SYNC_AUTH })),
  );

  for (const res of responses) expect(res.status(), await res.text()).toBe(200);
  const player = await testPlayer();
  expect(await db.playerMatch.count({ where: { playerId: player.id } })).toBe(10);
  expect(await db.playerStats.count({ where: { playerId: player.id } })).toBe(1);
  expect(player.stats).toMatchObject(FIXTURE_STATS);
});

test("a stats refresh waits for the player lock and never loses an update", async ({ request }) => {
  const player = await testPlayer();
  const other = new PrismaClient({ datasourceUrl: appEnv.DATABASE_URL });
  const extraMatchId = "e2e-extra-newest-win";

  // Transaction A takes the exact lock a refresh takes (the shared helper), writes a
  // deliberately stale stats row, and holds the lock until released.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let lockTaken!: () => void;
  const locked = new Promise<void>((resolve) => (lockTaken = resolve));
  const holder = db.$transaction(
    async (tx) => {
      await lockPlayer(tx, player.id);
      await tx.playerStats.update({
        where: { playerId: player.id },
        data: { matches: 0, wins: 0, losses: 0, trackerScore: 0, totalMatches: 0 },
      });
      lockTaken();
      await gate;
    },
    { timeout: 60_000 },
  );
  await locked;

  // Refresh B: a real refreshPlayerStats in its own process, through the backfill script.
  const refresh = new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn("npx", ["tsx", "scripts/backfill-player-stats.ts"], { env: { ...process.env, ...appEnv } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output }));
  });

  try {
    // Wait until Postgres reports B blocked on a row lock inside lockPlayer.
    // If the refresh took no lock, this never happens and the test fails here.
    await expect
      .poll(
        async () => {
          const waiting = await other.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM "Player"%' AND pid <> pg_backend_pid()`;
          return waiting[0].n;
        },
        { message: "a refresh should be waiting on the player lock", timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // While B waits, another connection stores a newer win for this player. FOR NO KEY UPDATE
    // doesn't block the foreign-key check on PlayerMatch; FOR UPDATE would hang here.
    const insert = (async () => {
      await other.match.create({
        data: {
          id: extraMatchId,
          map: "Pearl",
          mode: "Competitive",
          region: "na",
          startedAt: new Date("2026-09-21T00:00:00Z"),
          roundsRed: 13,
          roundsBlue: 7,
        },
      });
      await other.playerMatch.create({
        data: {
          matchId: extraMatchId,
          playerId: player.id,
          team: "red",
          kills: 20,
          deaths: 16,
          assists: 5,
          score: 5000,
          damage: 3200,
          headshots: 10,
          bodyshots: 25,
          legshots: 5,
        },
      });
    })();
    const blocked = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("insert was blocked by the lock")), 5_000),
    );
    await Promise.race([insert, blocked]);

    // A commits its stale row. B then reads after getting the lock, sees the new match,
    // and overwrites the stale row. A refresh that read before locking, took no lock, or
    // used a snapshot from before the wait would leave stale or incomplete stats.
    release();
    await holder;
    const result = await refresh;
    expect(result.code, result.output).toBe(0);

    expect((await testPlayer()).stats).toMatchObject({
      matches: 10,
      wins: 7,
      losses: 3,
      trackerScore: 63,
      totalMatches: 11,
    });
  } finally {
    release();
    await holder.catch(() => {});
    await refresh;
    await other.match.deleteMany({ where: { id: extraMatchId } }); // cascades to the stat line
    await other.$disconnect();
    await syncNow(request); // restores the fixture stats and clears the cached match list
  }
  expect((await testPlayer()).stats).toMatchObject(FIXTURE_STATS);
});

test("the backfill script rebuilds a missing stats row and is safe to re-run", async () => {
  const player = await testPlayer();
  await db.playerStats.delete({ where: { playerId: player.id } });

  const backfill = () =>
    execSync("npx tsx scripts/backfill-player-stats.ts", { env: { ...process.env, ...appEnv }, encoding: "utf8" });

  expect(backfill()).toContain("Rebuilt stats for");
  expect((await testPlayer()).stats).toMatchObject(FIXTURE_STATS);

  backfill();
  expect((await testPlayer()).stats).toMatchObject(FIXTURE_STATS);
});
