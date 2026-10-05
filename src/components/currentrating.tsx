import Image from "next/image";

type Props = {
  rankIcon?: string;
  rankText?: string;
  peakRankText?: string;
};

export default function CurrentRating({ rankIcon, rankText, peakRankText }: Props) {
  return (
    <section className="panel flex items-center gap-4 p-5">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-ink-800">
        {rankIcon ? <Image src={rankIcon} alt="Rank" width={56} height={56} /> : <span aria-hidden className="text-2xl text-slate-600">?</span>}
      </div>

      <div className="min-w-0">
        <h2 className="truncate text-xl font-semibold tracking-tight text-slate-50">{rankText ?? "Unranked"}</h2>
        <p className="mt-0.5 text-sm text-slate-400">{peakRankText ? `Peak - ${peakRankText}` : "Peak rank unavailable"}</p>
      </div>
    </section>
  );
}
