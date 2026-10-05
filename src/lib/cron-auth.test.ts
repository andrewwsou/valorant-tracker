import { describe, expect, it, vi } from "vitest";
import { requireCronSecret } from "@/lib/cron-auth";

const SECRET = "s".repeat(64);

const request = (authorization?: string) =>
  new Request("http://localhost/api/sync", { method: "POST", headers: authorization ? { authorization } : {} });

describe("requireCronSecret", () => {
  it("keeps the endpoint closed when no secret, or too short a secret, is configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const secret of ["", "short"]) {
      vi.stubEnv("CRON_SECRET", secret);
      const res = requireCronSecret(request(`Bearer ${secret}`));
      expect(res?.status, JSON.stringify(secret)).toBe(503);
      expect(await res!.json()).toMatchObject({ outcome: "not-configured" });
    }
  });

  it("refuses a missing, malformed, or wrong token, without throwing", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const header of [undefined, SECRET, `Basic ${SECRET}`, "Bearer wrong", `Bearer ${SECRET}x`, "Bearer ", `Bearer ${SECRET.slice(0, 10)}`]) {
      const res = requireCronSecret(request(header));
      expect(res?.status, String(header)).toBe(401);
      expect(res!.headers.get("www-authenticate")).toBe('Bearer realm="sync"');
      expect(res!.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("lets the right token through, whatever the scheme's capitalization", () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(requireCronSecret(request(`Bearer ${SECRET}`))).toBeNull();
    expect(requireCronSecret(request(`bearer ${SECRET}`))).toBeNull();
  });

  it("ignores whitespace pasted around the configured secret", () => {
    vi.stubEnv("CRON_SECRET", `  ${SECRET}\n`);
    expect(requireCronSecret(request(`Bearer ${SECRET}`))).toBeNull();
  });

  it("reads the secret on every request", () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(requireCronSecret(request(`Bearer ${SECRET}`))).toBeNull();
    vi.stubEnv("CRON_SECRET", "t".repeat(64));
    expect(requireCronSecret(request(`Bearer ${SECRET}`))?.status).toBe(401);
  });
});
