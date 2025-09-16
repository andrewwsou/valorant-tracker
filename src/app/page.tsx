import Image from "next/image";
import PlayerSearch from '@/components/player_search_input';

export default function Home() {
  return (
    <div className="font-sans min-h-screen flex">
      <main className="flex-1 flex items-center justify-center px-4 py-8">
        <PlayerSearch />
      </main>


      <footer className="row-start-3 flex gap-[24px] flex-wrap items-center justify-center">
       
      </footer>
    </div>
  );
}
