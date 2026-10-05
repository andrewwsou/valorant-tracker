import { NextResponse, type NextRequest } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { parsePuuid, parseRiotId } from "@/lib/riot-id";
import { SYNC_COOLDOWN_MS, SYNC_WAIT_MS, syncPlayer, type SyncTarget } from "@/services/sync";

export const dynamic = "force-dynamic";

/**
 * Pulls a player's recent competitive matches into Postgres. Only for the nightly
 * job: it needs `Authorization: Bearer <CRON_SECRET>`. Every JSON answer has an
 * `outcome` the job can act on.
 *
 * A player is named by `puuid` (survives renames; must already be tracked) or by
 * `name` and `tag`.
 */
export async function POST(req: NextRequest) {
  // Checked first, so an unauthorized request costs nothing and learns nothing.
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const { searchParams } = req.nextUrl;
  const id = searchParams.has("puuid") ? parsePuuid(searchParams) : parseRiotId(searchParams);
  if (!id.ok) {
    return NextResponse.json({ outcome: "bad-request", error: id.error }, { status: 400 });
  }
  const target: SyncTarget = id.value;

  // HenrikDev's v4 match list returns at most 10. Anything that isn't a number means the default.
  const requested = Number.parseInt(searchParams.get("size") ?? "", 10);
  const size = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 10) : 10;
  // Until a sync names the player, a PUUID is shown by its start.
  const asked = "puuid" in target ? `puuid:${target.puuid.slice(0, 8)}` : `${target.name}#${target.tag}`;
  const result = await syncPlayer(target, size);
  const player = "player" in result ? result.player : asked;

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
      // HenrikDev refusing the app's API key isn't the caller's fault: a 401 here would
      // look like a wrong CRON_SECRET, so it's reported as a bad gateway instead.
      if (result.httpStatus === 401 || result.httpStatus === 403) {
        return NextResponse.json(
          { outcome: "upstream-auth", player, error: `HenrikDev refused the app's API key (HTTP ${result.httpStatus})` },
          { status: 502 },
        );
      }
      // Anything else from HenrikDev is passed through with its status.
      return new NextResponse(result.body, {
        status: result.httpStatus,
        headers: {
          "content-type": result.contentType,
          ...(result.retryAfterSeconds ? { "retry-after": String(result.retryAfterSeconds) } : {}),
        },
      });
    case "in-progress":
      return NextResponse.json(
        { outcome: "in-progress", player, error: "Another sync of this player is still running" },
        { status: 409, headers: { "retry-after": String(SYNC_WAIT_MS / 1000) } },
      );
    case "not-tracked":
      return NextResponse.json(
        { outcome: "not-tracked", player, error: "No tracked player has this PUUID. Open their profile first." },
        { status: 404 },
      );
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
