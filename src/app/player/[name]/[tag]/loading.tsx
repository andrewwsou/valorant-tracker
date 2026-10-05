/** Shown at once while a profile loads. A first-time lookup has to fetch matches, which takes a second or two. */
export default function Loading() {
  const block = "animate-pulse rounded-xl bg-white/6";
  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6" aria-busy="true">
      <p role="status" className="sr-only">Loading player profile</p>
      <div className={`${block} h-44 rounded-2xl md:h-56`} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-3">
          <div className={`${block} h-28`} />
          <div className={`${block} h-24`} />
        </div>
        <div className="space-y-6 lg:col-span-9">
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className={`${block} h-24`} />
            ))}
          </div>
          <div className={`${block} h-96`} />
        </div>
      </div>
    </main>
  );
}
