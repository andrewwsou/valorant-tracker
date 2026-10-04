import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({
  cacheGetJson: vi.fn(),
  cacheSetJson: vi.fn(),
  getUntil: vi.fn(),
  extendUntil: vi.fn(),
}));

import { CACHE_TTL_SECONDS, getAccount, getMatches, getMmr, NEGATIVE_TTL_SECONDS } from "@/lib/henrik";
import { resetLimitsForTests } from "@/lib/henrik-limits";
import { cacheGetJson, cacheSetJson, extendUntil, getUntil } from "@/lib/redis";

const fetchMock = vi.fn<typeof fetch>();

function upstream(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fetch that never answers on its own, like a hung server. It only fails when aborted. */
function hang(_url: unknown, init?: RequestInit) {
  return new Promise<Response>((_, reject) =>
    init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError"))),
  );
}

/** Headers arrive, then the body stalls mid-stream until the request is aborted. */
function stalledBody(_url: unknown, init?: RequestInit) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":'));
      init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  });
  return Promise.resolve(new Response(body, { status: 200 }));
}

const refused = () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));

/** Headers arrive, then the connection drops partway through the body. */
function cutOffBody() {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":['));
      controller.error(new TypeError("terminated"));
    },
  });
  return Promise.resolve(new Response(body, { status: 200 }));
}

/** Runs a lookup while letting fake time pass, and reports how much passed. */
async function timed<T>(call: Promise<T>, budgetMs = 20_000) {
  const start = Date.now();
  let settled = false;
  let elapsed = 0;
  const result = call.finally(() => {
    settled = true;
    elapsed = Date.now() - start;
  });
  for (let t = 0; t < budgetMs && !settled; t += 50) await vi.advanceTimersByTimeAsync(50);
  return { result: await result, elapsed };
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-10-04T12:00:00Z") });
  resetLimitsForTests();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("HENRIKDEV_API_KEY", "test-key");
  vi.mocked(cacheGetJson).mockResolvedValue(null);
  vi.mocked(cacheSetJson).mockResolvedValue(undefined);
  vi.mocked(getUntil).mockResolvedValue([null, null]);
  vi.mocked(extendUntil).mockResolvedValue(true);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.useRealTimers());

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
    expect(init?.signal).toBeInstanceOf(AbortSignal);
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

  it("caches a not-found answer for 5 minutes, so repeat views cost nothing", async () => {
    fetchMock.mockResolvedValue(upstream(404, { errors: [{ code: 22, message: "Account not found" }] }));

    await expect(getAccount("ghost", "0000")).resolves.toMatchObject({ status: 404, cache: "MISS" });
    expect(cacheSetJson).toHaveBeenCalledWith(
      "henrik:v1:account:ghost:0000",
      expect.objectContaining({ status: 404 }),
      NEGATIVE_TTL_SECONDS.notFound,
    );

    vi.mocked(cacheGetJson).mockResolvedValue(vi.mocked(cacheSetJson).mock.calls[0][1]);
    await expect(getAccount("ghost", "0000")).resolves.toMatchObject({ status: 404, cache: "HIT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("doesn't cache answers that mean the request itself is wrong", async () => {
    for (const status of [400, 401, 403]) {
      fetchMock.mockResolvedValueOnce(upstream(status, { errors: [] }));
      await expect(getAccount("enzo", "yyy")).resolves.toMatchObject({ status });
    }
    expect(cacheSetJson).not.toHaveBeenCalled();
  });

  it("treats a cached value of the wrong shape as a miss", async () => {
    vi.mocked(cacheGetJson).mockResolvedValue({ data: "left by an older version" });
    fetchMock.mockResolvedValue(upstream(200, { data: {} }));

    await expect(getAccount("enzo", "yyy")).resolves.toMatchObject({ status: 200, cache: "MISS" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still answers when the cache is down", async () => {
    vi.mocked(cacheGetJson).mockRejectedValue(new Error("redis down"));
    vi.mocked(cacheSetJson).mockRejectedValue(new Error("redis down"));
    vi.mocked(getUntil).mockRejectedValue(new Error("redis down"));
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
  it("doesn't cache a successful response, because the payload is several megabytes", async () => {
    fetchMock.mockResolvedValue(upstream(200, { data: [{ metadata: { matchid: "m1" } }] }));

    await getMatches("na", "enzo", "yyy", { size: 10, mode: "competitive" });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.henrikdev.xyz/valorant/v3/matches/na/enzo/yyy?size=10&mode=competitive",
    );
    expect(cacheSetJson).not.toHaveBeenCalled();
  });

  it("caches a not-found answer and an empty match history for 5 minutes", async () => {
    fetchMock.mockResolvedValueOnce(upstream(404, { errors: [] }));
    await getMatches("na", "Ghost", "0000", { size: 10, mode: "competitive" });
    fetchMock.mockResolvedValueOnce(upstream(200, { status: 200, data: [] }));
    await getMatches("na", "Fresh", "0001", { size: 10, mode: "competitive" });

    expect(cacheSetJson).toHaveBeenCalledWith("henrik:v1:matches:na:ghost:0000:competitive", expect.anything(), 300);
    expect(cacheSetJson).toHaveBeenCalledWith("henrik:v1:matches:na:fresh:0001:competitive", expect.anything(), 300);
  });
});

describe("timeouts and retries", () => {
  it("times out a hung request, retries once, then answers 504 and caches it for 30 seconds", async () => {
    fetchMock.mockImplementation(hang);

    const { result, elapsed } = await timed(getAccount("enzo", "yyy"));

    expect(result).toMatchObject({ status: 504, cache: "MISS" });
    expect(JSON.parse(result.body).errors[0].details).toEqual({ source: "stattrack", reason: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Two 3-second attempts and a jittered wait of at most 250 ms between them.
    expect(elapsed).toBeGreaterThanOrEqual(6_000);
    expect(elapsed).toBeLessThanOrEqual(6_300);
    expect(cacheSetJson).toHaveBeenCalledWith("henrik:v1:account:enzo:yyy", expect.objectContaining({ status: 504 }), 30);
  });

  it("times out a body that stops arriving, not just a missing response", async () => {
    fetchMock.mockImplementationOnce(stalledBody).mockResolvedValueOnce(upstream(200, { data: {} }));

    const { result, elapsed } = await timed(getAccount("enzo", "yyy"));

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(3_000);
    expect(elapsed).toBeLessThan(3_500);
  });

  it("never retries a matches timeout: it was probably already charged, and it's 7 MB", async () => {
    fetchMock.mockImplementation(hang);

    const { result, elapsed } = await timed(getMatches("na", "enzo", "yyy", { size: 10, mode: "competitive" }));

    expect(result.status).toBe(504);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elapsed).toBe(10_000);
  });

  it("retries a refused connection after a jittered wait", async () => {
    fetchMock.mockImplementationOnce(refused).mockResolvedValueOnce(upstream(200, { data: {} }));

    const { result, elapsed } = await timed(getAccount("enzo", "yyy"));

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Math.random is 0.5, so the wait is half of the 250 ms ceiling.
    expect(elapsed).toBe(125);
  });

  it("answers 502 when the API can't be reached at all, after exactly one retry", async () => {
    fetchMock.mockImplementation(refused);

    const { result } = await timed(getAccount("enzo", "yyy"));

    expect(result.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.body).errors[0].details.reason).toBe("ECONNREFUSED");
  });

  it("retries a small response cut off mid-body, but never a matches download", async () => {
    fetchMock.mockImplementationOnce(cutOffBody).mockResolvedValueOnce(upstream(200, { data: {} }));
    const { result: account } = await timed(getAccount("enzo", "yyy"));
    expect(account.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockImplementation(cutOffBody);
    const { result: matches } = await timed(getMatches("na", "enzo", "yyy", { size: 10, mode: "competitive" }));
    expect(matches.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 once", async () => {
    fetchMock.mockResolvedValueOnce(upstream(503, { errors: [] })).mockResolvedValueOnce(upstream(200, { data: {} }));

    const { result } = await timed(getMmr("na", "enzo", "yyy"));

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't start a retry that can't finish before the deadline", async () => {
    // A matches 503 after 7.5 s leaves 4.5 s, less than the 5 s a retry needs.
    fetchMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(upstream(503, { errors: [] })), 7_500)),
    );

    const { result } = await timed(getMatches("na", "enzo", "yyy", { size: 10, mode: "competitive" }));

    expect(result.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("doesn't retry when the budget is nearly spent", async () => {
    fetchMock.mockResolvedValueOnce(upstream(200, { data: {} }, { "x-ratelimit-remaining": "3", "x-ratelimit-reset": "40" }));
    await timed(getAccount("first", "0001"));
    fetchMock.mockResolvedValueOnce(upstream(503, { errors: [] }));

    const { result } = await timed(getAccount("second", "0002"));

    expect(result.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a 4xx", async () => {
    fetchMock.mockResolvedValue(upstream(404, { errors: [] }));

    await timed(getAccount("ghost", "0000"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("rate limits and cooldowns", () => {
  it("doesn't retry a 429; waits as long as the API asks, and shares that wait", async () => {
    fetchMock.mockResolvedValue(upstream(429, { errors: [] }, { "retry-after": "20", "x-ratelimit-reset": "25" }));
    const start = Date.now();

    const { result } = await timed(getAccount("enzo", "yyy"));

    expect(result).toMatchObject({ status: 429, retryAfterSeconds: 25 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(extendUntil).toHaveBeenCalledWith("henrik:v1:cooldown:rate_limit", start + 25_000);
    // A 429 is about the budget, not this player: never cached per key.
    expect(cacheSetJson).not.toHaveBeenCalled();
  });

  it("waits a minute when a 429 doesn't say how long, and at most 10 minutes", async () => {
    fetchMock.mockResolvedValueOnce(upstream(429, {}));
    await expect(getAccount("a", "0001")).resolves.toMatchObject({ retryAfterSeconds: 60 });

    resetLimitsForTests();
    fetchMock.mockResolvedValueOnce(upstream(429, {}, { "retry-after": "99999" }));
    await expect(getAccount("b", "0002")).resolves.toMatchObject({ retryAfterSeconds: 600 });
  });

  it("answers locally during a cooldown, for every player, until it ends", async () => {
    fetchMock.mockResolvedValueOnce(upstream(429, {}, { "retry-after": "25" }));
    await getAccount("enzo", "yyy");

    const paused = await getMmr("na", "someone", "else");
    expect(paused).toMatchObject({ status: 429, retryAfterSeconds: 25, cache: "MISS" });
    expect(JSON.parse(paused.body).errors[0].details).toEqual({ source: "stattrack", reason: "rate_limit_cooldown" });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(getMmr("na", "someone", "else")).resolves.toMatchObject({ retryAfterSeconds: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    fetchMock.mockResolvedValueOnce(upstream(200, { data: {} }));
    await expect(getMmr("na", "someone", "else")).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("respects a cooldown another instance started", async () => {
    vi.mocked(getUntil).mockResolvedValue([Date.now() + 10_000, null]);

    await expect(getAccount("enzo", "yyy")).resolves.toMatchObject({ status: 429, retryAfterSeconds: 10 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still serves cached data during a cooldown", async () => {
    vi.mocked(getUntil).mockResolvedValue([Date.now() + 10_000, null]);
    vi.mocked(cacheGetJson).mockResolvedValue({ status: 200, contentType: "application/json", body: "{}" });

    await expect(getAccount("enzo", "yyy")).resolves.toMatchObject({ status: 200, cache: "HIT" });
  });

  it("stops calling once the budget hits zero, before the API has to refuse", async () => {
    fetchMock.mockResolvedValueOnce(upstream(200, { data: {} }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "42" }));

    // The response that spent the last unit is still used and cached.
    await expect(getAccount("enzo", "yyy")).resolves.toMatchObject({ status: 200 });
    expect(cacheSetJson).toHaveBeenCalledTimes(1);

    await expect(getMmr("na", "enzo", "yyy")).resolves.toMatchObject({ status: 429, retryAfterSeconds: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pauses every call when a 503 asks for a long wait, and never caches that answer", async () => {
    fetchMock.mockResolvedValueOnce(upstream(503, { errors: [] }, { "retry-after": "30" }));
    const start = Date.now();

    const { result } = await timed(getAccount("enzo", "yyy"));

    expect(result).toMatchObject({ status: 503, retryAfterSeconds: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(extendUntil).toHaveBeenCalledWith("henrik:v1:cooldown:outage", start + 30_000);
    // The cooldown keeps calls away; a cached copy would outlive a shorter wait.
    expect(cacheSetJson).not.toHaveBeenCalled();
    await expect(getMmr("na", "other", "0001")).resolves.toMatchObject({ status: 503, retryAfterSeconds: 30 });
  });

  it("opens the circuit breaker after 5 failed lookups in a row", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(upstream(500, { errors: [] })));
    for (let i = 0; i < 5; i++) {
      const { result } = await timed(getAccount(`player${i}`, "0000"));
      // Each of the 5 really reached the API (an attempt and its retry).
      expect(result.status, `lookup ${i + 1}`).toBe(500);
      expect(fetchMock).toHaveBeenCalledTimes(2 * (i + 1));
    }

    const { result } = await timed(getAccount("next", "0000"));

    expect(result).toMatchObject({ status: 503, retryAfterSeconds: 30 });
    expect(JSON.parse(result.body).errors[0].details.reason).toBe("outage_cooldown");
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("after the breaker's cooldown, sends one probe without a retry while other lookups wait", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(upstream(500, { errors: [] })));
    for (let i = 0; i < 5; i++) await timed(getAccount(`player${i}`, "0000"));
    await vi.advanceTimersByTimeAsync(30_000);
    fetchMock.mockClear();

    let answer!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const probe = getAccount("probe", "0000");
    await vi.advanceTimersByTimeAsync(0);
    const waiting = await getAccount("waiting", "0000");
    expect(waiting).toMatchObject({ status: 503, retryAfterSeconds: 5 });
    expect(JSON.parse(waiting.body).errors[0].details.reason).toBe("outage_cooldown");

    answer(upstream(500, { errors: [] }));
    await expect(probe).resolves.toMatchObject({ status: 500 });
    // One call, no retry, and the breaker reopens straight away.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(getAccount("after", "0000")).resolves.toMatchObject({ status: 503, retryAfterSeconds: 30 });

    // The failed probe gave its slot back: the next cooldown ends with a new probe, not a wait.
    await vi.advanceTimersByTimeAsync(30_000);
    fetchMock.mockResolvedValueOnce(upstream(200, { data: {} }));
    await expect(getAccount("next-probe", "0000")).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("closes the breaker when the probe succeeds", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(upstream(500, { errors: [] })));
    for (let i = 0; i < 5; i++) await timed(getAccount(`player${i}`, "0000"));
    await vi.advanceTimersByTimeAsync(30_000);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(upstream(200, { data: {} }));
    await expect(getAccount("probe", "0000")).resolves.toMatchObject({ status: 200 });

    // Back to normal: retries are allowed again.
    fetchMock.mockResolvedValueOnce(upstream(503, {})).mockResolvedValueOnce(upstream(200, { data: {} }));
    const { result } = await timed(getAccount("normal", "0000"));
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("doesn't retry a 5xx whose own headers say the budget is spent, and pauses instead", async () => {
    fetchMock.mockResolvedValue(upstream(503, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "40" }));
    const start = Date.now();

    const { result } = await timed(getMmr("na", "enzo", "yyy"));

    expect(result.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(extendUntil).toHaveBeenCalledWith("henrik:v1:cooldown:rate_limit", start + 40_000);
  });

  it("doesn't retry a 5xx whose own headers say the budget is nearly spent", async () => {
    fetchMock.mockResolvedValue(upstream(503, {}, { "x-ratelimit-remaining": "3", "x-ratelimit-reset": "40" }));

    await timed(getMmr("na", "enzo", "yyy"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads the budget from headers that arrived before the body stalled", async () => {
    fetchMock.mockImplementation((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "40" } }),
      );
    });

    const { result } = await timed(getAccount("enzo", "yyy"));

    expect(result.status).toBe(504);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(extendUntil).toHaveBeenCalledWith("henrik:v1:cooldown:rate_limit", expect.any(Number));
  });

  it("drops a planned retry if another instance paused calls during the wait", async () => {
    fetchMock.mockResolvedValue(upstream(503, {}));
    // The lookup's own check finds no cooldown; the check after the backoff finds one.
    vi.mocked(getUntil)
      .mockResolvedValueOnce([null, null])
      .mockImplementation(() => Promise.resolve([Date.now() + 10_000, null]));

    const { result } = await timed(getMmr("na", "enzo", "yyy"));

    expect(result.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes on a 5xx's Retry-After when it doesn't retry, and doesn't cache that answer", async () => {
    // 8 s doesn't fit in the 7 s deadline, and is below the 10 s that pauses every call.
    fetchMock.mockResolvedValue(upstream(503, {}, { "retry-after": "8" }));

    const { result } = await timed(getAccount("enzo", "yyy"));

    expect(result).toMatchObject({ status: 503, retryAfterSeconds: 8 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cacheSetJson).not.toHaveBeenCalled();
  });
});
