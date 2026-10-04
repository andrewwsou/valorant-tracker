import { spawn } from "node:child_process";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, test } from "@playwright/test";
import { PrismaClient } from "../src/generated/prisma";
import { readOnly } from "../src/mcp/read-only";
import { appEnv, SYNC_AUTH } from "./env.mjs";
import { PLAYERS } from "./fixtures.mjs";

// Starts the MCP server the way the README tells AI clients to: over stdio, from
// another directory, with DATABASE_URL passed explicitly (here, the test database).
// Playwright runs from the repo root.
const REPO = process.cwd();
const COMMAND = "npm";
const ARGS = ["--prefix", REPO, "run", "--silent", "mcp"];
const serverEnv = (extra: Record<string, string> = {}) => ({
  ...getDefaultEnvironment(),
  DATABASE_URL: appEnv.DATABASE_URL,
  ...extra,
});

test.beforeAll(async ({ request }) => {
  // Sync every fixture player, clearing any cooldown left by earlier tests.
  const db = new PrismaClient({ datasourceUrl: appEnv.DATABASE_URL });
  await db.player.updateMany({ data: { lastSyncedAt: null } });
  await db.$disconnect();
  for (const p of PLAYERS) {
    const res = await request.post(`/api/sync?name=${p.name}&tag=${p.tag}`, { headers: SYNC_AUTH });
    expect(res.ok(), `${p.name}: ${await res.text()}`).toBe(true);
  }
});

test.describe("tools over stdio", () => {
  let client: Client;

  test.beforeAll(async () => {
    client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: COMMAND, args: ARGS, cwd: tmpdir(), env: serverEnv() }));
  });
  test.afterAll(() => client.close());

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { isError: result.isError === true, text: content[0].text };
  }
  const json = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await call(name, args);
    expect(res.isError, res.text).toBe(false);
    return JSON.parse(res.text);
  };

  test("lists three read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_leaderboard", "get_player_stats", "get_recent_matches"]);
    for (const tool of tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  test("get_leaderboard ranks players the same way the website does", async () => {
    const board = await json("get_leaderboard");
    expect(board.players.map((p: Record<string, unknown>) => [p.rank, p.player, p.trackerScore, p.acs, p.kd, p.winRate])).toEqual([
      [1, "Ace#E2E", 67, 150, 1.1, 80],
      [2, "Tester#E2E", 57, 250, 1.25, 60],
      [3, "Rookie#E2E", 55, 200, 0.4, 70],
    ]);

    const byKd = await json("get_leaderboard", { sort: "kd" });
    expect(byKd.players.map((p: { player: string }) => p.player)).toEqual(["Tester#E2E", "Ace#E2E", "Rookie#E2E"]);

    const everyone = await json("get_leaderboard", { minMatches: 1, limit: 2 });
    expect(everyone.players.map((p: { player: string }) => p.player)).toEqual(["Newbie#E2E", "Ace#E2E"]);
  });

  test("get_player_stats returns the stored stats, ignoring Riot ID case", async () => {
    expect(await json("get_player_stats", { riotId: "tester#e2e" })).toMatchObject({
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
      totalStoredMatches: 10,
      lastMatchAt: "2026-09-20T18:00:00.000Z",
    });
  });

  test("get_recent_matches returns the newest matches first", async () => {
    const { player, matches } = await json("get_recent_matches", { riotId: "Tester#E2E", limit: 3 });
    expect(player).toBe("Tester#E2E");
    expect(matches.map((m: Record<string, unknown>) => [m.startedAt, m.map, m.result, m.score, m.acs, m.adr])).toEqual([
      ["2026-09-20T18:00:00.000Z", "Ascent", "W", "13–7", 250, 160],
      ["2026-09-20T17:00:00.000Z", "Bind", "W", "13–7", 250, 160],
      ["2026-09-20T16:00:00.000Z", "Haven", "W", "13–7", 250, 160],
    ]);
  });

  test("unknown players and bad input come back as tool errors", async () => {
    expect(await call("get_player_stats", { riotId: "Nobody#E2E" })).toMatchObject({
      isError: true,
      text: expect.stringContaining("No tracked player named Nobody#E2E"),
    });
    expect((await call("get_recent_matches", { riotId: "Tester#E2E", limit: 50 })).isError).toBe(true);
  });
});

test("the tools' transaction is read-only and time-limited, enforced by Postgres", async () => {
  const db = new PrismaClient({ datasourceUrl: appEnv.DATABASE_URL });
  try {
    const settings = await readOnly(db, 1234, (tx) =>
      tx.$queryRaw<{ ro: string; timeout: string }[]>`
        SELECT current_setting('transaction_read_only') AS ro, current_setting('statement_timeout') AS timeout`,
    );
    expect(settings).toEqual([{ ro: "on", timeout: "1234ms" }]);

    await expect(
      readOnly(db, 2_000, (tx) => tx.player.create({ data: { name: "Intruder", tag: "RO" } })),
    ).rejects.toThrow(/read-only transaction/);
    expect(await db.player.count({ where: { name: "Intruder" } })).toBe(0);

    const started = Date.now();
    await expect(readOnly(db, 300, (tx) => tx.$queryRaw`SELECT pg_sleep(5)`)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);

    // The settings were local to the transaction, so they don't leak to the pooled connection.
    const [after] = await db.$queryRaw<{ timeout: string }[]>`SELECT current_setting('statement_timeout') AS timeout`;
    expect(after.timeout).toBe("0");
  } finally {
    await db.$disconnect();
  }
});

/** Starts the server as a raw process, to watch exactly what it writes and how it exits. */
function startServer(env: Record<string, string>) {
  // Only these variables: nothing from this shell, so no stray DATABASE_URL.
  const child = spawn(COMMAND, ARGS, { cwd: tmpdir(), env: env as NodeJS.ProcessEnv, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (const line of stdout.split("\n")) {
      try {
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      } catch {
        // Not a whole message yet. The stdout test checks every line in the end.
      }
    }
  });
  const ready = new Promise<void>((resolve) =>
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("server ready")) resolve();
    }),
  );
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));

  let nextId = 1;
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  /** One JSON-RPC request, answered by the response with the same id. */
  const request = (method: string, params: object) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });
  /** The opening handshake an MCP client sends before calling tools. */
  const initialize = async () => {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "raw-e2e", version: "0.0.0" },
    });
    send({ method: "notifications/initialized" });
  };
  const callTool = async (name: string, args: object) =>
    (await request("tools/call", { name, arguments: args })).result as { isError?: boolean; content: { text: string }[] };

  return { child, ready, exited, initialize, callTool, stdout: () => stdout, stderr: () => stderr };
}

/** Waits for the process to exit, failing if it takes longer than `ms`. */
async function exitWithin(server: ReturnType<typeof startServer>, ms: number) {
  const started = Date.now();
  const code = await Promise.race([server.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
  if (code === "timeout") {
    server.child.kill("SIGKILL");
    throw new Error(`The server was still running after ${ms} ms. stderr:\n${server.stderr()}`);
  }
  return { code, ms: Date.now() - started };
}

/** A TCP proxy to the test database that can go silent, like a network that dropped mid-session. */
async function stallableDatabase() {
  const target = new URL(appEnv.DATABASE_URL);
  let silent = false;
  const sockets: Socket[] = [];
  const proxy = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    sockets.push(client, upstream);
    client.on("data", (data) => silent || upstream.write(data));
    upstream.on("data", (data) => silent || client.write(data));
    for (const [a, b] of [[client, upstream], [upstream, client]]) {
      a.on("error", () => {});
      a.on("close", () => b.destroy());
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const url = new URL(appEnv.DATABASE_URL);
  url.hostname = "127.0.0.1";
  url.port = String((proxy.address() as AddressInfo).port);
  return {
    url: url.toString(),
    goSilent: () => (silent = true),
    close: () => {
      sockets.forEach((s) => s.destroy());
      proxy.close();
    },
  };
}

test("every line the server writes to stdout is a JSON-RPC message", async () => {
  const server = startServer(serverEnv());
  await server.ready;
  await server.initialize();
  expect((await server.callTool("get_player_stats", { riotId: "Tester#E2E" })).isError).toBeFalsy();
  // The error path logs to the console; that must land on stderr.
  expect((await server.callTool("get_player_stats", { riotId: "Nobody#E2E" })).isError).toBe(true);
  server.child.stdin.end();
  await exitWithin(server, 5_000);

  const lines = server.stdout().split("\n").filter(Boolean);
  expect(lines.length).toBeGreaterThanOrEqual(3);
  for (const line of lines) expect(JSON.parse(line), line).toMatchObject({ jsonrpc: "2.0" });
});

test("the server exits as soon as the client closes stdin", async () => {
  const server = startServer(serverEnv());
  await server.ready;

  server.child.stdin.end();

  const { code, ms } = await exitWithin(server, 5_000);
  expect(code).toBe(0);
  expect(ms).toBeLessThan(3_000);
  expect(server.stderr()).toContain("stopping: client disconnected");
});

test("the server shuts down cleanly on SIGTERM", async () => {
  const server = startServer(serverEnv());
  await server.ready;

  server.child.kill("SIGTERM");

  await exitWithin(server, 5_000);
  expect(server.stderr()).toContain("stopping: SIGTERM");
});

test("the server exits on its own after idling, even with stdin still open", async () => {
  const server = startServer(serverEnv({ MCP_IDLE_EXIT_MS: "1500" }));
  await server.ready;

  const { code } = await exitWithin(server, 10_000);
  expect(code).toBe(0);
  expect(server.stderr()).toContain("stopping: idle");
});

test("closing idle database connections never breaks the next call", async () => {
  // Connections close 1 ms after every call, so each new call races a disconnect.
  const server = startServer(serverEnv({ MCP_IDLE_RELEASE_MS: "1" }));
  await server.ready;
  await server.initialize();

  for (let i = 0; i < 30; i++) {
    const res = await server.callTool("get_player_stats", { riotId: "Tester#E2E" });
    expect(res.isError, `call ${i + 1}: ${res.content[0].text}`).toBeFalsy();
  }
  server.child.stdin.end();
  await exitWithin(server, 5_000);
});

test("a message over the size limit ends the session", async () => {
  const server = startServer(serverEnv({ MCP_MESSAGE_BYTES: "4096" }));
  await server.ready;
  await server.initialize();

  server.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "x".repeat(8_000) } }) + "\n");

  await exitWithin(server, 5_000);
  expect(server.stdout()).not.toContain("x".repeat(100));
  expect(server.stderr()).toContain("stopping: client disconnected");
});

test("a database that goes silent can't hang a call or keep the server alive", async () => {
  const db = await stallableDatabase();
  const server = startServer(serverEnv({ DATABASE_URL: db.url, MCP_QUERY_TIMEOUT_MS: "1000" }));
  try {
    await server.ready;
    await server.initialize();
    // The first call opens a connection through the proxy.
    expect((await server.callTool("get_player_stats", { riotId: "Tester#E2E" })).isError).toBeFalsy();

    db.goSilent();
    const started = Date.now();
    const stalled = await server.callTool("get_player_stats", { riotId: "Tester#E2E" });
    expect(stalled.isError).toBe(true);
    expect(stalled.content[0].text).toMatch(/unreachable or the query timed out/);
    expect(Date.now() - started).toBeLessThan(3_000);

    // Shutdown can't wait forever on the stuck connection either.
    server.child.stdin.end();
    const { code } = await exitWithin(server, 6_000);
    expect(code).toBe(0);
  } finally {
    db.close();
  }
});

test("the server refuses to start without an explicit DATABASE_URL", async () => {
  const server = startServer(getDefaultEnvironment());

  const { code } = await exitWithin(server, 10_000);
  expect(code).toBe(1);
  expect(server.stderr()).toContain("Set DATABASE_URL explicitly");
});
