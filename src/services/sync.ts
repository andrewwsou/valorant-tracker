import { Prisma } from "@/generated/prisma";
import { getMatches, rememberUnreadableMatches } from "@/lib/henrik";
import { MatchV4, parseListBody, reportValidation, type HenrikMatch, type HenrikPlayer } from "@/lib/henrik-schemas";
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
  /** HenrikDev answered, but no match in the answer could be read. Nothing was written. */
  | { status: "invalid-payload" }
  | { status: "upstream-error"; httpStatus: number; contentType: string; body: string; retryAfterSeconds?: number };

/** Finds a player in a match by Riot ID. Riot IDs ignore case. */
export function findPlayerByRiotId(match: HenrikMatch, name: string, tag: string): HenrikPlayer | undefined {
  return match.players.find(
    (p) => (p.name ?? "").toLowerCase() === name.toLowerCase() && (p.tag ?? "").toLowerCase() === tag.toLowerCase(),
  );
}

/**
 * An agent's icon, built from its ID. v4 sends only the ID; v3 sent this exact
 * URL (checked against real responses), so stored rows don't change.
 */
export function agentIconUrl(agentId: string | null): string | null {
  return agentId ? `https://media.valorant-api.com/agents/${agentId}/displayicon.png` : null;
}

/** Rounds a side won. Teams are matched by name, ignoring case. */
function roundsWon(match: HenrikMatch, side: "red" | "blue"): number | null {
  return match.teams.find((t) => t.team_id.toLowerCase() === side)?.rounds?.won ?? null;
}

/**
 * The `Match` columns stored for one validated match. Values were already
 * checked by the schema: anything of the wrong type is null by now.
 */
export function toMatchRecord(match: HenrikMatch, region: string) {
  const { map, queue, started_at } = match.metadata;
  return {
    map: map?.name ?? null,
    // The spec lets queue.name be null; the queue id still says what it was.
    mode: queue?.name ?? (queue?.id === "competitive" ? "Competitive" : null),
    region,
    // Whole seconds, like v3's game_start, so re-synced rows don't change.
    startedAt: started_at === null ? null : new Date(Math.floor(started_at / 1000) * 1000),
    roundsRed: roundsWon(match, "red"),
    roundsBlue: roundsWon(match, "blue"),
  };
}

/** The `PlayerMatch` columns stored for one player in one match. */
export function toPlayerMatchRecord(player: HenrikPlayer) {
  const stats = player.stats;
  return {
    team: player.team_id?.toLowerCase() ?? null,
    kills: stats?.kills ?? null,
    deaths: stats?.deaths ?? null,
    assists: stats?.assists ?? null,
    score: stats?.score ?? null,
    damage: stats?.damage?.dealt ?? null,
    headshots: stats?.headshots ?? null,
    bodyshots: stats?.bodyshots ?? null,
    legshots: stats?.legshots ?? null,
    agentIcon: agentIconUrl(player.agent?.id ?? null),
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

  const mode = "competitive";
  const upstream = await getMatches(region, name, tag, { size, mode });
  if (upstream.status < 200 || upstream.status >= 300) {
    return {
      status: "upstream-error",
      httpStatus: upstream.status,
      contentType: upstream.contentType,
      body: upstream.body,
      ...(upstream.retryAfterSeconds ? { retryAfterSeconds: upstream.retryAfterSeconds } : {}),
    };
  }

  // Each match is checked on its own: a bad one is skipped and counted, the rest are kept.
  const { items: matches, report } = parseListBody("matches", upstream.body, MatchV4);
  // Only fresh answers count in the metrics, not every view of a cached one.
  if (upstream.cache === "MISS") reportValidation(report);
  if (matches === null || (matches.length === 0 && report.rejected > 0)) {
    // Nothing usable: don't download the same megabytes again on the next view.
    if (upstream.cache === "MISS") await rememberUnreadableMatches(region, name, tag, mode);
    return { status: "invalid-payload" };
  }
  if (matches.length === 0) return { status: "no-matches" };

  // From the first match that has the player, in case an earlier one lost its player list.
  const puuid = matches.map((m) => findPlayerByRiotId(m, name, tag)).find(Boolean)?.puuid;
  if (!puuid) return { status: "player-not-in-matches" };

  const player = await prisma.player.upsert({
    where: { puuid },
    update: { name, tag },
    create: { puuid, name, tag },
  });

  const matchRows: MatchUpsert[] = [];
  const lineRows: PlayerMatchUpsert[] = [];
  for (const m of matches) {
    const matchId = m.metadata.match_id;
    matchRows.push({ id: matchId, ...toMatchRecord(m, region) });
    const p = m.players.find((x) => x.puuid === puuid);
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
