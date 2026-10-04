/**
 * Starts the OpenTelemetry Node SDK: traces and metrics exported over OTLP/HTTP.
 *
 * Configuration comes from the standard environment variables:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  where to send data, for example http://localhost:4318
 *   OTEL_EXPORTER_OTLP_HEADERS   auth headers for hosted backends such as Grafana Cloud
 *   OTEL_SERVICE_NAME            defaults to "valorant-stattrack"
 */
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { PrismaInstrumentation } from "@prisma/instrumentation";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "valorant-stattrack",
  }),
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 15_000,
  }),
  // Adds a span for every Prisma query, including the SQL it ran.
  instrumentations: [new PrismaInstrumentation()],
});

sdk.start();

// Flush buffered spans and metrics when the container stops.
process.once("SIGTERM", () => {
  sdk.shutdown().finally(() => process.exit(0));
});
