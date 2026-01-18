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

async function runOne(p: Player) {
  const url = new URL(`${BASE_URL}/api/sync`);
  url.searchParams.set("region", REGION);
  url.searchParams.set("name", p.name);
  url.searchParams.set("tag", p.tag);
  url.searchParams.set("size", SIZE);

  const r = await fetch(url.toString(), { method: "POST" });
  const text = await r.text();
  if (!r.ok) throw new Error(`${p.name}#${p.tag} failed: ${r.status} ${text}`);
  return `${p.name}#${p.tag}: ${text}`;
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
    } catch (e: any) {
      console.error(e?.message ?? e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
