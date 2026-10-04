import { NextResponse, type NextRequest } from "next/server";
import { msSince, nowMs } from "@/lib/metrics";
import { getRecentMatches } from "@/services/matches";

export const dynamic = "force-dynamic";

function headers(t0: number, cache: "HIT" | "MISS") {
  return {
    "x-cache": cache,
    "x-response-ms": String(msSince(t0)),
    "cache-control": "no-store",
  };
}

/** A player's recent matches from Postgres. Cached for 60 seconds; a sync clears it. */
export async function GET(req: NextRequest) {
  const t0 = nowMs();
  const { searchParams } = req.nextUrl;
  const name = (searchParams.get("name") ?? "").trim();
  const tag = (searchParams.get("tag") ?? "").trim();
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "10", 10) || 10, 25);

  if (!name || !tag) {
    return NextResponse.json({ error: "Missing name or tag" }, { status: 400, headers: headers(t0, "MISS") });
  }

  const result = await getRecentMatches(name, tag, limit);
  return NextResponse.json(result, { headers: headers(t0, result.cache) });
}
