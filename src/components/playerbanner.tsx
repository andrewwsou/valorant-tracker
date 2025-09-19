import Image from "next/image";

type Props = {
  name: string;
  tag: string;
  rankIcon?: string;   
  rankText?: string;  
  agentIcon?: string; 
//   peakRankIcon?: string;
//   peakRankText?: string;

};


export default function PlayerBanner({
  name,
  tag,
  rankIcon,
  rankText,
  agentIcon,
//   peakRankIcon,
//   peakRankText,
}: Props) {

  return (
    <section className="relative overflow-hidden rounded-2xl border bg-gradient-to-r from-slate-800 to-slate-700 p-5 text-slate-50">
      <div className="pointer-events-none absolute inset-0 opacity-10"
           style={{ backgroundImage: "radial-gradient(transparent 1px, rgba(255,255,255,0.3) 1px)", backgroundSize: "6px 6px" }} />

      <div className="relative z-10 flex items-center gap-4">
        <div className="h-16 w-16 overflow-hidden">
          {agentIcon ? (
            <Image src={agentIcon} alt="Player Banner" width={64} height={64} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-lg font-semibold">
              {name?.[0]?.toUpperCase() ?? "?"}
            </div>
          )}
        </div>

        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {name}<span className="text-slate-300">#{tag}</span>
            </h1>

            {rankIcon ? (
              <Image
                src={rankIcon}
                alt="Rank"
                width={28}
                height={28}
                className="rounded-sm"
              />
            ) : null}
          </div>

          <div className="mt-1 flex items-center gap-3 text-sm text-slate-300">
            <span className="rounded bg-white/10 px-2 py-0.5">
              {rankText ?? "Unrated"}
            </span>
            <span className="inline-flex items-center gap-1">
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}