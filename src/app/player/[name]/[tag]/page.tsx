import Image from 'next/image';
import CurrentRating from "@/components/currentrating";
import PlayerBanner from '@/components/playerbanner';
import OverallStats from '@/components/overallstats';

type Metadata = {
  map?: string;
  mode?: string;
  game_start?: number;
  game_start_patched?: string;
  matchid?: string;
};
type Teams = { red?: { rounds_won?: number }; blue?: { rounds_won?: number } };
type Segment = { stats?: { result?: string } };
type Round = { winning_team?: 'Red' | 'Blue' | string};

type ApiResponse<T> = { status?: number; data?: T; error?: string };

type ParamsP = Promise<{ name: string; tag: string }>;

type PlayerStats = {
  kills?: number;
  deaths?: number;
  assists?: number;
  score?: number;
  bodyshots?: number;
  headshots?: number;
  legshots?: number;
};

type PlayerLite = {
  puuid?: string;
  name?: string;
  tag?: string;
  assets?: { agent?: { small: string } };
  stats?: PlayerStats;
  damage_made?: number;
  team?: "Red" | "Blue" | string;
};

// type HenrikMatch = {
//   metadata?: Metadata;
//   teams?: Teams;
//   rounds?: Round[];
//   segments?: Segment[];
// };

type HenrikMatchFull = {
  metadata?: Metadata;
  rounds?: Round[];
  segments?: Segment[];
  players?: {
    all_players?: PlayerLite[];
    red?: PlayerLite[];
    blue?: PlayerLite[];
  };
  teams?: {
    red?: { rounds_won?: number; rounds_lost?: number; has_won?: boolean };
    blue?: { rounds_won?: number; rounds_lost?: number; has_won?: boolean };
  };
};

// type HenrikMatch = {
//   metadata?: Metadata;
//   teams?: Teams;
//   rounds?: Round[];
//   segments?: Segment[];
// };

type EloData = {
  currenttier_patched?: string;
  images?: { small?: string; large?: string };
  match_id?: string;
  mmr_change_to_last_game?: number;
};

type OverallData = {
  current_data?: { currenttierpatched?: string; images?: { small?: string; large?: string; }; };
  highest_rank?: { patched_tier?: string; season?: string };
};

type PlayerCardData = {
  card: { small: string; large: string; wide: string; }
};


                
const date_format = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  dateStyle: 'short',
  timeStyle: 'short',
});

function findPlayerTeam(match: HenrikMatchFull, who: { puuid?: string; name?: string; tag?: string }): "red" | "blue" | null {
  const target = match_player(match, who )
  if (!target?.team) return null;
  const t = target.team.toLowerCase();
  return t === "red" || t === "blue" ? (t as "red" | "blue") : null;
}

function getRounds(match: HenrikMatchFull): { red: number | null; blue: number | null } {
  const red = match?.teams?.red?.rounds_won ?? null;
  const blue = match?.teams?.blue?.rounds_won ?? null;
  return { red, blue };
}

function resultForTeam(team: "red" | "blue" | null, rounds: { red: number | null; blue: number | null }, fallback?: string):
 "W" | "L" | "D" | string {
  const { red, blue } = rounds;
  if (!team || red == null || blue == null) return fallback ?? "-";
  if (red === blue) return "D";
  const weWon = team === "red" ? red > blue : blue > red;
  return weWon ? "W" : "L";
}

function readApiError(x: unknown): string | null {
  if (!x || typeof x !== "object") return null;
  const maybe = (x as { error?: unknown }).error;
  if (typeof maybe === "string" && maybe.trim()) return maybe;
  return null;
}


function getPlayerStats( match: HenrikMatchFull, who: { puuid?: string; name?: string; tag?: string }): 
{ kills: number | null; deaths: number | null; assists: number | null; acs: number | null; bodyshots: number | null;
  headshots: number | null; legshots: number | null; damage_dealt: number | null; agentIcon: string } {

  const target = match_player(match, who )
  if (!target) return { kills: null, deaths: null, assists: null, acs: null, bodyshots: null, headshots: null,
    legshots: null, damage_dealt: null, agentIcon: "" };

  const kills = target.stats?.kills ?? null;
  const deaths = target.stats?.deaths ?? null;
  const assists = target.stats?.assists ?? null;
  const acs = target.stats?.score ?? null;
  const bodyshots = target.stats?.bodyshots ?? null;
  const headshots = target.stats?.headshots ?? null;
  const legshots = target.stats?.legshots ?? null;
  const damage_dealt = target.damage_made ?? null;
  const agentIcon = target.assets!.agent?.small ?? "Agent Icon not Working";
  return { kills, deaths, assists, acs, bodyshots, headshots, legshots, damage_dealt, agentIcon};
}


function match_player( match: HenrikMatchFull, who: { puuid?: string; name?: string; tag?: string }): PlayerLite | undefined {
  const everyone = match?.players?.all_players ?? [];
  return everyone.find((p) => {
    if (who.puuid && p.puuid) return p.puuid === who.puuid;
    const pn = (p.name ?? "").toLowerCase();
    const pt = (p.tag ?? "").toLowerCase();
    return pn === (who.name ?? "").toLowerCase() && pt === (who.tag ?? "").toLowerCase();
  });
}

function winrateResults(matches: HenrikMatchFull[], who: { puuid?: string; name?: string; tag?: string }):
 { wins: number; losses: number; draws: number; winrate: number; } {
  let wins = 0, losses = 0, draws = 0;

  for (const m of matches) {
    const team = findPlayerTeam(m, who);
    const res = resultForTeam(team, getRounds(m));
    if (res === "W") wins++;
    else if (res === "L") losses++;
    else if (res === "D") draws++;
  }

  const totalMatches = wins + losses;
  const winrate = totalMatches ? Math.round((wins / totalMatches) * 100) : 0;

  return { wins, losses, draws, winrate };
}


function getKD(matches: HenrikMatchFull[], who: { puuid?: string; name?: string; tag?: string }): string {
  let kills = 0;
  let deaths = 0;
  
  for (const m of matches) {
    const target = match_player(m, who)

    kills  += target?.stats?.kills  ?? 0;
    deaths += target?.stats?.deaths ?? 0;

  }

  const kd = kills / deaths;

  return kd.toFixed(2);
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

  const [matchesRes, eloRes, overallRes, cardRes] = await Promise.all([
    fetch(`${base}/api/matches?${qs}`, { cache: "no-store" }),
    fetch(`${base}/api/elo?${qs}`, { cache: "no-store" }),
    fetch(`${base}/api/overall?${qs}`, { cache: "no-store" }), 
    fetch(`${base}/api/player?${qs}`, { cache: "no-store" }), 
  ]);

  let matches: HenrikMatchFull[] = [];
  let elo: EloData[] = [];
  let overall: OverallData | null = null;
  let card: PlayerCardData | null = null;
  let apiError = "";

  if (matchesRes.ok) {
    const json = (await matchesRes.json());
    matches = Array.isArray(json?.data) ? json.data : [];
  } else {
    apiError = `Matches error ${matchesRes.status}`;
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
    apiError = `Overall history error ${cardRes.status}`;
  }
  // console.log(overall)

  const eloMap = new Map<string, EloData>();
  for (const e of elo) {
    eloMap.set(e.match_id!, e);
  }

  const { wins, losses, draws, winrate } = winrateResults(matches, { name, tag });

  // const { wins, losses, draws, winrate } = winrateResults(matches, { name, tag });
  // console.log(wins)
  // console.log(losses)
  // console.log(draws)
  // console.log(winrate)

  type Row = { match: HenrikMatchFull; elo: EloData | null };
  const rows: Row[] = matches.map((m) => {
    const id = m?.metadata?.matchid ?? "";
    const e = id ? (eloMap.get(id) ?? null) : null;
    return { match: m, elo: e };
  });

  return (
    <main className="mx-auto max-w-7xl p-6 space-y-6">
      <header className="grid grid-cols-1 col-span-1 max-w-7xl max-h-sm gap-4">
        <PlayerBanner
          name={name}
          tag={tag}
          smallCard={card?.card.small}
          // largeCard={card?.card.large}
          wideCard={card?.card.wide}
        /> 
      </header>

      {apiError && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-800">
          {apiError}
        </div>
      )}


      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <aside className="lg:col-span-3">
            <p className="py-2">
              Current Rank
            </p>

            <CurrentRating
              rankIcon={overall?.current_data?.images?.small}
              rankText={overall?.current_data?.currenttierpatched}
              peakRankText={overall?.highest_rank?.patched_tier}
            />
          </aside>
           <div className="lg:col-span-9">
              <p className="py-2">
                Overall Stats
              </p>
              <OverallStats
                wins={wins}
                losses={losses}
                draws={draws}
                winrate={winrate}
                kd={getKD(matches, { name, tag })}
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
                {rows.map(( { match: m, elo: e }, i) => {
                  const map = m.metadata?.map ?? "-";
                  const mode = m.metadata?.mode ?? "-";

                  const rounds = getRounds(m);

                  const stats = getPlayerStats(m, { name, tag });

                  const myTeam = findPlayerTeam(m, { name, tag });
                  
                  const totalRounds = (rounds.red!) + (rounds.blue!);
                  const acs =  Math.round(stats.acs! / totalRounds);
                  const adr =  Math.round(stats.damage_dealt! / totalRounds);

                  const hsPercentage = Math.round((stats.headshots!/(stats.headshots! + stats.bodyshots! + stats.legshots!)) * 100);

                  const score =
                    myTeam != "blue" ? `${rounds.red}–${rounds.blue}` :  `${rounds.blue}–${rounds.red}`;
                  const fallback = m.segments?.[0]?.stats?.result ?? "-";
                  const result = resultForTeam(myTeam, rounds, fallback);

                  const game_start = m.metadata?.game_start;
                  
                  const started =
                    typeof game_start === 'number'
                      ? date_format.format(game_start * 1000)
                      : 'Date Unavailable';

                  const rankIcon: string = e!.images!.small!


                  return (
                    <tr key={m.metadata?.matchid ?? `m-${i}`} className="border-t">
                      <td className="px-3 py-2">{<Image src={stats.agentIcon} alt={"Agent"} width={35} height={35}/>}</td>
                      <td className="px-3 py-2">{map}</td>
                      <td className="px-3 py-2">{mode}</td>
                      <td className="px-3 py-2">{<Image src={rankIcon} alt={"Rank"} width={30} height={30}/>}</td>
                      <td className="px-3 py-2">{score}</td>
                      <td className="px-3 py-2">
                        {result}
                      </td>
                      <td className="px-3 py-2">{started}</td>
                      <td className="px-3 py-2">{`${stats.kills}/${stats.deaths}/${stats.assists}`}</td>
                      <td className="px-3 py-2">{acs}</td>
                      <td className="px-3 py-2">{hsPercentage}</td>
                      <td className="px-3 py-2">{adr}</td>
                    </tr>
                  );
                })}
                {matches.length === 0 && !apiError && (
                  <tr>
                    <td className="px-3 py-6 text-gray-500" colSpan={8}>
                      No matches found for this player/mode.
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
