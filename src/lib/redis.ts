import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  const v = await redis.get(key);
  return (v as T) ?? null;
}

export async function cacheSetJson(key: string, value: any, ttlSeconds: number) {
  await redis.set(key, value, { ex: ttlSeconds });
}

export async function invalidatePlayerMatches(name: string, tag: string) {
  const n = name.toLowerCase();
  const t = tag.toLowerCase();
  await Promise.all([
    redis.del(`dbmatches:v2:${n}:${t}:limit=10`),
    redis.del(`dbmatches:v2:${n}:${t}:limit=25`)
  ]);
}
