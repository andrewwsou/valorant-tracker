import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type { Prisma } from "@/generated/prisma";
import type { Activity } from "@/mcp/activity";
import type { CallBudget } from "@/mcp/limits";
import {
  leaderboardAnswer,
  leaderboardInput,
  playerInput,
  playerStatsAnswer,
  recentMatchesAnswer,
  recentMatchesInput,
  type ToolAnswer,
} from "@/mcp/tools";

export type ServerDeps = {
  /** Runs database work in a read-only, time-limited transaction. */
  readOnly: <T>(fn: (db: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  budget: CallBudget;
  activity: Pick<Activity, "begin" | "end">;
  maxResultBytes: number;
};

const INSTRUCTIONS =
  "Read-only VALORANT stats for players tracked by StatTrack. These tools only read StatTrack's database and never fetch new matches, so stats are as fresh as each player's last sync.";

/** Every tool only reads this app's own database. Clients can use these hints to auto-approve them. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Our largest input has 3 fields, so anything bigger is rejected before validation. */
const MAX_INPUT_ELEMENTS = 8;

const errorResult = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/**
 * Builds the MCP server. It only answers tool calls: no resources, no prompts,
 * no sampling (the MCP feature that lets a server ask the client's model to
 * generate text), and nothing scheduled.
 */
export function createStatTrackServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: "stattrack", version: "0.1.0" },
    { instructions: INSTRUCTIONS, maxToolInputElements: MAX_INPUT_ELEMENTS },
  );

  server.registerTool(
    "get_leaderboard",
    {
      title: "StatTrack leaderboard",
      description: "Top tracked players ranked by one stat over each player's last 10 stored matches.",
      inputSchema: leaderboardInput,
      annotations: READ_ONLY,
    },
    (input) => answer(deps, (db) => leaderboardAnswer(db, input)),
  );

  server.registerTool(
    "get_player_stats",
    {
      title: "Player stats",
      description:
        "One tracked player's stats over their last 10 stored matches: record, win rate, tracker score, K/D, ACS, ADR, headshot %, and when they were last synced.",
      inputSchema: playerInput,
      annotations: READ_ONLY,
    },
    (input) => answer(deps, (db) => playerStatsAnswer(db, input)),
  );

  server.registerTool(
    "get_recent_matches",
    {
      title: "Recent matches",
      description:
        "A tracked player's most recent stored matches, newest first, with map, result, score, kills, deaths, assists, ACS, ADR, and headshot %.",
      inputSchema: recentMatchesInput,
      annotations: READ_ONLY,
    },
    (input) => answer(deps, (db) => recentMatchesAnswer(db, input)),
  );

  return server;
}

/**
 * Runs one tool call inside every guard: the call budget, the read-only
 * transaction, the result size cap, and idle tracking. Failures become short
 * error results for the agent; details go to stderr, never to the client.
 */
async function answer(deps: ServerDeps, work: (db: Prisma.TransactionClient) => Promise<ToolAnswer>) {
  const refusal = deps.budget.take();
  if (refusal) return errorResult(refusal);

  deps.activity.begin();
  try {
    const result = await deps.readOnly(work);
    if (!result.ok) return errorResult(result.message);

    const text = JSON.stringify(result.data);
    if (Buffer.byteLength(text) > deps.maxResultBytes) {
      return errorResult("The result is too large to return. Ask for fewer rows.");
    }
    return { content: [{ type: "text", text }] } satisfies CallToolResult;
  } catch (error) {
    console.error("[mcp] tool call failed:", error);
    return errorResult("The StatTrack database is unreachable or the query timed out. Try again shortly.");
  } finally {
    deps.activity.end();
  }
}
