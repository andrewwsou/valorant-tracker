'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import PlayerSearch from '@/components/player_search_input';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/leaderboard', label: 'Leaderboard' },
];

/** The top bar: brand, page links, and a search box on every page but the home page (which has the big one). */
export default function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-white/8 bg-ink-950/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <nav aria-label="Main" className="flex items-center gap-1 text-sm">
          <Link href="/" className="mr-3 flex items-center gap-2 font-semibold tracking-tight text-slate-50">
            <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 text-accent" fill="currentColor">
              <path d="M12 2 22 12 12 22 2 12Zm0 4.2L6.2 12 12 17.8 17.8 12Z" />
              <circle cx="12" cy="12" r="2.2" />
            </svg>
            <span>
              VALORANT <span className="text-accent">StatTrack</span>
            </span>
          </Link>
          {LINKS.map(({ href, label }) => {
            const current = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={current ? 'page' : undefined}
                // On a phone the brand already links home, so only the other links show.
                className={`rounded-md px-3 py-1.5 ${href === '/' ? 'hidden sm:block' : ''} ${
                  current ? 'bg-white/8 text-slate-50' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
        {pathname !== '/' && (
          <div className="ml-auto hidden w-full max-w-md md:block">
            <PlayerSearch variant="compact" />
          </div>
        )}
      </div>
    </header>
  );
}
