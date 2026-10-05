import { describe, expect, it } from "vitest";
import { parsePuuid, parseRiotId, riotIdKey } from "@/lib/riot-id";

const parse = (query: string) => parseRiotId(new URLSearchParams(query));

describe("parseRiotId", () => {
  it("reads region, name, and tag", () => {
    expect(parse("region=eu&name=Alpha&tag=EU1")).toEqual({
      ok: true,
      value: { region: "eu", name: "Alpha", tag: "EU1" },
    });
  });

  it("defaults to na, trims whitespace, and ignores region case", () => {
    expect(parse("name=%20enzo%20&tag=yyy")).toEqual({ ok: true, value: { region: "na", name: "enzo", tag: "yyy" } });
    expect(parse("region=KR&name=a&tag=b")).toMatchObject({ ok: true, value: { region: "kr" } });
  });

  it("rejects a missing name or tag", () => {
    expect(parse("name=enzo")).toEqual({ ok: false, error: "Missing name or tag" });
    expect(parse("tag=yyy")).toEqual({ ok: false, error: "Missing name or tag" });
  });

  it("rejects regions outside the allowlist, including path tricks", () => {
    for (const region of ["xx", "na/../v1", "na%2F..%2Fv1"]) {
      expect(parse(`region=${region}&name=a&tag=b`).ok).toBe(false);
    }
  });
});

describe("riotIdKey", () => {
  it("is the same for any capitalization", () => {
    expect(riotIdKey("TenZ", "NA1")).toBe("tenz#na1");
    expect(riotIdKey("tENZ", "na1")).toBe(riotIdKey("TenZ", "NA1"));
  });

  it("treats the two ways of writing an accented letter as the same name", () => {
    // "é" as one character, and as "e" plus a combining accent.
    expect(riotIdKey("Caf\u00e9", "EU1")).toBe(riotIdKey("Cafe\u0301", "EU1"));
  });
});

describe("parsePuuid", () => {
  const parse = (query: string) => parsePuuid(new URLSearchParams(query));

  it("reads a PUUID and region", () => {
    expect(parse("puuid=54942ced-1967-5f66-8a16-1e0dae875641&region=EU")).toEqual({
      ok: true,
      value: { region: "eu", puuid: "54942ced-1967-5f66-8a16-1e0dae875641" },
    });
  });

  it("rejects anything that could change the upstream URL", () => {
    for (const puuid of ["", "a/b", "../v1", "a b", "a%2Fb", "x".repeat(129)]) {
      expect(parse(`puuid=${encodeURIComponent(puuid)}`).ok, puuid).toBe(false);
    }
    expect(parse("puuid=abc&region=xx").ok).toBe(false);
  });
});
