import { getAccount, getMmr, getMmrHistory, type CachedUpstreamResponse } from "@/lib/henrik";
import {
  AccountV1,
  MmrHistoryEntryV1,
  MmrV2,
  parseListBody,
  parseObjectBody,
  reportValidation,
  type ParseReport,
} from "@/lib/henrik-schemas";
import { msSince, nowMs } from "@/lib/metrics";
import type { RiotId } from "@/lib/riot-id";
import { profileDuration, withSpan } from "@/lib/telemetry";
import { getRecentMatches, type MatchRow } from "@/services/matches";
import { RECENT_MATCH_WINDOW as MATCH_LIMIT } from "@/services/stats";
import { syncPlayer } from "@/services/sync";

/** Everything the player page shows. */
export type PlayerProfile = {
  cardImage: string | null;
  rank: { current: string | null; icon: string | null; peak: string | null };
  /** Rank icon after each match, keyed by match ID. */
  rankIconByMatch: Map<string, string>;
  matches: MatchRow[];
  /** One message per part that failed. The page still renders everything else. */
  errors: string[];
};


/**
 * Loads a player's profile.
 *
 * The match sync and the three upstream lookups run at the same time, because
 * only the match list depends on the sync. Each part fails on its own, so one
 * outage shows an error message instead of breaking the page.
 */
export function getPlayerProfile(id: RiotId): Promise<PlayerProfile> {
  const attributes = { "valorant.region": id.region, "valorant.player": `${id.name}#${id.tag}` };
  return withSpan("profile.load", attributes, async (span) => {
    const t0 = nowMs();
    const profile = await loadProfile(id);
    span.setAttributes({ "profile.matches": profile.matches.length, "profile.errors": profile.errors.length });
    profileDuration.record(msSince(t0) / 1000, { outcome: profile.errors.length ? "partial" : "complete" });
    return profile;
  });
}

async function loadProfile(id: RiotId): Promise<PlayerProfile> {
  const errors: string[] = [];

  const [sync, account, mmr, history] = await Promise.allSettled([
    syncPlayer(id, MATCH_LIMIT),
    getAccount(id.name, id.tag),
    getMmr(id.region, id.name, id.tag),
    getMmrHistory(id.region, id.name, id.tag),
  ]);

  if (sync.status === "rejected") {
    console.error("[profile] sync failed:", sync.reason);
    errors.push("Couldn't sync recent matches");
  } else if (sync.value.status === "upstream-error") {
    errors.push(`Couldn't sync recent matches (HTTP ${sync.value.httpStatus})`);
  } else if (sync.value.status === "invalid-payload") {
    errors.push("Couldn't read recent matches");
  } else if (sync.value.status === "in-progress") {
    errors.push("Recent matches are still syncing. Refresh in a moment.");
  }

  const card = readData(account, "player card", errors, (body) => {
    const { data, report } = parseObjectBody("account", body, AccountV1);
    return { value: data, report };
  });
  const current = readData(mmr, "current rank", errors, (body) => {
    const { data, report } = parseObjectBody("mmr", body, MmrV2);
    return { value: data, report };
  });
  const rankHistory = readData(history, "rank history", errors, (body) => {
    const { items, report } = parseListBody("mmr-history", body, MmrHistoryEntryV1);
    return { value: items, report };
  });

  const paused = pausedNotice([
    sync.status === "fulfilled" && sync.value.status === "upstream-error"
      ? { status: sync.value.httpStatus, retryAfterSeconds: sync.value.retryAfterSeconds }
      : null,
    ...[account, mmr, history].map((r) => (r.status === "fulfilled" ? r.value : null)),
  ]);
  if (paused) errors.push(paused);

  let matches: MatchRow[] = [];
  try {
    matches = (await getRecentMatches(id.name, id.tag, MATCH_LIMIT)).data;
  } catch (e) {
    console.error("[profile] loading matches failed:", e);
    errors.push("Couldn't load recent matches");
  }

  const rankIconByMatch = new Map<string, string>();
  for (const entry of rankHistory ?? []) {
    if (entry.images?.small) rankIconByMatch.set(entry.match_id, entry.images.small);
  }

  return {
    cardImage: card?.card?.small ?? null,
    rank: {
      current: current?.current_data?.currenttierpatched ?? null,
      icon: current?.current_data?.images?.small ?? null,
      peak: current?.highest_rank?.patched_tier ?? null,
    },
    rankIconByMatch,
    matches,
    errors,
  };
}

/**
 * One line explaining a pause, however many parts were paused: live lookups stop
 * while the rate limit is spent or HenrikDev is down, and the page says for how long.
 */
function pausedNotice(results: ({ status: number; retryAfterSeconds?: number } | null)[]): string | null {
  const paused = results.filter((r): r is { status: number; retryAfterSeconds: number } => !!r?.retryAfterSeconds);
  if (paused.length === 0) return null;
  const seconds = Math.max(...paused.map((r) => r.retryAfterSeconds));
  return paused.some((r) => r.status === 429)
    ? `Live data is paused for about ${seconds}s to stay under the HenrikDev rate limit.`
    : `HenrikDev looks unavailable. Live data will be retried in about ${seconds}s.`;
}

/**
 * Returns the validated `data` from a successful upstream response, or records an
 * error and returns null. Validation is only reported for fresh responses, so the
 * metrics count what HenrikDev sent, not how often a cached copy was viewed.
 */
function readData<T>(
  result: PromiseSettledResult<CachedUpstreamResponse>,
  what: string,
  errors: string[],
  parse: (body: string) => { value: T | null; report: ParseReport },
): T | null {
  if (result.status === "rejected") {
    console.error(`[profile] loading ${what} failed:`, result.reason);
    errors.push(`Couldn't load ${what}`);
    return null;
  }
  if (result.value.status !== 200) {
    errors.push(`Couldn't load ${what} (HTTP ${result.value.status})`);
    return null;
  }
  const { value, report } = parse(result.value.body);
  if (result.value.cache === "MISS") reportValidation(report);
  if (value === null) errors.push(`Couldn't read ${what}`);
  return value;
}
