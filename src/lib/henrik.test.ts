import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({
  cacheGetJson: vi.fn(),
  cacheSetJson: vi.fn(),
}));

import { CACHE_TTL_SECONDS, getAccount, getMatches, getMmr } from "@/lib/henrik";
import { cacheGetJson, cacheSetJson } from "@/lib/redis";

const fetchMock = vi.fn<typeof fetch>();

function upstream(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("HENRIKDEV_API_KEY", "test-key");
  vi.mocked(cacheGetJson).mockResolvedValue(null);
  vi.mocked(cacheSetJson).mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("cached lookups", () => {
  it("serves a cache hit without calling upstream", async () => {
    const cached = { status: 200, contentType: "application/json", body: '{"data":{}}' };
    vi.mocked(cacheGetJson).mockResolvedValue(cached);

    await expect(getAccount("enzo", "yyy")).resolves.toEqual({ ...cached, cache: "HIT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on a miss, calls upstream once with the API key and caches the response", async () => {
    fetchMock.mockResolvedValue(upstream(200, { data: { name: "enzo" } }));

    await expect(getAccount("enzo", "yyy")).resolves.toMatchObject({ status: 200, cache: "MISS" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.henrikdev.xyz/valorant/v1/account/enzo/yyy");
    expect(init?.headers).toEqual({ Authorization: "test-key" });
    expect(cacheSetJson).toHaveBeenCalledWith(
      "henrik:v1:account:enzo:yyy",
      { status: 200, contentType: "application/json", body: '{"data":{"name":"enzo"}}' },
      CACHE_TTL_SECONDS.account,
    );
  });

  it("caches rank data for 5 minutes under a lowercase key", async () => {
    fetchMock.mockResolvedValue(upstream(200, { data: {} }));

    await getMmr("na", "Enzo", "YYY");

    expect(cacheSetJson).toHaveBeenCalledWith("henrik:v1:mmr:na:enzo:yyy", expect.anything(), 300);
  });

  it("does not cache error responses", async () => {
    fetchMock.mockResolvedValue(upstream(404, { errors: [{ code: 22, message: "Account not found" }] }));

    await expect(getAccount("ghost", "0000")).resolves.toMatchObject({ status: 404, cache: "MISS" });
    expect(cacheSetJson).not.toHaveBeenCalled();
  });

  it("still answers when the cache is down", async () => {
    vi.mocked(cacheGetJson).mockRejectedValue(new Error("redis down"));
    vi.mocked(cacheSetJson).mockRejectedValue(new Error("redis down"));
    fetchMock.mockResolvedValue(upstream(200, { data: {} }));

    await expect(getAccount("enzo", "yyy")).resolves.toMatchObject({ status: 200, cache: "MISS" });
  });

  it("URL-encodes Riot IDs", async () => {
    fetchMock.mockResolvedValue(upstream(200, { data: {} }));

    await getAccount("two words", "#1");

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.henrikdev.xyz/valorant/v1/account/two%20words/%231");
  });

  it("fails fast when the API key is missing", async () => {
    vi.stubEnv("HENRIKDEV_API_KEY", "");

    await expect(getAccount("enzo", "yyy")).rejects.toThrow("HENRIKDEV_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getMatches", () => {
  it("never touches the cache, because the payload is several megabytes", async () => {
    fetchMock.mockResolvedValue(upstream(200, { data: [] }));

    await getMatches("na", "enzo", "yyy", { size: 10, mode: "competitive" });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.henrikdev.xyz/valorant/v3/matches/na/enzo/yyy?size=10&mode=competitive",
    );
    expect(cacheGetJson).not.toHaveBeenCalled();
    expect(cacheSetJson).not.toHaveBeenCalled();
  });
});
