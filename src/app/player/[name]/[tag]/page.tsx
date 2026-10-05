import type { Metadata } from "next";
import Image from "next/image";
import CurrentRating from "@/components/currentrating";
import OverallStats from "@/components/overallstats";
import PlayerBanner from "@/components/playerbanner";
import RecentForm from "@/components/recentform";
import { getPlayerProfile } from "@/services/profile";
import {
  averageCombatStats,
  headshotPercent,
  kdRatio,
  matchResult,
  matchStats,
  trackerScore,
  winLossRecord,
  type MatchResult,
} from "@/services/stats";

export const dynamic = "force-dynamic";

type ParamsP = Promise<{ name: string; tag: string }>;

const date_format = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  dateStyle: "short",
  timeStyle: "short",
});

/** The colored edge and badge that mark a row as a win, loss, or draw. */
const RESULT_EDGE: Record<MatchResult, string> = {
  W: "shadow-[inset_3px_0_0_var(--color-win)]",
  L: "shadow-[inset_3px_0_0_var(--color-loss)]",
  D: "shadow-[inset_3px_0_0_var(--color-draw)]",
  "-": "",
};
const RESULT_BADGE: Record<MatchResult, string> = {
  W: "bg-win/15 text-win",
  L: "bg-loss/15 text-loss",
  D: "bg-draw/15 text-draw",
  "-": "text-slate-500",
};

export async function generateMetadata({ params }: { params: ParamsP }): Promise<Metadata> {
  const { name, tag } = await params;
  const riotId = `${decodeURIComponent(name)}#${decodeURIComponent(tag)}`;
  return {
    title: riotId,
    description: `${riotId}: VALORANT rank, recent competitive matches, K/D, ACS, and ADR.`,
  };
}

export default async function PlayerPage({ params }: { params: ParamsP }) {
  const { name: rawName, tag: rawTag } = await params;
  const name = decodeURIComponent(rawName);
  const tag = decodeURIComponent(rawTag);

  const profile = await getPlayerProfile({ region: "na", name, tag });
  const { matches, errors } = profile;

  const kd = kdRatio(matches);
  const { acs: overallACS, adr: overallADR } = averageCombatStats(matches);
  const { wins, losses, draws, winrate } = winLossRecord(matches);
  const score = trackerScore(matches);

  const th = "px-3 py-2.5 font-semibold";
  const num = "px-3 py-3 tabular-nums";

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PlayerBanner
        name={name}
        tag={tag}
        smallCard={profile.cardImage ?? undefined}
        chips={["NA", "Competitive", ...(matches.length > 0 ? [`Last ${matches.length} ${matches.length === 1 ? "match" : "matches"}`] : [])]}
      />

      {errors.length > 0 && (
        <div role="status" className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-200">
          {matches.length === 0 && (
            <p className="mb-2 text-base font-semibold text-amber-100">
              Nothing to show for {name}#{tag} yet. Check the spelling of the Riot ID, or try again in a minute.
            </p>
          )}
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <aside className="space-y-4 lg:col-span-3">
          <div>
            <p className="eyebrow mb-2">Current Rank</p>
            <CurrentRating
              rankIcon={profile.rank.icon ?? undefined}
              rankText={profile.rank.current ?? undefined}
              peakRankText={profile.rank.peak ?? undefined}
            />
          </div>
          <RecentForm results={matches.map(matchResult)} />
        </aside>

        <div className="space-y-6 lg:col-span-9">
          <div>
            <p className="eyebrow mb-2">Overall Stats</p>
            <OverallStats
              wins={wins}
              losses={losses}
              draws={draws}
              winrate={winrate}
              kd={kd}
              acs={overallACS}
              adr={overallADR}
              headshotPct={headshotPercent(matches)}
              trackerScore={score}
            />
          </div>

          <div>
            <h2 className="eyebrow mb-2">Recent Matches</h2>
            <div className="panel overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="border-b border-white/8 text-left text-[11px] uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className={th}><span className="sr-only">Agent</span></th>
                    <th className={th}>Map</th>
                    <th className={th}>Mode</th>
                    <th className={th}>Rank</th>
                    <th className={th}>Score</th>
                    <th className={th}>Result</th>
                    <th className={th}>Date</th>
                    <th className={th}>K/D/A</th>
                    <th className={th}>ACS</th>
                    <th className={th}>HS%</th>
                    <th className={th}>ADR</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-white/6">
                  {matches.map((r, i) => {
                    const { acs, adr, headshotPct, score: scoreStr, result } = matchStats(r);
                    const started = r.startedAt ? date_format.format(new Date(r.startedAt)) : "Date Unavailable";
                    const rankIcon = profile.rankIconByMatch.get(r.matchId);

                    return (
                      <tr key={r.matchId ?? `m-${i}`} className="transition-colors hover:bg-white/4">
                        <td className={`px-3 py-2 ${RESULT_EDGE[result]}`}>
                          {r.agentIcon ? (
                            <Image src={r.agentIcon} alt="Agent" width={36} height={36} className="rounded-md" />
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>

                        <td className="px-3 py-3 font-medium text-slate-100">{r.map ?? "-"}</td>
                        <td className="px-3 py-3 text-slate-400">{r.mode ?? "-"}</td>

                        <td className="px-3 py-2">
                          {rankIcon ? (
                            <Image src={rankIcon} alt="Rank" width={30} height={30} />
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>

                        <td className={`${num} font-semibold text-slate-100`}>{scoreStr}</td>
                        <td className="px-3 py-3">
                          <span className={`inline-block min-w-7 rounded-md px-2 py-0.5 text-center text-xs font-bold ${RESULT_BADGE[result]}`}>
                            {result}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-slate-400">{started}</td>

                        <td className={`${num} text-slate-100`}>
                          {(r.kills ?? 0)}/{(r.deaths ?? 0)}/{(r.assists ?? 0)}
                        </td>

                        <td className={num}>{acs}</td>
                        <td className={num}>{headshotPct}</td>
                        <td className={num}>{adr}</td>
                      </tr>
                    );
                  })}

                  {matches.length === 0 && errors.length === 0 && (
                    <tr>
                      <td className="px-4 py-8 text-center text-slate-500" colSpan={11}>
                        No matches found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {matches.length === 0 && errors.length > 0 && (
                <p className="px-4 py-8 text-center text-sm text-slate-500">No matches to show yet.</p>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
