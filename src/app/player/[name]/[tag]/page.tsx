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

type HenrikMatch = {
  metadata?: Metadata;
  teams?: Teams;
  rounds?: Round[];
  segments?: Segment[];
};

type ApiResponse<T> = { status?: number; data?: T; error?: string };

type ParamsP = Promise<{ name: string; tag: string }>;

type PlayerLite = {
  puuid?: string;
  name?: string;
  tag?: string;
  team?: "Red" | "Blue" | string;
};

type HenrikMatchFull = HenrikMatch & {
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

                
const date_format = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  dateStyle: 'short',
  timeStyle: 'short',
});

function findPlayerTeam(
  match: HenrikMatchFull,
  who: { puuid?: string; name?: string; tag?: string }
): "red" | "blue" | null {
  const everyone = match?.players?.all_players ?? [];
  const target = everyone.find((p) => {
    if (who.puuid && p.puuid) return p.puuid === who.puuid;
    const pn = (p.name ?? "").toLowerCase();
    const pt = (p.tag ?? "").toLowerCase();
    return pn === (who.name ?? "").toLowerCase() && pt === (who.tag ?? "").toLowerCase();
  });

  if (!target?.team) return null;
  const t = target.team.toLowerCase();
  return t === "red" || t === "blue" ? (t as "red" | "blue") : null;
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

function readApiError(x: unknown): string | null {
  if (!x || typeof x !== "object") return null;
  const maybe = (x as { error?: unknown }).error;
  if (typeof maybe === "string" && maybe.trim()) return maybe;
  return null;
}

// function findPlayerTeam( match: HenrikMatchFull, who: { puuid?: string; name?: string; tag?: string }): "red" | "blue" | null {
//   const everyone = match?.players?.all_players ?? [];
//   const target = everyone.find((p) => {
//     if (who.puuid && p.puuid) return p.puuid === who.puuid;
//     const pn = (p.name ?? "").toLowerCase();
//     const pt = (p.tag ?? "").toLowerCase();
//     return pn === (who.name ?? "").toLowerCase() && pt === (who.tag ?? "").toLowerCase();
//   });

//   if (!target?.team) return null;
//   const t = target.team.toLowerCase();
//   return t === "red" || t === "blue" ? (t as "red" | "blue") : null;
// }

// function getPlayerStats( match: HenrikMatchFull, who: { puuid?: string; name?: string; tag?: string }):
//   { kills: number | null; deaths: number | null; assists: number |null } {
//   const kills =
//   const red = match?.teams?.red?.rounds_won ?? null;
//   const blue = match?.teams?.blue?.rounds_won ?? null;
//   return { red, blue };
// }


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

  const res = await fetch(`${base}/api/matches?${qs.toString()}`, { cache: "no-store" });

  let matches: HenrikMatchFull[] = [];
  let apiError = "";

  if (res.ok) {
    const json = (await res.json()) as ApiResponse<HenrikMatchFull[]>;
    matches = Array.isArray(json?.data) ? json.data : [];
  } else {
    try {
      const errJson = (await res.json()) as unknown;
      const msg = readApiError(errJson);
      apiError = msg ?? `API error ${res.status}`;
    } catch {
      apiError = `API error ${res.status}`;
    }
  }

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
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">Result</th>
                <th className="px-3 py-2">Date</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((m, i) => {
                const map = m.metadata?.map ?? "-";
                const mode = m.metadata?.mode ?? "-";

                const rounds = getRounds(m);

                // const player_stats = getPlayerStats(m, { name, tag });

                const myTeam = findPlayerTeam(m, { name, tag });

                const score =
                  myTeam != "blue" ? `${rounds.red}–${rounds.blue}` :  `${rounds.blue}–${rounds.red}`;
                const fallback = m.segments?.[0]?.stats?.result ?? "-";
                const result = resultForTeam(myTeam, rounds, fallback);

                const game_start = m.metadata?.game_start;

                const started =
                  typeof game_start === 'number'
                    ? date_format.format(game_start * 1000)
                    : 'Date Unavailable';

                return (
                  <tr key={m.metadata?.matchid ?? `m-${i}`} className="border-t">
                    <td className="px-3 py-2">{map}</td>
                    <td className="px-3 py-2">{mode}</td>
                    <td className="px-3 py-2">{score}</td>
                    <td className="px-3 py-2">
                      {result}
                    </td>
                    <td className="px-3 py-2">{started}</td>
                  </tr>
                );
              })}
              {matches.length === 0 && !apiError && (
                <tr>
                  <td className="px-3 py-6 text-gray-500" colSpan={5}>
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
