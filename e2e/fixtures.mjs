// Deterministic fake data for the mock HenrikDev API.
// One known player, Tester#E2E, with 10 competitive matches: the 6 newest are wins, the 4 oldest are losses.
// Every match has 20 rounds and the same stat line, so the expected totals are round numbers.

export const PLAYER = { name: "Tester", tag: "E2E", puuid: "e2e-puuid-tester" };
const RIVAL = { name: "Rival", tag: "OPP", puuid: "e2e-puuid-rival" };
const MAPS = ["Ascent", "Bind", "Haven", "Lotus", "Sunset"];
/** Start of the newest match, in seconds, like the real API. */
const NEWEST_GAME_START = Date.UTC(2026, 8, 20, 18, 0, 0) / 1000;

export const matches = Array.from({ length: 10 }, (_, i) => {
  const won = i < 6;
  const team = i % 2 === 0 ? "Red" : "Blue";
  const ours = won ? 13 : 7;
  const theirs = won ? 7 : 13;
  const [red, blue] = team === "Red" ? [ours, theirs] : [theirs, ours];

  return {
    metadata: {
      matchid: `e2e-match-${String(i + 1).padStart(2, "0")}`,
      map: MAPS[i % MAPS.length],
      mode: "Competitive",
      game_start: NEWEST_GAME_START - i * 3600,
    },
    players: {
      all_players: [
        {
          ...PLAYER,
          team,
          damage_made: 3200,
          stats: { kills: 20, deaths: 16, assists: 5, score: 5000, headshots: 10, bodyshots: 25, legshots: 5 },
          assets: { agent: {} },
        },
        {
          ...RIVAL,
          team: team === "Red" ? "Blue" : "Red",
          damage_made: 2500,
          stats: { kills: 16, deaths: 20, assists: 3, score: 4000, headshots: 5, bodyshots: 30, legshots: 5 },
          assets: { agent: {} },
        },
      ],
    },
    teams: { red: { rounds_won: red }, blue: { rounds_won: blue } },
  };
});

export const account = { puuid: PLAYER.puuid, name: PLAYER.name, tag: PLAYER.tag, account_level: 120, card: {} };

export const mmr = {
  current_data: { currenttierpatched: "Diamond 2", images: {} },
  highest_rank: { patched_tier: "Ascendant 1", season: "e9a3" },
};

export const mmrHistory = matches.map((m) => ({
  match_id: m.metadata.matchid,
  currenttier_patched: "Diamond 2",
  images: {},
  mmr_change_to_last_game: 18,
}));
