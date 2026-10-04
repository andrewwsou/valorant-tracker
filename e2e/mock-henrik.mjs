// A small stand-in for the HenrikDev API, so end-to-end and load tests are fast,
// free, and never touch the real rate limit. It knows the players in fixtures.mjs;
// everyone else gets the same 404 the real API returns.
//
// Tests can script failures for one player and endpoint (POST /__script), to check
// timeouts, retries, and rate limiting against real HTTP. See scriptedStep() below.
import http from "node:http";
import { MOCK_API_PORT, TEST_API_KEY } from "./env.mjs";
import { findPlayer } from "./fixtures.mjs";

const ENDPOINTS = ["account", "mmr", "mmr-history", "matches"];

/** Upstream calls received, by endpoint. Tests read this to check caching. */
const calls = Object.fromEntries(ENDPOINTS.map((e) => [e, 0]));
/** The same counts per lowercased player name. */
const callsByName = new Map();
/** Scripted steps, first in first out, keyed by "endpoint:name". */
const scripts = new Map();
/** Connections left hanging on purpose, so /__reset can close them. */
const hanging = new Set();

const routes = [
  { endpoint: "account", pattern: /^\/valorant\/v1\/account\/([^/]+)\/([^/]+)$/, data: (p) => p.account },
  { endpoint: "mmr", pattern: /^\/valorant\/v2\/mmr\/[^/]+\/([^/]+)\/([^/]+)$/, data: (p) => p.mmr },
  { endpoint: "mmr-history", pattern: /^\/valorant\/v1\/mmr-history\/[^/]+\/([^/]+)\/([^/]+)$/, data: (p) => p.mmrHistory },
  {
    endpoint: "matches",
    pattern: /^\/valorant\/v3\/matches\/[^/]+\/([^/]+)\/([^/]+)$/,
    data: (p, query) => p.matches.slice(0, Number(query.get("size") ?? p.matches.length)),
  },
];

const DEFAULT_HEADERS = { "content-type": "application/json", "x-ratelimit-remaining": "30" };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...DEFAULT_HEADERS, ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function notFound(res) {
  send(res, 404, { status: 404, errors: [{ code: 22, message: "Account not found", status: 404 }] });
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/** Takes the next scripted step for this endpoint and player, if any. */
function scriptedStep(endpoint, name) {
  const key = `${endpoint}:${name.toLowerCase()}`;
  const queue = scripts.get(key);
  if (!queue?.length) return null;
  const step = queue[0];
  // `times` repeats a step; it's removed once used up.
  if ((step.times ?? 1) <= 1) queue.shift();
  else step.times--;
  return step;
}

/**
 * Plays one scripted step. Fields, all optional:
 *   status, headers, body   the response (default 200)
 *   as                      answer with this fixture player's data
 *   reverse                 with `as`, list that data in reverse order
 *   delayMs                 wait before sending headers
 *   hang                    never answer
 *   stallBodyMs             send headers and part of the body, then stall
 *   reset                   drop the connection without answering
 */
function playStep(step, res, route, query) {
  const status = step.status ?? 200;
  const respond = () => {
    if (step.reset) return res.socket?.destroy();
    if (step.hang) return hanging.add(res);
    if (step.stallBodyMs) {
      res.writeHead(status, { ...DEFAULT_HEADERS, ...step.headers });
      res.write('{"status":200,"data":');
      hanging.add(res);
      setTimeout(() => res.destroyed || res.end("null}"), step.stallBodyMs);
      return;
    }
    let body = step.body;
    if (body === undefined && step.as) {
      const player = findPlayer(step.as, "E2E");
      const data = route.data(player, query);
      body = { status: 200, data: step.reverse && Array.isArray(data) ? [...data].reverse() : data };
    }
    if (body === undefined) {
      body = status >= 400 ? { status, errors: [{ code: 0, message: "Scripted error", status }] } : { status, data: {} };
    }
    send(res, status, body, step.headers);
  };
  if (step.delayMs) setTimeout(respond, step.delayMs);
  else respond();
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");

    if (url.pathname === "/__health") return send(res, 200, { ok: true });
    if (url.pathname === "/__calls") {
      const name = url.searchParams.get("name");
      if (name) return send(res, 200, callsByName.get(name.toLowerCase()) ?? Object.fromEntries(ENDPOINTS.map((e) => [e, 0])));
      const total = Object.values(calls).reduce((a, b) => a + b, 0);
      return send(res, 200, { ...calls, total });
    }
    if (url.pathname === "/__script" && req.method === "POST") {
      const { endpoint, name, steps } = await readJson(req);
      const key = `${endpoint}:${String(name).toLowerCase()}`;
      scripts.set(key, [...(scripts.get(key) ?? []), ...steps]);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__reset" && req.method === "POST") {
      scripts.clear();
      for (const r of hanging) r.socket?.destroy();
      hanging.clear();
      return send(res, 200, { ok: true });
    }

    // The real API rejects requests without a key, so the mock does too.
    if (req.headers.authorization !== TEST_API_KEY) {
      return send(res, 401, { errors: [{ code: 1, message: "Invalid API key" }] });
    }

    for (const route of routes) {
      const match = url.pathname.match(route.pattern);
      if (!match) continue;
      const name = decodeURIComponent(match[1]);
      calls[route.endpoint]++;
      const counts = callsByName.get(name.toLowerCase()) ?? Object.fromEntries(ENDPOINTS.map((e) => [e, 0]));
      counts[route.endpoint]++;
      callsByName.set(name.toLowerCase(), counts);

      const step = scriptedStep(route.endpoint, name);
      if (step) return playStep(step, res, route, url.searchParams);

      const player = findPlayer(name, decodeURIComponent(match[2]));
      if (!player) return notFound(res);
      return send(res, 200, { status: 200, data: route.data(player, url.searchParams) });
    }

    send(res, 404, { errors: [{ message: `No mock for ${url.pathname}` }] });
  })
  .listen(MOCK_API_PORT, () => console.log(`[mock] HenrikDev API on http://localhost:${MOCK_API_PORT}`));
