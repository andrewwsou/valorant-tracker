import type { Metadata } from "next";
import Image from "next/image";
import CurrentRating from "@/components/currentrating";
import PlayerBanner from "@/components/playerbanner";
import OverallStats from "@/components/overallstats";

type ApiResponse<T> = { status?: number; data?: T; error?: string };

type ParamsP = Promise<{ name: string; tag: string }>;

type EloData = {
  currenttier_patched?: string;
  images?: { small?: string; large?: string };
  match_id?: string;
  mmr_change_to_last_game?: number;
};

type OverallData = {
  current_data?: { currenttierpatched?: string; images?: { small?: string; large?: string } };
  highest_rank?: { patched_tier?: string; season?: string };
};

type PlayerCardData = {
  card: { small: string; large: string; wide: string };
};

type DbRow = {
  matchId: string;
  map: string | null;
  mode: string | null;
  region: string | null;
  startedAt: string | null;
  roundsRed: number | null;
  roundsBlue: number | null;

  team: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  score: number | null;
  damage: number | null;
  headshots: number | null;
  bodyshots: number | null;
  legshots: number | null;
  agentIcon: string | null;
};

const date_format = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  dateStyle: "short",
  timeStyle: "short",
});

function computeKDFromDb(rows: DbRow[]): string {
  let kills = 0;
  let deaths = 0;
  for (const r of rows) {
    kills += r.kills ?? 0;
    deaths += r.deaths ?? 0;
  }
  return deaths ? (kills / deaths).toFixed(2) : "0.00";
}

function computeACSADRFromDb(rows: DbRow[]): { ACS: number; ADR: number } {
  let totalScore = 0;
  let totalDamage = 0;
  let totalRounds = 0;

  for (const r of rows) {
    totalScore += r.score ?? 0;
    totalDamage += r.damage ?? 0;
    totalRounds += (r.roundsRed ?? 0) + (r.roundsBlue ?? 0);
  }

  const ACS = totalRounds ? Math.round(totalScore / totalRounds) : 0;
  const ADR = totalRounds ? Math.round(totalDamage / totalRounds) : 0;
  return { ACS, ADR };
}

function winrateFromDb(rows: DbRow[]): { wins: number; losses: number; draws: number; winrate: number } {
  let wins = 0;
  let losses = 0;
  let draws = 0;

  for (const r of rows) {
    const rr = r.roundsRed;
    const rb = r.roundsBlue;
    const team = r.team?.toLowerCase();

    if (rr == null || rb == null) continue;
    if (team !== "red" && team !== "blue") continue;

    if (rr === rb) {
      draws++;
      continue;
    }

    const redWon = rr > rb;
    const weWon = team === "red" ? redWon : !redWon;

    if (weWon) wins++;
    else losses++;
  }

  const totalMatches = wins + losses;
  const winrate = totalMatches ? Math.round((wins / totalMatches) * 100) : 0;
  return { wins, losses, draws, winrate };
}

function computeTrackerScoreLastN(rows: DbRow[], n = 10): number {
  const slice = rows.slice(0, n);
  if (slice.length === 0) return 0;

  let sum = 0;

  for (const r of slice) {
    const rr = r.roundsRed ?? 0;
    const rb = r.roundsBlue ?? 0;

    const team = (r.team ?? "").toLowerCase();
    const teamIsRed = team === "red";
    const teamIsBlue = team === "blue";

    let win = 0;
    if (rr !== rb && (teamIsRed || teamIsBlue)) {
      const redWon = rr > rb;
      const weWon = teamIsRed ? redWon : !redWon;
      win = weWon ? 1 : 0;
    }

    const kills = r.kills ?? 0;
    const deaths = r.deaths ?? 0;

    const kd = kills / Math.max(1, deaths);
    const kdNorm = kd / (kd + 1);

    const rounds = rr + rb;
    const acs = rounds > 0 && r.score != null ? r.score / rounds : 0;
    const acsNorm = acs / (acs + 200);

    const perf = 0.7 * kdNorm + 0.3 * acsNorm;
    const perfAdj = perf * (win ? 1.0 : 0.85);

    const impact = 0.6 * win + 0.4 * perfAdj;
    sum += impact;
  }

  const avg = sum / slice.length;
  return Math.max(0, Math.min(100, Math.round(avg * 100)));
}

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

  const qs = new URLSearchParams({
    region: "na",
    name,
    tag,
    size: "10",
    mode: "competitive",
  });

  const base =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

  await fetch(`${base}/api/sync?${qs}`, { method: "POST", cache: "no-store" });

  const [matchesRes, eloRes, overallRes, cardRes] = await Promise.all([
    fetch(`${base}/api/db/matches?name=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}&limit=10`, {
      cache: "no-store",
    }),
    fetch(`${base}/api/elo?${qs}`, { cache: "no-store" }),
    fetch(`${base}/api/overall?${qs}`, { cache: "no-store" }),
    fetch(`${base}/api/player?${qs}`, { cache: "no-store" }),
  ]);

  let dbRows: DbRow[] = [];
  let elo: EloData[] = [];
  let overall: OverallData | null = null;
  let card: PlayerCardData | null = null;
  let apiError = "";

  if (matchesRes.ok) {
    const json = await matchesRes.json();
    dbRows = Array.isArray(json?.data) ? json.data : [];
  } else {
    apiError = `DB matches error ${matchesRes.status}`;
  }

  if (eloRes.ok) {
    const json = (await eloRes.json()) as ApiResponse<EloData[]>;
    elo = Array.isArray(json?.data) ? json.data : [];
  } else {
    apiError = `Elo history error ${eloRes.status}`;
  }

  if (overallRes.ok) {
    const json = (await overallRes.json()) as ApiResponse<OverallData>;
    overall = json?.data ?? null;
  } else {
    apiError = `Overall history error ${overallRes.status}`;
  }

  if (cardRes.ok) {
    const json = (await cardRes.json()) as ApiResponse<PlayerCardData>;
    card = json?.data ?? null;
  } else {
    apiError = `Player card error ${cardRes.status}`;
  }

  const eloMap = new Map<string, EloData>();
  for (const e of elo) if (e.match_id) eloMap.set(e.match_id, e);

  const kd = computeKDFromDb(dbRows);
  const { ACS: overallACS, ADR: overallADR } = computeACSADRFromDb(dbRows);
  const { wins, losses, draws, winrate } = winrateFromDb(dbRows);
  const trackerScore = computeTrackerScoreLastN(dbRows, 10);

  return (
    <main className="mx-auto max-w-7xl p-6 space-y-6">
      <header className="grid grid-cols-1 col-span-1 max-w-7xl max-h-sm gap-4">
        <PlayerBanner name={name} tag={tag} smallCard={card?.card.small} wideCard={card?.card.wide} />
      </header>

      {apiError && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-800">{apiError}</div>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <aside className="lg:col-span-3">
          <p className="py-2">Current Rank</p>
          <CurrentRating
            rankIcon={overall?.current_data?.images?.small}
            rankText={overall?.current_data?.currenttierpatched}
            peakRankText={overall?.highest_rank?.patched_tier}
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
            trackerScore={trackerScore}
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
                {dbRows.map((r, i) => {
                  const rr = r.roundsRed ?? 0;
                  const rb = r.roundsBlue ?? 0;
                  const totalRounds = rr + rb;

                  const acs = totalRounds > 0 && r.score != null ? Math.round(r.score / totalRounds) : 0;
                  const adr = totalRounds > 0 && r.damage != null ? Math.round(r.damage / totalRounds) : 0;

                  const shots = (r.headshots ?? 0) + (r.bodyshots ?? 0) + (r.legshots ?? 0);
                  const hsPercentage = shots > 0 ? Math.round(((r.headshots ?? 0) / shots) * 100) : 0;

                  const team = r.team?.toLowerCase() === "blue" ? "blue" : "red";
                  const scoreStr = team !== "blue" ? `${rr}–${rb}` : `${rb}–${rr}`;

                  const result =
                    r.roundsRed == null || r.roundsBlue == null
                      ? "-"
                      : rr === rb
                      ? "D"
                      : team === "red"
                      ? rr > rb
                        ? "W"
                        : "L"
                      : rb > rr
                      ? "W"
                      : "L";

                  const started = r.startedAt ? date_format.format(new Date(r.startedAt)) : "Date Unavailable";
                  const rankIcon = eloMap.get(r.matchId)?.images?.small;

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
                      <td className="px-3 py-2">{hsPercentage}</td>
                      <td className="px-3 py-2">{adr}</td>
                    </tr>
                  );
                })}

                {dbRows.length === 0 && !apiError && (
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
