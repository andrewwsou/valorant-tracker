// Deterministic fake data for the mock HenrikDev API, in the shapes the app reads.
//
// Four known players, all tagged E2E. Each player's matches repeat one stat line,
// and every match has 20 rounds, so the expected stats are round numbers:
//   Tester  10 matches, 6 wins: K/D 1.25, ACS 250, ADR 160 (the profile tests use this one)
//   Ace     10 matches, 8 wins: K/D 1.10, ACS 150
//   Rookie  10 matches, 7 wins: K/D 0.40, ACS 200
//   Newbie   3 matches, 3 wins: best at everything, but too few matches for the default leaderboard
// Among the three with 10 matches, every sort gives a different order, so the
// leaderboard tests prove each sort really applies:
//   tracker score  Ace, Tester, Rookie
//   ACS            Tester, Rookie, Ace
//   K/D            Tester, Ace, Rookie
//   win rate       Ace, Rookie, Tester

const RIVAL = { name: "Rival", tag: "OPP", puuid: "e2e-puuid-rival" };
const MAPS = ["Ascent", "Bind", "Haven", "Lotus", "Sunset"];
/** Start of each player's newest match, in seconds, like the real API. */
const NEWEST_GAME_START = Date.UTC(2026, 8, 20, 18, 0, 0) / 1000;

/**
 * Matches newest first, shaped like HenrikDev's v4 match list: the first `wins`
 * are wins, the rest are losses. Agents carry no id, so no agent icon URL is
 * built and the tests never load images from the internet.
 */
export function buildMatches({ player, idPrefix, count, wins, line }) {
  return Array.from({ length: count }, (_, i) => {
    const won = i < wins;
    const team = i % 2 === 0 ? "Red" : "Blue";
    const ours = won ? 13 : 7;
    const theirs = won ? 7 : 13;
    const [red, blue] = team === "Red" ? [ours, theirs] : [theirs, ours];
    const stats = (s, damage) => ({ ...s, damage: { dealt: damage, received: 0 } });

    return {
      metadata: {
        match_id: `${idPrefix}-${String(i + 1).padStart(2, "0")}`,
        map: { id: "e2e-map", name: MAPS[i % MAPS.length] },
        started_at: new Date((NEWEST_GAME_START - i * 3600) * 1000).toISOString(),
        queue: { id: "competitive", name: "Competitive", mode_type: "Standard" },
        is_completed: true,
        platform: "pc",
      },
      players: [
        {
          puuid: player.puuid,
          name: player.name,
          tag: player.tag,
          team_id: team,
          agent: { name: "Jett" },
          stats: stats(
            {
              kills: line.kills,
              deaths: line.deaths,
              assists: line.assists,
              score: line.score,
              headshots: line.headshots,
              bodyshots: line.bodyshots,
              legshots: line.legshots,
            },
            line.damage,
          ),
        },
        {
          ...RIVAL,
          team_id: team === "Red" ? "Blue" : "Red",
          agent: { name: "Sova" },
          stats: stats({ kills: 16, deaths: 20, assists: 3, score: 4000, headshots: 5, bodyshots: 30, legshots: 5 }, 2500),
        },
      ],
      teams: [
        { team_id: "Red", rounds: { won: red, lost: blue }, won: red > blue },
        { team_id: "Blue", rounds: { won: blue, lost: red }, won: blue > red },
      ],
    };
  });
}

function definePlayer({ name, puuid, rank, peak, idPrefix, count, wins, line }) {
  const player = { name, tag: "E2E", puuid };
  const matches = buildMatches({ player, idPrefix, count, wins, line });
  return {
    ...player,
    matches,
    account: { ...player, account_level: 120, card: {} },
    mmr: { current_data: { currenttierpatched: rank, images: {} }, highest_rank: { patched_tier: peak, season: "e9a3" } },
    mmrHistory: matches.map((m) => ({
      match_id: m.metadata.match_id,
      currenttierpatched: rank,
      images: {},
      mmr_change_to_last_game: 18,
    })),
  };
}

export const PLAYERS = [
  definePlayer({
    name: "Tester", puuid: "e2e-puuid-tester", rank: "Diamond 2", peak: "Ascendant 1",
    idPrefix: "e2e-match", count: 10, wins: 6,
    line: { kills: 20, deaths: 16, assists: 5, score: 5000, damage: 3200, headshots: 10, bodyshots: 25, legshots: 5 },
  }),
  definePlayer({
    name: "Ace", puuid: "e2e-puuid-ace", rank: "Immortal 1", peak: "Immortal 2",
    idPrefix: "e2e-ace-match", count: 10, wins: 8,
    line: { kills: 22, deaths: 20, assists: 4, score: 3000, damage: 3000, headshots: 12, bodyshots: 24, legshots: 4 },
  }),
  definePlayer({
    name: "Rookie", puuid: "e2e-puuid-rookie", rank: "Gold 1", peak: "Platinum 1",
    idPrefix: "e2e-rookie-match", count: 10, wins: 7,
    line: { kills: 8, deaths: 20, assists: 9, score: 4000, damage: 3600, headshots: 6, bodyshots: 30, legshots: 4 },
  }),
  definePlayer({
    name: "Newbie", puuid: "e2e-puuid-newbie", rank: "Silver 3", peak: "Silver 3",
    idPrefix: "e2e-newbie-match", count: 3, wins: 3,
    line: { kills: 30, deaths: 10, assists: 2, score: 8000, damage: 4000, headshots: 15, bodyshots: 20, legshots: 5 },
  }),
];

/** Finds a known player by PUUID. */
export function findPlayerByPuuid(puuid) {
  return PLAYERS.find((p) => p.puuid === puuid);
}

/** Finds a known player by Riot ID, ignoring case like the real API. */
export function findPlayer(name, tag) {
  return PLAYERS.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.tag.toLowerCase() === tag.toLowerCase());
}

/** The player the profile tests use. */
export const PLAYER = { name: "Tester", tag: "E2E", puuid: "e2e-puuid-tester" };
