// Settings shared by the end-to-end tests, the server they run against, and the load test.
// Everything points at local services. Nothing here can reach production.

export const APP_PORT = 3100;
export const MOCK_API_PORT = 4010;
export const APP_URL = `http://localhost:${APP_PORT}`;
export const MOCK_API_URL = `http://localhost:${MOCK_API_PORT}`;
export const TEST_API_KEY = "e2e-test-key";

/** Environment for the app under test. It overrides anything in .env files. */
export const appEnv = {
  // A separate database, so tests never touch local development data.
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/valorant_e2e?schema=public",
  UPSTASH_REDIS_REST_URL: process.env.E2E_REDIS_REST_URL ?? "http://localhost:8079",
  UPSTASH_REDIS_REST_TOKEN: process.env.E2E_REDIS_REST_TOKEN ?? "local-dev-token",
  HENRIKDEV_API_KEY: TEST_API_KEY,
  HENRIKDEV_BASE_URL: `${MOCK_API_URL}/valorant`,
  // Telemetry stays off during tests.
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
};
