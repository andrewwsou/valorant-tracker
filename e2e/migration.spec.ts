import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PrismaClient } from "../src/generated/prisma";
import { appEnv } from "./env.mjs";

// Runs the real migration SQL that adds Player.riotIdKey against data shaped like
// production's before it: rows differing only in case, a row without a PUUID, and a
// non-ASCII name. Uses its own scratch database, created and dropped here.

const MIGRATIONS = "prisma/migrations";
const KEY_MIGRATION = "20261004200000_player_riot_id_key";
const scratchName = "valorant_migration_check";
const scratchUrl = (() => {
  const url = new URL(appEnv.DATABASE_URL);
  url.pathname = `/${scratchName}`;
  return url.toString();
})();

const runSql = (dir: string) =>
  execSync(`npx prisma db execute --file ${join(MIGRATIONS, dir, "migration.sql")} --url "${scratchUrl}"`, { stdio: "pipe" });

test("the Riot ID key migration keeps one key per lowercased Riot ID and drops nothing", async () => {
  test.setTimeout(60_000);
  const admin = new PrismaClient({ datasourceUrl: appEnv.DATABASE_URL });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${scratchName}`);
  await admin.$executeRawUnsafe(`CREATE DATABASE ${scratchName}`);
  const db = new PrismaClient({ datasourceUrl: scratchUrl });
  try {
    // Every migration before this one, in order.
    const before = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d) && d < KEY_MIGRATION).sort();
    for (const dir of before) runSql(dir);

    const hourAgo = new Date(Date.now() - 3_600_000);
    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    await db.$executeRaw`
      INSERT INTO "Player" (id, name, tag, puuid, "lastSyncedAt") VALUES
        ('enzo-with-puuid', 'Enzo', 'YYY', 'p-enzo', ${hourAgo}),
        ('enzo-no-puuid', 'enzo', 'yyy', NULL, now()),
        ('ace-older', 'Ace', 'na1', 'p-ace-1', ${twoHoursAgo}),
        ('ace-newer', 'ace', 'NA1', 'p-ace-2', ${hourAgo}),
        ('greek', 'Σίσυφος', 'EU1', 'p-greek', NULL),
        ('plain', 'Plain', 'T1', 'p-plain', NULL)`;

    runSql(KEY_MIGRATION);

    const rows = await db.$queryRaw<{ id: string; riotIdKey: string | null }[]>`SELECT id, "riotIdKey" FROM "Player" ORDER BY id`;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.riotIdKey]))).toEqual({
      // A row with a PUUID wins over one without, even if that one synced later.
      "enzo-with-puuid": "enzo#yyy",
      "enzo-no-puuid": null,
      // Between two PUUIDs, the most recently synced wins.
      "ace-newer": "ace#na1",
      "ace-older": null,
      // Postgres and JavaScript lowercase some non-ASCII letters differently, so the app sets this one.
      greek: null,
      plain: "plain#t1",
    });

    // The case-sensitive name+tag index is gone, so a player can take a name a stale row still shows.
    await db.$executeRaw`INSERT INTO "Player" (id, name, tag, puuid, "riotIdKey") VALUES ('new-plain', 'Plain', 'T1', 'p-new', NULL)`;
    // And the key is unique.
    await expect(db.$executeRaw`UPDATE "Player" SET "riotIdKey" = 'plain#t1' WHERE id = 'new-plain'`).rejects.toThrow();
  } finally {
    await db.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${scratchName}`);
    await admin.$disconnect();
  }
});
