import { NextResponse } from "next/server";
import type { CachedUpstreamResponse } from "@/lib/henrik";
import { msSince } from "@/lib/metrics";

/** Returns an upstream response unchanged, adding cache and timing headers. */
export function passThrough(res: CachedUpstreamResponse, t0: number) {
  return new NextResponse(res.body, {
    status: res.status,
    headers: {
      "content-type": res.contentType,
      "cache-control": "no-store",
      "x-cache": res.cache,
      "x-response-ms": String(msSince(t0)),
    },
  });
}

export function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}
