'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Recent = { name: string; tag: string };

// check for if recent data in localstorage is proper format - strings
const isRecent = (x: unknown): x is Recent => {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.name === 'string' && typeof r.tag === 'string';
};

type Props = {
  /** "hero" is the big box on the home page; "compact" fits in the top bar. */
  variant?: 'hero' | 'compact';
};

export default function PlayerSearch({ variant = 'hero' }: Props) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLInputElement>(null);
  const hero = variant === 'hero';

  useEffect(() => {         // loads recent searches from local data
    const raw = localStorage.getItem('recentSearches');
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const arr: Recent[] = Array.isArray(parsed) ? parsed.filter(isRecent).slice(-5) : [];
      setRecent(arr);
    } catch {
    }
  }, []);

  const saveRecent = (r: Recent) => {
    setRecent(prev => {
      const next = [...prev.filter(x => !(x.name === r.name && x.tag === r.tag)), r].slice(-5);
      localStorage.setItem('recentSearches', JSON.stringify(next));
      return next;
    });
  };

  const deleteRecent = (r: Recent) => {
    setRecent(prev => {
      const next = prev.filter(x => !(x.name === r.name && x.tag === r.tag));
      localStorage.setItem('recentSearches', JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {       // listens for clicks outside of search bar to close dropdown
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setFocused(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const go = (r: Recent) => {       // saves search, then navigates page to the player and tag using router, closes dropdown
    const clean = { name: r.name.trim(), tag: r.tag.trim().replace(/^#/, '') };
    if (!clean.name || !clean.tag) return;
    saveRecent(clean);
    router.push(`/player/${encodeURIComponent(clean.name)}/${encodeURIComponent(clean.tag)}`);
    setFocused(false);
    setName('');
    setTag('');
  };

  // Pasting or typing a whole Riot ID ("TenZ#NA1") into the name box fills both boxes.
  const onNameChange = (value: string) => {
    const hash = value.indexOf('#');
    if (hash === -1) return setName(value);
    setName(value.slice(0, hash));
    setTag(value.slice(hash + 1));
    tagRef.current?.focus();
  };

  const showSuggests = focused && !name && !tag && recent.length > 0;
  const showAutocomplete = focused && !!name && !!tag;
  const dropdown = 'absolute left-0 right-0 z-20 mt-2 overflow-hidden rounded-xl border border-white/10 bg-ink-800 shadow-2xl shadow-black/50';

  return (
    <div // actual search bar
      ref={wrapRef}
      className={`relative w-full ${hero ? 'mx-auto max-w-2xl' : 'max-w-md'}`}
      onFocus={() => setFocused(true)}
    >
      <div
        role="search"
        className={`flex items-center border border-white/10 bg-ink-800 transition focus-within:border-accent/70 focus-within:ring-2 focus-within:ring-accent/25 ${
          hero ? 'gap-2 rounded-2xl p-2 pl-4 shadow-xl shadow-black/40' : 'gap-1 rounded-lg py-1 pl-3 pr-1'
        }`}
      >
        <svg aria-hidden viewBox="0 0 20 20" className={`shrink-0 text-slate-500 ${hero ? 'h-5 w-5' : 'h-4 w-4'}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="9" cy="9" r="6" />
          <path d="m14 14 4 4" />
        </svg>
        <input
          aria-label="Riot name"
          className={`min-w-0 flex-1 bg-transparent text-slate-100 outline-none placeholder:text-slate-500 ${hero ? 'px-2 py-2 text-base' : 'px-1 py-1 text-sm'}`}
          placeholder="Riot Name (e.g. TenZ)"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={e => onNameChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && go({ name, tag })}
        />
        <span aria-hidden className={`select-none font-mono text-slate-500 ${hero ? 'text-lg' : 'text-sm'}`}>#</span>
        <input
          ref={tagRef}
          aria-label="Tag"
          className={`bg-transparent text-slate-100 outline-none placeholder:text-slate-500 ${hero ? 'w-32 px-1 py-2 text-base' : 'w-28 px-1 py-1 text-sm'}`}
          placeholder="Tag (e.g. NA1)"
          autoComplete="off"
          spellCheck={false}
          value={tag}
          onChange={e => setTag(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && go({ name, tag })}
        />
        <button
          className={`shrink-0 rounded-xl bg-accent font-semibold text-white transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40 ${
            hero ? 'px-5 py-2.5 text-sm' : 'rounded-md px-3 py-1 text-xs'
          }`}
          onClick={() => go({ name, tag })}
        >
          Search
        </button>
      </div>

      {showSuggests && ( // dropdown for recents and preview of searched person
        <div className={dropdown}>
          <div className="eyebrow px-4 pb-1 pt-3">Recent</div>
          {recent
            .slice()
            .reverse()
            .map((r, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-2 hover:bg-white/5"
              >
                <button className="flex-1 px-2 py-2.5 text-left text-sm" onClick={() => go(r)}>
                  <span className="font-medium text-slate-100">{r.name}</span>
                  <span className="text-slate-400">#{r.tag}</span>
                </button>
                <button
                  aria-label="Remove from recent searches"
                  className="rounded px-2 py-1 text-xs text-slate-500 hover:text-slate-200"
                  onClick={() => deleteRecent(r)}
                >
                  ✕
                </button>
              </div>
            ))}
        </div>
      )}

      {showAutocomplete && (
        <div className={dropdown}>
          <button className="w-full px-4 py-3 text-left hover:bg-white/5" onClick={() => go({ name, tag })}>
            <div className="text-sm font-medium text-slate-100">
              {name}
              <span className="text-slate-400">#{tag}</span>
            </div>
            <div className="text-xs text-slate-500">Press Enter to open this profile</div>
          </button>
        </div>
      )}
    </div>
  );
}
