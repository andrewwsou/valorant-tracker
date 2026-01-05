import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cacheGetJson, cacheSetJson } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const name = (searchParams.get("name") ?? "").trim();
  const tag = (searchParams.get("tag") ?? "").trim();
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "10", 10) || 10, 25);

  if (!name || !tag) {
    return NextResponse.json({ error: "Missing name or tag" }, { status: 400 });
  }

  const key = `dbmatches:v2:${name.toLowerCase()}:${tag.toLowerCase()}:limit=${limit}`;

  try {
    const cached = await cacheGetJson<any>(key);
    if (cached) {
      return NextResponse.json(
        { cache: "HIT", ...cached },
        { headers: { "x-cache": "HIT", "cache-control": "no-store" } }
      );
    }
  } catch (e) {
    console.warn("[redis] cache get failed:", e);
  }

  const player = await prisma.player.findUnique({
    where: { name_tag: { name, tag } },
    select: { id: true, name: true, tag: true, puuid: true },
  });

  if (!player) {
    const payload = { player: null, data: [], message: "Player not found in DB. Run /api/sync first." };

    try {
      await cacheSetJson(key, payload, 15);
    } catch (e) {
      console.warn("[redis] cache set failed:", e);
    }

    return NextResponse.json(
      { cache: "MISS", ...payload },
      { headers: { "x-cache": "MISS", "cache-control": "no-store" } }
    );
  }

  const rows = await prisma.playerMatch.findMany({
    where: { playerId: player.id },
    include: { match: true },
    orderBy: { match: { startedAt: "desc" } },
    take: limit,
  });

  const data = rows.map((pm) => ({
    matchId: pm.matchId,
    map: pm.match.map,
    mode: pm.match.mode,
    region: pm.match.region,
    startedAt: pm.match.startedAt ? pm.match.startedAt.toISOString() : null,
    roundsRed: pm.match.roundsRed,
    roundsBlue: pm.match.roundsBlue,

    team: pm.team,
    kills: pm.kills,
    deaths: pm.deaths,
    assists: pm.assists,
    score: pm.score,
    damage: pm.damage,
    headshots: pm.headshots,
    bodyshots: pm.bodyshots,
    legshots: pm.legshots,
    agentIcon: pm.agentIcon,
  }));

  const payload = { player, data };

  try {
    await cacheSetJson(key, payload, 60);
  } catch (e) {
    console.warn("[redis] cache set failed:", e);
  }

  return NextResponse.json(
    { cache: "MISS", ...payload },
    { headers: { "x-cache": "MISS", "cache-control": "no-store" } }
  );
}
