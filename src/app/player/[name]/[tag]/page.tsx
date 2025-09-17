type Metadata = {
  map?: string;
  mode?: string;
  game_start?: number;
  game_start_patched?: string;
  matchid?: string;
};
type Teams = { red?: { rounds_won?: number }; blue?: { rounds_won?: number } };
type Segment = { stats?: { result?: string } };
type HenrikMatch = {
  metadata?: Metadata;
  teams?: Teams;
  rounds?: { red: number; blue: number };
  segments?: Segment[];
};
type ApiResponse<T> = { status?: number; data?: T; error?: string };

type ParamsP = Promise<{ name: string; tag: string }>;

export default async function PlayerPage({ params }: { params: ParamsP }) {
  const { name: rawName, tag: rawTag } = await params;
  const name = decodeURIComponent(rawName);
  const tag  = decodeURIComponent(rawTag);

  const qs = new URLSearchParams({
    region: 'na',
    name,
    tag,
    size: '10',
    mode: 'competitive',
  });

  const base =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  const res = await fetch(`${base}/api/matches?${qs.toString()}`, { cache: 'no-store' });

  console.log(`${base}/api/matches?${qs.toString()}`);
  console.log(qs.toString());
  
  let matches: HenrikMatch[] = [];
  let apiError = '';

  if (res.ok) {
    const json = (await res.json()) as ApiResponse<HenrikMatch[]>;
    matches = Array.isArray(json?.data) ? json.data : [];
  } else {
    try {
      const errJson = (await res.json()) as ApiResponse<unknown>;
      apiError =
        typeof errJson?.error === 'string' && errJson.error.trim()
          ? errJson.error
          : `API error ${res.status}`;
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
            <thead className="bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-3 py-2">Map</th>
                <th className="px-3 py-2">Mode</th>
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">Result</th>
                <th className="px-3 py-2">Started</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((m, i) => {
                const map = m.metadata?.map ?? '-';
                const mode = m.metadata?.mode ?? '-';

                const rRed =
                  typeof m.rounds?.red === 'number'
                    ? m.rounds.red
                    : m.teams?.red?.rounds_won ?? null;
                const rBlue =
                  typeof m.rounds?.blue === 'number'
                    ? m.rounds.blue
                    : m.teams?.blue?.rounds_won ?? null;
                const score =
                  rRed != null && rBlue != null ? `${rRed}–${rBlue}` : '-';

                const result =
                  rRed != null && rBlue != null
                    ? rRed > rBlue
                      ? 'W'
                      : rRed < rBlue
                      ? 'L'
                      : 'T'
                    : m.segments?.[0]?.stats?.result ?? '-';

                const started =
                  m.metadata?.game_start_patched ??
                  (typeof m.metadata?.game_start === 'number'
                    ? new Date(m.metadata.game_start * 1000).toLocaleString()
                    : '-');

                return (
                  <tr key={m.metadata?.matchid ?? `m-${i}`} className="border-t">
                    <td className="px-3 py-2">{map}</td>
                    <td className="px-3 py-2">{mode}</td>
                    <td className="px-3 py-2">{score}</td>
                    <td className="px-3 py-2">{result}</td>
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
