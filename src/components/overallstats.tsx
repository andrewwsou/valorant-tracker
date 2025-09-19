import Image from "next/image";

type Props = {
  wins?: number;
  losses?: number;
  draws?: number;
  winrate?: number;
};


export default function OverallStats({
  wins,
  losses,
  draws,
  winrate,
}: Props) {

  return (
      <section className="relative overflow-hidden rounded-2xl border bg-slate-800 p-5 text-slate-200">  
        <div className="grid grid-cols-1 lg:grid-cols-1 gap-2">
          <div className="lg:col-span-1">
            <h1 className="text-xl font-semibold tracking-tight">
                {wins} W
            </h1>
          </div>
          <div className="lg:col-span-1">
            <h1 className="text-xl font-semibold tracking-tight">
                {losses} L
            </h1>
          </div>
  
          <div className="lg:col-span-1">
              <span className="rounded text-white/70 py-0.5">
                hi
              </span>
          </div>
        </div>
      </section>
    );
  }