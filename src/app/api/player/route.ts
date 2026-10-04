import type { NextRequest } from "next/server";
import { getAccount } from "@/lib/henrik";
import { jsonError, passThrough } from "@/lib/http";
import { nowMs } from "@/lib/metrics";
import { parseRiotId } from "@/lib/riot-id";

export const dynamic = "force-dynamic";

/** Player card and account level for a Riot ID. Cached in Redis; see CACHE_TTL_SECONDS. */
export async function GET(req: NextRequest) {
  const t0 = nowMs();
  const id = parseRiotId(req.nextUrl.searchParams);
  if (!id.ok) return jsonError(400, id.error);

  try {
    return passThrough(await getAccount(id.value.name, id.value.tag), t0);
  } catch (e) {
    console.error("[api/player]", e);
    return jsonError(500, "Unexpected server error");
  }
}
