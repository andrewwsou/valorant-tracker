import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type HenrikMatchFull = any; // keep it simple for now

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const region = (searchParams.get("region") ?? "na").trim();
  const name = (searchParams.get("name") ?? "").trim();
  const tag = (searchParams.get("tag") ?? "").trim();

  if (!name || !tag) {
    return NextResponse.json({ error: "Missing name or tag" }, { status: 400 });
  }

  // Call YOUR existing matches route (already sets auth + no-store)
  const base =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

  const qs = new URLSearchParams({
    region,
    name,
    tag,
    size: "10",
    mode: "competitive",
  });

  const r = await fetch(`${base}/api/matches?${qs.toString()}`, { cache: "no-store" });

  if (!r.ok) {
    const text = await r.text();
    return new NextResponse(text, { status: r.status });
  }

  const json = await r.json();
  const matches: HenrikMatchFull[] = Array.isArray(json?.data) ? json.data : [];

  if (matches.length === 0) {
    return NextResponse.json({ message: "No matches found" });
  }

  // Resolve player in first match
  const first = matches[0];
  const playerData =
    first?.players?.all_players?.find(
      (p: any) =>
        (p.name ?? "").toLowerCase() === name.toLowerCase() &&
        (p.tag ?? "").toLowerCase() === tag.toLowerCase()
    ) ?? null;

  if (!playerData?.puuid) {
    return NextResponse.json({ error: "Could not resolve player puuid" }, { status: 500 });
  }

  // Upsert Player
  const player = await prisma.player.upsert({
    where: { puuid: playerData.puuid },
    update: { name, tag },
    create: { puuid: playerData.puuid, name, tag },
  });

  let matchesUpserted = 0;
  let playerMatchesUpserted = 0;

  for (const m of matches) {
    const matchId = m?.metadata?.matchid;
    if (!matchId) continue;

    await prisma.match.upsert({
      where: { id: matchId },
      update: {
        map: m?.metadata?.map ?? null,
        mode: m?.metadata?.mode ?? null,
        region,
        startedAt: m?.metadata?.game_start ? new Date(m.metadata.game_start * 1000) : null,
        roundsRed: m?.teams?.red?.rounds_won ?? null,
        roundsBlue: m?.teams?.blue?.rounds_won ?? null,
      },
      create: {
        id: matchId,
        map: m?.metadata?.map ?? null,
        mode: m?.metadata?.mode ?? null,
        region,
        startedAt: m?.metadata?.game_start ? new Date(m.metadata.game_start * 1000) : null,
        roundsRed: m?.teams?.red?.rounds_won ?? null,
        roundsBlue: m?.teams?.blue?.rounds_won ?? null,
      },
    });

    matchesUpserted++;

    const p = m?.players?.all_players?.find((x: any) => x?.puuid === playerData.puuid);
    if (!p) continue;

    await prisma.playerMatch.upsert({
      where: {
        matchId_playerId: {
          matchId,
          playerId: player.id,
        },
      },
      update: {
        team: p?.team?.toLowerCase?.() ?? null,
        kills: p?.stats?.kills ?? null,
        deaths: p?.stats?.deaths ?? null,
        assists: p?.stats?.assists ?? null,
        score: p?.stats?.score ?? null,
        damage: p?.damage_made ?? null,
        headshots: p?.stats?.headshots ?? null,
        bodyshots: p?.stats?.bodyshots ?? null,
        legshots: p?.stats?.legshots ?? null,
        agentIcon: p?.assets?.agent?.small ?? null,
      },
      create: {
        matchId,
        playerId: player.id,
        team: p?.team?.toLowerCase?.() ?? null,
        kills: p?.stats?.kills ?? null,
        deaths: p?.stats?.deaths ?? null,
        assists: p?.stats?.assists ?? null,
        score: p?.stats?.score ?? null,
        damage: p?.damage_made ?? null,
        headshots: p?.stats?.headshots ?? null,
        bodyshots: p?.stats?.bodyshots ?? null,
        legshots: p?.stats?.legshots ?? null,
        agentIcon: p?.assets?.agent?.small ?? null,
      },
    });

    playerMatchesUpserted++;
  }

  return NextResponse.json({
    ok: true,
    player: `${name}#${tag}`,
    matchesUpserted,
    playerMatchesUpserted,
  });
}
