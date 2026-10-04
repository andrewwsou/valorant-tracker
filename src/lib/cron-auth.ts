import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/** Shortest secret accepted. `openssl rand -hex 32` gives 64 characters. */
export const MIN_SECRET_LENGTH = 32;

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const NO_STORE = { "cache-control": "no-store" };

/**
 * Guards endpoints only the nightly job may call, such as POST /api/sync: they
 * spend the shared HenrikDev budget, so the public internet mustn't trigger them.
 * The profile page syncs in-process and is unaffected.
 *
 * Returns the response to send when the request isn't allowed, or null when it is.
 * Without a configured secret the endpoint stays closed (fail closed).
 */
export function requireCronSecret(req: Request): NextResponse | null {
  // Read on every request, so a secret added to the deployment takes effect on restart.
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    console.error(`[auth] CRON_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters, so sync endpoints are closed`);
    return NextResponse.json(
      { outcome: "not-configured", error: "Sync is not configured on this server" },
      { status: 503, headers: NO_STORE },
    );
  }

  const token = /^Bearer +(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  // Comparing hashes gives equal lengths, so the comparison never throws and the
  // time it takes doesn't reveal how much of the secret matched, or its length.
  if (!timingSafeEqual(sha256(token), sha256(secret))) {
    return NextResponse.json(
      { outcome: "unauthorized", error: "Missing or wrong bearer token" },
      { status: 401, headers: { ...NO_STORE, "www-authenticate": 'Bearer realm="sync"' } },
    );
  }
  return null;
}
