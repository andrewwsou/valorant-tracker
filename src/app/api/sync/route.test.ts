import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/sync", () => ({ SYNC_COOLDOWN_MS: 300_000, SYNC_WAIT_MS: 15_000, syncPlayer: vi.fn() }));

import { POST } from "@/app/api/sync/route";
import { syncPlayer } from "@/services/sync";

const SECRET = "s".repeat(64);
const post = (query: string, authorization: string | null = `Bearer ${SECRET}`) =>
  POST(
    new NextRequest(`http://localhost/api/sync?${query}`, {
      method: "POST",
      headers: authorization ? { authorization } : {},
    }),
  );

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.mocked(syncPlayer).mockResolvedValue({ status: "synced", player: "Enzo#YYY", matchesUpserted: 10, playerMatchesUpserted: 10 });
});

describe("POST /api/sync", () => {
  it("refuses a request without the secret before reading it or calling anything", async () => {
    const res = await post("name=&tag=", null);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ outcome: "unauthorized" });
    expect(syncPlayer).not.toHaveBeenCalled();
  });

  it("answers every result with an outcome the nightly job can act on", async () => {
    const results = [
      [{ status: "synced", player: "Enzo#YYY", matchesUpserted: 1, playerMatchesUpserted: 1 }, 200, "synced"],
      [{ status: "skipped", player: "Enzo#YYY", lastSyncedAt: new Date() }, 200, "skipped"],
      [{ status: "no-matches" }, 200, "no-matches"],
      [{ status: "invalid-payload" }, 502, "invalid-payload"],
      [{ status: "player-not-in-matches" }, 500, "player-not-in-matches"],
    ] as const;
    for (const [result, status, outcome] of results) {
      vi.mocked(syncPlayer).mockResolvedValue(result as never);
      const res = await post("name=Enzo&tag=YYY");
      expect(res.status, outcome).toBe(status);
      expect(await res.json()).toMatchObject({ outcome, player: "Enzo#YYY" });
    }
    expect(await (await post("tag=YYY")).json()).toMatchObject({ outcome: "bad-request" });
  });

  it("syncs a tracked player by PUUID, naming them from the stored row", async () => {
    vi.mocked(syncPlayer).mockResolvedValue({ status: "synced", player: "Enzo#YYY", matchesUpserted: 10, playerMatchesUpserted: 10 });

    const res = await post("puuid=54942ced-1967-5f66&region=eu");

    expect(syncPlayer).toHaveBeenCalledWith({ region: "eu", puuid: "54942ced-1967-5f66" }, 10);
    expect(await res.json()).toMatchObject({ outcome: "synced", player: "Enzo#YYY" });
  });

  it("rejects a PUUID that could change the upstream URL", async () => {
    const res = await post("puuid=..%2Fv1");

    expect(res.status).toBe(400);
    expect(syncPlayer).not.toHaveBeenCalled();
  });

  it("says when another sync of the player is running, and when to come back", async () => {
    vi.mocked(syncPlayer).mockResolvedValue({ status: "in-progress" });

    const res = await post("name=Enzo&tag=YYY");

    expect(res.status).toBe(409);
    expect(res.headers.get("retry-after")).toBe("15");
    expect(await res.json()).toMatchObject({ outcome: "in-progress", player: "Enzo#YYY" });
  });

  it("answers 404 for a PUUID it doesn't track", async () => {
    vi.mocked(syncPlayer).mockResolvedValue({ status: "not-tracked" });

    const res = await post("puuid=unknown-puuid");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ outcome: "not-tracked", player: "puuid:unknown-" });
  });

  it("answers 502 when HenrikDev's match data couldn't be read", async () => {
    vi.mocked(syncPlayer).mockResolvedValue({ status: "invalid-payload" });

    const res = await post("name=Enzo&tag=YYY");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      outcome: "invalid-payload",
      player: "Enzo#YYY",
      error: "HenrikDev sent match data this app couldn't read",
    });
  });

  it("asks for 1 to 10 matches, the most HenrikDev's v4 list returns", async () => {
    for (const [size, sent] of [
      ["", 10],
      ["5", 5],
      ["25", 10],
      ["0", 1],
      ["-3", 1],
      ["abc", 10],
    ] as const) {
      vi.mocked(syncPlayer).mockClear();
      await post(`name=Enzo&tag=YYY&size=${size}`);
      expect(syncPlayer, `size=${size}`).toHaveBeenCalledWith({ region: "na", name: "Enzo", tag: "YYY" }, sent);
    }
  });

  it("reports HenrikDev refusing the app's API key as a bad gateway, never as a 401", async () => {
    for (const httpStatus of [401, 403]) {
      vi.mocked(syncPlayer).mockResolvedValue({ status: "upstream-error", httpStatus, contentType: "application/json", body: "{}" });

      const res = await post("name=Enzo&tag=YYY");

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ outcome: "upstream-auth", player: "Enzo#YYY" });
    }
  });

  it("passes a wait from upstream on as Retry-After", async () => {
    vi.mocked(syncPlayer).mockResolvedValue({
      status: "upstream-error",
      httpStatus: 429,
      contentType: "application/json",
      body: "{}",
      retryAfterSeconds: 25,
    });

    const res = await post("name=Enzo&tag=YYY");

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("25");
  });
});
