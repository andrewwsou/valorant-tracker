/**
 * Types for the parts of the HenrikDev VALORANT API that this app reads.
 *
 * Every field is optional on purpose. The upstream API is third-party and
 * unofficial, so the code must handle missing fields instead of trusting them.
 */

export type HenrikPlayer = {
  puuid?: string;
  name?: string;
  tag?: string;
  team?: string;
  damage_made?: number;
  stats?: {
    kills?: number;
    deaths?: number;
    assists?: number;
    score?: number;
    headshots?: number;
    bodyshots?: number;
    legshots?: number;
  };
  assets?: { agent?: { small?: string } };
};

export type HenrikMatch = {
  metadata?: {
    matchid?: string;
    map?: string;
    mode?: string;
    /** Unix timestamp in seconds. */
    game_start?: number;
  };
  players?: { all_players?: HenrikPlayer[] };
  teams?: {
    red?: { rounds_won?: number };
    blue?: { rounds_won?: number };
  };
};
