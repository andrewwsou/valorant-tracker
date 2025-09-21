import Image from "next/image";
import CurrentRating from "@/components/currentrating";
import PlayerBanner from "@/components/playerbanner";
import OverallStats from "@/components/overallstats";
import { computeRadarPoints } from "recharts/types/polar/Radar";

type Metadata = {
  map?: string;
  mode?: string;
  game_start?: number;
  game_start_patched?: string;
  matchid?: string;
};
type Segment = { stats?: { result?: string } };
type Round = { winning_team?: "Red" | "Blue" | string };

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
  assets?: { agent?: { small?: string } };
  stats?: PlayerStats;
  damage_made?: number;
  team?: "Red" | "Blue" | string;
};

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

const date_format = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  dateStyle: "short",
  timeStyle: "short",
});


function findPlayer(
  match: HenrikMatchFull,
  who: { puuid?: string; name?: string; tag?: string }
): PlayerLite | undefined {
  const everyone = match?.players?.all_players ?? [];
  return everyone.find((p) => {
    if (who.puuid && p.puuid) return p.puuid === who.puuid;
    const pn = (p.name ?? "").toLowerCase();
    const pt = (p.tag ?? "").toLowerCase();
    return pn === (who.name ?? "").toLowerCase() && pt === (who.tag ?? "").toLowerCase();
  });
}

function extractStats(p?: PlayerLite) {
  return {
    kills: p?.stats?.kills ?? null,
    deaths: p?.stats?.deaths ?? null,
    assists: p?.stats?.assists ?? null,
    acs: p?.stats?.score ?? null,
    bodyshots: p?.stats?.bodyshots ?? null,
    headshots: p?.stats?.headshots ?? null,
    legshots: p?.stats?.legshots ?? null,
    damage_dealt: p?.damage_made ?? null,
    agentIcon: p?.assets?.agent?.small ?? "",
    team: (p?.team?.toLowerCase?.() as "red" | "blue" | undefined) ?? undefined,
  };
}

function computeKD(players: Array<PlayerLite | undefined>): string {
  let kills = 0, deaths = 0;
  for (const p of players) {
    kills += p?.stats?.kills ?? 0;
    deaths += p?.stats?.deaths ?? 0;
  }
  return (kills / deaths).toFixed(2);
}

function computeACSADR(matches: HenrikMatchFull[], players: Array<PlayerLite | undefined>): { ACS: number, ADR: number } {
  let totalACS = 0;
  let totalRounds = 0;
  let totalDamage = 0;

  for (const p of players) {
    totalACS += p?.stats?.score ?? 0;
    totalDamage += p?.damage_made ?? 0 ;
    console.log(p);
  }

  for (const m of matches) {
    const { red, blue } = getRounds(m);
    totalRounds += (red ?? 0) + (blue ?? 0);
  }

  const ACS = Math.round(totalACS / totalRounds);
  const ADR = Math.round(totalDamage / totalRounds);

  return { ACS, ADR };
}



function getRounds(match: HenrikMatchFull): { red: number | null; blue: number | null } {
  const red = match?.teams?.red?.rounds_won ?? null;
  const blue = match?.teams?.blue?.rounds_won ?? null;
  return { red, blue };
}

function resultForTeam(
  team: "red" | "blue" | null,
  rounds: { red: number | null; blue: number | null },
  fallback?: string
): "W" | "L" | "D" | string {
  const { red, blue } = rounds;
  if (!team || red == null || blue == null) return fallback ?? "-";
  if (red === blue) return "D";
  const weWon = team === "red" ? red > blue : blue > red;
  return weWon ? "W" : "L";
}

function findPlayerTeam(match: HenrikMatchFull, who: { puuid?: string; name?: string; tag?: string }): "red" | "blue" | null {
  const player = findPlayer(match, who);
  const t = player?.team?.toLowerCase?.();
  return t === "red" || t === "blue" ? t : null;
}

function winrateResults(matches: HenrikMatchFull[], who: { puuid?: string; name?: string; tag?: string }):
 { wins: number; losses: number; draws: number; winrate: number } {
  let wins = 0,
    losses = 0,
    draws = 0;

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


export default async function PlayerPage({ params }: { params: ParamsP }) {
  const { name: rawName, tag: rawTag } = await params;
  const name = decodeURIComponent(rawName);
  const tag = decodeURIComponent(rawTag);
  const who = { name, tag };

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
    const json = await matchesRes.json();
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
    apiError = `Player card error ${cardRes.status}`;
  }

  const eloMap = new Map<string, EloData>();
  for (const e of elo) if (e.match_id) eloMap.set(e.match_id, e);

  const targets: Array<PlayerLite | undefined> = matches.map((m) => findPlayer(m, who));

  const kd = computeKD(targets);
  const overallACS = computeACSADR(matches, targets).ACS;
  const overallADR = computeACSADR(matches, targets).ADR;

  type Row = { match: HenrikMatchFull; elo: EloData | null; player?: PlayerLite };
  const rows: Row[] = matches.map((m, i) => {
    const id = m?.metadata?.matchid ?? "";
    const e = id ? eloMap.get(id) ?? null : null;
    return { match: m, elo: e, player: targets[i] };
  });

  const { wins, losses, draws, winrate } = winrateResults(matches, who);

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
          <OverallStats wins={wins} losses={losses} draws={draws} winrate={winrate} kd={kd} acs={overallACS} adr={overallADR} />

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
                {rows.map(({ match: m, elo: e, player }, i) => {
                  const map = m.metadata?.map ?? "-";
                  const mode = m.metadata?.mode ?? "-";

                  const rounds = getRounds(m);
                  const totalRounds = (rounds.red ?? 0) + (rounds.blue ?? 0);

                  const ps = extractStats(player);

                  const acs = totalRounds > 0 && ps.acs != null ? Math.round(ps.acs / totalRounds) : 0;
                  const adr = totalRounds > 0 && ps.damage_dealt != null
                      ? Math.round(ps.damage_dealt / totalRounds)
                      : 0;

                  const allShots = (ps.headshots ?? 0) + (ps.bodyshots ?? 0) + (ps.legshots ?? 0);
                  const hsPercentage = allShots > 0 ? Math.round(((ps.headshots ?? 0) / allShots) * 100) : 0;

                  const team = ps.team ?? findPlayerTeam(m, who);
                  const score =
                    team !== "blue" ? `${rounds.red ?? "-"}–${rounds.blue ?? "-"}` : `${rounds.blue ?? "-"}–${rounds.red ?? "-"}`;
                  const fallback = m.segments?.[0]?.stats?.result ?? "-";
                  const result = resultForTeam(team ?? null, rounds, fallback);

                  const game_start = m.metadata?.game_start;
                  const started =
                    typeof game_start === "number"
                      ? date_format.format(game_start * 1000)
                      : "Date Unavailable";

                  const rankIcon = e?.images?.small;

                  return (
                    <tr key={m.metadata?.matchid ?? `m-${i}`} className="border-t">
                      <td className="px-3 py-2">
                        {ps.agentIcon ? (
                          <Image src={ps.agentIcon} alt="Agent" width={35} height={35} />
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">{map}</td>
                      <td className="px-3 py-2">{mode}</td>
                      <td className="px-3 py-2">
                        {rankIcon ? (
                          <Image src={rankIcon} alt="Rank" width={30} height={30} />
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">{score}</td>
                      <td className="px-3 py-2">{result}</td>
                      <td className="px-3 py-2">{started}</td>
                      <td className="px-3 py-2">
                        {ps.kills ?? 0}/{ps.deaths ?? 0}/{ps.assists ?? 0}
                      </td>
                      <td className="px-3 py-2">{acs}</td>
                      <td className="px-3 py-2">{hsPercentage}</td>
                      <td className="px-3 py-2">{adr}</td>
                    </tr>
                  );
                })}

                {matches.length === 0 && !apiError && (
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
