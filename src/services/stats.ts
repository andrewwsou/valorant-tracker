/**
 * Pure stat calculations over stored match rows. No I/O, so every function
 * here is covered by fast unit tests in stats.test.ts.
 */
import type { MatchRow } from "@/services/matches";

export type MatchResult = "W" | "L" | "D" | "-";

/** How many recent matches the profile and the stored player stats are computed over. */
export const RECENT_MATCH_WINDOW = 10;

/** Raw sums over rows. Every ratio below is built from these, so the formulas live in one place. */
export function sumMatchRows(rows: MatchRow[]) {
  const totals = { kills: 0, deaths: 0, score: 0, damage: 0, rounds: 0, headshots: 0, shots: 0 };
  for (const r of rows) {
    totals.kills += r.kills ?? 0;
    totals.deaths += r.deaths ?? 0;
    totals.score += r.score ?? 0;
    totals.damage += r.damage ?? 0;
    totals.rounds += (r.roundsRed ?? 0) + (r.roundsBlue ?? 0);
    totals.headshots += r.headshots ?? 0;
    totals.shots += (r.headshots ?? 0) + (r.bodyshots ?? 0) + (r.legshots ?? 0);
  }
  return totals;
}

/** Win, loss, or draw from the player's side, or "-" when the score or team is missing. */
export function matchResult(row: MatchRow): MatchResult {
  const team = row.team?.toLowerCase();
  if (row.roundsRed == null || row.roundsBlue == null) return "-";
  if (team !== "red" && team !== "blue") return "-";
  if (row.roundsRed === row.roundsBlue) return "D";
  const redWon = row.roundsRed > row.roundsBlue;
  return (team === "red") === redWon ? "W" : "L";
}

/** Per-match numbers for one row of the match table. */
export function matchStats(row: MatchRow) {
  const red = row.roundsRed ?? 0;
  const blue = row.roundsBlue ?? 0;
  const rounds = red + blue;

  const shots = (row.headshots ?? 0) + (row.bodyshots ?? 0) + (row.legshots ?? 0);
  const onBlue = row.team?.toLowerCase() === "blue";

  return {
    /** Average combat score per round. */
    acs: rounds > 0 && row.score != null ? Math.round(row.score / rounds) : 0,
    /** Average damage per round. */
    adr: rounds > 0 && row.damage != null ? Math.round(row.damage / rounds) : 0,
    headshotPct: shots > 0 ? Math.round(((row.headshots ?? 0) / shots) * 100) : 0,
    /** Rounds won by the player's team first, for example "13–7". */
    score: onBlue ? `${blue}–${red}` : `${red}–${blue}`,
    result: matchResult(row),
  };
}

/** Kills divided by deaths over all rows. Zero deaths counts as one, like most trackers. */
export function kdRatio(rows: MatchRow[]): string {
  const { kills, deaths } = sumMatchRows(rows);
  return (kills / Math.max(1, deaths)).toFixed(2);
}

/** Combat score and damage per round, averaged over every round played. */
export function averageCombatStats(rows: MatchRow[]): { acs: number; adr: number } {
  const { score, damage, rounds } = sumMatchRows(rows);
  return {
    acs: rounds ? Math.round(score / rounds) : 0,
    adr: rounds ? Math.round(damage / rounds) : 0,
  };
}

/** Headshots as a percent of all shots, summed across matches (not an average of per-match percents). */
export function headshotPercent(rows: MatchRow[]): number {
  const { headshots, shots } = sumMatchRows(rows);
  return shots ? Math.round((headshots / shots) * 100) : 0;
}

/** Wins, losses, and draws. Draws are left out of the win rate. */
export function winLossRecord(rows: MatchRow[]) {
  let wins = 0;
  let losses = 0;
  let draws = 0;
  for (const r of rows) {
    const result = matchResult(r);
    if (result === "W") wins++;
    else if (result === "L") losses++;
    else if (result === "D") draws++;
  }
  const decided = wins + losses;
  return { wins, losses, draws, winrate: decided ? Math.round((wins / decided) * 100) : 0 };
}

/**
 * A 0 to 100 score over the most recent `n` matches. Each match counts 60% for
 * winning and 40% for performance, where performance blends K/D (70%) and ACS
 * (30%), each squashed into 0 to 1. Performance in a loss is discounted by 15%.
 */
export function trackerScore(rows: MatchRow[], n = 10): number {
  const slice = rows.slice(0, n);
  if (slice.length === 0) return 0;

  let sum = 0;

  for (const r of slice) {
    const rr = r.roundsRed ?? 0;
    const rb = r.roundsBlue ?? 0;

    const team = (r.team ?? "").toLowerCase();
    const teamIsRed = team === "red";
    const teamIsBlue = team === "blue";

    let win = 0;
    if (rr !== rb && (teamIsRed || teamIsBlue)) {
      const redWon = rr > rb;
      const weWon = teamIsRed ? redWon : !redWon;
      win = weWon ? 1 : 0;
    }

    const kills = r.kills ?? 0;
    const deaths = r.deaths ?? 0;

    const kd = kills / Math.max(1, deaths);
    const kdNorm = kd / (kd + 1);

    const rounds = rr + rb;
    const acs = rounds > 0 && r.score != null ? r.score / rounds : 0;
    const acsNorm = acs / (acs + 200);

    const perf = 0.7 * kdNorm + 0.3 * acsNorm;
    const perfAdj = perf * (win ? 1.0 : 0.85);

    const impact = 0.6 * win + 0.4 * perfAdj;
    sum += impact;
  }

  const avg = sum / slice.length;
  return Math.max(0, Math.min(100, Math.round(avg * 100)));
}

/**
 * Everything stored in a PlayerStats row, computed from a player's newest rows.
 *
 * Ratios stay unrounded so the leaderboard sorts exactly. Rounding them the way
 * the profile does (Math.round, or toFixed(2) for K/D) gives the profile's numbers;
 * stats.test.ts checks that parity.
 */
export function computePlayerStats(newestFirst: MatchRow[]) {
  const rows = newestFirst.slice(0, RECENT_MATCH_WINDOW);
  const t = sumMatchRows(rows);
  const { wins, losses, draws } = winLossRecord(rows);
  const decided = wins + losses;

  return {
    matches: rows.length,
    wins,
    losses,
    draws,
    kd: t.kills / Math.max(1, t.deaths),
    acs: t.rounds ? t.score / t.rounds : 0,
    adr: t.rounds ? t.damage / t.rounds : 0,
    winRate: decided ? (wins / decided) * 100 : 0,
    headshotPct: t.shots ? (t.headshots / t.shots) * 100 : 0,
    trackerScore: trackerScore(rows, RECENT_MATCH_WINDOW),
  };
}
