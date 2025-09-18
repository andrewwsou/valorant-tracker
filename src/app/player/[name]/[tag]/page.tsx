import Image from 'next/image';

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
  headshots: number | null; legshots: number | null; damage_dealt: number | null } {

  const target = match_player(match, who )
  if (!target) return { kills: null, deaths: null, assists: null, acs: null, bodyshots: null, headshots: null,
    legshots: null, damage_dealt: null };

  const kills = target.stats?.kills ?? null;
  const deaths = target.stats?.deaths ?? null;
  const assists = target.stats?.assists ?? null;
  const acs = target.stats?.score ?? null;
  const bodyshots = target.stats?.bodyshots ?? null;
  const headshots = target.stats?.headshots ?? null;
  const legshots = target.stats?.legshots ?? null;
  const damage_dealt = target.damage_made ?? null;
  return { kills, deaths, assists, acs, bodyshots, headshots, legshots, damage_dealt};
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

  // const res = await fetch(`${base}/api/matches?${qs.toString()}`, { cache: "no-store" });

  const [matchesRes, mmrRes] = await Promise.all([
    fetch(`${base}/api/matches?${qs}`, { cache: "no-store" }),
    fetch(`${base}/api/elo?${qs}`, { cache: "no-store" }), // example second endpoint
  ]);

  let matches: HenrikMatchFull[] = [];
  let elo: EloData[] = [];
  let apiError = "";

  if (matchesRes.ok) {
    const json = (await matchesRes.json());
    matches = Array.isArray(json?.data) ? json.data : [];
  } else {
    apiError = `Matches error ${matchesRes.status}`;
  }

  if (mmrRes.ok) {
    const json = (await mmrRes.json()) as ApiResponse<EloData[]>;
    elo = Array.isArray(json?.data) ? json.data : [];
    console.log(elo);
  } else {
    apiError = `MMR history error ${mmrRes.status}`;
  }

  const eloMap = new Map<string, EloData>();
  for (const e of elo) {
    eloMap.set(e.match_id!, e);
  }

  type Row = { match: HenrikMatchFull; elo: EloData | null };
  const rows: Row[] = matches.map((m) => {
    const id = m?.metadata?.matchid ?? "";
    const e = id ? (eloMap.get(id) ?? null) : null;
    return { match: m, elo: e };
  });

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6">
      <header className="flex items-center gap-4">
        <div className="h-16 w-16 rounded bg-gray-200" />
        <div>
          <h1 className="text-2xl font-semibold">
            {name}
            <span className="text-gray-500">#{tag}</span>
          </h1>
          <p className="text-sm text-gray-500">Competitive · last {matches.length} matches</p>
        </div>
      </header>

      {apiError && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-800">
          {apiError}
        </div>
      )}

      <section>
        <h2 className="mb-2 text-lg font-medium">Recent Matches</h2>
        <div className="overflow-x-auto rounded border">
          <table className="min-w-full text-sm">
            <thead className="bg-[#2b3d50] text-left text-gray-300">
              <tr>
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

                const rank_icon: string = e!.images!.small!

                return (
                  <tr key={m.metadata?.matchid ?? `m-${i}`} className="border-t">
                    <td className="px-3 py-2">{map}</td>
                    <td className="px-3 py-2">{mode}</td>
                    <td className="px-3 py-2">{<Image src={rank_icon} alt={"Rank"} width={5} height={5}/>}</td>
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
      </section>
    </main>
  );
}
