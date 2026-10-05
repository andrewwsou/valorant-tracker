import Image from "next/image";

type Props = {
  name?: string;
  tag?: string;
  smallCard?: string;
  /** Short facts shown as chips under the name, such as the region. */
  chips?: string[];
};

export default function PlayerBanner({ name, tag, smallCard, chips = [] }: Props) {
  const safeSmall = smallCard && (smallCard.startsWith("http://") || smallCard.startsWith("https://"))
    ? smallCard
    : "/icon.png";

  return (
    <section className="relative h-44 overflow-hidden rounded-2xl border border-white/8 md:h-56">
      <Image
        src={"/banners/banner3.webp"}
        alt=""
        fill
        className="object-cover object-[50%_10%]"
        priority
        sizes="100vw"
      />

      {/* Fades the art into the page so the name stays readable on any banner. */}
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/60 to-transparent" />

      <div className="relative z-10 flex h-full items-end gap-4 p-5 md:p-7">
        <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-ink-700 ring-2 ring-white/15">
          <Image
            src={safeSmall}
            alt="Player Icon"
            fill
            className="object-cover"
            sizes="80px"
          />
        </div>

        <div className="min-w-0">
          <h1 className="truncate text-3xl font-bold tracking-tight text-white md:text-4xl">
            {name} <span className="font-medium text-white/55">#{tag}</span>
          </h1>
          {chips.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {chips.map((chip) => (
                <li key={chip} className="rounded-full border border-white/12 bg-black/35 px-2.5 py-0.5 text-xs text-slate-200 backdrop-blur">
                  {chip}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
