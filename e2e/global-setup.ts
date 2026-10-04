import { execSync } from "node:child_process";
import { PrismaClient } from "../src/generated/prisma";
import { appEnv } from "./env.mjs";

/** Gives every test run a migrated, empty test database and an empty cache. */
export default async function globalSetup() {
  execSync("npx prisma migrate deploy", { env: { ...process.env, ...appEnv }, stdio: "ignore" });

  const prisma = new PrismaClient({ datasourceUrl: appEnv.DATABASE_URL });
  try {
    await prisma.$executeRawUnsafe('TRUNCATE "PlayerMatch", "Match", "Player"');
  } finally {
    await prisma.$disconnect();
  }

  const res = await fetch(appEnv.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${appEnv.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(["FLUSHDB"]),
  });
  if (!res.ok) throw new Error(`Could not clear the cache: HTTP ${res.status} ${await res.text()}`);
}
