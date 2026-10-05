import Link from "next/link";
import PlayerSearch from "@/components/player_search_input";
import { getLeaderboard, LEADERBOARD_DEFAULTS, type LeaderboardEntry } from "@/services/leaderboard";

// The top-players strip reads the database, so the page is rendered per request.
export const dynamic = "force-dynamic";

const FEATURES = [
  { title: "Rank and peak", body: "Current competitive rank and the highest rank a player has reached." },
  { title: "Last 10 matches", body: "Score, K/D/A, ACS, ADR, and headshot rate for every recent competitive game." },
  { title: "Tracker Score", body: "One 0 to 100 number that blends winning with K/D and combat score." },
];

export default async function Home() {
  // The strip is a bonus: without the database, the search box still works.
  let top: LeaderboardEntry[] = [];
  try {
    top = await getLeaderboard({ ...LEADERBOARD_DEFAULTS, limit: 5 });
  } catch (e) {
    console.error("[home] loading top players failed:", e);
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center px-4 pb-16 pt-16 sm:pt-24">
      <p className="eyebrow text-accent">Competitive stats, NA region</p>
      <h1 className="mt-3 text-center text-4xl font-bold tracking-tight text-slate-50 sm:text-5xl">
        Look up any VALORANT player
      </h1>
      <p className="mt-4 max-w-xl text-center text-slate-400">
        Enter a Riot ID to see rank, recent matches, and how a player has really been performing.
      </p>

      <div className="mt-8 w-full">
        <PlayerSearch />
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Tip: paste a full Riot ID like <span className="font-mono text-slate-400">TenZ#NA1</span> into the first box.
      </p>

      {top.length > 0 && (
        <section aria-labelledby="top-players" className="mt-14 w-full">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 id="top-players" className="eyebrow">Top tracked players</h2>
            <Link href="/leaderboard" className="text-sm text-slate-400 hover:text-slate-100">
              Full leaderboard →
            </Link>
          </div>
          <ol className="panel divide-y divide-white/6 overflow-hidden">
            {top.map((p, i) => {
              const row = (
                <>
                  <span className="w-6 text-center font-mono text-sm text-slate-500">{p.rank}</span>
                  <span className="flex-1 truncate font-medium text-slate-100">
                    {p.name}
                    <span className="text-slate-500">#{p.tag}</span>
                  </span>
                  <span className="hidden text-sm tabular-nums text-slate-400 sm:block">
                    {p.wins}–{p.losses} · {p.kd.toFixed(2)} K/D
                  </span>
                  <span className="w-12 text-right text-lg font-bold tabular-nums text-slate-50">{p.trackerScore}</span>
                </>
              );
              return (
                <li key={`${i}:${p.name}#${p.tag}`}>
                  {p.linked ? (
                    <Link
                      href={`/player/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`}
                      className="flex items-center gap-4 px-4 py-3 hover:bg-white/4"
                    >
                      {row}
                    </Link>
                  ) : (
                    <div className="flex items-center gap-4 px-4 py-3">{row}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <section aria-label="What you get" className="mt-10 grid w-full gap-4 sm:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="panel p-5">
            <h3 className="font-semibold text-slate-100">{f.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-400">{f.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
