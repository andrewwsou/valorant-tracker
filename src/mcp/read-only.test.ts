import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma";
import { idleReleasable, readOnly, withNetworkTimeouts } from "@/mcp/read-only";

describe("readOnly", () => {
  afterEach(() => vi.useRealTimers());

  it("gives up at the deadline even when the database never answers", async () => {
    vi.useFakeTimers();
    // A transaction stuck on a silent network: it never settles.
    const db = { $transaction: vi.fn(() => new Promise(() => {})) } as unknown as PrismaClient;

    const result = readOnly(db, 5_000, async () => "never");
    const outcome = expect(result).rejects.toThrow("Database work passed its 5000 ms deadline");
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
  });

  it("passes the same limit to Prisma as its wait and transaction timeouts", async () => {
    const db = { $transaction: vi.fn().mockResolvedValue("rows") } as unknown as PrismaClient;

    await expect(readOnly(db, 1_234, async () => "rows")).resolves.toBe("rows");
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 1_234, timeout: 1_234 });
  });
});

describe("idleReleasable", () => {
  /** A client whose disconnect finishes only when the test says so. */
  function fakeDb(disconnect: Promise<void>) {
    return {
      $disconnect: vi.fn(() => disconnect),
      $transaction: vi.fn().mockResolvedValue("rows"),
    };
  }

  it("makes a call that arrives mid-release wait until the connections are closed", async () => {
    let finishDisconnect!: () => void;
    const db = fakeDb(new Promise<void>((resolve) => (finishDisconnect = resolve)));
    const connections = idleReleasable(db as unknown as PrismaClient, 1_000);

    connections.release();
    const call = connections.run(async () => "rows");
    await Promise.resolve();
    await Promise.resolve();
    expect(db.$transaction).not.toHaveBeenCalled();

    finishDisconnect();
    await expect(call).resolves.toBe("rows");
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it("keeps answering calls when closing the connections fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = fakeDb(Promise.reject(new Error("socket already closed")));
    const connections = idleReleasable(db as unknown as PrismaClient, 1_000);

    connections.release();

    await expect(connections.run(async () => "rows")).resolves.toBe("rows");
    expect(console.error).toHaveBeenCalledWith("[mcp] closing idle connections failed:", expect.any(Error));
  });
});

describe("withNetworkTimeouts", () => {
  const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

  it("adds connect and socket timeouts in whole seconds, keeping other options", () => {
    const url = withNetworkTimeouts("postgresql://u:p@db.example:5432/app?schema=public&sslmode=require", 4_500);
    expect(params(url)).toEqual({ schema: "public", sslmode: "require", connect_timeout: "5", socket_timeout: "5" });
  });

  it("keeps a stricter value from the URL but replaces looser or disabled ones", () => {
    const url = withNetworkTimeouts("postgresql://db.example/app?connect_timeout=2&socket_timeout=0", 5_000);
    expect(params(url)).toMatchObject({ connect_timeout: "2", socket_timeout: "5" });
    expect(params(withNetworkTimeouts("postgresql://db.example/app?socket_timeout=60", 5_000)).socket_timeout).toBe("5");
  });

  it("never sets a timeout below one second", () => {
    expect(params(withNetworkTimeouts("postgresql://db.example/app", 300))).toMatchObject({
      connect_timeout: "1",
      socket_timeout: "1",
    });
  });
});
