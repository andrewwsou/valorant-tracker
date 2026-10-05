import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/henrik", () => ({ getAccount: vi.fn(), getMmr: vi.fn(), getMmrHistory: vi.fn() }));
vi.mock("@/services/sync", () => ({ syncPlayer: vi.fn() }));
vi.mock("@/services/matches", () => ({ getRecentMatches: vi.fn() }));

import { getAccount, getMmr, getMmrHistory } from "@/lib/henrik";
import type { RiotId } from "@/lib/riot-id";
import { getRecentMatches, type MatchRow } from "@/services/matches";
import { getPlayerProfile } from "@/services/profile";
import { syncPlayer, type SyncResult } from "@/services/sync";

const id: RiotId = { region: "na", name: "enzo", tag: "yyy" };

const row: MatchRow = {
  matchId: "m1",
  map: "Haven",
  mode: "Competitive",
  region: "na",
  startedAt: "2026-10-01T00:00:00.000Z",
  roundsRed: 13,
  roundsBlue: 9,
  team: "red",
  kills: 18,
  deaths: 9,
  assists: 7,
  score: 5055,
  damage: 3100,
  headshots: 12,
  bodyshots: 30,
  legshots: 2,
  agentIcon: null,
};

const skipped: SyncResult = { status: "skipped", lastSyncedAt: new Date(), player: "enzo#yyy" };

// Real HenrikDev image URLs: only https on media.valorant-api.com reach the page.
const MEDIA = "https://media.valorant-api.com";
const CARD = `${MEDIA}/playercards/03f88215-41f1-d3a2-7983-67b56517eb72/smallart.png`;
const RADIANT = `${MEDIA}/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/27/smallicon.png`;
const DIAMOND = `${MEDIA}/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/19/smallicon.png`;

function ok(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify({ data }), cache: "MISS" as const };
}

function failed(status: number) {
  return { status, contentType: "application/json", body: '{"errors":[]}', cache: "MISS" as const };
}

beforeEach(() => {
  vi.mocked(syncPlayer).mockResolvedValue(skipped);
  vi.mocked(getAccount).mockResolvedValue(ok({ card: { small: CARD } }));
  vi.mocked(getMmr).mockResolvedValue(
    ok({
      current_data: { currenttierpatched: "Radiant", images: { small: RADIANT } },
      highest_rank: { patched_tier: "Radiant" },
    }),
  );
  vi.mocked(getMmrHistory).mockResolvedValue(ok([{ match_id: "m1", images: { small: DIAMOND } }]));
  vi.mocked(getRecentMatches).mockResolvedValue({ cache: "MISS", player: null, data: [row] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getPlayerProfile", () => {
  it("combines the sync, card, rank, rank history, and match list", async () => {
    const profile = await getPlayerProfile(id);

    expect(profile).toMatchObject({
      cardImage: CARD,
      rank: { current: "Radiant", icon: RADIANT, peak: "Radiant" },
      matches: [row],
      errors: [],
    });
    expect(profile.rankIconByMatch.get("m1")).toBe(DIAMOND);
  });

  it("drops an image from a host the page can't load, keeping everything else", async () => {
    vi.mocked(getAccount).mockResolvedValue(ok({ card: { small: "https://evil.example/card.png" } }));

    const profile = await getPlayerProfile(id);

    expect(profile.cardImage).toBeNull();
    expect(profile.rank.icon).toBe(RADIANT);
    expect(profile.errors).toEqual([]);
  });

  it("says it couldn't read a part whose answer has no usable data", async () => {
    vi.mocked(getAccount).mockResolvedValue(ok(null));
    vi.mocked(getMmrHistory).mockResolvedValue(ok({ not: "a list" }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const profile = await getPlayerProfile(id);

    expect(profile.errors).toEqual(["Couldn't read player card", "Couldn't read rank history"]);
    expect(profile.rank.current).toBe("Radiant");
  });

  it("reports validation only for fresh answers, not for every view of a cached one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const history = ok([{ images: { small: RADIANT } }, { match_id: "m1", images: { small: DIAMOND } }]);

    vi.mocked(getMmrHistory).mockResolvedValue({ ...history, cache: "HIT" });
    await getPlayerProfile(id);
    expect(warn).not.toHaveBeenCalled();

    vi.mocked(getMmrHistory).mockResolvedValue(history);
    await getPlayerProfile(id);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mmr-history: dropped 1 of 2 items"));
  });

  it("skips a rank history entry without a match ID", async () => {
    vi.mocked(getMmrHistory).mockResolvedValue(ok([{ images: { small: RADIANT } }, { match_id: "m1", images: { small: DIAMOND } }]));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const profile = await getPlayerProfile(id);

    expect([...profile.rankIconByMatch]).toEqual([["m1", DIAMOND]]);
  });

  it("says the matches are still syncing when another sync of this player didn't finish in time", async () => {
    vi.mocked(syncPlayer).mockResolvedValue({ status: "in-progress" });

    const profile = await getPlayerProfile(id);

    expect(profile.errors).toEqual(["Recent matches are still syncing. Refresh in a moment."]);
    expect(profile.matches).toEqual([row]);
  });

  it("reports a match list it couldn't read, and still shows stored matches", async () => {
    vi.mocked(syncPlayer).mockResolvedValue({ status: "invalid-payload" });

    const profile = await getPlayerProfile(id);

    expect(profile.errors).toEqual(["Couldn't read recent matches"]);
    expect(profile.matches).toEqual([row]);
  });

  it("starts the upstream lookups without waiting for the sync", async () => {
    let finishSync!: () => void;
    vi.mocked(syncPlayer).mockReturnValue(new Promise((resolve) => (finishSync = () => resolve(skipped))));

    const pending = getPlayerProfile(id);

    expect(getAccount).toHaveBeenCalled();
    expect(getMmr).toHaveBeenCalled();
    expect(getMmrHistory).toHaveBeenCalled();
    expect(getRecentMatches).not.toHaveBeenCalled(); // the match list has to wait for new rows

    finishSync();
    await pending;
    expect(getRecentMatches).toHaveBeenCalledWith("enzo", "yyy", 10);
  });

  it("keeps going when parts fail, and reports each failure", async () => {
    vi.mocked(syncPlayer).mockRejectedValue(new Error("database down"));
    vi.mocked(getAccount).mockRejectedValue(new Error("timeout"));
    vi.mocked(getMmr).mockResolvedValue(failed(404));

    const profile = await getPlayerProfile(id);

    expect(profile.errors).toEqual([
      "Couldn't sync recent matches",
      "Couldn't load player card",
      "Couldn't load current rank (HTTP 404)",
    ]);
    expect(profile.matches).toEqual([row]);
    expect(profile.rank.current).toBeNull();
  });

  it("reports an upstream error from the sync", async () => {
    vi.mocked(syncPlayer).mockResolvedValue({
      status: "upstream-error",
      httpStatus: 429,
      contentType: "application/json",
      body: "{}",
    });

    await expect(getPlayerProfile(id)).resolves.toMatchObject({ errors: ["Couldn't sync recent matches (HTTP 429)"] });
  });

  it("explains a pause once, with the longest wait, however many parts were paused", async () => {
    // The longest wait is on neither the first nor the last part checked.
    vi.mocked(getMmr).mockResolvedValue({ ...failed(429), retryAfterSeconds: 25 });
    vi.mocked(getMmrHistory).mockResolvedValue({ ...failed(429), retryAfterSeconds: 20 });
    vi.mocked(syncPlayer).mockResolvedValue({
      status: "upstream-error",
      httpStatus: 429,
      contentType: "application/json",
      body: "{}",
      retryAfterSeconds: 10,
    });

    const { errors } = await getPlayerProfile(id);

    expect(errors.filter((e) => e.includes("paused"))).toEqual([
      "Live data is paused for about 25s to stay under the HenrikDev rate limit.",
    ]);
    expect(errors).toContain("Couldn't load current rank (HTTP 429)");
  });

  it("says HenrikDev looks down when the pause is an outage", async () => {
    vi.mocked(getAccount).mockResolvedValue({ ...failed(503), retryAfterSeconds: 30 });

    const { errors } = await getPlayerProfile(id);

    expect(errors).toContain("HenrikDev looks unavailable. Live data will be retried in about 30s.");
  });

  it("reports a failed match list without throwing", async () => {
    vi.mocked(getRecentMatches).mockRejectedValue(new Error("database down"));

    const profile = await getPlayerProfile(id);

    expect(profile.matches).toEqual([]);
    expect(profile.errors).toEqual(["Couldn't load recent matches"]);
  });
});
