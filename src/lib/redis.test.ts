import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { claimLock, createRedis, REDIS_TIMEOUT_MS } from "@/lib/redis";

// Real sockets and real timers: these check how fast the cache client gives up,
// which is what keeps a page fast when Redis is unreachable or stuck.

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  sockets.splice(0).forEach((s) => s.destroy());
  servers.splice(0).forEach((s) => s.close());
});

/** A local TCP server; `onConnection` decides how it misbehaves. Resolves to its URL. */
async function server(onConnection: (socket: Socket) => void) {
  const srv = createServer((socket) => {
    sockets.push(socket);
    onConnection(socket);
  });
  servers.push(srv);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, srv };
}

/** A port that just stopped listening, so connections are refused. */
async function closedPort() {
  const { url, srv } = await server(() => {});
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  servers.pop();
  return url;
}

async function elapsedOf(promise: Promise<unknown>) {
  const start = performance.now();
  const error = await promise.then(() => null, (e: unknown) => e);
  return { ms: performance.now() - start, error };
}

describe("createRedis", () => {
  it("gives up quickly when Redis refuses connections", async () => {
    const redis = createRedis(await closedPort(), "token");

    const { ms, error } = await elapsedOf(redis.get("key"));

    expect(error).toBeInstanceOf(Error);
    // One retry 50 ms later, instead of the default 5 retries over about 4.3 s.
    expect(ms).toBeLessThan(300);
  });

  it("gives up after the timeout when Redis accepts but never answers, without retrying", async () => {
    let requests = 0;
    const { url } = await server((socket) => socket.on("data", () => requests++));
    const redis = createRedis(url, "token");

    const { ms, error } = await elapsedOf(redis.get("key"));

    expect((error as Error).name).toBe("TimeoutError");
    expect(ms).toBeGreaterThanOrEqual(REDIS_TIMEOUT_MS - 20);
    expect(ms).toBeLessThan(REDIS_TIMEOUT_MS + 400);
    expect(requests).toBe(1);
  });

  it("gives every command its own timeout, so one stuck request doesn't break the next", async () => {
    let calls = 0;
    const { url } = await server((socket) =>
      socket.on("data", () => {
        // The first request hangs; later ones get a normal reply. Commands go through
        // Upstash's /pipeline endpoint, which answers with base64-encoded results.
        if (++calls === 1) return;
        const body = JSON.stringify([{ result: Buffer.from(JSON.stringify("value")).toString("base64") }]);
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
      }),
    );
    const redis = createRedis(url, "token");

    await expect(redis.get("key")).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(redis.get("key")).resolves.toBe("value");
  });
});

describe("claimLock", () => {
  /** A fake Upstash REST server that answers SET NX with "already taken" and GET with `holder`. */
  async function takenLock(holder: string) {
    const commands: (string | number)[][] = [];
    const { url } = await server((socket) =>
      socket.on("data", (raw) => {
        const body = raw.toString().split("\r\n\r\n")[1] ?? "[]";
        const batch = JSON.parse(body) as (string | number)[][];
        commands.push(...batch);
        const results = batch.map(([cmd]) =>
          String(cmd).toUpperCase() === "GET" ? { result: Buffer.from(holder).toString("base64") } : { result: null },
        );
        const reply = JSON.stringify(results);
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${reply.length}\r\n\r\n${reply}`);
      }),
    );
    return { client: createRedis(url, "token"), commands };
  }

  it("counts a lock that already holds this caller's token as won", async () => {
    // What happens when a SET lands, its reply is lost, and the client's retry finds the key taken.
    const mine = await takenLock("my-token");
    await expect(claimLock("sync:v1:claim:riot:x", "my-token", 30_000, mine.client)).resolves.toBe(true);
    expect(mine.commands[0]).toEqual(["set", "sync:v1:claim:riot:x", "my-token", "nx", "px", 30000]);

    const theirs = await takenLock("someone-else");
    await expect(claimLock("sync:v1:claim:riot:x", "my-token", 30_000, theirs.client)).resolves.toBe(false);
  });
});
