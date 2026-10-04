import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "../src/generated/prisma";
import { APP_URL, appEnv, MOCK_API_URL } from "./env.mjs";
import { buildMatches } from "./fixtures.mjs";

// How the app behaves when HenrikDev misbehaves: timeouts, retries, rate limits,
// and cached failures, checked against the real app and a scripted mock API.
// Cooldowns are shared by every request, so these tests run in order, use a new
// player name each, and wait for the app to settle after each one.

type Calls = { account: number; mmr: number; "mmr-history": number; matches: number };
type Step = Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;
/** A player name no other test (or earlier run) has used, so nothing is cached for it. */
const fresh = (prefix: string) => `${prefix}${Date.now().toString(36)}${counter++}`;

async function script(endpoint: keyof Calls, name: string, steps: Step[]) {
  const res = await fetch(`${MOCK_API_URL}/__script`, { method: "POST", body: JSON.stringify({ endpoint, name, steps }) });
  expect(res.ok).toBe(true);
}

async function callsFor(name: string): Promise<Calls> {
  return (await fetch(`${MOCK_API_URL}/__calls?name=${encodeURIComponent(name)}`)).json();
}

const NO_CALLS: Calls = { account: 0, mmr: 0, "mmr-history": 0, matches: 0 };

/** Reads a key straight from the test cache, through its REST API. */
async function redisGet(key: string) {
  const res = await fetch(appEnv.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${appEnv.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(["GET", key]),
  });
  return (await res.json()).result as string | null;
}

test.describe.configure({ mode: "serial" });

test.afterEach(async ({ request }) => {
  await fetch(`${MOCK_API_URL}/__reset`, { method: "POST" });
  // Wait out any cooldown the test started, then succeed once, which also resets the
  // circuit breaker's count of failures in a row, so the next test starts clean.
  const calm = fresh("Calm");
  await script("account", calm, [{ as: "Tester", times: 1000 }]);
  await expect
    .poll(async () => (await request.get(`/api/player?name=${calm}&tag=E2E`)).status(), { timeout: 20_000, intervals: [250] })
    .toBe(200);
});

const get = (request: APIRequestContext, route: string, name: string) =>
  request.get(`/api/${route}?name=${encodeURIComponent(name)}&tag=E2E`, { timeout: 20_000 });

test("viewing an unknown player again costs no API calls: failures are cached", async ({ page }) => {
  const ghost = fresh("Ghost");
  const once: Calls = { account: 1, mmr: 1, "mmr-history": 1, matches: 1 };

  await page.goto(`/player/${ghost}/E2E`);
  await expect(page.getByText("Couldn't sync recent matches (HTTP 404)")).toBeVisible();
  expect(await callsFor(ghost)).toEqual(once);

  await page.reload();
  await expect(page.getByText("Couldn't sync recent matches (HTTP 404)")).toBeVisible();
  expect(await callsFor(ghost)).toEqual(once);
});

test("a 429 pauses every lookup, for every player, for as long as the API asked", async ({ request }) => {
  const limited = fresh("Limited");
  const other = fresh("Other");
  await script("mmr", limited, [{ status: 429, headers: { "retry-after": "2" } }]);

  const refused = await get(request, "overall", limited);
  expect(refused.status()).toBe(429);
  expect(refused.headers()["retry-after"]).toBe("2");

  const paused = await get(request, "player", other);
  expect(paused.status()).toBe(429);
  expect(Number(paused.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
  expect((await paused.json()).errors[0].details).toEqual({ source: "stattrack", reason: "rate_limit_cooldown" });
  expect(await callsFor(other)).toEqual(NO_CALLS);

  await sleep(2_300);
  expect((await get(request, "player", other)).status()).toBe(404);
  expect((await callsFor(other)).account).toBe(1);
  // The 429 itself wasn't cached: asking again reaches the API.
  expect((await get(request, "overall", limited)).status()).toBe(404);
  expect((await callsFor(limited)).mmr).toBe(2);
});

test("the app stops calling once the budget hits zero, before the API has to refuse", async ({ request }) => {
  const spender = fresh("Spent");
  const next = fresh("Next");
  await script("mmr", spender, [{ as: "Tester", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2" } }]);

  expect((await get(request, "overall", spender)).status()).toBe(200);
  const paused = await get(request, "elo", next);
  expect(paused.status()).toBe(429);
  expect(await callsFor(next)).toEqual(NO_CALLS);

  await sleep(2_300);
  expect((await get(request, "elo", next)).status()).toBe(404);
});

test("a shorter cooldown can't cut a longer one short, in the shared cache too", async ({ request }) => {
  const short = fresh("Short");
  const long = fresh("Long");
  await script("account", short, [{ as: "Tester", delayMs: 400, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" } }]);
  await script("account", long, [{ status: 429, headers: { "retry-after": "4" } }]);
  const started = Date.now();

  // The short one is already waiting on the API when the long one starts.
  const shortCall = get(request, "player", short);
  await sleep(150);
  expect((await get(request, "player", long)).status()).toBe(429);
  expect((await shortCall).status()).toBe(200);

  const until = Number(await redisGet("henrik:v1:cooldown:rate_limit"));
  expect(until).toBeGreaterThanOrEqual(started + 3_500);
  await sleep(1_500);
  expect((await get(request, "player", fresh("Waiting"))).status()).toBe(429);
});

test("a 503 is retried once and the page gets the data", async ({ request }) => {
  const flaky = fresh("Flaky");
  await script("mmr", flaky, [{ status: 503 }, { as: "Tester" }]);

  expect((await get(request, "overall", flaky)).status()).toBe(200);
  expect((await callsFor(flaky)).mmr).toBe(2);
});

test("a hung API times out, is retried once, and the failure is cached briefly", async ({ request }) => {
  const hung = fresh("Hung");
  await script("account", hung, [{ hang: true }, { hang: true }]);

  const started = Date.now();
  const res = await get(request, "player", hung);
  const elapsed = Date.now() - started;
  expect(res.status()).toBe(504);
  // Two 3-second attempts, a short jittered wait between them, inside the 7-second deadline.
  expect(elapsed).toBeGreaterThanOrEqual(6_000);
  expect(elapsed).toBeLessThan(7_500);
  expect((await callsFor(hung)).account).toBe(2);

  const again = Date.now();
  expect((await get(request, "player", hung)).status()).toBe(504);
  expect(Date.now() - again).toBeLessThan(500);
  expect((await callsFor(hung)).account).toBe(2);
});

test("a match download that stalls can't hang the profile page", async ({ page }) => {
  test.setTimeout(40_000);
  const stalled = fresh("Stall");
  await script("matches", stalled, [{ stallBodyMs: 20_000 }]);

  const started = Date.now();
  await page.goto(`/player/${stalled}/E2E`, { timeout: 20_000 });
  expect(Date.now() - started).toBeLessThan(12_500);
  await expect(page.getByText("Couldn't sync recent matches (HTTP 504)")).toBeVisible();
  // Never retried: the first try was probably charged, and it's several megabytes.
  expect((await callsFor(stalled)).matches).toBe(1);
});

test("during a cooldown the profile page says live data is paused, and calls nothing", async ({ page, request }) => {
  const trigger = fresh("Trigger");
  const viewer = fresh("Viewer");
  await script("account", trigger, [{ status: 429, headers: { "retry-after": "3" } }]);
  expect((await get(request, "player", trigger)).status()).toBe(429);

  await page.goto(`/player/${viewer}/E2E`);

  await expect(page.getByText(/Live data is paused for about \ds to stay under the HenrikDev rate limit\./)).toBeVisible();
  expect(await callsFor(viewer)).toEqual(NO_CALLS);
});

test("the nightly job waits as long as the app asks, then syncs", async () => {
  test.setTimeout(40_000);
  const db = new PrismaClient({ datasourceUrl: appEnv.DATABASE_URL });
  try {
    await db.player.updateMany({ where: { name: "Tester", tag: "E2E" }, data: { lastSyncedAt: null } });
  } finally {
    await db.$disconnect();
  }
  await script("matches", "Tester", [{ status: 429, headers: { "retry-after": "2" } }]);
  const before = (await callsFor("Tester")).matches;

  // Only what the job needs: it talks to the app, never to a database.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    BASE_URL: APP_URL,
    SYNC_PLAYERS: JSON.stringify([{ name: "Tester", tag: "E2E" }]),
  };
  const started = Date.now();
  const { stdout } = await promisify(execFile)("npx", ["tsx", "scripts/nightly-sync.ts"], {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 30_000,
  });

  expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
  expect(stdout).toContain("Tester#E2E: HTTP 429, waiting 2s as asked");
  expect(stdout).toContain('Tester#E2E: {"ok":true');
  expect((await callsFor("Tester")).matches).toBe(before + 2);
});

test("one unreadable match or value doesn't cost the rest of the sync", async ({ request }) => {
  const name = fresh("Partial");
  const puuid = `e2e-puuid-${name.toLowerCase()}`;
  const matches = buildMatches({
    player: { name, tag: "E2E", puuid },
    idPrefix: `e2e-${name.toLowerCase()}`,
    count: 10,
    wins: 5,
    line: { kills: 20, deaths: 16, assists: 5, score: 5000, damage: 3200, headshots: 10, bodyshots: 25, legshots: 5 },
  });
  (matches[3].metadata as { match_id: unknown }).match_id = 123; // can't be stored: dropped
  matches[7].players[0].stats.kills = "lots"; // one bad value: stored as null
  await script("matches", name, [{ body: { status: 200, data: matches } }]);

  const res = await request.post(`/api/sync?name=${name}&tag=E2E`);
  expect(await res.json()).toMatchObject({ ok: true, matchesUpserted: 9, playerMatchesUpserted: 9 });

  const db = new PrismaClient({ datasourceUrl: appEnv.DATABASE_URL });
  try {
    const player = await db.player.findUniqueOrThrow({ where: { puuid } });
    const lines = await db.playerMatch.findMany({ where: { playerId: player.id }, orderBy: { matchId: "asc" } });
    expect(lines).toHaveLength(9);
    expect(lines.find((l) => l.matchId.endsWith("-08"))?.kills).toBeNull();
    expect(lines.find((l) => l.matchId.endsWith("-07"))?.kills).toBe(20);
    expect(lines.some((l) => l.matchId.endsWith("-04"))).toBe(false);
  } finally {
    // Leave the other specs only the fixture players.
    await db.player.deleteMany({ where: { puuid } });
    await db.match.deleteMany({ where: { id: { startsWith: `e2e-${name.toLowerCase()}` } } });
    await db.$disconnect();
  }
});

test("an answer without readable match data is reported, and not asked for again right away", async ({ page }) => {
  const name = fresh("Garbled");
  // A full-size list where no match can be identified, like an upstream field rename.
  const unreadable = buildMatches({
    player: { name, tag: "E2E", puuid: `e2e-puuid-${name.toLowerCase()}` },
    idPrefix: "unused",
    count: 10,
    wins: 5,
    line: { kills: 20, deaths: 16, assists: 5, score: 5000, damage: 3200, headshots: 10, bodyshots: 25, legshots: 5 },
    // match_id renamed: undefined values are left out of the JSON.
  }).map((m) => ({ ...m, metadata: { ...m.metadata, match_id: undefined, id: m.metadata.match_id } }));
  await script("matches", name, [{ body: { status: 200, data: unreadable } }]);

  await page.goto(`/player/${name}/E2E`);
  await expect(page.getByText("Couldn't read recent matches")).toBeVisible();

  // Remembered for 30 seconds like a failure, so the second view doesn't download it again.
  await page.reload();
  await expect(page.getByText("Couldn't sync recent matches (HTTP 502)")).toBeVisible();
  expect((await callsFor(name)).matches).toBe(1);
});

test("a tiny answer without a data list is cached like a failure too", async ({ request }) => {
  const name = fresh("Empty");
  await script("matches", name, [{ body: { status: 200, data: null } }]);

  expect((await request.post(`/api/sync?name=${name}&tag=E2E`)).status()).toBe(502);
  expect((await request.post(`/api/sync?name=${name}&tag=E2E`)).status()).toBe(502);
  expect((await callsFor(name)).matches).toBe(1);
});
