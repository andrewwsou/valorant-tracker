import { describe, expect, it, vi } from "vitest";
import { upstreamFieldFallbacks, upstreamInvalidPayloads } from "@/lib/telemetry";
import {
  AccountV1,
  MatchV4,
  MmrHistoryEntryV1,
  MmrV2,
  parseListBody,
  parseObjectBody,
  reportValidation,
} from "@/lib/henrik-schemas";

const JETT = "add6443a-41bd-e414-f6ad-e58d267f4e95";

/** A v4 match shaped like the spec, with every field the app reads. */
function match(id: string, overrides: { kills?: unknown; metadata?: unknown } = {}) {
  return {
    metadata: "metadata" in overrides ? overrides.metadata : {
      match_id: id,
      map: { id: "map-id", name: "Ascent" },
      queue: { id: "competitive", name: "Competitive", mode_type: "Standard" },
      started_at: "2026-09-30T19:24:10.94Z",
      is_completed: true,
    },
    players: [
      {
        puuid: "puuid-1",
        name: "Enzo",
        tag: "YYY",
        team_id: "Red",
        agent: { id: JETT.toUpperCase(), name: "Jett" },
        stats: {
          kills: overrides.kills ?? 18,
          deaths: 9,
          assists: 7,
          score: 5055,
          headshots: 12,
          bodyshots: 30,
          legshots: 2,
          damage: { dealt: 3100, received: 2000 },
        },
      },
    ],
    teams: [
      { team_id: "Red", rounds: { won: 13, lost: 9 }, won: true },
      { team_id: "Blue", rounds: { won: 9, lost: 13 }, won: false },
    ],
  };
}

const body = (data: unknown) => JSON.stringify({ status: 200, data });

describe("MatchV4", () => {
  it("reads a spec-shaped match with no fallbacks", () => {
    const { items, report } = parseListBody("matches", body([match("m1")]), MatchV4);

    expect(report).toMatchObject({ kept: 1, rejected: 0, envelopeInvalid: false });
    // toEqual, not toMatchObject: an empty object pattern would match anything.
    expect(report.fallbacks).toEqual({});
    expect(items![0]).toMatchObject({
      metadata: { match_id: "m1", map: { name: "Ascent" }, queue: { name: "Competitive" }, started_at: Date.parse("2026-09-30T19:24:10.94Z") },
      players: [{ puuid: "puuid-1", team_id: "Red", agent: { id: JETT }, stats: { kills: 18, damage: { dealt: 3100 } } }],
      teams: [{ team_id: "Red", rounds: { won: 13 } }, { team_id: "Blue", rounds: { won: 9 } }],
    });
  });

  it("drops a match it can't identify and keeps the rest", () => {
    const { items, report } = parseListBody(
      "matches",
      body([match("m1"), match("x", { metadata: { match_id: 123 } }), match("x", { metadata: null }), match("m4")]),
      MatchV4,
    );

    expect(items!.map((m) => m.metadata.match_id)).toEqual(["m1", "m4"]);
    expect(report).toMatchObject({ kept: 2, rejected: 2 });
    expect(report.issues[0]).toEqual({ item: 1, path: "metadata.match_id", code: "invalid_type" });
  });

  it("turns one bad field into null and counts it, keeping the match", () => {
    const { items, report } = parseListBody("matches", body([match("m1", { kills: "18" })]), MatchV4);

    expect(items![0].players[0].stats?.kills).toBeNull();
    expect(items![0].players[0].stats?.deaths).toBe(9);
    expect(report.fallbacks).toEqual({ "matches.player.stats.kills|invalid": 1 });
  });

  it("falls back field by field for a whole range of upstream oddities", () => {
    const odd = match("m1") as Record<string, unknown> & { metadata: Record<string, unknown> };
    odd.teams = "oops";
    odd.metadata.started_at = "yesterday";
    (odd.players as { stats: { damage: unknown } }[])[0].stats.damage = null;
    (odd.players as { agent: unknown }[])[0].agent = { id: "not-a-guid" };

    const { items, report } = parseListBody("matches", body([odd]), MatchV4);

    expect(report.kept).toBe(1);
    expect(items![0].teams).toEqual([]);
    expect(items![0].metadata.started_at).toBeNull();
    expect(items![0].players[0].stats?.damage).toBeNull();
    expect(items![0].players[0].agent?.id).toBeNull();
    expect(report.fallbacks).toEqual({
      "matches.teams|invalid": 1,
      "matches.metadata.started_at|invalid": 1,
      "matches.player.stats.damage|null": 1,
      "matches.player.agent.id|invalid": 1,
    });
  });

  it("drops only a player without a PUUID", () => {
    const m = match("m1");
    m.players.push({ ...m.players[0], puuid: "" });

    const { items, report } = parseListBody("matches", body([m]), MatchV4);

    expect(items![0].players).toHaveLength(1);
    expect(report.fallbacks).toEqual({ "matches.players[]|invalid": 1 });
  });

  it("doesn't count the fallbacks of a match it dropped", () => {
    const bad = match("x", { kills: "18" });
    (bad.metadata as { match_id: unknown }).match_id = 7;

    const { report } = parseListBody("matches", body([bad]), MatchV4);

    expect(report).toMatchObject({ kept: 0, rejected: 1 });
    expect(report.fallbacks).toEqual({});
  });

  it("keeps numbers within a Postgres INT, truncating fractions", () => {
    // Built as raw JSON text, so 1e999 really arrives as Infinity (JSON.stringify would make it null).
    const parse = (kills: string) => {
      const raw = body([match("m1")]).replace('"kills":18', `"kills":${kills}`);
      const { items, report } = parseListBody("matches", raw, MatchV4);
      return { kills: items![0].players[0].stats?.kills, fallbacks: report.fallbacks };
    };
    expect(parse("9.7")).toEqual({ kills: 9, fallbacks: {} });
    expect(parse("1e12")).toEqual({ kills: null, fallbacks: { "matches.player.stats.kills|invalid": 1 } });
    expect(parse("1e999")).toEqual({ kills: null, fallbacks: { "matches.player.stats.kills|invalid": 1 } });
  });

  it("doesn't count the fields of a player or team it dropped", () => {
    const m = match("m1");
    m.players.push({ puuid: "", name: null, stats: { kills: "x" } } as never);
    (m.teams as unknown[]).push({ team_id: 7, rounds: "bad" });

    const { report } = parseListBody("matches", body([m]), MatchV4);

    expect(report.fallbacks).toEqual({ "matches.players[]|invalid": 1, "matches.teams[]|invalid": 1 });
  });

  it("allows a null queue name, as the spec does, without counting it", () => {
    const m = match("m1");
    (m.metadata as { queue: { name: unknown } }).queue.name = null;

    const { items, report } = parseListBody("matches", body([m]), MatchV4);

    expect(items![0].metadata.queue?.name).toBeNull();
    expect(report.fallbacks).toEqual({});
  });
});

describe("parsing a response body", () => {
  it("flags a body without a usable data field, but accepts an empty list", () => {
    for (const bad of ["not json", body(null), body({}), "null"]) {
      expect(parseListBody("matches", bad, MatchV4), bad).toMatchObject({ items: null, report: { envelopeInvalid: true } });
    }
    expect(parseListBody("matches", body([]), MatchV4)).toMatchObject({ items: [], report: { envelopeInvalid: false } });
    expect(parseObjectBody("account", body([]), AccountV1)).toMatchObject({ data: null, report: { envelopeInvalid: true } });
  });

  it("never puts upstream values in its report", () => {
    const secret = "SENTINEL-VALUE-123";
    const bad = match("x", { kills: secret });
    (bad.metadata as { match_id: unknown }).match_id = { secret };

    const { report } = parseListBody("matches", body([bad, match("m2", { kills: secret })]), MatchV4);

    expect(JSON.stringify(report)).not.toContain(secret);
  });
});

describe("profile schemas", () => {
  const card = "https://media.valorant-api.com/playercards/03f88215-41f1-d3a2-7983-67b56517eb72/smallart.png";
  const icon = "https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/27/smallicon.png";

  it("reads the account, rank, and rank history fields the page shows", () => {
    expect(parseObjectBody("account", body({ card: { small: card } }), AccountV1).data).toEqual({ card: { small: card } });
    expect(
      parseObjectBody("mmr", body({ current_data: { currenttierpatched: "Radiant", images: { small: icon } }, highest_rank: { patched_tier: "Radiant" } }), MmrV2).data,
    ).toEqual({ current_data: { currenttierpatched: "Radiant", images: { small: icon } }, highest_rank: { patched_tier: "Radiant" } });
    const { items, report } = parseListBody("mmr-history", body([{ match_id: "m1", images: { small: icon } }, { images: {} }]), MmrHistoryEntryV1);
    expect(items).toEqual([{ match_id: "m1", images: { small: icon } }]);
    expect(report.rejected).toBe(1);
  });

  it("only accepts https images from the host the page is allowed to load", () => {
    for (const url of ["http://media.valorant-api.com/x.png", "https://evil.example/x.png", "javascript:alert(1)", "card.png"]) {
      const { data, report } = parseObjectBody("account", body({ card: { small: url } }), AccountV1);
      expect(data?.card?.small, url).toBeNull();
      expect(report.fallbacks).toEqual({ "account.card.small|invalid": 1 });
    }
  });
});

describe("reportValidation", () => {
  it("counts dropped items, unreadable answers, and each field fallback in the metrics", () => {
    // Without an SDK, OpenTelemetry hands out one shared no-op counter, so one spy sees both.
    expect(upstreamInvalidPayloads).toBe(upstreamFieldFallbacks);
    const add = vi.spyOn(upstreamInvalidPayloads, "add");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = match("x", { kills: "18" });
    (bad.metadata as { match_id: unknown }).match_id = 5;

    reportValidation(parseListBody("matches", body([bad, match("m2", { kills: "18" })]), MatchV4).report);
    reportValidation(parseObjectBody("account", "not json", AccountV1).report);

    expect(add.mock.calls).toEqual([
      [1, { endpoint: "matches", kind: "item" }],
      // Only the kept match's fallback: the dropped one's aren't counted.
      [1, { endpoint: "matches", field: "matches.player.stats.kills", reason: "invalid" }],
      [1, { endpoint: "account", kind: "envelope" }],
    ]);
  });

  it("warns with paths and codes when something was dropped, and stays quiet otherwise", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportValidation(parseListBody("matches", body([match("m1")]), MatchV4).report);
    expect(warn).not.toHaveBeenCalled();

    const bad = match("x");
    (bad.metadata as { match_id: unknown }).match_id = 5;
    reportValidation(parseListBody("matches", body([bad, match("m2")]), MatchV4).report);
    expect(warn).toHaveBeenCalledWith("[henrik] matches: dropped 1 of 2 items (#0 metadata.match_id: invalid_type)");
  });
});
