import type { Metadata } from "next";
import Image from "next/image";
import CurrentRating from "@/components/currentrating";
import OverallStats from "@/components/overallstats";
import PlayerBanner from "@/components/playerbanner";
import { getPlayerProfile } from "@/services/profile";
import { averageCombatStats, kdRatio, matchStats, trackerScore, winLossRecord } from "@/services/stats";

export const dynamic = "force-dynamic";

type ParamsP = Promise<{ name: string; tag: string }>;

const date_format = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  dateStyle: "short",
  timeStyle: "short",
});

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

  return (
    <main className="mx-auto w-full max-w-7xl p-6 space-y-6">
      <header className="grid grid-cols-1 col-span-1 max-w-7xl max-h-sm gap-4">
        <PlayerBanner name={name} tag={tag} smallCard={profile.cardImage ?? undefined} />
      </header>

      {errors.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-800">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <aside className="lg:col-span-3">
          <p className="py-2">Current Rank</p>
          <CurrentRating
            rankIcon={profile.rank.icon ?? undefined}
            rankText={profile.rank.current ?? undefined}
            peakRankText={profile.rank.peak ?? undefined}
          />
        </aside>

        <div className="lg:col-span-9">
          <p className="py-2">Overall Stats</p>
          <OverallStats
            wins={wins}
            losses={losses}
            draws={draws}
            winrate={winrate}
            kd={kd}
            acs={overallACS}
            adr={overallADR}
            trackerScore={score}
          />

          <h3 className="mb-2 text-lg font-medium text-slate-100">Recent Matches</h3>
          <div className="overflow-x-auto rounded border border-slate-700">
            <table className="min-w-full text-sm">
              <thead className="bg-[#2b3d50] text-left text-gray-300">
                <tr>
                  <th className="px-3 py-2"></th>
                  <th className="px-3 py-2"></th>
                  <th className="px-3 py-2">Mode</th>
                  <th className="px-3 py-2">Rank</th>
                  <th className="px-3 py-2">Score</th>
                  <th className="px-3 py-2">Result</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">K/D/A</th>
                  <th className="px-3 py-2">ACS</th>
                  <th className="px-3 py-2">HS%</th>
                  <th className="px-3 py-2">ADR</th>
                </tr>
              </thead>

              <tbody>
                {matches.map((r, i) => {
                  const { acs, adr, headshotPct, score: scoreStr, result } = matchStats(r);
                  const started = r.startedAt ? date_format.format(new Date(r.startedAt)) : "Date Unavailable";
                  const rankIcon = profile.rankIconByMatch.get(r.matchId);

                  return (
                    <tr key={r.matchId ?? `m-${i}`} className="border-t">
                      <td className="px-3 py-2">
                        {r.agentIcon ? (
                          <Image src={r.agentIcon} alt="Agent" width={35} height={35} />
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      <td className="px-3 py-2">{r.map ?? "-"}</td>
                      <td className="px-3 py-2">{r.mode ?? "-"}</td>

                      <td className="px-3 py-2">
                        {rankIcon ? (
                          <Image src={rankIcon} alt="Rank" width={30} height={30} />
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      <td className="px-3 py-2">{scoreStr}</td>
                      <td className="px-3 py-2">{result}</td>
                      <td className="px-3 py-2">{started}</td>

                      <td className="px-3 py-2">
                        {(r.kills ?? 0)}/{(r.deaths ?? 0)}/{(r.assists ?? 0)}
                      </td>

                      <td className="px-3 py-2">{acs}</td>
                      <td className="px-3 py-2">{headshotPct}</td>
                      <td className="px-3 py-2">{adr}</td>
                    </tr>
                  );
                })}

                {matches.length === 0 && errors.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-gray-500" colSpan={11}>
                      No matches found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}
