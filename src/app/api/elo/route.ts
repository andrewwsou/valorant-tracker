import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
const enc = encodeURIComponent;

export async function GET(req: NextRequest) {
  try {
    
    const { searchParams } = new URL(req.url);

    const region = (searchParams.get('region') ?? 'na').trim();
    const name   = (searchParams.get('name') ?? '').trim();
    const tag    = (searchParams.get('tag') ?? '').trim();

    if (!name || !tag) {
      return NextResponse.json({ error: 'Missing name or tag' }, { status: 400 });
    }

    const api_call =
      `https://api.henrikdev.xyz/valorant/v1/mmr-history/` +
      `${region}/${enc(name)}/${enc(tag)}`;

    const r = await fetch(api_call, {
      headers: {
        Authorization: process.env.HENRIKDEV_API_KEY as string,
      },
      cache: 'no-store',
    });

    const text = await r.text();
    const contentType = r.headers.get('content-type') ?? 'application/json';

    const preview = text.slice(0, 10000);
    console.log('[matches] upstream status/content-type:', r.status, contentType);
    console.log('[matches] upstream body (preview 400):', preview);

    return new NextResponse(text, {
      status: r.status,
      headers: { 'content-type': contentType, 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'Unexpected server error' }, { status: 500 });
  }
}
