import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { PrismaClient } from "../src/generated/prisma";
import { APP_URL, appEnv, MOCK_API_URL, TEST_CRON_SECRET } from "./env.mjs";

// POST /api/sync is for the nightly job only, and the job must fail loudly.
// These tests call the real app and run the real script against it.

type Calls = { account: number; mmr: number; "mmr-history": number; matches: number };

async function callsFor(name: string): Promise<Calls> {
  return (await fetch(`${MOCK_API_URL}/__calls?name=${encodeURIComponent(name)}`)).json();
}

async function script(endpoint: keyof Calls, name: string, steps: Record<string, unknown>[]) {
  const res = await fetch(`${MOCK_API_URL}/__script`, { method: "POST", body: JSON.stringify({ endpoint, name, steps }) });
  expect(res.ok).toBe(true);
}

async function clearCooldown(name: string) {
  const db = new PrismaClient({ datasourceUrl: appEnv.DATABASE_URL });
  try {
    await db.player.updateMany({ where: { name }, data: { lastSyncedAt: null } });
  } finally {
    await db.$disconnect();
  }
}

test.afterEach(() => fetch(`${MOCK_API_URL}/__reset`, { method: "POST" }));

test.describe("POST /api/sync", () => {
  test("refuses a request without the secret, before it costs anything", async ({ request }) => {
    const name = `Intruder${Date.now().toString(36)}`;

    const res = await request.post(`/api/sync?name=${name}&tag=E2E`);

    expect(res.status()).toBe(401);
    expect(res.headers()["www-authenticate"]).toBe('Bearer realm="sync"');
    expect(await res.json()).toMatchObject({ outcome: "unauthorized" });
    expect(await callsFor(name)).toEqual({ account: 0, mmr: 0, "mmr-history": 0, matches: 0 });
  });

  test("refuses a wrong secret, and accepts the right one in any scheme capitalization", async ({ request }) => {
    expect((await request.post("/api/sync?name=Tester&tag=E2E", { headers: { authorization: "Bearer wrong" } })).status()).toBe(401);

    const res = await request.post("/api/sync?name=Tester&tag=E2E", { headers: { authorization: `bearer ${TEST_CRON_SECRET}` } });
    expect(res.status()).toBe(200);
    expect(["synced", "skipped"]).toContain((await res.json()).outcome);
  });

  test("the profile page still syncs on its own, with no secret", async ({ page }) => {
    await clearCooldown("Tester");
    const before = (await callsFor("Tester")).matches;

    await page.goto("/player/Tester/E2E");
    await expect(page.locator("tbody tr")).toHaveCount(10);

    expect((await callsFor("Tester")).matches).toBe(before + 1);
  });
});

/** Runs the nightly script against the app, like the GitHub Actions job does. */
async function runNightly(env: Record<string, string>) {
  const summaryFile = join(mkdtempSync(join(tmpdir(), "nightly-")), "summary.md");
  // Only what the job needs: it talks to the app, never to a database.
  const fullEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    BASE_URL: APP_URL,
    CRON_SECRET: TEST_CRON_SECRET,
    SYNC_GAP_MS: "0",
    GITHUB_STEP_SUMMARY: summaryFile,
    ...env,
  };
  const started = Date.now();
  const { code, stdout } = await promisify(execFile)("npx", ["tsx", "scripts/nightly-sync.ts"], {
    env: fullEnv as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  }).then(
    (r) => ({ code: 0, stdout: r.stdout }),
    // A non-zero exit rejects; its code and output are on the error.
    (e: { code: number; stdout: string }) => ({ code: e.code, stdout: e.stdout }),
  );
  let summary = "";
  try {
    summary = readFileSync(summaryFile, "utf8");
  } catch {
    // No summary written.
  }
  return { code, stdout, summary, elapsed: Date.now() - started };
}

const players = (...list: { name: string; tag: string }[]) => JSON.stringify(list);

test.describe("the nightly job", () => {
  test.setTimeout(60_000);

  test("waits as long as the app asks, then syncs, and exits 0", async () => {
    await clearCooldown("Tester");
    await script("matches", "Tester", [{ status: 429, headers: { "retry-after": "2" } }]);
    const before = (await callsFor("Tester")).matches;

    const run = await runNightly({ SYNC_PLAYERS: players({ name: "Tester", tag: "E2E" }) });

    expect(run.code).toBe(0);
    expect(run.elapsed).toBeGreaterThanOrEqual(2_000);
    expect(run.stdout).toContain("Tester#E2E: HTTP 429, waiting 2s as asked");
    expect(run.stdout).toContain("Tester#E2E: synced (HTTP 200)");
    expect(run.summary).toContain("## Nightly sync: all 1 player(s) fine");
    expect(run.summary).toContain("| Tester#E2E | synced | 200 |");
    expect((await callsFor("Tester")).matches).toBe(before + 2);
  });

  test("exits 1 when any player fails, after trying every player, and says which", async () => {
    const run = await runNightly({ SYNC_PLAYERS: players({ name: "Nobody", tag: "E2E" }, { name: "Tester", tag: "E2E" }) });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("::error title=Nightly sync::Nobody#E2E: upstream-error (HTTP 404)");
    // The player after the failure was still synced (or already fresh).
    expect(run.stdout).toMatch(/Tester#E2E: (synced|skipped) \(HTTP 200\)/);
    expect(run.summary).toContain("## Nightly sync: 1 of 2 player(s) failed");
    expect(run.summary).toContain("| Nobody#E2E | ❌ upstream-error | 404 |");
  });

  test("syncs players listed by PUUID, and names each one in the summary", async () => {
    const run = await runNightly({
      SYNC_PLAYERS: JSON.stringify([{ puuid: "e2e-puuid-tester" }, { puuid: "e2e-puuid-nobody" }]),
    });

    expect(run.code).toBe(1);
    expect(run.stdout).not.toContain("players listed by Riot ID");
    expect(run.stdout).toMatch(/Tester#E2E: (synced|skipped) \(HTTP 200\)/);
    expect(run.stdout).toContain("::error title=Nightly sync::puuid:e2e-puui: not-tracked (HTTP 404)");
    expect(run.summary).toContain("| puuid:e2e-puui | ❌ not-tracked | 404 |");
  });

  test("treats HenrikDev refusing the API key as that player's failure, not a wrong secret", async () => {
    // A name of its own: an earlier test's 404 for another name stays cached for 5 minutes.
    const name = `KeyRevoked${Date.now().toString(36)}`;
    await script("matches", name, [{ status: 401 }]);

    const run = await runNightly({ SYNC_PLAYERS: players({ name, tag: "E2E" }) });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`::error title=Nightly sync::${name}#E2E: upstream-auth (HTTP 502) HenrikDev refused the app's API key (HTTP 401)`);
  });

  test("exits 2, before syncing anyone, when the app refuses the secret", async () => {
    const name = `Locked${Date.now().toString(36)}`;

    const run = await runNightly({ CRON_SECRET: "not-the-secret", SYNC_PLAYERS: players({ name, tag: "E2E" }) });

    expect(run.code).toBe(2);
    expect(run.stdout).toContain("::error title=Nightly sync::the app refused the secret: HTTP 401 unauthorized");
    expect(await callsFor(name)).toEqual({ account: 0, mmr: 0, "mmr-history": 0, matches: 0 });
  });

  test("exits 2 when it isn't configured properly", async () => {
    for (const [env, message] of [
      [{ SYNC_PLAYERS: "" }, "SYNC_PLAYERS must be a JSON array"],
      [{ SYNC_PLAYERS: "[]" }, "SYNC_PLAYERS must be a non-empty JSON array"],
      [{ SYNC_PLAYERS: '[{"name":"Tester"}]' }, "SYNC_PLAYERS[0] needs a puuid, or a name and a tag"],
      [{ SYNC_PLAYERS: '[{"puuid":"../v1"}]' }, "SYNC_PLAYERS[0] has an invalid puuid"],
      [{ SYNC_PLAYERS: players({ name: "Tester", tag: "E2E" }), CRON_SECRET: "" }, "CRON_SECRET is not set"],
      [{ SYNC_PLAYERS: players({ name: "Tester", tag: "E2E" }), BASE_URL: "http://example.com" }, "BASE_URL must use https"],
    ] as const) {
      const run = await runNightly(env);
      expect(run.code, message).toBe(2);
      expect(run.stdout).toContain(message);
    }
  });
});
