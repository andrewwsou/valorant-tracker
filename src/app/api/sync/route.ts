import { NextResponse, type NextRequest } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { parseRiotId } from "@/lib/riot-id";
import { SYNC_COOLDOWN_MS, syncPlayer } from "@/services/sync";

export const dynamic = "force-dynamic";

/**
 * Pulls a player's recent competitive matches into Postgres. Only for the nightly
 * job: it needs `Authorization: Bearer <CRON_SECRET>`. Every JSON answer has an
 * `outcome` the job can act on.
 */
export async function POST(req: NextRequest) {
  // Checked first, so an unauthorized request costs nothing and learns nothing.
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const { searchParams } = req.nextUrl;
  const id = parseRiotId(searchParams);
  if (!id.ok) {
    return NextResponse.json({ outcome: "bad-request", error: id.error }, { status: 400 });
  }

  // HenrikDev's v4 match list returns at most 10. Anything that isn't a number means the default.
  const requested = Number.parseInt(searchParams.get("size") ?? "", 10);
  const size = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 10) : 10;
  const player = `${id.value.name}#${id.value.tag}`;
  const result = await syncPlayer(id.value, size);

  switch (result.status) {
    case "skipped":
      return NextResponse.json({
        outcome: "skipped",
        ok: true,
        skipped: true,
        reason: "synced recently",
        player,
        lastSyncedAt: result.lastSyncedAt,
        cooldownMs: SYNC_COOLDOWN_MS,
      });
    case "upstream-error":
      // HenrikDev's own answer, passed through with its status.
      return new NextResponse(result.body, {
        status: result.httpStatus,
        headers: {
          "content-type": result.contentType,
          ...(result.retryAfterSeconds ? { "retry-after": String(result.retryAfterSeconds) } : {}),
        },
      });
    case "no-matches":
      return NextResponse.json({ outcome: "no-matches", player, message: "No matches found" });
    case "invalid-payload":
      return NextResponse.json(
        { outcome: "invalid-payload", player, error: "HenrikDev sent match data this app couldn't read" },
        { status: 502 },
      );
    case "player-not-in-matches":
      return NextResponse.json(
        { outcome: "player-not-in-matches", player, error: "Could not resolve player puuid" },
        { status: 500 },
      );
    case "synced":
      return NextResponse.json({
        outcome: "synced",
        ok: true,
        skipped: false,
        player,
        size,
        matchesUpserted: result.matchesUpserted,
        playerMatchesUpserted: result.playerMatchesUpserted,
      });
  }
}
