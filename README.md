# VALORANT StatTrack

[![CI](https://github.com/andrewwsou/valorant-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/andrewwsou/valorant-tracker/actions/workflows/ci.yml)

Look up any VALORANT player to see their rank, recent competitive matches, and performance stats, and compare tracked players on a leaderboard. Match history is stored in PostgreSQL, third-party API lookups are cached in Redis, and a nightly GitHub Actions job keeps tracked players up to date. AI assistants such as Claude can query the same stats through a read-only MCP server.

![Player profile showing current rank, overall stats, and recent matches](docs/screenshot.png)

## Highlights

- **One cached API client.** Every call to the third-party VALORANT API goes through `src/lib/henrik.ts`, which uses cache-aside with a TTL per kind of data. Repeat profile views make zero upstream calls, which matters under the API's 30-requests-per-minute limit.
- **Idempotent ingestion.** Syncing upserts matches by match ID and player stats by a unique (match, player) key, so re-running a sync never creates duplicates. A 5-minute cooldown protects the rate limit.
- **Precomputed player stats.** After each sync, the player's `PlayerStats` row is rebuilt from their stored matches in one short, locked transaction, never incremented, so overlapping syncs can't double count. The leaderboard reads one indexed table instead of every match row. Tests on a real Postgres show that concurrent syncs don't conflict and that a refresh waits for the lock instead of losing an update.
- **Normalized schema.** `Match`, `Player`, and `PlayerMatch` tables with unique constraints and indexes on every lookup path.
- **Production Docker image.** A multi-stage build with Next.js standalone output: 382 MB, runs as a non-root user, and contains no source code or secrets.
- **Health checks and graceful degradation.** `/api/health` checks Postgres and Redis. If the cache goes down, pages keep working and health reports `degraded`. If the database goes down, health returns 503.
- **Leaderboard.** Rank tracked players by tracker score, ACS, K/D, or win rate, with a minimum-matches filter. Each request is one indexed query plus a primary-key lookup for names; sort keys come from an allowlist, and exact ties share a rank.
- **MCP server for AI agents.** Three typed tools let Claude and other MCP clients read player stats, recent matches, and the leaderboard over stdio. Postgres enforces read-only access, every call has hard caps on rate, result size, and query time, and the server exits when its client disconnects or sits idle. It never calls an AI model itself, and a CI test keeps it that way.
- **Tested at three levels.** 117 Vitest unit tests cover the logic. Playwright drives a real browser through the production build against a mocked upstream API. A k6 load test fails CI if either the profile page or the leaderboard passes a 250 ms p95 at 20 requests per second each; locally the cached profile page held a 20 ms p95 at 100 requests per second.
- **OpenTelemetry tracing and metrics.** Every request is traced through the cache, the upstream API, and each Prisma query. Custom metrics track profile load time, cache hit ratio, upstream latency, the API rate-limit budget, and sync outcomes, and a preloaded Grafana dashboard shows them.
- **Parallel page loading.** The profile page calls a service layer directly instead of its own API over HTTP, and syncs matches while rank and player card load at the same time.
- **CI on every pull request and push to main.** GitHub Actions runs lint, type checks, unit tests with coverage, the end-to-end and load tests, a production build, and a dependency audit. It also boots the full Docker stack and waits for the health check to pass. Dependabot opens weekly update pull requests.
- **Nightly sync** through a scheduled GitHub Actions workflow.

## Architecture

```mermaid
flowchart LR
    subgraph app [Next.js app]
        pages[Server-rendered pages] --> services[Services]
        api[API routes] --> services
        services --> client[HenrikDev client]
    end

    browser([Browser]) --> pages
    cron[Nightly GitHub Actions job] -->|"POST /api/sync"| api
    client -->|cache-aside with TTL| redis[(Redis)]
    client -->|on cache miss| henrik[HenrikDev VALORANT API]
    services -->|cached reads| redis
    services -->|Prisma| postgres[(PostgreSQL)]
    app -.->|OTLP traces and metrics| lgtm[Grafana, Tempo, Prometheus]
    agent([AI client, such as Claude]) -->|"MCP over stdio"| mcp[MCP server]
    mcp -->|read-only transactions| postgres
```

What happens when someone opens a profile:

1. The page calls the profile service. It syncs the player's latest competitive matches into Postgres, unless they synced in the last 5 minutes.
2. At the same time, rank, rank history, and the player card load from the HenrikDev API through the Redis cache.
3. Once the sync finishes, it rebuilds the player's `PlayerStats` row and starts the cooldown in the same commit, and the 10 most recent matches are read from Postgres.
4. K/D, ACS, ADR, win rate, and the tracker score are computed from those rows by pure functions in `src/services/stats.ts`.
5. If any part fails, the page still renders and lists what failed.

| Data | Cached for | Why |
|---|---|---|
| Player card and account | 1 hour | Changes only when the player edits their profile |
| Rank and rank history | 5 minutes | Changes only after a match, and matches sync at most every 5 minutes |
| Recent matches from Postgres | 60 seconds | Cleared whenever a sync writes new matches |
| Raw match details | not cached | About 7 MB per 10 matches, and the fields we need already live in Postgres |

## Observability

The app is instrumented with OpenTelemetry and sends traces and metrics over OTLP, so any compatible backend works. Locally, one command adds Grafana with Tempo for traces and Prometheus for metrics:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up --build
```

Grafana runs at http://localhost:3001 with the StatTrack dashboard preloaded.

![Grafana dashboard showing profile load time, cache hit ratio, upstream calls, and the rate-limit budget](docs/grafana-dashboard.png)

Below is a trace of a first-time profile view. The card and rank lookups run while the match sync is still going, and the match list loads once the sync finishes:

![Trace waterfall of one profile view in Grafana](docs/trace-waterfall.png)

| Metric | Type | What it shows |
|---|---|---|
| `stattrack.profile.duration` | histogram, seconds | Time to load a whole profile |
| `stattrack.cache.lookups` | counter | Cache hits, misses, and errors by resource |
| `stattrack.upstream.requests` | counter | HenrikDev calls by endpoint and HTTP status |
| `stattrack.upstream.duration` | histogram, seconds | HenrikDev latency by endpoint |
| `stattrack.upstream.ratelimit.remaining` | gauge | Requests left in the API's rate-limit window |
| `stattrack.sync.runs` | counter | Sync attempts by outcome |

Telemetry stays off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so tests and a plain `npm run dev` pay nothing for it. To use a hosted backend, set that variable and put its credentials in `OTEL_EXPORTER_OTLP_HEADERS`.

## AI agent access (MCP)

`src/mcp/` is a [Model Context Protocol](https://modelcontextprotocol.io) server, so an AI assistant can answer questions like "who has the best K/D on StatTrack, and how did their last three matches go?" from this app's own data.

| Tool | Input | Returns |
|---|---|---|
| `get_leaderboard` | `sort`, `minMatches`, `limit` (up to 25) | Ranked players with record, tracker score, ACS, K/D, win rate, and headshot % |
| `get_player_stats` | `riotId`, such as `TenZ#NA1` | One player's stats over their last 10 stored matches, and when they last synced |
| `get_recent_matches` | `riotId`, `limit` (up to 10) | Newest matches with map, result, score, kills, deaths, assists, ACS, ADR, and headshot % |

The tools reuse the website's queries and formulas, so they return the numbers the site shows. They only read what's already stored and never fetch new matches.

To add it to Claude Code, run this from the repo:

```bash
claude mcp add stattrack --env DATABASE_URL="postgresql://..." -- npm --prefix "$PWD" run --silent mcp
```

It's saved to your local Claude Code config only, not to the repo. If the server has exited after idling, reconnect it with `/mcp`.

For Claude Desktop or another client, add this to its MCP config. Desktop apps on macOS don't see your shell's `PATH`, so if the client can't find `npm`, use the full path from `which npm`.

```json
{
  "mcpServers": {
    "stattrack": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/valorant-tracker", "run", "--silent", "mcp"],
      "env": { "DATABASE_URL": "postgresql://..." }
    }
  }
}
```

For a deployed database, give the server its own login that can only read:

```sql
CREATE ROLE stattrack_mcp LOGIN PASSWORD 'choose-one';
GRANT USAGE ON SCHEMA public TO stattrack_mcp;
GRANT SELECT ON "Player", "PlayerStats", "PlayerMatch", "Match" TO stattrack_mcp;
```

### Cost safeguards

The server can't spend AI tokens or credits by itself. Tokens are only spent by the AI client you run, when you ask it something, under that client's own permission prompts and limits.

- **It never calls a model.** The project has no AI SDK and calls no AI API. The server doesn't use MCP sampling, the one feature that lets a server ask the client's model to generate text. `src/mcp/guardrails.test.ts` fails CI if any of this changes.
- **It only runs while a client has it open.** The client starts it on demand. It exits when the client closes the connection or quits, on `SIGINT` or `SIGTERM`, and after 10 minutes without a tool call. If the database is stuck, it's forced out within 2 seconds anyway. Nothing is scheduled; the only timers are the idle ones that shut it down.
- **Every answer is bounded.** At most 30 tool calls a minute and 300 per session reach the database. Calls with invalid input are turned away before that with a one-line error. Results are compact JSON capped at 16 KB, about 4,000 tokens. A client message over 64 KB ends the session.
- **Every call is time-limited.** Each call gets at most 5 seconds of database time. That holds even if the network goes silent mid-query, through Postgres's statement timeout, Prisma's socket timeout, and a deadline on the call itself.
- **It can't write or spend the API quota.** Each call runs in a `READ ONLY` transaction, so Postgres rejects any write. It never calls the HenrikDev API.
- **It lets the database sleep.** Database connections close after a minute without calls, so a serverless Postgres can scale to zero.

Environment variables can lower these limits but never raise them: `MCP_CALLS_PER_MINUTE`, `MCP_CALLS_PER_SESSION`, `MCP_RESULT_BYTES`, `MCP_MESSAGE_BYTES`, `MCP_QUERY_TIMEOUT_MS`, `MCP_IDLE_RELEASE_MS`, and `MCP_IDLE_EXIT_MS`.

## Tech stack

TypeScript, Next.js 15 (App Router), React 19, Tailwind CSS 4, PostgreSQL 16, Prisma 6, Redis (Upstash), OpenTelemetry, Grafana, Docker, GitHub Actions.

## Getting started

You need Node 22 or newer (see `.nvmrc`), Docker, and a [HenrikDev](https://docs.henrikdev.xyz) API key.

### Run everything with Docker

```bash
cp .env.example .env    # then set HENRIKDEV_API_KEY
docker compose up --build
```

Open http://localhost:3000. Compose starts Postgres, Redis, a migration job, and the app, and waits for each one to be healthy before starting the next.

### Develop locally

```bash
npm install
cp .env.example .env    # then set HENRIKDEV_API_KEY
docker compose up -d db cache migrate
npm run dev
```

In production the app reaches Redis through Upstash's REST API. Locally, [serverless-redis-http](https://github.com/hiett/serverless-redis-http) serves the same API in front of a plain Redis, so the app runs the same cache code in both places.

| Command | What it does |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript type check |
| `npm test` | Unit tests with Vitest |
| `npm run test:coverage` | Unit tests with a coverage report |
| `npm run test:e2e` | End-to-end tests with Playwright |
| `npm run e2e:serve` | Starts the mock API and the app on port 3100 for the end-to-end and load tests |
| `npm run test:load` | k6 load test against `e2e:serve`, run through Docker |
| `npm run db:backfill-stats` | Rebuilds every player's `PlayerStats` row. Needs an explicit `DATABASE_URL`; safe to re-run |
| `npm run mcp` | The MCP server over stdio. AI clients start it themselves; needs an explicit `DATABASE_URL` |

## Testing

| Level | Tool | What it covers |
|---|---|---|
| Unit | Vitest | Stat math, sync, caching, tracing, and input parsing. MCP tools through an in-memory client, their call budget, size cap, and idle timers, and the cost guardrails. The database, cache, and `fetch` are mocked, so the suite runs in under a second |
| End to end | Playwright | Searching, the profile page's numbers, caching across reloads, an unknown player, recent searches, and the JSON API, all in a real browser against the production build. Also the `PlayerStats` table on a real database (re-syncs, concurrent syncs, the row lock, the backfill), the leaderboard's ranking, sorting, and filtering, and the MCP server over real stdio: its answers, a clean stdout, Postgres rejecting writes, a database that goes silent mid-call, and exiting on disconnect, SIGTERM, idle, or an oversized message |
| Load | k6 | 20 requests per second each to the cached profile page and the leaderboard, for 30 seconds. Fails if either page's p95 passes 250 ms or more than 1% of requests fail |

The end-to-end and load tests use a mock of the HenrikDev API (`e2e/mock-henrik.mjs`), so they are deterministic and never spend the real API's rate limit. They also use their own `valorant_e2e` database.

```bash
docker compose up -d db cache
npm run build
npm run test:e2e
```

For the load test, start `npm run e2e:serve` in one terminal and run `npm run test:load` in another.


## Configuration

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `UPSTASH_REDIS_REST_URL` | yes | Redis REST endpoint: Upstash, or the local proxy |
| `UPSTASH_REDIS_REST_TOKEN` | yes | Token for that endpoint |
| `HENRIKDEV_API_KEY` | yes | HenrikDev API key |
| `HENRIKDEV_BASE_URL` | no | Base URL of the HenrikDev API. Tests point it at a mock |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | Where to send traces and metrics. Telemetry is off when it's unset |
| `OTEL_EXPORTER_OTLP_HEADERS` | no | Auth headers for a hosted OTLP backend |
| `OTEL_SERVICE_NAME` | no | Service name on traces and metrics. Defaults to `valorant-stattrack` |
| `MCP_*` | no | Lower the MCP server's limits. See [Cost safeguards](#cost-safeguards) |

The nightly workflow reads two GitHub Actions secrets: `BASE_URL`, the deployed app, and `SYNC_PLAYERS`, a JSON array such as `[{"name":"PlayerName","tag":"NA1"}]`.

## API

| Method | Endpoint | Returns |
|---|---|---|
| `GET` | `/api/player?name=&tag=` | Account details and player card |
| `GET` | `/api/overall?region=&name=&tag=` | Current and peak rank |
| `GET` | `/api/elo?region=&name=&tag=` | Rank change for each recent match |
| `POST` | `/api/sync?region=&name=&tag=&size=` | Pulls recent matches into Postgres |
| `GET` | `/api/db/matches?name=&tag=&limit=` | Recent matches from Postgres |
| `GET` | `/api/leaderboard?sort=&minMatches=&limit=` | Top players. `sort` is `trackerScore` (default), `acs`, `kd`, or `winRate`; `minMatches` 1 to 10 (default 5); `limit` 1 to 100 (default 25) |
| `GET` | `/api/health` | Database and cache status |

`region` defaults to `na` and must be one of `na`, `eu`, `ap`, `kr`, `latam`, or `br`. Cached endpoints return an `x-cache` header set to `HIT` or `MISS`.

## Project structure

```
src/
  app/
    api/                   route handlers: parse input, call a service
    player/[name]/[tag]/   player profile page
    leaderboard/           leaderboard page
  instrumentation.ts       starts OpenTelemetry when an endpoint is configured
  components/              UI components
  services/
    profile.ts             loads everything the player page shows
    sync.ts                pulls recent matches into Postgres
    player-stats.ts        rebuilds a player's PlayerStats row in one locked transaction
    leaderboard.ts         ranks players from PlayerStats; validates sort and filters
    matches.ts             reads recent matches from Postgres, cached
    match-rows.ts          the one query both the page and the stats use
    stats.ts               K/D, ACS, ADR, win rate, and tracker score
  mcp/
    main.ts                stdio entry point: startup checks, idle exit, shutdown
    server.ts              registers the tools and wraps every call in the guards
    tools.ts               what each tool reads and returns
    read-only.ts           the read-only transaction, deadlines, and idle connection release
    limits.ts              hard caps and the call budget
    activity.ts            idle timers that close connections and exit
  lib/
    henrik.ts              HenrikDev client: auth, URLs, caching, logging
    redis.ts               cache helpers
    prisma.ts              database client
    riot-id.ts             input parsing and region allowlist
    telemetry.ts           spans and custom metrics
observability/             Grafana dashboard and provisioning
e2e/                       Playwright tests, the mock HenrikDev API, and its test data
load/                      k6 load test
prisma/                    schema and migrations
scripts/                   nightly ingestion job and the stats backfill
```

Unit tests sit next to the code they cover, as `*.test.ts`.

## Roadmap

- [x] Unit tests with Vitest
- [x] CI on every pull request and push to main
- [x] End-to-end and load tests
- [x] OpenTelemetry traces, metrics, and a Grafana dashboard
- [x] Precomputed per-player stats
- [x] Leaderboard page and API backed by those stats
- [x] MCP server so AI agents can query player stats
- [ ] Retries with backoff and rate-limit handling for upstream calls

---

VALORANT StatTrack is a fan project and isn't endorsed by Riot Games. VALORANT and Riot Games are trademarks of Riot Games, Inc. Player data comes from the unofficial [HenrikDev API](https://docs.henrikdev.xyz).
