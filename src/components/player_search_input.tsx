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

export default function PlayerSearch() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

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
    const clean = { name: r.name.trim(), tag: r.tag.trim() };
    if (!clean.name || !clean.tag) return;
    saveRecent(clean);
    router.push(`/player/${encodeURIComponent(clean.name)}/${encodeURIComponent(clean.tag)}`);
    setFocused(false);
  };

  const showSuggests = focused && !name && !tag && recent.length > 0;
  const showAutocomplete = focused && !!name && !!tag;

  return (
    <div // actual search bar
      ref={wrapRef}
      className="relative w-full max-w-xl mx-auto"
      onFocus={() => setFocused(true)}
    >
      <div className="flex gap-2 items-center bg-white border rounded px-3 py-2 shadow-sm">
        <input
          className="flex-1 outline-none text-gray-800"
          placeholder="Riot Name (e.g. TenZ)"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && go({ name, tag })}
        />
        <div aria-hidden className="mx-1 h-6 border-l" />
        <input
          className="w-36 outline-none text-gray-800"
          placeholder="Tag (e.g. NA1)"
          value={tag}
          onChange={e => setTag(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && go({ name, tag })}
        />
        <button
          className="px-3 py-1 rounded bg-black text-white"
          onClick={() => go({ name, tag })}
        >
          Search
        </button>
      </div>

      {showSuggests && ( // dropdown for recents and preview of searched person
        <div className="absolute left-0 right-0 mt-2 bg-[#1b2733] border rounded shadow z-10">
          <div className="px-3 py-2 text-xs font-semibold text-gray-200">Recent</div>
          {recent
            .slice()
            .reverse()
            .map((r, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-3 py-2 hover:bg-[#323d48]"
              >
                <button className="text-left flex-1" onClick={() => go(r)}>
                  <span className="font-medium text-gray-400">{r.name}</span>
                  <span className="text-gray-400">#{r.tag}</span>
                </button>
                <button
                  className="text-xs text-gray-400 hover:text-gray-300"
                  onClick={() => deleteRecent(r)}
                >
                  ✕
                </button>
              </div>
            ))}
        </div>
      )}

      {showAutocomplete && (
        <div className="absolute left-0 right-0 mt-2 bg-white border rounded shadow z-10 p-3">
          <button className="w-full text-left" onClick={() => go({ name, tag })}>
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded bg-gray-200" />
              <div className="flex-1">
                <div className="font-medium">
                  {name}
                  <span className="text-gray-800">#{tag}</span>
                </div>
                <div className="text-xs text-gray-800">Press Enter to search</div>
              </div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
