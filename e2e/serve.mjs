// Starts what the end-to-end and load tests run against: the mock HenrikDev API
// and the production build of the app, configured from env.mjs.
//
// Needs the database and cache running and a production build:
//   docker compose up -d db cache
//   npm run build
import { execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { APP_PORT, appEnv } from "./env.mjs";

const require = createRequire(import.meta.url);
const env = { ...process.env, ...appEnv };

// Creates the test database on first run and applies any pending migrations.
execSync("npx prisma migrate deploy", { env, stdio: "inherit" });

// Runs the app's database sessions in a time zone other than UTC, so a timestamp
// that isn't stored as UTC shows up as hours off in the tests instead of hiding.
execSync("npx prisma db execute --stdin --schema prisma/schema.prisma", {
  env,
  input: `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'America/Los_Angeles'); END $$;`,
  stdio: ["pipe", "inherit", "inherit"],
});

const children = [
  spawn(process.execPath, ["e2e/mock-henrik.mjs"], { env, stdio: "inherit" }),
  spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(APP_PORT)], {
    env,
    stdio: "inherit",
  }),
];

function stopAll(code = 0) {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => stopAll());
process.on("SIGTERM", () => stopAll());
// If either server dies, stop the other one too, so failures are obvious.
for (const child of children) child.on("exit", (code) => stopAll(code ?? 1));
