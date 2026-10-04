import { Prisma } from "@/generated/prisma";
import { getMatches, type HenrikMatch, type HenrikPlayer } from "@/lib/henrik";
import { prisma } from "@/lib/prisma";
import type { RiotId } from "@/lib/riot-id";
import { syncRuns, withSpan } from "@/lib/telemetry";
import { invalidateRecentMatches } from "@/services/matches";
import { refreshPlayerStats } from "@/services/player-stats";

/** Minimum time between two syncs of the same player, to protect the upstream rate limit. */
export const SYNC_COOLDOWN_MS = 5 * 60_000;

export type SyncResult =
  | { status: "skipped"; lastSyncedAt: Date }
  | { status: "synced"; matchesUpserted: number; playerMatchesUpserted: number }
  | { status: "no-matches" }
  | { status: "player-not-in-matches" }
  | { status: "upstream-error"; httpStatus: number; contentType: string; body: string; retryAfterSeconds?: number };

/** Finds a player in a match by Riot ID. Riot IDs ignore case. */
export function findPlayerByRiotId(match: HenrikMatch, name: string, tag: string): HenrikPlayer | undefined {
  return match.players?.all_players?.find(
    (p) =>
      (p.name ?? "").toLowerCase() === name.toLowerCase() &&
      (p.tag ?? "").toLowerCase() === tag.toLowerCase(),
  );
}

/**
 * Upstream data is untrusted, and the batch writes one statement for all rows:
 * a single value of the wrong type would fail the whole sync. So anything that
 * isn't what the column holds becomes null instead. Payload validation comes later.
 */
const INT_MAX = 2_147_483_647;
const int = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= INT_MAX ? Math.trunc(v) : null;
const text = (v: unknown) => (typeof v === "string" ? v : null);

/** The `Match` columns stored for one upstream match. */
export function toMatchRecord(match: HenrikMatch, region: string) {
  const start = match.metadata?.game_start;
  const startedAt = typeof start === "number" && start > 0 ? new Date(start * 1000) : null;
  return {
    map: text(match.metadata?.map),
    mode: text(match.metadata?.mode),
    region,
    startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
    roundsRed: int(match.teams?.red?.rounds_won),
    roundsBlue: int(match.teams?.blue?.rounds_won),
  };
}

/** The `PlayerMatch` columns stored for one player in one match. */
export function toPlayerMatchRecord(player: HenrikPlayer) {
  return {
    team: text(player.team)?.toLowerCase() ?? null,
    kills: int(player.stats?.kills),
    deaths: int(player.stats?.deaths),
    assists: int(player.stats?.assists),
    score: int(player.stats?.score),
    damage: int(player.damage_made),
    headshots: int(player.stats?.headshots),
    bodyshots: int(player.stats?.bodyshots),
    legshots: int(player.stats?.legshots),
    agentIcon: text(player.assets?.agent?.small),
  };
}

type MatchUpsert = ReturnType<typeof toMatchRecord> & { id: string };
type PlayerMatchUpsert = ReturnType<typeof toPlayerMatchRecord> & { matchId: string };

/**
 * One row per key, the last one winning like a row-by-row loop would, sorted by key.
 * A batch upsert can't touch the same row twice (Postgres error 21000), and a fixed
 * order stops two syncs that share matches, such as teammates, from deadlocking.
 */
export function uniqueByKey<T>(rows: T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
}

/**
 * Upserts every match in one statement. Returns the number of rows written.
 * startedAt is cast to UTC explicitly: the column has no time zone, and a raw
 * query's timestamp would otherwise be shifted by the session's time zone.
 */
function upsertMatches(rows: MatchUpsert[]): Promise<number> {
  if (rows.length === 0) return Promise.resolve(0);
  const values = rows.map(
    (m) =>
      Prisma.sql`(${m.id}, ${m.map}, ${m.mode}, ${m.region}, (${m.startedAt}::timestamptz AT TIME ZONE 'UTC'), ${m.roundsRed}, ${m.roundsBlue})`,
  );
  return prisma.$executeRaw`
    INSERT INTO "Match" ("id", "map", "mode", "region", "startedAt", "roundsRed", "roundsBlue")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("id") DO UPDATE SET
      "map" = EXCLUDED."map", "mode" = EXCLUDED."mode", "region" = EXCLUDED."region",
      "startedAt" = EXCLUDED."startedAt", "roundsRed" = EXCLUDED."roundsRed", "roundsBlue" = EXCLUDED."roundsBlue"`;
}

/**
 * Upserts the player's stat lines in one statement. New rows get a UUID for an
 * id; older rows keep the cuid Prisma generated. Nothing reads the id itself.
 */
function upsertPlayerMatches(playerId: string, rows: PlayerMatchUpsert[]): Promise<number> {
  if (rows.length === 0) return Promise.resolve(0);
  const values = rows.map(
    (l) => Prisma.sql`(gen_random_uuid()::text, ${l.matchId}, ${playerId}, ${l.team},
      ${l.kills}, ${l.deaths}, ${l.assists}, ${l.score}, ${l.damage},
      ${l.headshots}, ${l.bodyshots}, ${l.legshots}, ${l.agentIcon})`,
  );
  return prisma.$executeRaw`
    INSERT INTO "PlayerMatch" ("id", "matchId", "playerId", "team", "kills", "deaths", "assists",
      "score", "damage", "headshots", "bodyshots", "legshots", "agentIcon")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("matchId", "playerId") DO UPDATE SET
      "team" = EXCLUDED."team", "kills" = EXCLUDED."kills", "deaths" = EXCLUDED."deaths",
      "assists" = EXCLUDED."assists", "score" = EXCLUDED."score", "damage" = EXCLUDED."damage",
      "headshots" = EXCLUDED."headshots", "bodyshots" = EXCLUDED."bodyshots",
      "legshots" = EXCLUDED."legshots", "agentIcon" = EXCLUDED."agentIcon"`;
}

/**
 * Pulls a player's recent competitive matches and upserts them into Postgres.
 *
 * Idempotent: matches are keyed by match ID and stat lines by (match, player),
 * so running it twice never creates duplicates. Skipped inside the cooldown.
 */
export function syncPlayer(id: RiotId, size = 10): Promise<SyncResult> {
  const attributes = { "valorant.region": id.region, "valorant.player": `${id.name}#${id.tag}` };
  return withSpan("sync.player", attributes, async (span) => {
    try {
      const result = await runSync(id, size);
      span.setAttribute("sync.status", result.status);
      if (result.status === "synced") {
        span.setAttribute("sync.matches_upserted", result.matchesUpserted);
      }
      syncRuns.add(1, { status: result.status });
      return result;
    } catch (e) {
      syncRuns.add(1, { status: "error" });
      throw e;
    }
  });
}

async function runSync(id: RiotId, size: number): Promise<SyncResult> {
  const { region, name, tag } = id;

  const existing = await prisma.player.findUnique({
    where: { name_tag: { name, tag } },
    select: { lastSyncedAt: true },
  });
  if (existing?.lastSyncedAt && Date.now() - existing.lastSyncedAt.getTime() < SYNC_COOLDOWN_MS) {
    return { status: "skipped", lastSyncedAt: existing.lastSyncedAt };
  }

  const upstream = await getMatches(region, name, tag, { size, mode: "competitive" });
  if (upstream.status < 200 || upstream.status >= 300) {
    return {
      status: "upstream-error",
      httpStatus: upstream.status,
      contentType: upstream.contentType,
      body: upstream.body,
      ...(upstream.retryAfterSeconds ? { retryAfterSeconds: upstream.retryAfterSeconds } : {}),
    };
  }

  const json = JSON.parse(upstream.body) as { data?: unknown };
  const matches = Array.isArray(json?.data) ? (json.data as HenrikMatch[]) : [];
  if (matches.length === 0) return { status: "no-matches" };

  const puuid = findPlayerByRiotId(matches[0], name, tag)?.puuid;
  if (!puuid) return { status: "player-not-in-matches" };

  const player = await prisma.player.upsert({
    where: { puuid },
    update: { name, tag },
    create: { puuid, name, tag },
  });

  const matchRows: MatchUpsert[] = [];
  const lineRows: PlayerMatchUpsert[] = [];
  for (const m of matches) {
    const matchId = m.metadata?.matchid;
    if (typeof matchId !== "string" || !matchId) continue;
    matchRows.push({ id: matchId, ...toMatchRecord(m, region) });
    const p = m.players?.all_players?.find((x) => x.puuid === puuid);
    if (p) lineRows.push({ matchId, ...toPlayerMatchRecord(p) });
  }

  // Two statements instead of one per row. No transaction around them: each is
  // atomic, matches go first for the foreign key, and the cooldown is only armed
  // below, once stats are rebuilt, so a failure here just means the next view retries.
  const matchesUpserted = await upsertMatches(uniqueByKey(matchRows, (r) => r.id));
  const playerMatchesUpserted = await upsertPlayerMatches(player.id, uniqueByKey(lineRows, (r) => r.matchId));

  // Rebuild the player's stats row and arm the cooldown in one commit. If this
  // throws, the sync fails and the cooldown stays off, so the next view retries.
  await refreshPlayerStats(player.id, { syncedAt: new Date() });

  try {
    await invalidateRecentMatches(name, tag);
  } catch (e) {
    console.warn("[cache] invalidating recent matches failed:", e);
  }

  return { status: "synced", matchesUpserted, playerMatchesUpserted };
}
