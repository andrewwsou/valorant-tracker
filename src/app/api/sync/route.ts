import { NextResponse, type NextRequest } from "next/server";
import { parseRiotId } from "@/lib/riot-id";
import { SYNC_COOLDOWN_MS, syncPlayer } from "@/services/sync";

export const dynamic = "force-dynamic";

/** Pulls a player's recent competitive matches into Postgres. */
export async function POST(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const id = parseRiotId(searchParams);
  if (!id.ok) {
    return NextResponse.json({ error: id.error }, { status: 400 });
  }

  // HenrikDev's v4 match list returns at most 10. Anything that isn't a number means the default.
  const requested = Number.parseInt(searchParams.get("size") ?? "", 10);
  const size = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 10) : 10;
  const player = `${id.value.name}#${id.value.tag}`;
  const result = await syncPlayer(id.value, size);

  switch (result.status) {
    case "skipped":
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "synced recently",
        player,
        lastSyncedAt: result.lastSyncedAt,
        cooldownMs: SYNC_COOLDOWN_MS,
      });
    case "upstream-error":
      return new NextResponse(result.body, {
        status: result.httpStatus,
        headers: {
          "content-type": result.contentType,
          ...(result.retryAfterSeconds ? { "retry-after": String(result.retryAfterSeconds) } : {}),
        },
      });
    case "no-matches":
      return NextResponse.json({ message: "No matches found" });
    case "invalid-payload":
      return NextResponse.json({ error: "HenrikDev sent match data this app couldn't read" }, { status: 502 });
    case "player-not-in-matches":
      return NextResponse.json({ error: "Could not resolve player puuid" }, { status: 500 });
    case "synced":
      return NextResponse.json({
        ok: true,
        skipped: false,
        player,
        size,
        matchesUpserted: result.matchesUpserted,
        playerMatchesUpserted: result.playerMatchesUpserted,
      });
  }
}
