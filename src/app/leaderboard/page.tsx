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

  const th = (sort?: LeaderboardSort) =>
    `px-3 py-2.5 font-semibold ${sort && sort === query.sort ? "text-accent" : ""}`;
  // The column the board is sorted by stands out; the rest stay quiet.
  const td = (sort?: LeaderboardSort) =>
    `px-3 py-3 tabular-nums ${sort && sort === query.sort ? "font-semibold text-slate-50" : "text-slate-300"}`;
  const medal = ["text-amber-300", "text-slate-300", "text-orange-400"];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="space-y-1 pt-4">
        <p className="eyebrow text-accent">Rankings</p>
        <h1 className="text-3xl font-bold tracking-tight text-slate-50">Leaderboard</h1>
        <p className="text-sm text-slate-400">
          Tracked players with at least {minimum}, ranked over their last 10.
        </p>
      </header>

      <nav aria-label="Sort by" className="inline-flex flex-wrap gap-1 rounded-xl border border-white/8 bg-ink-900 p-1">
        {(Object.keys(SORT_LABELS) as LeaderboardSort[]).map((sort) => (
          <Link
            key={sort}
            href={sortHref(sort)}
            aria-current={sort === query.sort ? "page" : undefined}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${
              sort === query.sort ? "bg-accent text-white" : "text-slate-400 hover:bg-white/6 hover:text-slate-100"
            }`}
          >
            {SORT_LABELS[sort]}
          </Link>
        ))}
      </nav>

      {unavailable && (
        <div role="alert" className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-200">
          The leaderboard is unavailable right now. Try again in a minute.
        </div>
      )}

      <div className="panel overflow-x-auto">
        <table className="min-w-full text-sm">
          <caption className="sr-only">Players ranked by {SORT_LABELS[query.sort]}</caption>
          <thead className="border-b border-white/8 text-left text-[11px] uppercase tracking-wider text-slate-400">
            <tr>
              <th scope="col" className={`${th()} w-12 text-center`}>#</th>
              <th scope="col" className={th()}>Player</th>
              <th scope="col" className={th("trackerScore")}>Tracker Score</th>
              <th scope="col" className={th("acs")}>ACS</th>
              <th scope="col" className={th("kd")}>K/D</th>
              <th scope="col" className={th("winRate")}>Win %</th>
              <th scope="col" className={th()}>HS%</th>
              <th scope="col" className={th()}>Record</th>
              <th scope="col" className={th()}>Last match</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/6">
            {entries.map((e, i) => (
              // Two rows can share a name once a player renames and someone else takes it.
              <tr key={`${i}:${e.name}#${e.tag}`} className="transition-colors hover:bg-white/4">
                <td className={`px-3 py-3 text-center font-mono font-bold tabular-nums ${medal[e.rank - 1] ?? "font-normal text-slate-500"}`}>
                  {e.rank}
                </td>
                <td className="px-3 py-3">
                  {e.linked ? (
                    <Link
                      href={`/player/${encodeURIComponent(e.name)}/${encodeURIComponent(e.tag)}`}
                      className="font-medium text-slate-100 hover:text-accent"
                    >
                      {e.name}
                      <span className="font-normal text-slate-500">#{e.tag}</span>
                    </Link>
                  ) : (
                    // Renamed away: their old Riot ID now opens someone else's profile.
                    <span className="text-slate-400" title="This player has since changed their Riot ID">
                      {e.name}
                      <span className="text-slate-600">#{e.tag}</span>
                    </span>
                  )}
                </td>
                <td className={td("trackerScore")}>
                  <div className="flex items-center gap-3">
                    <span className="w-7">{e.trackerScore}</span>
                    <div aria-hidden className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-white/8 sm:block">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${e.trackerScore}%` }} />
                    </div>
                  </div>
                </td>
                <td className={td("acs")}>{Math.round(e.acs)}</td>
                <td className={td("kd")}>{e.kd.toFixed(2)}</td>
                <td className={td("winRate")}>{Math.round(e.winRate)}%</td>
                <td className={td()}>{Math.round(e.headshotPct)}%</td>
                <td className={td()}>
                  <span className="text-win">{e.wins}</span>–<span className="text-loss">{e.losses}</span>
                  {e.draws ? `–${e.draws}` : ""}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-slate-400">
                  {e.lastMatchAt ? dateFormat.format(new Date(e.lastMatchAt)) : "—"}
                </td>
              </tr>
            ))}
            {entries.length === 0 && !unavailable && (
              <tr>
                <td className="px-4 py-10 text-center text-slate-400" colSpan={9}>
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
