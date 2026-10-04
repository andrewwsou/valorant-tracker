import type { NextRequest } from "next/server";
import { getMmrHistory } from "@/lib/henrik";
import { jsonError, passThrough } from "@/lib/http";
import { nowMs } from "@/lib/metrics";
import { parseRiotId } from "@/lib/riot-id";

export const dynamic = "force-dynamic";

/** Rank change for each recent competitive match. Cached in Redis; see CACHE_TTL_SECONDS. */
export async function GET(req: NextRequest) {
  const t0 = nowMs();
  const id = parseRiotId(req.nextUrl.searchParams);
  if (!id.ok) return jsonError(400, id.error);

  try {
    return passThrough(await getMmrHistory(id.value.region, id.value.name, id.value.tag), t0);
  } catch (e) {
    console.error("[api/elo]", e);
    return jsonError(500, "Unexpected server error");
  }
}
