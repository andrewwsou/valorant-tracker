import {
  getAccount,
  getMmr,
  getMmrHistory,
  type CachedUpstreamResponse,
  type HenrikAccount,
  type HenrikMmr,
  type HenrikMmrHistoryEntry,
} from "@/lib/henrik";
import type { RiotId } from "@/lib/riot-id";
import { getRecentMatches, type MatchRow } from "@/services/matches";
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

const MATCH_LIMIT = 10;

/**
 * Loads a player's profile.
 *
 * The match sync and the three upstream lookups run at the same time, because
 * only the match list depends on the sync. Each part fails on its own, so one
 * outage shows an error message instead of breaking the page.
 */
export async function getPlayerProfile(id: RiotId): Promise<PlayerProfile> {
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
  }

  const card = readData<HenrikAccount>(account, "player card", errors);
  const current = readData<HenrikMmr>(mmr, "current rank", errors);
  const rankHistory = readData<HenrikMmrHistoryEntry[]>(history, "rank history", errors);

  let matches: MatchRow[] = [];
  try {
    matches = (await getRecentMatches(id.name, id.tag, MATCH_LIMIT)).data;
  } catch (e) {
    console.error("[profile] loading matches failed:", e);
    errors.push("Couldn't load recent matches");
  }

  const rankIconByMatch = new Map<string, string>();
  for (const entry of Array.isArray(rankHistory) ? rankHistory : []) {
    if (entry.match_id && entry.images?.small) rankIconByMatch.set(entry.match_id, entry.images.small);
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

/** Returns `data` from a successful upstream response, or records an error and returns null. */
function readData<T>(
  result: PromiseSettledResult<CachedUpstreamResponse>,
  what: string,
  errors: string[],
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
  try {
    return (JSON.parse(result.value.body) as { data?: T }).data ?? null;
  } catch {
    errors.push(`Couldn't read ${what}`);
    return null;
  }
}
