/**
 * Next.js runs `register` once when a server starts, before any request.
 * OpenTelemetry only starts when an OTLP endpoint is configured, so local
 * development and tests run without it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    await import("./instrumentation.node");
  }
}
