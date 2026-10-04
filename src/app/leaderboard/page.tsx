import type { Metadata } from "next";
import Link from "next/link";
import {
  getLeaderboard,
  LEADERBOARD_DEFAULTS,
  parseLeaderboardQuery,
  type LeaderboardSort,
} from "@/services/leaderboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Leaderboard",
  description: "Tracked VALORANT players ranked by tracker score, ACS, K/D, or win rate over their last 10 matches.",
};

const SORT_LABELS: Record<LeaderboardSort, string> = {
  trackerScore: "Tracker Score",
  acs: "ACS",
  kd: "K/D",
  winRate: "Win %",
};

const dateFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium" });

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LeaderboardPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) if (typeof value === "string") params.set(key, value);

  // Bad query values fall back to the defaults instead of an error page.
  const parsed = parseLeaderboardQuery(params);
  const query = parsed.ok ? parsed.value : LEADERBOARD_DEFAULTS;

  // A database outage shows a message inside the normal layout, like the profile page does.
  let entries: Awaited<ReturnType<typeof getLeaderboard>> = [];
  let unavailable = false;
  try {
    entries = await getLeaderboard(query);
  } catch (e) {
    console.error("[leaderboard] loading failed:", e);
    unavailable = true;
  }

  // Sort links keep the other options the visitor chose.
  const sortHref = (sort: LeaderboardSort) => {
    const next = new URLSearchParams({ sort });
    if (query.minMatches !== LEADERBOARD_DEFAULTS.minMatches) next.set("minMatches", String(query.minMatches));
    if (query.limit !== LEADERBOARD_DEFAULTS.limit) next.set("limit", String(query.limit));
    return `/leaderboard?${next}`;
  };
  const minimum = `${query.minMatches} recent ${query.minMatches === 1 ? "match" : "matches"}`;

  return (
    <main className="mx-auto w-full max-w-5xl p-6 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-100">Leaderboard</h1>
        <p className="text-sm text-slate-400">
          Tracked players with at least {minimum}, ranked over their last 10.
        </p>
      </header>

      <nav aria-label="Sort by" className="flex flex-wrap gap-2">
        {(Object.keys(SORT_LABELS) as LeaderboardSort[]).map((sort) => (
          <Link
            key={sort}
            href={sortHref(sort)}
            aria-current={sort === query.sort ? "page" : undefined}
            className={`rounded px-3 py-1 text-sm ${
              sort === query.sort ? "bg-slate-200 text-slate-900" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {SORT_LABELS[sort]}
          </Link>
        ))}
      </nav>

      {unavailable && (
        <div role="alert" className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-800">
          The leaderboard is unavailable right now. Try again in a minute.
        </div>
      )}

      <div className="overflow-x-auto rounded border border-slate-700">
        <table className="min-w-full text-sm">
          <caption className="sr-only">Players ranked by {SORT_LABELS[query.sort]}</caption>
          <thead className="bg-[#2b3d50] text-left text-gray-300">
            <tr>
              <th scope="col" className="px-3 py-2">#</th>
              <th scope="col" className="px-3 py-2">Player</th>
              <th scope="col" className="px-3 py-2">Tracker Score</th>
              <th scope="col" className="px-3 py-2">ACS</th>
              <th scope="col" className="px-3 py-2">K/D</th>
              <th scope="col" className="px-3 py-2">Win %</th>
              <th scope="col" className="px-3 py-2">HS%</th>
              <th scope="col" className="px-3 py-2">Record</th>
              <th scope="col" className="px-3 py-2">Last match</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={`${e.name}#${e.tag}`} className="border-t border-slate-700">
                <td className="px-3 py-2 tabular-nums">{e.rank}</td>
                <td className="px-3 py-2">
                  <Link
                    href={`/player/${encodeURIComponent(e.name)}/${encodeURIComponent(e.tag)}`}
                    className="text-slate-100 hover:underline"
                  >
                    {e.name}
                    <span className="text-slate-400">#{e.tag}</span>
                  </Link>
                </td>
                <td className="px-3 py-2 tabular-nums">{e.trackerScore}</td>
                <td className="px-3 py-2 tabular-nums">{Math.round(e.acs)}</td>
                <td className="px-3 py-2 tabular-nums">{e.kd.toFixed(2)}</td>
                <td className="px-3 py-2 tabular-nums">{Math.round(e.winRate)}%</td>
                <td className="px-3 py-2 tabular-nums">{Math.round(e.headshotPct)}%</td>
                <td className="px-3 py-2 tabular-nums">
                  {e.wins}–{e.losses}
                  {e.draws ? `–${e.draws}` : ""}
                </td>
                <td className="px-3 py-2">{e.lastMatchAt ? dateFormat.format(new Date(e.lastMatchAt)) : "—"}</td>
              </tr>
            ))}
            {entries.length === 0 && !unavailable && (
              <tr>
                <td className="px-3 py-6 text-gray-400" colSpan={9}>
                  No players with at least {minimum} yet. Look up a player to add them.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
