import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "../src/generated/prisma";
import { appEnv, SYNC_AUTH } from "./env.mjs";
import { PLAYERS } from "./fixtures.mjs";

// Ranks the four fixture players (see fixtures.mjs). Among the three with 10
// matches, each sort gives a different order, which proves every sort applies.

test.beforeAll(async ({ request }) => {
  // Sync every fixture player, clearing any cooldown left by earlier tests.
  const db = new PrismaClient({ datasourceUrl: appEnv.DATABASE_URL });
  await db.player.updateMany({ data: { lastSyncedAt: null } });
  await db.$disconnect();
  for (const p of PLAYERS) {
    const res = await request.post(`/api/sync?name=${p.name}&tag=${p.tag}`, { headers: SYNC_AUTH });
    expect(res.ok(), `${p.name}: ${await res.text()}`).toBe(true);
  }
});

/** Each table row as [rank, player, tracker score, ACS, K/D, win %]. */
async function tableRows(page: Page) {
  const rows = page.getByRole("table").getByRole("row").filter({ has: page.getByRole("cell") });
  return rows.evaluateAll((trs) =>
    trs.map((tr) => [...tr.querySelectorAll("td")].slice(0, 6).map((td) => td.textContent?.trim())),
  );
}

const players = async (page: Page) => (await tableRows(page)).map((row) => row[1]);
const sortLink = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Sort by" }).getByRole("link", { name, exact: true });

test("ranks players with enough matches by tracker score by default", async ({ page }) => {
  await page.goto("/leaderboard");

  await expect(page).toHaveTitle("Leaderboard · VALORANT StatTrack");
  await expect(sortLink(page, "Tracker Score")).toHaveAttribute("aria-current", "page");
  // Newbie has only 3 matches, below the default minimum of 5.
  expect(await tableRows(page)).toEqual([
    ["1", "Ace#E2E", "67", "150", "1.10", "80%"],
    ["2", "Tester#E2E", "57", "250", "1.25", "60%"],
    ["3", "Rookie#E2E", "55", "200", "0.40", "70%"],
  ]);
});

test("every sort gives its own order and moves the highlight", async ({ page }) => {
  await page.goto("/leaderboard");

  const expected: [string, string, string[]][] = [
    ["ACS", "acs", ["Tester#E2E", "Rookie#E2E", "Ace#E2E"]],
    ["K/D", "kd", ["Tester#E2E", "Ace#E2E", "Rookie#E2E"]],
    ["Win %", "winRate", ["Ace#E2E", "Rookie#E2E", "Tester#E2E"]],
    ["Tracker Score", "trackerScore", ["Ace#E2E", "Tester#E2E", "Rookie#E2E"]],
  ];
  for (const [label, sort, order] of expected) {
    await sortLink(page, label).click();
    await expect(page).toHaveURL(new RegExp(`sort=${sort}`));
    await expect(sortLink(page, label)).toHaveAttribute("aria-current", "page");
    expect(await players(page), label).toEqual(order);
  }
});

test("sort links keep the chosen minimum and limit", async ({ page }) => {
  await page.goto("/leaderboard?minMatches=1&limit=2");
  expect(await players(page)).toEqual(["Newbie#E2E", "Ace#E2E"]);
  await expect(page.getByText("at least 1 recent match,")).toBeVisible();

  await sortLink(page, "ACS").click();

  await expect(page).toHaveURL(/sort=acs/);
  await expect(page).toHaveURL(/minMatches=1/);
  await expect(page).toHaveURL(/limit=2/);
  expect(await players(page)).toEqual(["Newbie#E2E", "Tester#E2E"]);
});

test("invalid options fall back to the defaults instead of an error page", async ({ page }) => {
  const response = await page.goto("/leaderboard?sort=hacker&minMatches=999");

  expect(response?.status()).toBe(200);
  expect(await players(page)).toEqual(["Ace#E2E", "Tester#E2E", "Rookie#E2E"]);
});

test("the nav leads to the leaderboard and a row leads to that player's profile", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Leaderboard" }).click();
  await expect(page).toHaveURL(/\/leaderboard$/);

  await page.getByRole("link", { name: "Ace#E2E" }).click();
  await expect(page).toHaveURL(/\/player\/Ace\/E2E$/);
  await expect(page.getByText("Immortal 1")).toBeVisible();
});

test("the home page previews the top players and links to them and to the full board", async ({ page }) => {
  await page.goto("/");

  const top = page.getByRole("region", { name: "Top tracked players" });
  await expect(top.getByRole("listitem")).toHaveCount(3);
  await expect(top.getByRole("listitem").first()).toContainText("Ace#E2E");
  await expect(top.getByRole("listitem").first()).toContainText("67");

  await top.getByRole("link", { name: /Tester#E2E/ }).click();
  await expect(page).toHaveURL(/\/player\/Tester\/E2E$/);

  await page.goto("/");
  await page.getByRole("link", { name: /Full leaderboard/ }).click();
  await expect(page).toHaveURL(/\/leaderboard$/);
});

test("no page scrolls sideways on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ["/", "/leaderboard", "/player/Tester/E2E"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

test("the JSON API sorts, limits, and validates", async ({ request }) => {
  const res = await request.get("/api/leaderboard?sort=kd&limit=2");
  const body = await res.json();

  expect(body).toMatchObject({ sort: "kd", minMatches: 5, limit: 2 });
  expect(body.entries.map((e: { name: string; kd: number }) => [e.name, e.kd])).toEqual([
    ["Tester", 1.25],
    ["Ace", 1.1],
  ]);

  for (const bad of ["sort=playerId", "minMatches=0", "limit=500"]) {
    expect((await request.get(`/api/leaderboard?${bad}`)).status(), bad).toBe(400);
  }
});
