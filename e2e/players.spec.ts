import { expect, test, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "../src/generated/prisma";
import { appEnv, MOCK_API_URL, SYNC_AUTH } from "./env.mjs";
import { buildMatches, PLAYER } from "./fixtures.mjs";

// A player is their PUUID. Their Riot ID can change, and is matched in any
// capitalization. These tests drive the real app, database, and lock.

const db = new PrismaClient({ datasourceUrl: appEnv.DATABASE_URL });
test.afterAll(() => db.$disconnect());
test.afterEach(() => fetch(`${MOCK_API_URL}/__reset`, { method: "POST" }));

type Calls = { account: number; mmr: number; "mmr-history": number; matches: number };
const callsFor = async (name: string): Promise<Calls> =>
  (await fetch(`${MOCK_API_URL}/__calls?name=${encodeURIComponent(name)}`)).json();

async function script(endpoint: keyof Calls, name: string, steps: Record<string, unknown>[]) {
  const res = await fetch(`${MOCK_API_URL}/__script`, { method: "POST", body: JSON.stringify({ endpoint, name, steps }) });
  expect(res.ok).toBe(true);
}

const LINE = { kills: 20, deaths: 16, assists: 5, score: 5000, damage: 3200, headshots: 10, bodyshots: 25, legshots: 5 };
/** Three v4 matches of a synthetic player. */
const matchesOf = (name: string, puuid: string, idPrefix: string) =>
  buildMatches({ player: { name, tag: "E2E", puuid }, idPrefix, count: 3, wins: 2, line: LINE });

const sync = (request: APIRequestContext, query: string) => request.post(`/api/sync?${query}`, { headers: SYNC_AUTH });
const clearCooldown = (puuid: string) => db.player.updateMany({ where: { puuid }, data: { lastSyncedAt: null } });

test("another capitalization finds the same player and doesn't sync again", async ({ page }) => {
  await page.goto("/player/Tester/E2E");
  await expect(page.locator("tbody tr")).toHaveCount(10);
  const before = (await callsFor("Tester")).matches;

  await page.goto("/player/tESTER/e2E");
  await expect(page.locator("tbody tr")).toHaveCount(10);

  expect((await callsFor("Tester")).matches).toBe(before);
  const rows = await db.player.findMany({ where: { puuid: PLAYER.puuid } });
  expect(rows).toMatchObject([{ name: "Tester", tag: "E2E", riotIdKey: "tester#e2e" }]);
});

test("a sync asked for in other capitalization keeps HenrikDev's capitalization", async ({ request }) => {
  await clearCooldown(PLAYER.puuid);

  const res = await sync(request, "name=TESTER&tag=e2e");

  expect(await res.json()).toMatchObject({ outcome: "synced", player: "Tester#E2E" });
  expect(await db.player.findUniqueOrThrow({ where: { puuid: PLAYER.puuid } })).toMatchObject({ name: "Tester", tag: "E2E" });
});

test("three simultaneous views of a player make one upstream call between them", async ({ browser }) => {
  await clearCooldown(PLAYER.puuid);
  // A slow answer, so the three views overlap.
  await script("matches", "Tester", [{ as: "Tester", delayMs: 1_500 }]);
  const before = (await callsFor("Tester")).matches;
  const context = await browser.newContext();
  try {
    const pages = await Promise.all([1, 2, 3].map(() => context.newPage()));
    await Promise.all(pages.map((p, i) => p.goto(`/player/${["Tester", "tester", "TESTER"][i]}/E2E`)));

    for (const p of pages) await expect(p.locator("tbody tr")).toHaveCount(10);
    expect((await callsFor("Tester")).matches).toBe(before + 1);
  } finally {
    await context.close();
  }
});

test("a new player synced three times at once is fetched once and stored once", async ({ request }) => {
  const name = `Fresh${Date.now().toString(36)}`;
  const puuid = `e2e-puuid-${name.toLowerCase()}`;
  await script("matches", name, [{ body: { status: 200, data: matchesOf(name, puuid, `e2e-${name.toLowerCase()}`) }, delayMs: 800 }]);
  try {
    const responses = await Promise.all([1, 2, 3].map(() => sync(request, `name=${name}&tag=E2E`)));
    const outcomes = await Promise.all(responses.map(async (r) => (await r.json()).outcome));

    expect(outcomes.sort()).toEqual(["skipped", "skipped", "synced"]);
    expect((await callsFor(name)).matches).toBe(1);
    expect(await db.player.count({ where: { puuid } })).toBe(1);
  } finally {
    await db.player.deleteMany({ where: { puuid } });
    await db.match.deleteMany({ where: { id: { startsWith: `e2e-${name.toLowerCase()}` } } });
  }
});

test("renames: the Riot ID moves to whoever has it now, and nothing collides or duplicates", async ({ page, request }) => {
  const suffix = Date.now().toString(36);
  const [oldName, newName] = [`Old${suffix}`, `New${suffix}`];
  const [x, y] = [`e2e-puuid-x-${suffix}`, `e2e-puuid-y-${suffix}`];
  const prefix = `e2e-${suffix}`;
  try {
    // Player X has the Riot ID Old.
    await script("matches", oldName, [{ body: { status: 200, data: matchesOf(oldName, x, `${prefix}-x`) } }]);
    expect((await (await sync(request, `name=${oldName}&tag=E2E`)).json()).outcome).toBe("synced");
    expect(await db.player.findUnique({ where: { puuid: x } })).toMatchObject({ riotIdKey: `${oldName.toLowerCase()}#e2e` });

    // X renames away, and player Y takes Old. Before, this broke the name+tag unique index.
    await clearCooldown(x);
    await script("matches", oldName, [{ body: { status: 200, data: matchesOf(oldName, y, `${prefix}-y`) } }]);
    expect((await (await sync(request, `name=${oldName}&tag=E2E`)).json()).outcome).toBe("synced");
    expect(await db.player.findUnique({ where: { puuid: x } })).toMatchObject({ name: oldName, riotIdKey: null });
    expect(await db.player.findUnique({ where: { puuid: y } })).toMatchObject({ riotIdKey: `${oldName.toLowerCase()}#e2e` });
    // Old's match list and profile now belong to Y.
    const list = await (await request.get(`/api/db/matches?name=${oldName}&tag=E2E`)).json();
    expect(list.player.puuid).toBe(y);
    // On the leaderboard, both rows are named Old, but only Y's links to the Old profile.
    const board = await (await request.get("/api/leaderboard?minMatches=1&limit=100")).json();
    expect(
      board.entries.filter((e: { name: string }) => e.name === oldName).map((e: { linked: boolean }) => e.linked).sort(),
    ).toEqual([false, true]);
    // The page: Y's row links to Old's profile; X's is plain text that explains why.
    await page.goto("/leaderboard?minMatches=1&limit=100");
    await expect(page.getByRole("link", { name: `${oldName}#E2E` })).toHaveCount(1);
    await expect(page.getByTitle("This player has since changed their Riot ID")).toHaveText(`${oldName}#E2E`);

    // X shows up as New. Their matches still show the old name, so the app asks the account endpoint who New is.
    await script("matches", newName, [{ body: { status: 200, data: matchesOf(oldName, x, `${prefix}-x`) } }]);
    await script("account", newName, [{ body: { status: 200, data: { puuid: x, name: newName, tag: "E2E", card: {} } } }]);
    expect((await (await sync(request, `name=${newName}&tag=E2E`)).json())).toMatchObject({ outcome: "synced", player: `${newName}#E2E` });
    expect(await db.player.findMany({ where: { puuid: x } })).toMatchObject([{ name: newName, riotIdKey: `${newName.toLowerCase()}#e2e` }]);
    const xRow = await db.player.findUniqueOrThrow({ where: { puuid: x } });
    expect(await db.playerMatch.count({ where: { playerId: xRow.id } })).toBe(3);

    // The nightly job's path: by PUUID, through the by-puuid endpoint, without changing who X is.
    await clearCooldown(x);
    await script("matches", x, [{ body: { status: 200, data: matchesOf(oldName, x, `${prefix}-x`) } }]);
    expect((await (await sync(request, `puuid=${x}`)).json())).toMatchObject({ outcome: "synced", player: `${newName}#E2E` });
    const requests: string[] = await (await fetch(`${MOCK_API_URL}/__requests`)).json();
    expect(requests).toContain(`/valorant/v4/by-puuid/matches/na/pc/${x}`);
    expect(await db.player.findUniqueOrThrow({ where: { puuid: x } })).toMatchObject({ name: newName });
  } finally {
    await db.player.deleteMany({ where: { puuid: { in: [x, y] } } });
    await db.match.deleteMany({ where: { id: { startsWith: prefix } } });
  }
});

test("syncing by a PUUID nobody tracks costs nothing and says so", async ({ request }) => {
  const puuid = `e2e-puuid-nobody-${Date.now().toString(36)}`;

  const res = await sync(request, `puuid=${puuid}`);

  expect(res.status()).toBe(404);
  expect(await res.json()).toMatchObject({ outcome: "not-tracked" });
  expect((await callsFor(puuid)).matches).toBe(0);
});
