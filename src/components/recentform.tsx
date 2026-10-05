import type { MatchResult } from "@/services/stats";

const STYLE: Record<MatchResult, string> = {
  W: "bg-win/15 text-win ring-win/30",
  L: "bg-loss/15 text-loss ring-loss/30",
  D: "bg-draw/15 text-draw ring-draw/30",
  "-": "bg-white/5 text-slate-500 ring-white/10",
};
const WORD: Record<MatchResult, string> = { W: "Win", L: "Loss", D: "Draw", "-": "Unknown" };

type Props = {
  /** Newest match first, like the match table. */
  results: MatchResult[];
};

/** The last few results at a glance, oldest on the left so it reads like a timeline. */
export default function RecentForm({ results }: Props) {
  // The current run of identical results, counted from the newest match.
  let streak = 0;
  while (streak < results.length && results[streak] === results[0]) streak++;
  const streakText =
    results.length === 0 || results[0] === "-" || results[0] === "D" || streak < 2
      ? null
      : `${streak}-${results[0] === "W" ? "win" : "loss"} streak`;

  return (
    <section className="panel p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="eyebrow">Recent form</h2>
        {streakText && (
          <span className={`text-xs font-medium ${results[0] === "W" ? "text-win" : "text-loss"}`}>{streakText}</span>
        )}
      </div>
      {results.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No matches yet.</p>
      ) : (
        <ol className="mt-3 flex flex-wrap gap-1.5" aria-label="Results, oldest to newest">
          {results
            .slice()
            .reverse()
            .map((r, i) => (
              <li
                key={i}
                title={WORD[r]}
                className={`flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold ring-1 ring-inset ${STYLE[r]}`}
              >
                <span aria-hidden>{r}</span>
                <span className="sr-only">{WORD[r]}</span>
              </li>
            ))}
        </ol>
      )}
    </section>
  );
}
