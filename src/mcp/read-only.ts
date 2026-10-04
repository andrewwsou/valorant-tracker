import type { Prisma, PrismaClient } from "@/generated/prisma";

/**
 * Runs `fn` in a transaction that Postgres itself keeps read-only, and settles
 * within `timeoutMs` no matter what.
 *
 * `SET TRANSACTION READ ONLY` makes the database reject any INSERT, UPDATE, or
 * DELETE in the transaction, so the MCP tools can't write even if their code
 * had a bug. The statement timeout stops slow queries on the server. The
 * deadline covers what neither Postgres nor Prisma can see: waiting for a
 * connection, and a network that has gone silent mid-query.
 */
export function readOnly<T>(
  db: PrismaClient,
  timeoutMs: number,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const work = db.$transaction(
    async (tx) => {
      // Must come first: the mode can't change once the transaction has read anything.
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
      return fn(tx);
    },
    { maxWait: timeoutMs, timeout: timeoutMs },
  );
  return withDeadline(work, timeoutMs);
}

/**
 * Read-only access to `db` that can close its idle connections safely. A call
 * that starts while connections are closing waits for the close to finish, then
 * Prisma reconnects; without that wait the two race and the call fails.
 */
export function idleReleasable(db: PrismaClient, timeoutMs: number) {
  let releasing: Promise<void> = Promise.resolve();
  return {
    run<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
      return releasing.then(() => readOnly(db, timeoutMs, fn));
    },
    release() {
      releasing = db.$disconnect().catch((error) => console.error("[mcp] closing idle connections failed:", error));
    },
  };
}

/** Rejects if `work` hasn't settled within `ms`. The timer never outlives the race. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Database work passed its ${ms} ms deadline`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Adds Prisma's connect and socket timeouts to a connection string, so a dead
 * network fails a query instead of hanging it, and a stuck connection can
 * still be closed at shutdown. A lower value already in the URL is kept.
 */
export function withNetworkTimeouts(databaseUrl: string, timeoutMs: number): string {
  const url = new URL(databaseUrl);
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  for (const key of ["connect_timeout", "socket_timeout"]) {
    const current = Number(url.searchParams.get(key));
    // 0 means "no timeout" to Prisma, so it's replaced too.
    if (!(current > 0 && current <= seconds)) url.searchParams.set(key, String(seconds));
  }
  return url.toString();
}
