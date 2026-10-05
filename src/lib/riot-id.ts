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
 * The key a Riot ID is stored and looked up under: "name#tag", Unicode-normalized
 * (NFC) and lowercased, because Riot IDs ignore case.
 */
export function riotIdKey(name: string, tag: string): string {
  return `${name.normalize("NFC").toLowerCase()}#${tag.normalize("NFC").toLowerCase()}`;
}

/**
 * A player's PUUID: Riot's permanent ID, which survives renames. Real ones are
 * UUIDs; tests use readable slugs. Restricted so it's safe in a URL path.
 */
export const PUUID_PATTERN = /^[0-9A-Za-z_-]{1,128}$/;

/** A player to sync by PUUID, plus the region to look them up in. */
export type PuuidTarget = { region: Region; puuid: string };

export type ParsedPuuid = { ok: true; value: PuuidTarget } | { ok: false; error: string };

/** Reads `region` and `puuid` from query parameters. */
export function parsePuuid(params: URLSearchParams): ParsedPuuid {
  const region = (params.get("region") ?? "na").trim().toLowerCase();
  const puuid = (params.get("puuid") ?? "").trim();
  if (!PUUID_PATTERN.test(puuid)) return { ok: false, error: "Invalid puuid" };
  if (!isRegion(region)) {
    return { ok: false, error: `Unknown region. Use one of: ${REGIONS.join(", ")}` };
  }
  return { ok: true, value: { region, puuid } };
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
