import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const name = (searchParams.get("name") ?? "").trim();
  const tag = (searchParams.get("tag") ?? "").trim();
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "10", 10) || 10, 25);

  if (!name || !tag) {
    return NextResponse.json({ error: "Missing name or tag" }, { status: 400 });
  }

  const player = await prisma.player.findUnique({
    where: { name_tag: { name, tag } },
    select: { id: true, name: true, tag: true, puuid: true },
  });

  if (!player) {
    return NextResponse.json({ data: [], message: "Player not found in DB. Run /api/sync first." });
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

  return NextResponse.json({ player, data });
}
