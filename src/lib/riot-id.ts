/** Regions the HenrikDev API accepts. */
export const REGIONS = ["na", "eu", "ap", "kr", "latam", "br"] as const;
export type Region = (typeof REGIONS)[number];

/** A Riot ID such as `TenZ#NA1`, plus the region to look it up in. */
export type RiotId = { region: Region; name: string; tag: string };

export type ParsedRiotId = { ok: true; value: RiotId } | { ok: false; error: string };

function isRegion(value: string): value is Region {
  return (REGIONS as readonly string[]).includes(value);
}

/**
 * Reads `region`, `name`, and `tag` from query parameters.
 *
 * Region defaults to "na" and must be one of {@link REGIONS}. Checking it here
 * stops callers from injecting extra path segments into upstream URLs.
 */
export function parseRiotId(params: URLSearchParams): ParsedRiotId {
  const region = (params.get("region") ?? "na").trim().toLowerCase();
  const name = (params.get("name") ?? "").trim();
  const tag = (params.get("tag") ?? "").trim();

  if (!name || !tag) return { ok: false, error: "Missing name or tag" };
  if (!isRegion(region)) {
    return { ok: false, error: `Unknown region. Use one of: ${REGIONS.join(", ")}` };
  }
  return { ok: true, value: { region, name, tag } };
}
