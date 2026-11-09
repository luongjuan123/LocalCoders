import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Download, Trash2, CheckCircle2, Search, Cpu } from 'lucide-react';

export const ModelManagerView: React.FC = () => {
  const { installedModels, modelCatalogue, pullModel, deleteModel } = useAppStore();
  const [search, setSearch] = useState('');
  const [pulling, setPulling] = useState<string | null>(null);

  const filteredCatalogue = modelCatalogue.filter(
    (m) =>
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.tag.toLowerCase().includes(search.toLowerCase()) ||
      m.category.toLowerCase().includes(search.toLowerCase())
  );

  const handlePull = async (tag: string) => {
    setPulling(tag);
    try {
      await pullModel(tag);
    } finally {
      setPulling(null);
    }
  };

  return (
    <div className="flex flex-col h-full text-xs p-3 overflow-y-auto space-y-4">
      <div className="font-semibold uppercase tracking-wider text-[11px] text-[#94a3b8] flex items-center justify-between">
        <span>Ollama Model Manager</span>
        <Cpu size={14} className="text-sky-400" />
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-2.5 text-[#64748b]" />
        <input
          type="text"
          placeholder="Filter models (qwen, deepseek, coder)..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-[#0b0f19] border border-[#334155] rounded pl-8 pr-2 py-1.5 text-xs text-[#f8fafc] outline-none"
        />
      </div>

      {/* Installed Models */}
      <div>
        <div className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider mb-2">
          Installed Models ({installedModels.length})
        </div>
        <div className="space-y-2">
          {installedModels.map((m) => (
            <div key={m.name} className="bg-[#0b0f19] border border-[#1f2937] rounded p-2 flex justify-between items-center">
              <div>
                <strong className="text-[#f8fafc]">{m.name}</strong>
                <div className="text-[10px] text-[#64748b]">
                  {(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB • {m.details?.parameter_size || 'N/A'}
                </div>
              </div>
              <button
                onClick={() => deleteModel(m.name)}
                className="p-1.5 text-rose-400 hover:bg-rose-500/10 rounded"
                title="Delete Model"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Model Catalogue */}
      <div>
        <div className="text-[11px] font-semibold text-sky-400 uppercase tracking-wider mb-2">
          Catalogue
        </div>
        <div className="space-y-2">
          {filteredCatalogue.map((c) => (
            <div key={c.tag} className="bg-[#0b0f19] border border-[#1f2937] rounded p-2.5 space-y-1.5">
              <div className="flex justify-between items-start">
                <div>
                  <strong className="text-[#f8fafc]">{c.name}</strong>
                  <div className="text-[10px] text-[#64748b] font-mono">{c.tag}</div>
                </div>
                {c.installed ? (
                  <span className="flex items-center space-x-1 text-emerald-400 text-[10px] font-semibold">
                    <CheckCircle2 size={12} />
                    <span>Ready</span>
                  </span>
                ) : (
                  <button
                    onClick={() => handlePull(c.tag)}
                    disabled={pulling === c.tag}
                    className="px-2 py-1 bg-sky-500 hover:bg-sky-600 disabled:opacity-50 text-[#0f172a] rounded font-semibold text-[11px] flex items-center space-x-1"
                  >
                    <Download size={12} />
                    <span>{pulling === c.tag ? 'Pulling...' : 'Pull'}</span>
                  </button>
                )}
              </div>
              <p className="text-[#94a3b8] text-[11px] line-clamp-2">{c.description}</p>
              <div className="flex items-center space-x-2 text-[10px] text-[#64748b]">
                <span className="bg-[#1e293b] px-1.5 py-0.5 rounded text-sky-300 uppercase">{c.category}</span>
                <span>{c.size}</span>
                <span>Min {c.minRamGb} GB RAM</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
