import { describe, expect, it } from "vitest";
import type { MatchRow } from "@/services/matches";
import {
  averageCombatStats,
  kdRatio,
  matchResult,
  matchStats,
  trackerScore,
  winLossRecord,
} from "@/services/stats";

/** A finished 13-7 win on red: 20/10/5, 5000 combat score, 3000 damage. Override per test. */
function row(overrides: Partial<MatchRow> = {}): MatchRow {
  return {
    matchId: "m1",
    map: "Ascent",
    mode: "Competitive",
    region: "na",
    startedAt: "2026-10-01T00:00:00.000Z",
    roundsRed: 13,
    roundsBlue: 7,
    team: "red",
    kills: 20,
    deaths: 10,
    assists: 5,
    score: 5000,
    damage: 3000,
    headshots: 10,
    bodyshots: 25,
    legshots: 5,
    agentIcon: null,
    ...overrides,
  };
}

const loss = { roundsRed: 7, roundsBlue: 13 };
const draw = { roundsRed: 12, roundsBlue: 12 };

describe("matchResult", () => {
  it.each([
    { team: "red", red: 13, blue: 7, expected: "W" },
    { team: "red", red: 7, blue: 13, expected: "L" },
    { team: "blue", red: 7, blue: 13, expected: "W" },
    { team: "blue", red: 13, blue: 7, expected: "L" },
    { team: "Blue", red: 5, blue: 13, expected: "W" },
    { team: "red", red: 12, blue: 12, expected: "D" },
  ])("$team with red $red and blue $blue is $expected", ({ team, red, blue, expected }) => {
    expect(matchResult(row({ team, roundsRed: red, roundsBlue: blue }))).toBe(expected);
  });

  it("returns '-' when the score or team is missing", () => {
    expect(matchResult(row({ roundsRed: null }))).toBe("-");
    expect(matchResult(row({ roundsBlue: null }))).toBe("-");
    expect(matchResult(row({ team: null }))).toBe("-");
    expect(matchResult(row({ team: "spectator" }))).toBe("-");
  });
});

describe("matchStats", () => {
  it("computes per-round numbers for one match", () => {
    expect(matchStats(row())).toEqual({ acs: 250, adr: 150, headshotPct: 25, score: "13–7", result: "W" });
  });

  it("puts the player's own rounds first in the score", () => {
    expect(matchStats(row({ team: "blue" })).score).toBe("7–13");
  });

  it("returns zeros instead of dividing by zero", () => {
    const empty = row({ roundsRed: 0, roundsBlue: 0, headshots: 0, bodyshots: 0, legshots: 0 });
    expect(matchStats(empty)).toMatchObject({ acs: 0, adr: 0, headshotPct: 0 });
  });
});

describe("kdRatio", () => {
  it("divides total kills by total deaths", () => {
    expect(kdRatio([row({ kills: 20, deaths: 10 }), row({ kills: 3, deaths: 10 })])).toBe("1.15");
  });

  it("counts zero deaths as one instead of showing 0.00", () => {
    expect(kdRatio([row({ kills: 12, deaths: 0 })])).toBe("12.00");
  });

  it("is 0.00 with no matches", () => {
    expect(kdRatio([])).toBe("0.00");
  });
});

describe("averageCombatStats", () => {
  it("averages over every round played, not per match", () => {
    // (5000 + 2000) / 40 rounds = 175 ACS, (3000 + 1000) / 40 rounds = 100 ADR
    const rows = [row(), row({ score: 2000, damage: 1000, ...loss })];
    expect(averageCombatStats(rows)).toEqual({ acs: 175, adr: 100 });
  });

  it("is zero with no rounds", () => {
    expect(averageCombatStats([])).toEqual({ acs: 0, adr: 0 });
  });
});

describe("winLossRecord", () => {
  it("counts results and leaves draws out of the win rate", () => {
    const rows = [row(), row(), row(loss), row(draw)];
    expect(winLossRecord(rows)).toEqual({ wins: 2, losses: 1, draws: 1, winrate: 67 });
  });

  it("ignores matches with missing data", () => {
    expect(winLossRecord([row({ team: null }), row({ roundsBlue: null })])).toEqual({
      wins: 0,
      losses: 0,
      draws: 0,
      winrate: 0,
    });
  });
});

describe("trackerScore", () => {
  // Worked example for row(): K/D 2 squashes to 2/3, ACS 250 squashes to 250/450.
  // Performance = 0.7(0.667) + 0.3(0.556) = 0.633. Impact = 0.6 + 0.4(0.633) = 0.853, so 85.
  it("matches a hand-computed win", () => {
    expect(trackerScore([row()])).toBe(85);
  });

  it("discounts performance by 15% in a loss", () => {
    // Impact = 0.4 * 0.633 * 0.85 = 0.215, so 22.
    expect(trackerScore([row(loss)])).toBe(22);
  });

  it("only counts the most recent n matches", () => {
    const recentWins = Array.from({ length: 10 }, () => row());
    const olderLosses = Array.from({ length: 5 }, () => row(loss));
    expect(trackerScore([...recentWins, ...olderLosses])).toBe(85);
  });

  it("stays between 0 and 100", () => {
    expect(trackerScore([])).toBe(0);
    expect(trackerScore([row({ kills: 0, deaths: 30, score: 0, roundsRed: 0, roundsBlue: 13 })])).toBe(0);
    expect(trackerScore([row({ kills: 60, deaths: 0, score: 20000 })])).toBeLessThanOrEqual(100);
  });
});
