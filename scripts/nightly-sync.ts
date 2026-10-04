const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const REGION = process.env.SYNC_REGION || "na";
const SIZE = process.env.SYNC_SIZE || "10";

type Player = { name: string; tag: string };

function parsePlayers(): Player[] {
  const raw = process.env.SYNC_PLAYERS || "[]";
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((p) => ({ name: String(p.name || "").trim(), tag: String(p.tag || "").trim() }))
    .filter((p) => p.name && p.tag);
}

/** Retries per player when the app says to wait (a 429 or 503 with Retry-After). */
const MAX_WAITS = 2;
/** Longer waits than this aren't worth holding the job for; that player is skipped. */
const MAX_WAIT_SECONDS = 120;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runOne(p: Player) {
  const url = new URL(`${BASE_URL}/api/sync`);
  url.searchParams.set("region", REGION);
  url.searchParams.set("name", p.name);
  url.searchParams.set("tag", p.tag);
  url.searchParams.set("size", SIZE);

  for (let waits = 0; ; waits++) {
    const r = await fetch(url.toString(), { method: "POST" });
    const text = await r.text();
    if (r.ok) return `${p.name}#${p.tag}: ${text}`;

    // The app already retried anything worth retrying. It only says "wait" when the
    // rate limit is spent or HenrikDev is down, so wait as asked, plus some jitter.
    const retryAfter = Number(r.headers.get("retry-after"));
    const canWait = (r.status === 429 || r.status === 503) && retryAfter > 0 && retryAfter <= MAX_WAIT_SECONDS;
    if (!canWait || waits >= MAX_WAITS) throw new Error(`${p.name}#${p.tag} failed: ${r.status} ${text}`);
    console.log(`${p.name}#${p.tag}: HTTP ${r.status}, waiting ${retryAfter}s as asked`);
    await sleep(retryAfter * 1000 + Math.random() * 2000);
  }
}

async function main() {
  const players = parsePlayers();
  if (players.length === 0) {
    console.log("No SYNC_PLAYERS configured.");
    return;
  }

  console.log(`Syncing ${players.length} players against ${BASE_URL}...`);
  for (const p of players) {
    try {
      const out = await runOne(p);
      console.log(out);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
