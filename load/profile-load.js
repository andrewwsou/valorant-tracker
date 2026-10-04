// Load test for the player profile page and the leaderboard, run with k6
// (https://grafana.com/docs/k6/).
//
// One warm-up request syncs the test player and fills the cache. Then k6 sends a
// steady 20 requests per second to each page for 30 seconds, which measures the
// cached path that almost every real visit takes. The run fails, and CI fails with
// it, when either page's p95 latency goes over the threshold or more than 1% of
// requests fail.
//
// It targets the end-to-end test server (`npm run e2e:serve`), whose upstream API
// is a mock, so a load test never spends the real API's rate limit.
/* global __ENV */
import { check } from "k6";
import http from "k6/http";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3100";
/** Fail the run if the 95th percentile response time goes over this many milliseconds. */
const P95_LIMIT_MS = Number(__ENV.P95_LIMIT_MS || 250);
/** Requests per second to send. CI uses the default. */
const RATE = Number(__ENV.RATE || 20);
const PROFILE_URL = `${BASE_URL}/player/Tester/E2E`;
const LEADERBOARD_URL = `${BASE_URL}/leaderboard`;

export const options = {
  scenarios: {
    cached_profile_views: {
      executor: "constant-arrival-rate",
      exec: "viewProfile",
      rate: RATE,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 10,
      maxVUs: 200,
    },
    leaderboard_views: {
      executor: "constant-arrival-rate",
      exec: "viewLeaderboard",
      rate: RATE,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 10,
      maxVUs: 200,
    },
  },
  thresholds: {
    "http_req_duration{page:profile}": [`p(95)<${P95_LIMIT_MS}`],
    "http_req_duration{page:leaderboard}": [`p(95)<${P95_LIMIT_MS}`],
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
  },
};

export function setup() {
  const res = http.get(PROFILE_URL);
  if (res.status !== 200) throw new Error(`Warm-up request failed with HTTP ${res.status}`);
}

export function viewProfile() {
  const res = http.get(PROFILE_URL, { tags: { page: "profile" } });
  check(res, {
    "status is 200": (r) => r.status === 200,
    "page lists recent matches": (r) => r.body.includes("Recent Matches"),
  });
}

export function viewLeaderboard() {
  const res = http.get(LEADERBOARD_URL, { tags: { page: "leaderboard" } });
  check(res, {
    "status is 200": (r) => r.status === 200,
    "leaderboard lists the synced player": (r) => r.body.includes("Tester"),
  });
}
