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

const skipped: SyncResult = { status: "skipped", lastSyncedAt: new Date() };

function ok(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify({ data }), cache: "MISS" as const };
}

function failed(status: number) {
  return { status, contentType: "application/json", body: '{"errors":[]}', cache: "MISS" as const };
}

beforeEach(() => {
  vi.mocked(syncPlayer).mockResolvedValue(skipped);
  vi.mocked(getAccount).mockResolvedValue(ok({ card: { small: "card.png" } }));
  vi.mocked(getMmr).mockResolvedValue(
    ok({
      current_data: { currenttierpatched: "Radiant", images: { small: "radiant.png" } },
      highest_rank: { patched_tier: "Radiant" },
    }),
  );
  vi.mocked(getMmrHistory).mockResolvedValue(ok([{ match_id: "m1", images: { small: "rank-after-m1.png" } }]));
  vi.mocked(getRecentMatches).mockResolvedValue({ cache: "MISS", player: null, data: [row] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getPlayerProfile", () => {
  it("combines the sync, card, rank, rank history, and match list", async () => {
    const profile = await getPlayerProfile(id);

    expect(profile).toMatchObject({
      cardImage: "card.png",
      rank: { current: "Radiant", icon: "radiant.png", peak: "Radiant" },
      matches: [row],
      errors: [],
    });
    expect(profile.rankIconByMatch.get("m1")).toBe("rank-after-m1.png");
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

  it("reports a failed match list without throwing", async () => {
    vi.mocked(getRecentMatches).mockRejectedValue(new Error("database down"));

    const profile = await getPlayerProfile(id);

    expect(profile.matches).toEqual([]);
    expect(profile.errors).toEqual(["Couldn't load recent matches"]);
  });
});
