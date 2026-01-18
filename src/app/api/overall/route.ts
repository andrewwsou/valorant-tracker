import { NextRequest, NextResponse } from "next/server";
import { cacheGetJson, cacheSetJson } from "@/lib/redis";

export const dynamic = "force-dynamic";
const enc = encodeURIComponent;

type CachedResp = { status: number; contentType: string; body: string };

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    const region = (searchParams.get("region") ?? "na").trim();
    const name = (searchParams.get("name") ?? "").trim();
    const tag = (searchParams.get("tag") ?? "").trim();

    if (!name || !tag) {
      return NextResponse.json({ error: "Missing name or tag" }, { status: 400 });
    }

    const key = `overall:v1:${region}:${name.toLowerCase()}:${tag.toLowerCase()}`;

    try {
      const cached = await cacheGetJson<CachedResp>(key);
      if (cached) {
        return new NextResponse(cached.body, {
          status: cached.status,
          headers: {
            "content-type": cached.contentType,
            "cache-control": "no-store",
            "x-cache": "HIT",
          },
        });
      }
    } catch (e) {
      console.warn("[redis] overall cache get failed:", e);
    }

    const api_call =
      `https://api.henrikdev.xyz/valorant/v2/mmr/` +
      `${region}/${enc(name)}/${enc(tag)}`;

    const r = await fetch(api_call, {
      headers: { Authorization: process.env.HENRIKDEV_API_KEY as string },
      cache: "no-store",
    });

    const text = await r.text();
    const contentType = r.headers.get("content-type") ?? "application/json";

    const payload: CachedResp = { status: r.status, contentType, body: text };

    try {
      if (r.ok) await cacheSetJson(key, payload, 60);
    } catch (e) {
      console.warn("[redis] overall cache set failed:", e);
    }

    return new NextResponse(text, {
      status: r.status,
      headers: {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-cache": "MISS",
      },
    });
  } catch {
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
