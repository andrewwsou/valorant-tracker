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
