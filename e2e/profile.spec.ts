import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MOCK_API_URL } from "./env.mjs";

// These tests drive a real browser against the production build. Upstream data comes
// from the mock API in mock-henrik.mjs; see fixtures.mjs for the player's 10 matches.

/** The value shown under a label in the "Overall Stats" panel. */
function statValue(page: Page, label: string) {
  const term = page.getByRole("term").filter({ hasText: new RegExp(`^${label}$`, "i") });
  return page.locator("dl > div").filter({ has: term }).getByRole("definition");
}

/** How many requests the mock HenrikDev API has received so far. */
async function upstreamCalls(request: APIRequestContext): Promise<number> {
  const res = await request.get(`${MOCK_API_URL}/__calls`);
  return (await res.json()).total;
}

async function searchFor(page: Page, name: string, tag: string) {
  await page.getByPlaceholder("Riot Name (e.g. TenZ)").fill(name);
  await page.getByPlaceholder("Tag (e.g. NA1)").fill(tag);
  await page.getByRole("button", { name: "Search", exact: true }).click();
}

test("searching opens a profile with stats computed from the player's matches", async ({ page }) => {
  await page.goto("/");
  await searchFor(page, "Tester", "E2E");

  await expect(page).toHaveURL(/\/player\/Tester\/E2E$/);
  await expect(page).toHaveTitle("Tester#E2E · VALORANT StatTrack");
  await expect(page.getByText("Diamond 2")).toBeVisible();
  await expect(page.getByText("Peak - Ascendant 1")).toBeVisible();

  const expected = {
    Wins: "6",
    Losses: "4",
    Draws: "0",
    Winrate: "60%",
    KD: "1.25",
    ACS: "250",
    ADR: "160",
    "Tracker Score": "57",
  };
  for (const [label, value] of Object.entries(expected)) {
    await expect(statValue(page, label), label).toHaveText(value);
  }

  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(10);
  // Newest match first: a 13-7 win on Ascent. The date cell can be anything.
  await expect(rows.first().getByRole("cell")).toHaveText([
    "—", "Ascent", "Competitive", "—", "13–7", "W", /.+/, "20/16/5", "250", "25", "160",
  ]);
  // Oldest match last: a 7-13 loss on Sunset.
  await expect(rows.last()).toContainText("Sunset");
  await expect(rows.last()).toContainText("7–13");
});

test("repeat profile views come from the cache, with no upstream API calls", async ({ page, request }) => {
  await page.goto("/player/Tester/E2E");
  await expect(page.locator("tbody tr")).toHaveCount(10);
  const before = await upstreamCalls(request);

  await page.reload();
  await expect(page.locator("tbody tr")).toHaveCount(10);

  expect(await upstreamCalls(request)).toBe(before);
});

test("an unknown player shows what failed instead of an error page", async ({ page }) => {
  const response = await page.goto("/player/Nobody/0000");

  expect(response?.status()).toBe(200);
  await expect(page.getByText("Couldn't sync recent matches (HTTP 404)")).toBeVisible();
  await expect(page.getByText("Couldn't load player card (HTTP 404)")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(0);
});

test("the search box remembers players you looked up", async ({ page }) => {
  await page.goto("/");
  await searchFor(page, "Tester", "E2E");
  await expect(page).toHaveURL(/\/player\/Tester\/E2E$/);

  await page.goto("/");
  await page.getByPlaceholder("Riot Name (e.g. TenZ)").click();
  const recent = page.getByRole("button", { name: /Tester\s*#E2E/ });
  await expect(recent).toBeVisible();

  await recent.click();
  await expect(page).toHaveURL(/\/player\/Tester\/E2E$/);
});

test("the JSON API validates input, serves cached data, and reports health", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(await health.json()).toEqual({ status: "ok", checks: { database: "ok", cache: "ok" } });

  expect((await request.get("/api/overall?region=xx&name=a&tag=b")).status()).toBe(400);

  await request.get("/api/overall?name=Tester&tag=E2E");
  const cached = await request.get("/api/overall?name=Tester&tag=E2E");
  expect(cached.headers()["x-cache"]).toBe("HIT");
  expect((await cached.json()).data.current_data.currenttierpatched).toBe("Diamond 2");
});
