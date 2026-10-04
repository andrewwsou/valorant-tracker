import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ cacheGetJson: vi.fn(), cacheSetJson: vi.fn() }));

import { getAccount } from "@/lib/henrik";
import { cacheGetJson, cacheSetJson } from "@/lib/redis";
import { withSpan } from "@/lib/telemetry";

// A real tracer that keeps finished spans in memory, so tests can inspect them.
const exporter = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
});

afterAll(() => {
  trace.disable();
  context.disable();
});

beforeEach(() => {
  exporter.reset();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>());
  vi.stubEnv("HENRIKDEV_API_KEY", "test-key");
  vi.mocked(cacheGetJson).mockResolvedValue(null);
  vi.mocked(cacheSetJson).mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

const span = (name: string) => exporter.getFinishedSpans().find((s) => s.name === name);

describe("withSpan", () => {
  it("returns the result and records the span with its attributes", async () => {
    await expect(withSpan("work", { "job.id": 7 }, async () => 42)).resolves.toBe(42);

    expect(span("work")?.attributes).toMatchObject({ "job.id": 7 });
  });

  it("marks the span as failed, records the exception, and rethrows", async () => {
    const failing = withSpan("broken", {}, async () => {
      throw new Error("boom");
    });

    await expect(failing).rejects.toThrow("boom");
    expect(span("broken")?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span("broken")?.events.map((e) => e.name)).toContain("exception");
  });
});

describe("HenrikDev client spans", () => {
  it("traces a cache miss as a lookup with the upstream call nested inside", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200, headers: { "x-ratelimit-remaining": "21" } }));

    await getAccount("enzo", "yyy");

    const lookup = span("henrik.lookup account");
    const upstream = span("henrik.fetch account");
    expect(lookup?.attributes).toMatchObject({ "henrik.endpoint": "account", "cache.hit": false });
    expect(upstream?.attributes).toMatchObject({ "http.response.status_code": 200, "henrik.ratelimit.remaining": 21 });
    expect(upstream?.parentSpanContext?.spanId).toBe(lookup?.spanContext().spanId);
  });

  it("traces a cache hit without any upstream call", async () => {
    vi.mocked(cacheGetJson).mockResolvedValue({ status: 200, contentType: "application/json", body: "{}" });

    await getAccount("enzo", "yyy");

    expect(span("henrik.lookup account")?.attributes).toMatchObject({ "cache.hit": true });
    expect(span("henrik.fetch account")).toBeUndefined();
  });
});
