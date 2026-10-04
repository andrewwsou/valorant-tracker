import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

// The leaderboard service imports the shared client for its default; the tools never use it.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { CallBudget } from "@/mcp/limits";
import { createStatTrackServer, type ServerDeps } from "@/mcp/server";

/** Stands in for the read-only transaction: only the calls the tools make. */
type FakeTx = {
  player: { findUnique: Mock };
  playerStats: { findMany: Mock; findUnique: Mock };
  playerMatch: { findMany: Mock };
  $queryRaw: Mock;
};

const PLAYER = { id: "p1", name: "Tester", tag: "E2E", lastSyncedAt: new Date("2026-10-04T12:00:00Z") };

const STATS = {
  playerId: "p1",
  matches: 10,
  wins: 6,
  losses: 4,
  draws: 0,
  kd: 1.254,
  acs: 249.6,
  adr: 160.4,
  winRate: 60,
  headshotPct: 24.6,
  trackerScore: 57,
  totalMatches: 23,
  lastMatchAt: new Date("2026-09-20T18:00:00Z"),
  updatedAt: new Date("2026-10-04T12:00:00Z"),
};

function matchRow(i: number, won: boolean) {
  return {
    matchId: `m${i}`,
    team: "Red",
    kills: 20,
    deaths: 16,
    assists: 5,
    score: 5000,
    damage: 3200,
    headshots: 10,
    bodyshots: 25,
    legshots: 5,
    agentIcon: "https://example.com/agent.png",
    match: {
      map: "Ascent",
      mode: "Competitive",
      region: "na",
      startedAt: new Date(Date.UTC(2026, 8, 20 - i)),
      roundsRed: won ? 13 : 7,
      roundsBlue: won ? 7 : 13,
    },
  };
}

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

/**
 * Connects a client to a fresh server, through the same serveStdio entry the real server uses.
 * With `onClientRequest`, the client offers sampling and elicitation, and reports any use of them.
 */
async function setup(overrides: Partial<ServerDeps> = {}, onClientRequest?: Mock) {
  const tx: FakeTx = {
    player: { findUnique: vi.fn().mockResolvedValue(PLAYER) },
    playerStats: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(STATS) },
    playerMatch: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const deps = {
    readOnly: vi.fn((fn: (db: never) => Promise<unknown>) => fn(tx as never)),
    budget: new CallBudget({ callsPerMinute: 100, callsPerSession: 100 }),
    activity: { begin: vi.fn(), end: vi.fn() },
    maxResultBytes: 16_384,
    ...overrides,
  };

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  serveStdio(() => createStatTrackServer(deps as ServerDeps), { transport: serverSide });
  client = new Client(
    { name: "test", version: "0.0.0" },
    onClientRequest ? { capabilities: { sampling: {}, elicitation: {} } } : undefined,
  );
  if (onClientRequest) {
    client.setRequestHandler("sampling/createMessage", async (request) => {
      onClientRequest(request);
      throw new Error("sampling is not allowed");
    });
    client.setRequestHandler("elicitation/create", async (request) => {
      onClientRequest(request);
      return { action: "decline" as const };
    });
  }
  await client.connect(clientSide);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client!.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    return { result, isError: result.isError === true, text, json: () => JSON.parse(text) };
  };
  return { tx, deps, call };
}

describe("tool list", () => {
  it("offers exactly three tools, each marked read-only and closed-world", async () => {
    await setup();
    const { tools } = await client!.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(["get_leaderboard", "get_player_stats", "get_recent_matches"]);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.description).toBeTruthy();
    }
  });

  it("never asks the client's model or user for anything, even when the client offers it", async () => {
    const asked = vi.fn();
    const { tx, call } = await setup({}, asked);
    tx.playerMatch.findMany.mockResolvedValue([matchRow(0, true)]);

    for (const [name, args] of [
      ["get_leaderboard", {}],
      ["get_player_stats", { riotId: "Tester#E2E" }],
      ["get_recent_matches", { riotId: "Tester#E2E" }],
    ] as const) {
      const res = await call(name, args);
      expect(res.isError, name).toBe(false);
      // A finished answer, not a request for more input.
      expect(res.result).not.toHaveProperty("inputRequests");
    }
    expect(asked).not.toHaveBeenCalled();
  });

  it("offers tools only: no resources and no prompts", async () => {
    await setup();
    const capabilities = client!.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.resources).toBeUndefined();
    expect(capabilities?.prompts).toBeUndefined();
  });
});

describe("get_leaderboard", () => {
  it("ranks players from PlayerStats inside the read-only transaction, rounded like the site", async () => {
    const { tx, deps, call } = await setup();
    tx.playerStats.findMany.mockResolvedValue([
      { ...STATS, player: { name: "Ace", tag: "NA1" } },
      { ...STATS, playerId: "p2", trackerScore: 40, player: { name: "Rookie", tag: "NA1" } },
    ]);

    const res = await call("get_leaderboard", { sort: "kd" });

    expect(deps.readOnly).toHaveBeenCalledOnce();
    expect(tx.playerStats.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { matches: { gte: 5 } }, take: 10 }),
    );
    expect(res.json()).toEqual({
      sort: "kd",
      minMatches: 5,
      players: [
        {
          rank: 1,
          player: "Ace#NA1",
          matches: 10,
          wins: 6,
          losses: 4,
          draws: 0,
          trackerScore: 57,
          acs: 250,
          kd: 1.25,
          winRate: 60,
          headshotPct: 25,
        },
        expect.objectContaining({ rank: 1, player: "Rookie#NA1", trackerScore: 40 }),
      ],
    });
  });
});

describe("get_player_stats", () => {
  it("returns the stored stats for an exact Riot ID without the case-insensitive fallback", async () => {
    const { tx, call } = await setup();

    const res = await call("get_player_stats", { riotId: "Tester#E2E" });

    expect(res.isError).toBe(false);
    expect(tx.player.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name_tag: { name: "Tester", tag: "E2E" } } }),
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(res.json()).toEqual({
      player: "Tester#E2E",
      matches: 10,
      wins: 6,
      losses: 4,
      draws: 0,
      winRate: 60,
      trackerScore: 57,
      kd: 1.25,
      acs: 250,
      adr: 160,
      headshotPct: 25,
      totalStoredMatches: 23,
      lastMatchAt: "2026-09-20T18:00:00.000Z",
      lastSyncedAt: "2026-10-04T12:00:00.000Z",
    });
  });

  it("falls back to a case-insensitive match with lower(), not ILIKE wildcards", async () => {
    const { tx, call } = await setup();
    tx.player.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValue([PLAYER]);

    const res = await call("get_player_stats", { riotId: "  tester # e2e " });

    expect(res.json()).toMatchObject({ player: "Tester#E2E" });
    const [sql, name, tag] = tx.$queryRaw.mock.calls[0];
    expect(sql.join("?")).toContain("lower(name) = lower(?) AND lower(tag) = lower(?)");
    expect([name, tag]).toEqual(["tester", "e2e"]);
  });

  it("says when a player isn't tracked, as a tool error", async () => {
    const { tx, call } = await setup();
    tx.player.findUnique.mockResolvedValue(null);

    const res = await call("get_player_stats", { riotId: "Nobody#X1" });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/No tracked player named Nobody#X1/);
  });

  it("says when a tracked player has no stats row yet", async () => {
    const { tx, call } = await setup();
    tx.playerStats.findUnique.mockResolvedValue(null);

    const res = await call("get_player_stats", { riotId: "Tester#E2E" });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Tester#E2E is tracked but has no stats yet/);
  });
});

describe("get_recent_matches", () => {
  it("returns the newest matches with per-match stats and no asset URLs", async () => {
    const { tx, call } = await setup();
    tx.playerMatch.findMany.mockResolvedValue([matchRow(0, true), matchRow(1, false)]);

    const res = await call("get_recent_matches", { riotId: "Tester#E2E", limit: 2 });

    expect(tx.playerMatch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { playerId: "p1" }, take: 2 }));
    expect(res.json()).toEqual({
      player: "Tester#E2E",
      matches: [
        {
          startedAt: "2026-09-20T00:00:00.000Z",
          map: "Ascent",
          mode: "Competitive",
          result: "W",
          score: "13–7",
          kills: 20,
          deaths: 16,
          assists: 5,
          acs: 250,
          adr: 160,
          headshotPct: 25,
        },
        expect.objectContaining({ result: "L", score: "7–13" }),
      ],
    });
    expect(res.text).not.toContain("https://");
  });
});

describe("guards", () => {
  it("rejects bad input before any database work", async () => {
    const { deps, call } = await setup();

    for (const [name, args] of [
      ["get_leaderboard", { limit: 26 }],
      ["get_leaderboard", { sort: "kills" }],
      ["get_leaderboard", { minMatches: 0 }],
      ["get_player_stats", { riotId: "no-tag-here" }],
      ["get_player_stats", { riotId: "a#b#c" }],
      ["get_player_stats", { riotId: "ThisNameIsWayTooLong#NA1" }],
      ["get_player_stats", { riotId: "Te\u0000ster#E2E" }],
      ["get_player_stats", { riotId: "Tester#E\u00072" }],
      ["get_recent_matches", { riotId: "Tester#E2E", limit: 11 }],
      ["get_player_stats", {}],
    ] as const) {
      const res = await call(name, args);
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(deps.readOnly).not.toHaveBeenCalled();
  });

  it("refuses calls past the budget without touching the database", async () => {
    const { deps, call } = await setup({ budget: new CallBudget({ callsPerMinute: 2, callsPerSession: 100 }) });

    await call("get_leaderboard");
    await call("get_leaderboard");
    const refused = await call("get_leaderboard");

    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Rate limit reached/);
    expect(deps.readOnly).toHaveBeenCalledTimes(2);
    expect(deps.activity.begin).toHaveBeenCalledTimes(2);
  });

  it("refuses a result bigger than the size cap instead of sending it", async () => {
    const { call } = await setup({ maxResultBytes: 100 });

    const res = await call("get_player_stats", { riotId: "Tester#E2E" });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/too large/);
  });

  it("turns database failures into a short error that leaks no details", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn().mockRejectedValue(new Error("connect failed: postgresql://user:secret@db.example"));
    const { deps, call } = await setup({ readOnly: failing });

    const res = await call("get_player_stats", { riotId: "Tester#E2E" });

    expect(res.isError).toBe(true);
    expect(res.text).toBe("The StatTrack database is unreachable or the query timed out. Try again shortly.");
    expect(consoleError).toHaveBeenCalled();
    // The idle clock restarts even when a call fails.
    expect(deps.activity.begin).toHaveBeenCalledOnce();
    expect(deps.activity.end).toHaveBeenCalledOnce();
  });
});
