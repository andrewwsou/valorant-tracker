import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma";
import { getAccount, getMatches, rememberUnreadableMatches, type MatchesTarget } from "@/lib/henrik";
import {
  AccountV1,
  MatchV4,
  parseListBody,
  parseObjectBody,
  reportValidation,
  type HenrikMatch,
  type HenrikPlayer,
} from "@/lib/henrik-schemas";
import { prisma } from "@/lib/prisma";
import { claimLock, lockHeld, releaseLock } from "@/lib/redis";
import { riotIdKey, type PuuidTarget, type RiotId } from "@/lib/riot-id";
import { syncRuns, withSpan } from "@/lib/telemetry";
import { invalidateRecentMatches } from "@/services/matches";
import { refreshPlayerStats } from "@/services/player-stats";

/** Minimum time between two syncs of the same player, to protect the upstream rate limit. */
export const SYNC_COOLDOWN_MS = 5 * 60_000;
/** How long one sync may hold a player's lock: longer than the slowest upstream calls plus the writes. */
export const SYNC_CLAIM_TTL_MS = 30_000;
/** How long a caller waits for someone else's sync of the same player before giving up. */
export const SYNC_WAIT_MS = 15_000;
const POLL_MS = 250;

/** Who to sync: a Riot ID (from a profile view) or a PUUID (the nightly job; survives renames). */
export type SyncTarget = RiotId | PuuidTarget;

export type SyncResult =
  | { status: "skipped"; lastSyncedAt: Date; player: string }
  | { status: "synced"; player: string; matchesUpserted: number; playerMatchesUpserted: number }
  /** Another caller is syncing this player and didn't finish in time. Nothing was called. */
  | { status: "in-progress" }
  /** A PUUID this app has never stored. Only players already tracked are synced by PUUID. */
  | { status: "not-tracked" }
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

const TRACKED = { id: true, puuid: true, name: true, tag: true, riotIdKey: true, lastSyncedAt: true } as const;
type Tracked = { id: string; puuid: string | null; name: string; tag: string; riotIdKey: string | null; lastSyncedAt: Date | null };

const byPuuid = (target: SyncTarget): target is PuuidTarget => "puuid" in target;
const label = (p: { name: string; tag: string }) => `${p.name}#${p.tag}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The stored player a target means: by PUUID, or by Riot ID in any capitalization. */
function findTracked(target: SyncTarget): Promise<Tracked | null> {
  return prisma.player.findUnique({
    where: byPuuid(target) ? { puuid: target.puuid } : { riotIdKey: riotIdKey(target.name, target.tag) },
    select: TRACKED,
  });
}

const fresh = (p: Tracked | null): p is Tracked & { lastSyncedAt: Date } =>
  p?.lastSyncedAt != null && Date.now() - p.lastSyncedAt.getTime() < SYNC_COOLDOWN_MS;

const skipped = (p: Tracked & { lastSyncedAt: Date }): SyncResult => ({
  status: "skipped",
  lastSyncedAt: p.lastSyncedAt,
  player: label(p),
});

/**
 * Pulls a player's recent competitive matches and upserts them into Postgres.
 *
 * Idempotent: matches are keyed by match ID and stat lines by (match, player),
 * so running it twice never creates duplicates. Skipped inside the cooldown, and
 * only one caller syncs a player at a time (see runSync).
 */
export function syncPlayer(target: SyncTarget, size = 10): Promise<SyncResult> {
  const who = byPuuid(target) ? `puuid:${target.puuid}` : `${target.name}#${target.tag}`;
  return withSpan("sync.player", { "valorant.region": target.region, "valorant.player": who }, async (span) => {
    try {
      const result = await runSync(target, size);
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

/**
 * Checks the cooldown, then claims the player so simultaneous views (or a view
 * and the nightly job) make one upstream call between them, not one each. The
 * claim is a Redis lock shared by every instance; if Redis is down, the sync runs
 * without it, as before.
 */
async function runSync(target: SyncTarget, size: number): Promise<SyncResult> {
  const existing = await findTracked(target);
  if (byPuuid(target) && !existing) return { status: "not-tracked" };
  if (fresh(existing)) return skipped(existing);

  // Locked by the Riot ID being synced, which doesn't change during the sync (a PUUID
  // only appears once the first sync of a new player writes it). A sync by PUUID uses
  // the row's current Riot ID, so it shares the lock with views of that profile.
  const key = byPuuid(target) ? existing!.riotIdKey : riotIdKey(target.name, target.tag);
  const lock = key ? `sync:v1:claim:riot:${key}` : `sync:v1:claim:puuid:${existing!.puuid}`;
  const token = randomUUID();
  const waitUntil = Date.now() + SYNC_WAIT_MS;

  // At most two rounds: if the sync we waited for ended without fresh data (it failed),
  // try once ourselves. A failure is usually cached by then, so that costs no budget.
  for (let round = 0; round < 2; round++) {
    const claim = await tryClaim(lock, token);
    if (claim !== "lost") return await syncClaimed(target, size, lock, token, claim, round === 0 ? existing : null);

    const waited = await waitForOtherSync(lock, target, waitUntil);
    if (waited.status !== "released") return waited.result;
  }
  return { status: "in-progress" };
}

/** Runs a sync under a claim, re-checking the cooldown first, and always releases the lock. */
async function syncClaimed(
  target: SyncTarget,
  size: number,
  lock: string,
  token: string,
  claim: "won" | "unavailable",
  known: Tracked | null,
): Promise<SyncResult> {
  try {
    // A sync that finished just before this claim has already done the work.
    const current = claim === "won" || !known ? await findTracked(target) : known;
    if (fresh(current)) return skipped(current);
    return await syncNow(target, current, size);
  } finally {
    // Also after a claim that errored: a SET can land even when its reply is lost.
    // Releasing compares the token, so it's harmless if this caller never held the lock.
    await releaseLock(lock, token).catch((e) => console.warn(`[sync] releasing ${lock} failed:`, e instanceof Error ? e.name : e));
  }
}

async function tryClaim(lock: string, token: string): Promise<"won" | "lost" | "unavailable"> {
  try {
    return (await claimLock(lock, token, SYNC_CLAIM_TTL_MS)) ? "won" : "lost";
  } catch (e) {
    console.warn(`[sync] couldn't claim ${lock}, syncing without the lock:`, e instanceof Error ? e.name : e);
    return "unavailable";
  }
}

type Waited = { status: "released" } | { status: "done"; result: SyncResult };

/**
 * Waits for another caller's sync of this player, never calling upstream itself.
 * Ends as soon as the player is fresh (even if the lock is left behind), when the
 * lock is released without fresh data (the other sync failed), or at the deadline.
 */
async function waitForOtherSync(lock: string, target: SyncTarget, until: number): Promise<Waited> {
  try {
    for (let polls = 1; Date.now() < until; polls++) {
      if (!(await lockHeld(lock))) break;
      // Every second, also look at the row itself: an orphaned lock can't hold a page.
      if (polls % 4 === 0) {
        const current = await findTracked(target);
        if (fresh(current)) return { status: "done", result: skipped(current) };
      }
      await sleep(POLL_MS);
    }
  } catch {
    // Redis went away mid-wait: stop waiting and report what's stored.
  }
  const current = await findTracked(target);
  if (fresh(current)) return { status: "done", result: skipped(current) };
  return Date.now() < until ? { status: "released" } : { status: "done", result: { status: "in-progress" } };
}

type Identity = { puuid: string; name: string; tag: string; key: string };

/**
 * Who a Riot ID belongs to, from HenrikDev's own data. HenrikDev resolves the Riot ID
 * to its current owner before listing matches, so the owner is in every match. Not
 * simply the first player with that name: an older match can include whoever had the
 * name before. Anyone within one match of the most appearances is a candidate (one
 * of the owner's entries may have been unreadable). When there are several, such as a
 * duo that always queues together, the account endpoint says which one owns the Riot
 * ID, then the name does.
 * Name and tag keep HenrikDev's capitalization, not whatever was typed in the URL.
 */
async function identifyByRiotId(matches: HenrikMatch[], target: RiotId): Promise<Identity | null> {
  const key = riotIdKey(target.name, target.tag);
  const appearances = new Map<string, number>();
  for (const m of matches) {
    for (const puuid of new Set(m.players.map((p) => p.puuid))) appearances.set(puuid, (appearances.get(puuid) ?? 0) + 1);
  }
  const most = Math.max(0, ...appearances.values());
  const owners = matches
    .flatMap((m) => m.players)
    .filter((p, i, all) => (appearances.get(p.puuid) ?? 0) >= Math.max(1, most - 1) && all.findIndex((x) => x.puuid === p.puuid) === i);

  let owner: HenrikPlayer | undefined;
  let account: { puuid: string; name: string | null; tag: string | null } | null = null;
  if (owners.length === 1) {
    owner = owners[0];
  } else if (owners.length > 1) {
    account = await accountIdentity(target);
    owner = owners.find((p) => p.puuid === account?.puuid) ?? owners.find((p) => p.name && p.tag && riotIdKey(p.name, p.tag) === key);
  }
  if (!owner) return null;

  // The newest entry has the newest name. It may still be an old one if the owner
  // renamed since; then the account answer, or the Riot ID asked for, names them.
  const latest = matches.flatMap((m) => m.players).find((p) => p.puuid === owner.puuid) ?? owner;
  for (const named of [latest, account?.puuid === owner.puuid ? account : null]) {
    if (named?.name && named.tag && riotIdKey(named.name, named.tag) === key) {
      return { puuid: owner.puuid, name: named.name, tag: named.tag, key };
    }
  }
  return { puuid: owner.puuid, name: target.name, tag: target.tag, key };
}

async function accountIdentity(target: RiotId) {
  try {
    const res = await getAccount(target.name, target.tag);
    if (res.status !== 200) return null;
    const account = parseObjectBody("account", res.body, AccountV1).data;
    return account?.puuid ? { puuid: account.puuid, name: account.name, tag: account.tag } : null;
  } catch {
    return null;
  }
}

/**
 * Gives this PUUID's row the Riot ID, taking it from any other row that still has
 * it (a player who renamed away keeps their data and last name, with no key). One
 * transaction, so the unique key never collides.
 */
async function claimRiotId(identity: Identity): Promise<Tracked> {
  const write = () =>
    prisma.$transaction(async (tx) => {
      // Lock every row involved in one fixed order, so two players swapping names at
      // the same moment queue up instead of deadlocking.
      await tx.$queryRaw`SELECT id FROM "Player" WHERE "riotIdKey" = ${identity.key} OR puuid = ${identity.puuid} ORDER BY id FOR UPDATE`;
      await tx.player.updateMany({
        // Prisma's `not` leaves out NULLs, so rows without a PUUID are listed explicitly.
        where: { riotIdKey: identity.key, OR: [{ puuid: null }, { puuid: { not: identity.puuid } }] },
        data: { riotIdKey: null },
      });
      return tx.player.upsert({
        where: { puuid: identity.puuid },
        update: { name: identity.name, tag: identity.tag, riotIdKey: identity.key },
        create: { puuid: identity.puuid, name: identity.name, tag: identity.tag, riotIdKey: identity.key },
        select: TRACKED,
      });
    });
  try {
    return await write();
  } catch (e) {
    // Two players claiming one Riot ID at the same moment (P2002), or a write conflict
    // or deadlock (P2034): on a retry, this transaction sees the other one's result.
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2002" || e.code === "P2034")) return write();
    throw e;
  }
}

async function syncNow(target: SyncTarget, current: Tracked | null, size: number): Promise<SyncResult> {
  if (byPuuid(target) && !current) return { status: "not-tracked" };
  const mode = "competitive";
  const source: MatchesTarget = byPuuid(target)
    ? { region: target.region, puuid: target.puuid }
    : { region: target.region, name: target.name, tag: target.tag };

  const upstream = await getMatches(source, { size, mode });
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
    if (upstream.cache === "MISS") await rememberUnreadableMatches(source, mode);
    return { status: "invalid-payload" };
  }
  if (matches.length === 0) return { status: "no-matches" };

  let player: Tracked;
  if (byPuuid(target)) {
    // Syncing by PUUID never changes who a row is: only its matches.
    if (!matches.some((m) => m.players.some((p) => p.puuid === target.puuid))) return { status: "player-not-in-matches" };
    player = current!;
  } else {
    const identity = await identifyByRiotId(matches, target);
    if (!identity) return { status: "player-not-in-matches" };
    player = await claimRiotId(identity);
  }
  const puuid = player.puuid!;

  const matchRows: MatchUpsert[] = [];
  const lineRows: PlayerMatchUpsert[] = [];
  for (const m of matches) {
    const matchId = m.metadata.match_id;
    matchRows.push({ id: matchId, ...toMatchRecord(m, target.region) });
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

  if (player.riotIdKey) {
    try {
      await invalidateRecentMatches(player.riotIdKey);
    } catch (e) {
      console.warn("[cache] invalidating recent matches failed:", e);
    }
  }

  return { status: "synced", player: label(player), matchesUpserted, playerMatchesUpserted };
}
