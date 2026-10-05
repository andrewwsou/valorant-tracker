-- Players are identified by PUUID. The Riot ID becomes a case-insensitive lookup
-- key that can move from one row to another when players rename.
ALTER TABLE "Player" ADD COLUMN "riotIdKey" TEXT;

-- Backfill. The old unique index was case-sensitive, so rows differing only in case
-- can exist. Each lowercased Riot ID goes to one row: one with a PUUID first, then
-- the most recently synced. Nothing is deleted; the other rows keep their matches
-- and last known name, with no key, like any player who renamed away.
--
-- Only plain-ASCII Riot IDs are keyed here: for those, Postgres lower() and the app's
-- JavaScript toLowerCase() agree. A few non-ASCII letters (such as a final sigma) don't,
-- so those rows start with no key, and the app sets it on their next sync.
WITH ranked AS (
  SELECT id,
         lower(name) || '#' || lower(tag) AS k,
         row_number() OVER (
           PARTITION BY lower(name), lower(tag)
           ORDER BY (puuid IS NULL), "lastSyncedAt" DESC NULLS LAST, id
         ) AS rn
  FROM "Player"
  WHERE name ~ '^[ -~]+$' AND tag ~ '^[ -~]+$'
)
UPDATE "Player" p SET "riotIdKey" = r.k FROM ranked r WHERE p.id = r.id AND r.rn = 1;

CREATE UNIQUE INDEX "Player_riotIdKey_key" ON "Player"("riotIdKey");

-- Case-sensitive, and it made a rename fail when a stale row still held the new name.
DROP INDEX "Player_name_tag_key";
