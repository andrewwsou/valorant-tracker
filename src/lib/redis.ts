import { Redis } from "@upstash/redis";

/** Longest one cache request (a command, or a pipelined batch) may take before it fails. */
export const REDIS_TIMEOUT_MS = 500;

/**
 * A Redis client that fails fast, so a slow or unreachable cache costs a page
 * well under a second instead of the client's default of 5 retries (about 4.3 s
 * when Redis refuses connections, minutes when it hangs).
 *
 * `signal` must be a function: the client calls it once per HTTP request. A
 * single shared AbortSignal would fire once and then break every later command.
 */
export function createRedis(url: string, token: string): Redis {
  return new Redis({
    url,
    token,
    retry: { retries: 1, backoff: () => 50 },
    signal: () => AbortSignal.timeout(REDIS_TIMEOUT_MS),
  });
}

export const redis = createRedis(process.env.UPSTASH_REDIS_REST_URL!, process.env.UPSTASH_REDIS_REST_TOKEN!);

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  const v = await redis.get(key);
  return (v as T) ?? null;
}

export async function cacheSetJson(key: string, value: unknown, ttlSeconds: number) {
  await redis.set(key, value, { ex: ttlSeconds });
}

export async function cacheDelete(...keys: string[]) {
  if (keys.length > 0) await redis.del(...keys);
}

/** Reads timestamps (epoch ms) stored by extendUntil. Missing keys are null. */
export async function getUntil(...keys: string[]): Promise<(number | null)[]> {
  const values = await redis.mget<(string | number | null)[]>(...keys);
  return values.map((v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v)));
}

// Sets the key to ARGV[1] (epoch ms), expiring at that moment, but only if that's
// later than what's stored. Atomic, so concurrent writers can only extend it.
const EXTEND_UNTIL_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local next = tonumber(ARGV[1])
if next > current then
  redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[1])
  return 1
end
return 0`;

/** Pushes the timestamp stored at `key` out to `untilMs`, never back. True if it changed. */
export async function extendUntil(key: string, untilMs: number): Promise<boolean> {
  return (await redis.eval(EXTEND_UNTIL_SCRIPT, [key], [String(Math.round(untilMs))])) === 1;
}

/**
 * Takes a short-lived lock: true if this caller got it, false if someone else holds it.
 * `token` identifies the holder, so only they can release it.
 */
export async function claimLock(key: string, token: string, ttlMs: number, client: Redis = redis): Promise<boolean> {
  if ((await client.set(key, token, { nx: true, px: ttlMs })) === "OK") return true;
  // The client retries a request whose reply was lost. If the first try landed, the
  // retry sees our own lock and fails, so check whose lock it is before giving up.
  return (await client.get<string>(key)) === token;
}

// Deletes the key only if it still holds this caller's token, so an expired lock that
// someone else has since taken is never released by mistake. Atomic.
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export async function releaseLock(key: string, token: string): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, [key], [token]);
}

export async function lockHeld(key: string): Promise<boolean> {
  return (await redis.exists(key)) === 1;
}
