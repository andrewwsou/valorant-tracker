/**
 * Nightly sync: asks the deployed app to sync each configured player, one at a time.
 *
 * It fails loudly. The exit code is 0 only when every player synced (or was
 * already fresh): 1 when any player failed or wasn't reached, 2 when the
 * configuration or the secret is wrong. Each failure becomes a GitHub Actions
 * error annotation, and a summary table goes to the run's summary page.
 *
 * Environment:
 *   BASE_URL        the deployed app (https; http only for localhost)
 *   CRON_SECRET     the app's sync secret, sent as a bearer token
 *   SYNC_PLAYERS    JSON array, e.g. [{"name":"Player","tag":"NA1"}]
 *   SYNC_REGION     default na
 *   SYNC_SIZE       matches per player, 1 to 10 (default 10)
 *   SYNC_GAP_MS     pause between players that called HenrikDev (default 10000)
 *   SYNC_BUDGET_MS  total time the run may take (default 20 minutes)
 */
import { appendFileSync } from "node:fs";

export {};

type Target = { name: string; tag: string };
type Row = { label: string; outcome: string; http: string; detail: string; ok: boolean };

const FINE = new Set(["synced", "skipped", "no-matches"]);
/** Statuses that come with a Retry-After the job can wait out: rate limit, outage, another sync running. */
const WAITABLE = new Set([409, 429, 503]);
const MAX_WAITS = 2;
const MAX_WAIT_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 45_000;

class ConfigError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function readConfig() {
  const baseUrl = process.env.BASE_URL ?? "";
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError("BASE_URL must be the deployed app's URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new ConfigError("BASE_URL must use https (http is only allowed for localhost)");
  }

  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) throw new ConfigError("CRON_SECRET is not set");

  let parsed: unknown;
  try {
    parsed = JSON.parse(process.env.SYNC_PLAYERS ?? "");
  } catch {
    throw new ConfigError("SYNC_PLAYERS must be a JSON array");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new ConfigError("SYNC_PLAYERS must be a non-empty JSON array");
  const players = parsed.map((entry, i): Target => {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    const tag = typeof entry?.tag === "string" ? entry.tag.trim() : "";
    if (!name || !tag) throw new ConfigError(`SYNC_PLAYERS[${i}] needs a name and a tag`);
    return { name, tag };
  });

  return {
    url,
    secret,
    players,
    region: process.env.SYNC_REGION || "na",
    size: intEnv("SYNC_SIZE", 10, 1, 10),
    gapMs: intEnv("SYNC_GAP_MS", 10_000, 0, 600_000),
    budgetMs: intEnv("SYNC_BUDGET_MS", 20 * 60_000, 1_000, 6 * 60 * 60_000),
  };
}

type Config = ReturnType<typeof readConfig>;

/** Syncs one player, waiting out a Retry-After when it fits. Throws ConfigError on an auth problem. */
async function syncOne(config: Config, target: Target, deadline: number): Promise<Row> {
  const label = `${target.name}#${target.tag}`;
  const endpoint = new URL("/api/sync", config.url);
  endpoint.search = new URLSearchParams({ region: config.region, name: target.name, tag: target.tag, size: String(config.size) }).toString();

  for (let waits = 0; ; waits++) {
    let res: Response;
    let text: string;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.secret}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (e) {
      return { label, outcome: "error", http: "-", detail: e instanceof Error ? e.message : String(e), ok: false };
    }

    let body: { outcome?: string; player?: string; error?: string } = {};
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON, such as HenrikDev's own error passed through. The status says enough.
    }
    const outcome = body.outcome ?? (res.ok ? "unknown" : "upstream-error");
    const shown = body.player ?? label;

    if (res.status === 401 || (res.status === 503 && outcome === "not-configured")) {
      throw new ConfigError(`the app refused the secret: HTTP ${res.status} ${outcome}`);
    }
    if (res.ok && FINE.has(outcome)) return { label: shown, outcome, http: String(res.status), detail: "", ok: true };

    // The app already retried anything worth retrying. It only says "wait" when the rate
    // limit is spent, HenrikDev is down, or another sync of this player is running.
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = retryAfter * 1000 + Math.random() * 2000;
    const canWait =
      WAITABLE.has(res.status) &&
      retryAfter > 0 &&
      retryAfter <= MAX_WAIT_SECONDS &&
      waits < MAX_WAITS &&
      Date.now() + waitMs < deadline;
    if (canWait) {
      console.log(`${shown}: HTTP ${res.status}, waiting ${retryAfter}s as asked`);
      await sleep(waitMs);
      continue;
    }
    const detail = body.error ?? text.slice(0, 200);
    return { label: shown, outcome, http: String(res.status), detail, ok: false };
  }
}

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** Appends a table of every player's outcome to the GitHub Actions run summary, when there is one. */
function writeSummary(rows: Row[], headline: string) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    `## ${headline}`,
    "",
    "| Player | Outcome | HTTP | Detail |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${cell(r.label)} | ${r.ok ? "" : "❌ "}${cell(r.outcome)} | ${r.http} | ${cell(r.detail)} |`),
    "",
  ];
  appendFileSync(file, lines.join("\n"));
}

async function main() {
  let config: Config;
  try {
    config = readConfig();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.log(`::error title=Nightly sync::${e.message}`);
    writeSummary([], `Nightly sync not run: ${e.message}`);
    process.exitCode = 2;
    return;
  }

  const deadline = Date.now() + config.budgetMs;
  const rows: Row[] = [];
  console.log(`Syncing ${config.players.length} player(s) against ${config.url.origin}`);

  try {
    for (const [i, target] of config.players.entries()) {
      if (Date.now() >= deadline) {
        rows.push({ label: `${target.name}#${target.tag}`, outcome: "not-attempted", http: "-", detail: "time budget used up", ok: false });
        continue;
      }
      const row = await syncOne(config, target, deadline);
      rows.push(row);
      console.log(`${row.label}: ${row.outcome} (HTTP ${row.http})${row.detail ? ` ${row.detail}` : ""}`);
      if (!row.ok) console.log(`::error title=Nightly sync::${row.label}: ${row.outcome} (HTTP ${row.http}) ${cell(row.detail)}`);
      // Leave room in the shared rate limit, except after a player that didn't call HenrikDev.
      if (i < config.players.length - 1 && row.outcome !== "skipped") await sleep(config.gapMs);
    }
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.log(`::error title=Nightly sync::${e.message}`);
    writeSummary(rows, `Nightly sync stopped: ${e.message}`);
    process.exitCode = 2;
    return;
  }

  const failed = rows.filter((r) => !r.ok).length;
  const headline = failed === 0 ? `Nightly sync: all ${rows.length} player(s) fine` : `Nightly sync: ${failed} of ${rows.length} player(s) failed`;
  console.log(headline);
  writeSummary(rows, headline);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  console.log(`::error title=Nightly sync::crashed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
