type Props = {
  wins?: number;
  losses?: number;
  draws?: number;
  winrate?: number;
  kd?: string;
  acs?: number;
  adr?: number;
  headshotPct?: number;
  trackerScore?: number;
};

type Tone = "plain" | "good" | "bad" | "accent";
const TONE: Record<Tone, string> = {
  plain: "text-slate-50",
  good: "text-win",
  bad: "text-loss",
  accent: "text-accent",
};
const BAR: Record<Tone, string> = { plain: "bg-slate-400", good: "bg-win", bad: "bg-loss", accent: "bg-accent" };

function Stat({
  label,
  value,
  hint,
  tone = "plain",
  meter,
}: {
  label: string;
  value: React.ReactNode;
  /** A short plain-language note under the number. */
  hint?: string;
  tone?: Tone;
  /** 0 to 100: draws a bar under the number. */
  meter?: number;
}) {
  // One <div> per label and value pair keeps the <dl> valid HTML.
  return (
    <div className="panel flex flex-col gap-1 p-3 sm:p-4">
      <dt className="eyebrow">{label}</dt>
      <dd className={`text-2xl font-bold sm:text-3xl leading-none tabular-nums ${TONE[tone]}`}>{value}</dd>
      {meter !== undefined && (
        <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
          <div className={`h-full rounded-full ${BAR[tone]}`} style={{ width: `${Math.max(0, Math.min(100, meter))}%` }} />
        </div>
      )}
      {hint && <p className="mt-auto hidden pt-1 text-xs text-slate-500 sm:block">{hint}</p>}
    </div>
  );
}

export default function OverallStats({ wins, losses, draws, winrate, kd, acs, adr, headshotPct, trackerScore }: Props) {
  // With no matches, every number is a zero that means "nothing yet", not "bad".
  const played = (wins ?? 0) + (losses ?? 0) + (draws ?? 0) > 0;
  const kdValue = Number(kd);
  const kdTone: Tone = !played || !Number.isFinite(kdValue) || kdValue === 1 ? "plain" : kdValue > 1 ? "good" : "bad";
  const winTone: Tone = !played || winrate === undefined || winrate === 50 ? "plain" : winrate > 50 ? "good" : "bad";

  return (
    <dl className="grid grid-cols-3 gap-2 sm:gap-3">
      <Stat label="Tracker Score" value={trackerScore} tone={played ? "accent" : "plain"} meter={trackerScore} hint="0 to 100, wins plus performance" />
      <Stat label="Winrate" value={`${winrate}%`} tone={winTone} meter={winrate} />
      <Stat label="KD" value={kd} tone={kdTone} hint="Kills per death" />
      <Stat label="ACS" value={acs} hint="Average combat score" />
      <Stat label="ADR" value={adr} hint="Damage per round" />
      {headshotPct !== undefined && <Stat label="HS%" value={`${headshotPct}%`} hint="Share of hits to the head" />}
      <Stat label="Wins" value={wins} />
      <Stat label="Losses" value={losses} />
      <Stat label="Draws" value={draws} />
    </dl>
  );
}
