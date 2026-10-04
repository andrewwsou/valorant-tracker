import { NextResponse } from "next/server";
import { msSince, nowMs } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

const CHECK_TIMEOUT_MS = 2_000;

type CheckResult = "ok" | "down";

/** Runs one dependency probe. Errors and slow answers both count as "down". */
async function check(probe: () => Promise<unknown>): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return "ok";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Health check for Docker and uptime monitors.
 *
 * - 200 "ok": database and cache are reachable.
 * - 200 "degraded": the cache is down. Pages still work, but slower and with more upstream calls.
 * - 503 "down": the database is down, so syncing and match history cannot work.
 */
export async function GET() {
  const t0 = nowMs();
  const [database, cache] = await Promise.all([
    check(() => prisma.$queryRaw`SELECT 1`),
    check(() => redis.ping()),
  ]);

  const status = database === "down" ? "down" : cache === "down" ? "degraded" : "ok";

  return NextResponse.json(
    { status, checks: { database, cache } },
    {
      status: status === "down" ? 503 : 200,
      headers: { "cache-control": "no-store", "x-response-ms": String(msSince(t0)) },
    },
  );
}
