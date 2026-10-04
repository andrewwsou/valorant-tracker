/**
 * zod schemas for the parts of HenrikDev's responses the app reads.
 *
 * HenrikDev is unofficial and third-party, so its payloads are checked before
 * use. Identity fields (match id, PUUID) are strict: without them an item can't
 * be stored, so the item is dropped. Every other field falls back to null and is
 * counted, so one odd value never discards a match, and an upstream rename shows
 * up as a metric instead of as silent nulls. Unknown keys are ignored.
 *
 * Checked against real responses for all four endpoints (0 fallbacks) and
 * against the official OpenAPI spec (v4.6.0).
 */
import { trace } from "@opentelemetry/api";
import * as z from "zod";
import { upstreamFieldFallbacks, upstreamInvalidPayloads } from "@/lib/telemetry";

/* ------------------------------------------------------------------------ */
/* Lenient fields                                                           */
/* ------------------------------------------------------------------------ */

export type FallbackReason = "missing" | "null" | "invalid";

// safeParse is synchronous, so one module-level tally, swapped in around each parse
// by withTally(), is safe. Never use parseAsync with these schemas.
let tally: Map<string, number> | null = null;
const add = (key: string, n: number) => {
  if (tally) tally.set(key, (tally.get(key) ?? 0) + n);
};
const bump = (label: string, reason: FallbackReason) => add(`${label}|${reason}`, 1);
const reasonFor = (v: unknown): FallbackReason => (v === undefined ? "missing" : v === null ? "null" : "invalid");

/**
 * A field that never fails its parent: anything `schema` rejects becomes null and
 * is counted under `label`, a fixed string that's safe as a metric attribute.
 * A JSON null passes silently only where the spec allows it (`nullable`).
 */
function lenient<T extends z.ZodType>(schema: T, label: string, opts: { nullable?: boolean } = {}) {
  // The catch must be the outermost wrapper: zod only runs a missing key through it.
  return schema
    .nullable()
    .refine((v) => opts.nullable || v !== null)
    .catch((ctx) => {
      bump(label, reasonFor(ctx.value));
      return null;
    });
}

/**
 * An array where a bad element is dropped and counted, never the whole array.
 * A dropped element's own field fallbacks aren't counted: it was thrown away.
 */
function lenientArray<T extends z.ZodType>(item: T, label: string) {
  return z
    .array(z.unknown())
    .transform((values) => {
      const kept: z.output<T>[] = [];
      for (const value of values) {
        const { value: result, fallbacks } = withTally(() => item.safeParse(value));
        if (result.success) {
          kept.push(result.data);
          for (const [key, n] of Object.entries(fallbacks)) add(key, n);
        } else {
          bump(`${label}[]`, "invalid");
        }
      }
      return kept;
    })
    .catch((ctx): z.output<T>[] => {
      bump(label, reasonFor(ctx.value));
      return [];
    });
}

/** Identity: required, non-empty, bounded. Not z.uuid(): PUUIDs aren't UUIDs, and test data uses slugs. */
const Id = z.string().min(1).max(128);
const text = (label: string, nullable = false) => lenient(z.string().min(1), label, { nullable });
/** Finite, truncated toward zero, and fits a Postgres INT. */
const int = (label: string) => lenient(z.number().transform(Math.trunc).pipe(z.int32()), label);
/**
 * Only https URLs on media.valorant-api.com, the one host next/image is allowed to
 * load (next.config.ts). Any other URL would make the page throw, so it becomes null.
 */
const imageUrl = (label: string) =>
  lenient(z.url({ protocol: /^https$/, hostname: /^media\.valorant-api\.com$/ }), label);
/**
 * Valorant content IDs look like UUIDs but aren't RFC 9562 ones (Jett's has version
 * digit "e"), so z.uuid() rejects real agents. z.guid() checks only the hex shape.
 */
const contentId = (label: string) => lenient(z.guid().transform((s) => s.toLowerCase()), label);

/* ------------------------------------------------------------------------ */
/* GET /v4/matches: one item of `data`                                      */
/* ------------------------------------------------------------------------ */

const PlayerStats = z.object({
  kills: int("matches.player.stats.kills"),
  deaths: int("matches.player.stats.deaths"),
  assists: int("matches.player.stats.assists"),
  score: int("matches.player.stats.score"),
  headshots: int("matches.player.stats.headshots"),
  bodyshots: int("matches.player.stats.bodyshots"),
  legshots: int("matches.player.stats.legshots"),
  damage: lenient(z.object({ dealt: int("matches.player.stats.damage.dealt") }), "matches.player.stats.damage"),
});

const MatchPlayer = z.object({
  // A player we can't key is dropped from the list; the match stays.
  puuid: Id,
  name: text("matches.player.name"),
  tag: text("matches.player.tag"),
  team_id: text("matches.player.team_id"),
  agent: lenient(z.object({ id: contentId("matches.player.agent.id") }), "matches.player.agent"),
  stats: lenient(PlayerStats, "matches.player.stats"),
});

const MatchTeam = z.object({
  // A team we can't name can't be matched to a side, so it's dropped.
  team_id: Id,
  rounds: lenient(z.object({ won: int("matches.team.rounds.won") }), "matches.team.rounds"),
});

export const MatchV4 = z.object({
  metadata: z.object({
    match_id: Id,
    map: lenient(z.object({ name: text("matches.metadata.map.name") }), "matches.metadata.map"),
    queue: lenient(
      z.object({ id: text("matches.metadata.queue.id"), name: text("matches.metadata.queue.name", true) }),
      "matches.metadata.queue",
    ),
    /** ISO 8601, such as "2026-09-30T19:24:10.94Z". Kept as epoch ms. */
    started_at: lenient(
      z.string().transform((s) => Date.parse(s)).pipe(z.number().positive()),
      "matches.metadata.started_at",
    ),
  }),
  players: lenientArray(MatchPlayer, "matches.players"),
  teams: lenientArray(MatchTeam, "matches.teams"),
});

export type HenrikMatch = z.output<typeof MatchV4>;
export type HenrikPlayer = z.output<typeof MatchPlayer>;

/* ------------------------------------------------------------------------ */
/* Profile endpoints                                                        */
/* ------------------------------------------------------------------------ */

/** `data` from GET /v1/account. */
export const AccountV1 = z.object({
  card: lenient(z.object({ small: imageUrl("account.card.small") }), "account.card"),
});

/** `data` from GET /v2/mmr. */
export const MmrV2 = z.object({
  current_data: lenient(
    z.object({
      currenttierpatched: text("mmr.current_data.currenttierpatched"),
      images: lenient(z.object({ small: imageUrl("mmr.current_data.images.small") }), "mmr.current_data.images"),
    }),
    "mmr.current_data",
  ),
  highest_rank: lenient(z.object({ patched_tier: text("mmr.highest_rank.patched_tier") }), "mmr.highest_rank"),
});

/** One item of `data` from GET /v1/mmr-history. An entry without a match ID can't be shown, so it's dropped. */
export const MmrHistoryEntryV1 = z.object({
  match_id: Id,
  images: lenient(z.object({ small: imageUrl("mmr_history.images.small") }), "mmr_history.images"),
});

export type HenrikAccount = z.output<typeof AccountV1>;
export type HenrikMmr = z.output<typeof MmrV2>;
export type HenrikMmrHistoryEntry = z.output<typeof MmrHistoryEntryV1>;

/* ------------------------------------------------------------------------ */
/* Parsing a response body                                                  */
/* ------------------------------------------------------------------------ */

export type ValidatedEndpoint = "account" | "mmr" | "mmr-history" | "matches";

export type ParseReport = {
  endpoint: ValidatedEndpoint;
  /** Items kept and dropped. Single-object endpoints count as one item. */
  kept: number;
  rejected: number;
  /** The body wasn't JSON, or `data` wasn't the expected array or object. */
  envelopeInvalid: boolean;
  /** "field|reason" -> count, from the items that were kept. */
  fallbacks: Record<string, number>;
  /** The first few problems: path and code only, never the value. */
  issues: { item?: number; path: string; code: string }[];
};

function summarize(error: z.ZodError, item?: number) {
  return error.issues.slice(0, 3).map((issue) => ({
    ...(item === undefined ? {} : { item }),
    path: z.core.toDotPath(issue.path).replace(/\[\d+\]/g, "[]"),
    code: issue.code,
  }));
}

function withTally<T>(fn: () => T): { value: T; fallbacks: Record<string, number> } {
  const previous = tally;
  const mine = new Map<string, number>();
  tally = mine;
  try {
    return { value: fn(), fallbacks: Object.fromEntries(mine) };
  } finally {
    tally = previous;
  }
}

/** `data` from a `{ data: ... }` body, or undefined if the body isn't JSON. */
function dataOf(body: string): unknown {
  try {
    return (JSON.parse(body) as { data?: unknown } | null)?.data;
  } catch {
    return undefined;
  }
}

const emptyReport = (endpoint: ValidatedEndpoint): ParseReport => ({
  endpoint,
  kept: 0,
  rejected: 0,
  envelopeInvalid: false,
  fallbacks: {},
  issues: [],
});

/** `{ data: [...] }`. Items are checked one at a time, so a bad one is skipped, not fatal. */
export function parseListBody<S extends z.ZodType>(endpoint: ValidatedEndpoint, body: string, item: S) {
  const report = emptyReport(endpoint);
  const data = dataOf(body);
  if (!Array.isArray(data)) {
    report.envelopeInvalid = true;
    return { items: null, report };
  }
  const items: z.output<S>[] = [];
  const fallbacks = new Map<string, number>();
  data.forEach((raw, index) => {
    // Tallied per item, so the fallbacks of a dropped item aren't counted.
    const { value: result, fallbacks: own } = withTally(() => item.safeParse(raw));
    if (result.success) {
      items.push(result.data);
      report.kept++;
      for (const [key, n] of Object.entries(own)) fallbacks.set(key, (fallbacks.get(key) ?? 0) + n);
    } else {
      report.rejected++;
      if (report.issues.length < 9) report.issues.push(...summarize(result.error, index));
    }
  });
  report.fallbacks = Object.fromEntries(fallbacks);
  return { items, report };
}

/** `{ data: {...} }`. Only a missing or non-object `data` fails; fields inside fall back on their own. */
export function parseObjectBody<S extends z.ZodType>(endpoint: ValidatedEndpoint, body: string, schema: S) {
  const report = emptyReport(endpoint);
  const data = dataOf(body);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    report.envelopeInvalid = true;
    return { data: null, report };
  }
  const { value: result, fallbacks } = withTally(() => schema.safeParse(data));
  report.fallbacks = fallbacks;
  if (!result.success) {
    report.rejected = 1;
    report.issues = summarize(result.error);
    return { data: null, report };
  }
  report.kept = 1;
  return { data: result.data as z.output<S>, report };
}

/**
 * Records what a parse found: metrics always, span attributes on the active span,
 * and one warning line when something was dropped. Never logs values.
 */
export function reportValidation(report: ParseReport) {
  const { endpoint } = report;
  if (report.envelopeInvalid) upstreamInvalidPayloads.add(1, { endpoint, kind: "envelope" });
  if (report.rejected > 0) upstreamInvalidPayloads.add(report.rejected, { endpoint, kind: "item" });
  for (const [key, count] of Object.entries(report.fallbacks)) {
    const [field, reason] = key.split("|");
    upstreamFieldFallbacks.add(count, { endpoint, field, reason });
  }

  // Named per endpoint: the profile span validates three endpoints in a row.
  trace.getActiveSpan()?.setAttributes({
    [`henrik.validation.${endpoint}.kept`]: report.kept,
    [`henrik.validation.${endpoint}.rejected`]: report.rejected,
    [`henrik.validation.${endpoint}.envelope_invalid`]: report.envelopeInvalid,
  });

  if (report.envelopeInvalid || report.rejected > 0) {
    const problems = report.issues.map((i) => `${i.item === undefined ? "" : `#${i.item} `}${i.path}: ${i.code}`);
    console.warn(
      report.envelopeInvalid
        ? `[henrik] ${endpoint} response had no readable data`
        : `[henrik] ${endpoint}: dropped ${report.rejected} of ${report.kept + report.rejected} items (${problems.join("; ")})`,
    );
  }
}
