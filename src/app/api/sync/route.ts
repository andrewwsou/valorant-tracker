import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { invalidatePlayerMatches } from "@/lib/redis";

export const dynamic = "force-dynamic";

type HenrikMatchFull = any;

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const region = (searchParams.get("region") ?? "na").trim();
  const name = (searchParams.get("name") ?? "").trim();
  const tag = (searchParams.get("tag") ?? "").trim();

  const size = Math.min(parseInt(searchParams.get("size") ?? "10", 10) || 10, 25);

  if (!name || !tag) {
    return NextResponse.json({ error: "Missing name or tag" }, { status: 400 });
  }

  const COOLDOWN_MS = 5 * 60_000;

  const existingByNameTag = await prisma.player.findUnique({
    where: { name_tag: { name, tag } },
    select: { id: true, puuid: true, lastSyncedAt: true },
  });

  if (existingByNameTag?.lastSyncedAt) {
    const ageMs = Date.now() - new Date(existingByNameTag.lastSyncedAt).getTime();
    if (ageMs < COOLDOWN_MS) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "synced recently",
        player: `${name}#${tag}`,
        lastSyncedAt: existingByNameTag.lastSyncedAt,
        cooldownMs: COOLDOWN_MS,
      });
    }
  }

  const base =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

  const qs = new URLSearchParams({
    region,
    name,
    tag,
    size: String(size),
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

  const puuid = playerData.puuid as string;

  const player = await prisma.player.upsert({
    where: { puuid },
    update: { name, tag },
    create: { puuid, name, tag },
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

    const p = m?.players?.all_players?.find((x: any) => x?.puuid === puuid);
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

  await prisma.player.update({
    where: { id: player.id },
    data: { lastSyncedAt: new Date() },
  });

  try {
    await invalidatePlayerMatches(name, tag);
  } catch (e) {
    console.warn("[redis] invalidatePlayerMatches failed:", e);
  }

  return NextResponse.json({
    ok: true,
    skipped: false,
    player: `${name}#${tag}`,
    size,
    matchesUpserted,
    playerMatchesUpserted,
  });
}
