import PlayerSearch from "@/components/player_search_input";

export default function Home() {
  // Fills the space under the nav and centers the search box in it.
  return (
    <div className="font-sans flex flex-1 flex-col">
      <main className="flex flex-1 items-center justify-center px-4 py-8">
        <PlayerSearch />
      </main>
    </div>
  );
}
