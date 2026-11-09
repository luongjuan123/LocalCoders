import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Search } from 'lucide-react';

export const SearchView: React.FC = () => {
  const { openFile } = useAppStore();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ file: string; line: number; text: string }>>([]);
  const [searching, setSearching] = useState(false);

  const api = (window as any).localCodersAPI;

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await api.fs.searchCodebase(query.trim());
      setResults(res || []);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="flex flex-col h-full text-xs p-3">
      <div className="font-semibold uppercase tracking-wider text-[11px] text-[#94a3b8] mb-3">
        Search Across Files
      </div>

      <div className="relative mb-3">
        <input
          type="text"
          placeholder="Search text..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="w-full bg-[#0b0f19] border border-[#334155] rounded pl-8 pr-2 py-1.5 text-xs text-[#f8fafc] outline-none"
        />
        <Search size={13} className="absolute left-2.5 top-2.5 text-[#64748b]" />
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        {searching && <div className="text-[#64748b] text-center">Searching codebase...</div>}
        {!searching && results.length === 0 && query && (
          <div className="text-[#64748b] text-center">No results found.</div>
        )}
        {results.map((r, i) => (
          <div
            key={i}
            onClick={() => openFile(r.file)}
            className="p-2 bg-[#0b0f19] hover:bg-[#1e293b] border border-[#1f2937] rounded cursor-pointer"
          >
            <div className="flex justify-between text-sky-400 font-mono text-[11px]">
              <span className="truncate">{r.file}</span>
              <span>:{r.line}</span>
            </div>
            <div className="text-[#94a3b8] font-mono text-[11px] truncate mt-0.5">{r.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
};
