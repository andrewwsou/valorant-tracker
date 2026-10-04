import { describe, expect, it } from "vitest";
import { parseRiotId } from "@/lib/riot-id";

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
