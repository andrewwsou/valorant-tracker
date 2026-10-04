/**
 * Starts the StatTrack MCP server over stdio.
 *
 * An MCP client (Claude Code, Claude Desktop, ...) launches this process when
 * it needs the tools and talks to it over stdin and stdout. The server never
 * starts on its own, never runs on a schedule, and never calls an AI model: it
 * only answers tool calls by reading the database. It exits when the client
 * closes stdin, on SIGINT or SIGTERM, or after 10 idle minutes, and it's forced
 * out within 2 seconds even if the database is stuck.
 *
 * The client must pass DATABASE_URL explicitly, for example:
 *   claude mcp add stattrack --env DATABASE_URL="postgresql://..." -- npm --prefix /path/to/valorant-tracker run --silent mcp
 */
import { Console } from "node:console";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { trackActivity } from "@/mcp/activity";
import { CallBudget, readLimits } from "@/mcp/limits";

// stdout carries the protocol, so anything else printed there would corrupt it.
// Every console method, including dir() and table(), now writes to stderr.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

// Refuse to fall back to whatever .env holds, like the backfill script.
if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL explicitly in the MCP client's config, for the database to read.");
  process.exit(1);
}

/** How long shutdown waits for a clean close before exiting anyway. */
const SHUTDOWN_GRACE_MS = 2_000;

async function main() {
  const limits = readLimits();

  // Imported after the check, so nothing touches a database before it passes.
  const { PrismaClient } = await import("@/generated/prisma");
  const { idleReleasable, withNetworkTimeouts } = await import("@/mcp/read-only");
  const { createStatTrackServer } = await import("@/mcp/server");

  // Its own client, with network timeouts, so a silent connection fails instead of hanging.
  const db = new PrismaClient({
    datasourceUrl: withNetworkTimeouts(process.env.DATABASE_URL!, limits.queryTimeoutMs),
    log: ["error"],
  });

  const connections = idleReleasable(db, limits.queryTimeoutMs);
  // One budget per process, however many server instances the SDK creates.
  const budget = new CallBudget(limits);
  let stopping = false;

  const activity = trackActivity([
    // Idle connections could keep a serverless Postgres (like Neon) from scaling
    // to zero, so close them. Prisma reconnects on the next call.
    { afterMs: limits.idleReleaseMs, run: () => connections.release() },
    { afterMs: limits.idleExitMs, run: () => void shutdown("idle") },
  ]);

  const transport = new StdioServerTransport(undefined, undefined, { maxBufferSize: limits.messageBytes });
  const handle = serveStdio(
    () =>
      createStatTrackServer({
        readOnly: (fn) => connections.run(fn),
        budget,
        activity,
        maxResultBytes: limits.resultBytes,
      }),
    { transport, onerror: (error) => console.error("[mcp]", error) },
  );

  // However the connection ends (stdin closing, an oversized message, a broken
  // pipe), the process ends with it. serveStdio sets onclose, so chain onto it.
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    sdkOnClose?.();
    void shutdown("client disconnected");
  };

  async function shutdown(reason: string) {
    if (stopping) return;
    stopping = true;
    activity.stop();
    console.error(`[mcp] stopping: ${reason}`);
    // A stuck connection must not keep the process alive after its client is gone.
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    await Promise.allSettled([handle.close(), db.$disconnect()]);
    process.exit(0);
  }

  // Also watched directly, in case a future SDK stops closing the transport on end of input.
  process.stdin.once("end", () => void shutdown("client disconnected"));
  process.stdin.once("close", () => void shutdown("client disconnected"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  console.error("[mcp] StatTrack MCP server ready (read-only)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
