type Props = {
  wins?: number;
  losses?: number;
  draws?: number;
  winrate?: number;
  kd?: string;
  acs?: number;
  adr?: number;
};

function Stat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={`relative ${accent ? "pl-3 border-l border-slate-600" : ""}`}>
      <div className="flex flex-col leading-tight">
        <span className="text-xs uppercase tracking-wide text-slate-400">
          {label}
        </span>
        <span className="text-3xl font-extrabold text-slate-100 tabular-nums">
          {value}
        </span>
      </div>
    </div>
  );
}

export default function OverallStats({ wins, losses, draws, winrate, kd, acs, adr }: Props) {

  return (
    <section className="relative overflow-hidden rounded-2xl border border-slate-700 bg-slate-800 p-5 text-slate-200">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
        <Stat label="Wins" value={wins} accent />
        <Stat label="Losses" value={losses} />
        <Stat label="Draws" value={draws} />
        <Stat label="Winrate" value={`${winrate}%`} />
        <Stat label="KD" value={kd} accent/>
        <Stat label="ACS" value={acs} />
        <Stat label="ADR" value={adr} />
      </div>
    </section>
  );
}
