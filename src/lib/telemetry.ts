/**
 * Tracing and metrics helpers built on the OpenTelemetry API.
 *
 * Without a registered SDK (in tests, or when OTEL_EXPORTER_OTLP_ENDPOINT is not
 * set) the API hands out no-op implementations, so instrumented code costs nothing.
 * See src/instrumentation.node.ts for where the SDK is started.
 */
import { metrics, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

const SCOPE = "valorant-stattrack";
const tracer = trace.getTracer(SCOPE);
const meter = metrics.getMeter(SCOPE);

/** Latency buckets in seconds: OpenTelemetry's HTTP defaults, plus 15 and 30 so the upstream deadlines (up to 12 s) stay visible. */
const LATENCY_BUCKETS_S = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 15, 30];

export const cacheLookups = meter.createCounter("stattrack.cache.lookups", {
  description: "Cache lookups by resource and result (hit, miss, or error).",
});

export const upstreamRequests = meter.createCounter("stattrack.upstream.requests", {
  description: "HenrikDev API attempts that got a response, by endpoint and HTTP status.",
});

export const upstreamFailures = meter.createCounter("stattrack.upstream.failures", {
  description: "HenrikDev API attempts that got no response, by endpoint and error type (timeout or a network error code).",
});

export const upstreamRetries = meter.createCounter("stattrack.upstream.retries", {
  description: "HenrikDev API retries by endpoint and reason (timeout, network, or 5xx).",
});

export const upstreamShortCircuits = meter.createCounter("stattrack.upstream.short_circuits", {
  description: "Lookups answered locally during a cooldown instead of calling the HenrikDev API, by endpoint and reason.",
});

export const upstreamInvalidPayloads = meter.createCounter("stattrack.upstream.invalid_payloads", {
  description: "HenrikDev responses or items that failed validation, by endpoint and kind (envelope or item).",
});

export const upstreamFieldFallbacks = meter.createCounter("stattrack.upstream.field_fallbacks", {
  description: "Fields that were missing, null, or the wrong type and fell back to null, by endpoint, field, and reason.",
});

export const upstreamCooldowns = meter.createCounter("stattrack.upstream.cooldowns", {
  description: "Cooldowns started, by trigger (429, remaining_zero, retry_after, or breaker).",
});

export const upstreamDuration = meter.createHistogram("stattrack.upstream.duration", {
  description: "HenrikDev API response time by endpoint.",
  unit: "s",
  advice: { explicitBucketBoundaries: LATENCY_BUCKETS_S },
});

export const syncRuns = meter.createCounter("stattrack.sync.runs", {
  description: "Match sync attempts by outcome.",
});

export const profileDuration = meter.createHistogram("stattrack.profile.duration", {
  description: "Time to load everything shown on a player profile.",
  unit: "s",
  advice: { explicitBucketBoundaries: LATENCY_BUCKETS_S },
});

let rateLimitRemaining: number | null = null;

meter
  .createObservableGauge("stattrack.upstream.ratelimit.remaining", {
    description: "Requests left in the current HenrikDev rate-limit window, from the latest response.",
  })
  .addCallback((result) => {
    if (rateLimitRemaining !== null) result.observe(rateLimitRemaining);
  });

/** Remembers the rate-limit budget reported by the most recent upstream response. */
export function recordRateLimitRemaining(value: number) {
  if (Number.isFinite(value)) rateLimitRemaining = value;
}

let cooldownUntilMs = 0;

meter
  .createObservableGauge("stattrack.upstream.cooldown.remaining", {
    description: "Seconds until this instance calls the HenrikDev API again. 0 when no cooldown is active.",
    unit: "s",
  })
  .addCallback((result) => result.observe(Math.max(0, (cooldownUntilMs - Date.now()) / 1000)));

/** Remembers when the latest known upstream cooldown ends. */
export function recordCooldownUntil(untilMs: number) {
  cooldownUntilMs = Math.max(cooldownUntilMs, untilMs);
}

/** Runs `fn` inside a new active span. Errors are recorded on the span and rethrown. */
export function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e instanceof Error ? e : String(e));
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}
