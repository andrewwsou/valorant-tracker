import Image from "next/image";

type Props = {
  rankIcon?: string;   
  rankText?: string;  
  // agentIcon?: string; 
  peakRankText?: string;

};


export default function CurrentRating({
  rankIcon,
  rankText,
  // agentIcon,
  peakRankText,
}: Props) {

  return (
    <section className="relative overflow-hidden rounded-2xl border bg-slate-800 p-5 text-slate-50">
      <div className="pointer-events-none absolute"/>

      <div className="relative z-10 flex items-center gap-4">
        <div className="h-16 w-16 overflow-hidden">
          { rankIcon ? (<Image src={rankIcon} alt="Rank" width={64} height={64}/>) : null }
        </div>

        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {rankText}<span className="text-slate-300"></span>
            </h1>
          </div>

          <div className="mt-1 flex items-center gap-3 text-sm text-slate-300">
            <span className="rounded text-white/70 py-0.5">
              Peak - {peakRankText ?? "Peak Rank"}
            </span>
            <span className="inline-flex items-center gap-1">
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}