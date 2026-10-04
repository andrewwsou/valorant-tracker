// A small stand-in for the HenrikDev API, so end-to-end and load tests are fast,
// free, and never touch the real rate limit. It knows one player (see fixtures.mjs);
// everyone else gets the same 404 the real API returns.
import http from "node:http";
import { MOCK_API_PORT, TEST_API_KEY } from "./env.mjs";
import { PLAYER, account, matches, mmr, mmrHistory } from "./fixtures.mjs";

/** Upstream calls received, by endpoint. Tests read this to check caching. */
const calls = { account: 0, mmr: 0, "mmr-history": 0, matches: 0 };

const routes = [
  { endpoint: "account", pattern: /^\/valorant\/v1\/account\/([^/]+)\/([^/]+)$/, data: () => account },
  { endpoint: "mmr", pattern: /^\/valorant\/v2\/mmr\/[^/]+\/([^/]+)\/([^/]+)$/, data: () => mmr },
  { endpoint: "mmr-history", pattern: /^\/valorant\/v1\/mmr-history\/[^/]+\/([^/]+)\/([^/]+)$/, data: () => mmrHistory },
  {
    endpoint: "matches",
    pattern: /^\/valorant\/v3\/matches\/[^/]+\/([^/]+)\/([^/]+)$/,
    data: (query) => matches.slice(0, Number(query.get("size") ?? matches.length)),
  },
];

const isTestPlayer = (name, tag) =>
  decodeURIComponent(name).toLowerCase() === PLAYER.name.toLowerCase() &&
  decodeURIComponent(tag).toLowerCase() === PLAYER.tag.toLowerCase();

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "x-ratelimit-remaining": "30" });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");

    if (url.pathname === "/__health") return send(res, 200, { ok: true });
    if (url.pathname === "/__calls") {
      const total = Object.values(calls).reduce((a, b) => a + b, 0);
      return send(res, 200, { ...calls, total });
    }

    // The real API rejects requests without a key, so the mock does too.
    if (req.headers.authorization !== TEST_API_KEY) {
      return send(res, 401, { errors: [{ code: 1, message: "Invalid API key" }] });
    }

    for (const route of routes) {
      const match = url.pathname.match(route.pattern);
      if (!match) continue;
      calls[route.endpoint]++;
      if (!isTestPlayer(match[1], match[2])) {
        return send(res, 404, { status: 404, errors: [{ code: 22, message: "Account not found", status: 404 }] });
      }
      return send(res, 200, { status: 200, data: route.data(url.searchParams) });
    }

    send(res, 404, { errors: [{ message: `No mock for ${url.pathname}` }] });
  })
  .listen(MOCK_API_PORT, () => console.log(`[mock] HenrikDev API on http://localhost:${MOCK_API_PORT}`));
