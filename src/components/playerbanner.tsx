import Image from "next/image";

type Props = {
  name?: string;
  tag?: string;
  smallCard?: string;
  wideCard?: string;
};


export default function PlayerBanner({
  name,
  tag,
  smallCard,
  wideCard,
}: Props) {

  return (
    <section className="relative h-40 md:h-56 lg:h-50 overflow-hidden rounded-2xl">
    { wideCard ? (
    <Image
        src={'/banners/banner3.webp'}
        alt={`${name ?? "Player"} banner`}
        fill
        className="object-cover object-[50%_10%]"
        priority
        sizes="50vw"
    /> ) : null}
    <div className="absolute inset-0 bg-black/40" />

    <div className="relative z-10 h-full p-4 md:p-6 flex items-end gap-4">
        <div className="relative h-16 w-16 overflow-hidden rounded bg-gray-200/80 ">
        <Image
            src={smallCard || "Icon"}
            alt={"Player Icon"}
            fill
        />
        </div>
        <h1 className="text-2xl font-semibold text-white">
            {name} <span className="text-white/70">#{tag}</span>
        </h1>
        {/* <p className="text-sm text-white/80">Competitive · last 10 matches</p> */}
    </div>
    </section>
  );
  }