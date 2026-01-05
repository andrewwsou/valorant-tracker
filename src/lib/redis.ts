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
