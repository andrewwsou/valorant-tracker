import { NextResponse, type NextRequest } from "next/server";
import { msSince, nowMs } from "@/lib/metrics";
import { getLeaderboard, parseLeaderboardQuery } from "@/services/leaderboard";

export const dynamic = "force-dynamic";

/** Top tracked players by tracker score, ACS, K/D, or win rate over their last 10 matches. */
export async function GET(req: NextRequest) {
  const t0 = nowMs();
  const query = parseLeaderboardQuery(req.nextUrl.searchParams);
  if (!query.ok) return NextResponse.json({ error: query.error }, { status: 400 });

  let entries;
  try {
    entries = await getLeaderboard(query.value);
  } catch (e) {
    console.error("[api/leaderboard]", e);
    return NextResponse.json({ error: "Leaderboard unavailable" }, { status: 503 });
  }
  return NextResponse.json(
    { ...query.value, entries },
    { headers: { "cache-control": "no-store", "x-response-ms": String(msSince(t0)) } },
  );
}
