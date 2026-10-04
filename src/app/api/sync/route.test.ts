import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/sync", () => ({ SYNC_COOLDOWN_MS: 300_000, syncPlayer: vi.fn() }));

import { POST } from "@/app/api/sync/route";
import { syncPlayer } from "@/services/sync";

const post = (query: string) => POST(new NextRequest(`http://localhost/api/sync?${query}`, { method: "POST" }));

beforeEach(() => {
  vi.mocked(syncPlayer).mockResolvedValue({ status: "synced", matchesUpserted: 10, playerMatchesUpserted: 10 });
});

describe("POST /api/sync", () => {
  it("answers 502 when HenrikDev's match data couldn't be read", async () => {
    vi.mocked(syncPlayer).mockResolvedValue({ status: "invalid-payload" });

    const res = await post("name=Enzo&tag=YYY");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "HenrikDev sent match data this app couldn't read" });
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
