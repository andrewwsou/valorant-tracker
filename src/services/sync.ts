import { getMatches, type HenrikMatch, type HenrikPlayer } from "@/lib/henrik";
import { prisma } from "@/lib/prisma";
import type { RiotId } from "@/lib/riot-id";
import { syncRuns, withSpan } from "@/lib/telemetry";
import { invalidateRecentMatches } from "@/services/matches";

/** Minimum time between two syncs of the same player, to protect the upstream rate limit. */
export const SYNC_COOLDOWN_MS = 5 * 60_000;

export type SyncResult =
  | { status: "skipped"; lastSyncedAt: Date }
  | { status: "synced"; matchesUpserted: number; playerMatchesUpserted: number }
  | { status: "no-matches" }
  | { status: "player-not-in-matches" }
  | { status: "upstream-error"; httpStatus: number; contentType: string; body: string };

/** Finds a player in a match by Riot ID. Riot IDs ignore case. */
export function findPlayerByRiotId(match: HenrikMatch, name: string, tag: string): HenrikPlayer | undefined {
  return match.players?.all_players?.find(
    (p) =>
      (p.name ?? "").toLowerCase() === name.toLowerCase() &&
      (p.tag ?? "").toLowerCase() === tag.toLowerCase(),
  );
}

/** The `Match` columns stored for one upstream match. */
export function toMatchRecord(match: HenrikMatch, region: string) {
  return {
    map: match.metadata?.map ?? null,
    mode: match.metadata?.mode ?? null,
    region,
    startedAt: match.metadata?.game_start ? new Date(match.metadata.game_start * 1000) : null,
    roundsRed: match.teams?.red?.rounds_won ?? null,
    roundsBlue: match.teams?.blue?.rounds_won ?? null,
  };
}

/** The `PlayerMatch` columns stored for one player in one match. */
export function toPlayerMatchRecord(player: HenrikPlayer) {
  return {
    // Optional call kept on purpose: upstream data is untrusted and may not be a string.
    team: player.team?.toLowerCase?.() ?? null,
    kills: player.stats?.kills ?? null,
    deaths: player.stats?.deaths ?? null,
    assists: player.stats?.assists ?? null,
    score: player.stats?.score ?? null,
    damage: player.damage_made ?? null,
    headshots: player.stats?.headshots ?? null,
    bodyshots: player.stats?.bodyshots ?? null,
    legshots: player.stats?.legshots ?? null,
    agentIcon: player.assets?.agent?.small ?? null,
  };
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

  let matchesUpserted = 0;
  let playerMatchesUpserted = 0;

  for (const m of matches) {
    const matchId = m.metadata?.matchid;
    if (!matchId) continue;

    const match = toMatchRecord(m, region);
    await prisma.match.upsert({
      where: { id: matchId },
      update: match,
      create: { id: matchId, ...match },
    });
    matchesUpserted++;

    const p = m.players?.all_players?.find((x) => x.puuid === puuid);
    if (!p) continue;

    const line = toPlayerMatchRecord(p);
    await prisma.playerMatch.upsert({
      where: { matchId_playerId: { matchId, playerId: player.id } },
      update: line,
      create: { matchId, playerId: player.id, ...line },
    });
    playerMatchesUpserted++;
  }

  await prisma.player.update({
    where: { id: player.id },
    data: { lastSyncedAt: new Date() },
  });

  try {
    await invalidateRecentMatches(name, tag);
  } catch (e) {
    console.warn("[cache] invalidating recent matches failed:", e);
  }

  return { status: "synced", matchesUpserted, playerMatchesUpserted };
}
