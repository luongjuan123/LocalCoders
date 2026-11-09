import React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Shield, Star, Plus, Trash2, CheckCircle2 } from 'lucide-react';

export const AgentTeamView: React.FC = () => {
  const { mainAgent, subagents, criticConfig, installedModels, saveSetup } = useAppStore();

  const handleMainModelChange = (model: string) => {
    if (!mainAgent) return;
    saveSetup({ ...mainAgent, model }, subagents, criticConfig);
  };

  const handleCriticToggle = (enabled: boolean) => {
    saveSetup(mainAgent!, subagents, { ...criticConfig, enabled });
  };

  const handleCriticModelChange = (model: string) => {
    saveSetup(mainAgent!, subagents, { ...criticConfig, model });
  };

  const handleCriticStrictnessChange = (strictness: any) => {
    saveSetup(mainAgent!, subagents, { ...criticConfig, strictness });
  };

  return (
    <div className="flex flex-col h-full text-xs p-3 overflow-y-auto space-y-4">
      <div className="font-semibold uppercase tracking-wider text-[11px] text-[#94a3b8]">
        Agent Architecture Team
      </div>

      {/* Main Agent */}
      <div className="bg-[#0b0f19] border border-[#1f2937] border-l-2 border-l-indigo-500 rounded p-3">
        <div className="flex items-center space-x-2 text-indigo-400 font-semibold mb-2">
          <Star size={14} />
          <span>Main Agent (Mandatory)</span>
        </div>
        <p className="text-[#64748b] text-[11px] mb-2">
          Coordinates tasks, formulates implementation plans, executes tools, and delegates work.
        </p>
        <div className="space-y-1">
          <label className="text-[10px] uppercase text-[#94a3b8] font-bold">Assigned Model</label>
          <select
            value={mainAgent?.model || ''}
            onChange={(e) => handleMainModelChange(e.target.value)}
            className="w-full bg-[#1e293b] border border-[#334155] rounded px-2 py-1 text-xs text-[#f8fafc] outline-none"
          >
            {installedModels.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Critic Agent */}
      <div className="bg-[#0b0f19] border border-[#1f2937] border-l-2 border-l-rose-500 rounded p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center space-x-2 text-rose-400 font-semibold">
            <Shield size={14} />
            <span>Critic Agent (Auditor)</span>
          </div>
          <input
            type="checkbox"
            checked={criticConfig.enabled}
            onChange={(e) => handleCriticToggle(e.target.checked)}
            className="cursor-pointer"
          />
        </div>
        <p className="text-[#64748b] text-[11px] mb-2">
          Independent code review. Verifies security, logic flaws, memory leaks, and race conditions.
        </p>

        {criticConfig.enabled && (
          <div className="space-y-2 mt-2">
            <div>
              <label className="text-[10px] uppercase text-[#94a3b8] font-bold">Critic Model</label>
              <select
                value={criticConfig.model || mainAgent?.model || ''}
                onChange={(e) => handleCriticModelChange(e.target.value)}
                className="w-full bg-[#1e293b] border border-[#334155] rounded px-2 py-1 text-xs text-[#f8fafc] outline-none"
              >
                {installedModels.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase text-[#94a3b8] font-bold">Review Strictness</label>
              <select
                value={criticConfig.strictness}
                onChange={(e) => handleCriticStrictnessChange(e.target.value)}
                className="w-full bg-[#1e293b] border border-[#334155] rounded px-2 py-1 text-xs text-[#f8fafc] outline-none"
              >
                <option value="strict">Strict (Full defect audit)</option>
                <option value="paranoid">Paranoid (Ultra thorough)</option>
                <option value="moderate">Moderate</option>
                <option value="lenient">Lenient</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Subagents List */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="font-semibold text-emerald-400 uppercase tracking-wider text-[11px]">
            Subagents ({subagents.length})
          </span>
        </div>
        {subagents.length === 0 ? (
          <div className="text-[#64748b] text-center p-3 border border-dashed border-[#1f2937] rounded">
            No specialized subagents added. Main Agent operates all tasks directly.
          </div>
        ) : (
          <div className="space-y-2">
            {subagents.map((sub) => (
              <div key={sub.id} className="bg-[#0b0f19] border border-[#1f2937] rounded p-2 flex justify-between items-center">
                <div>
                  <strong className="text-[#f8fafc]">{sub.name}</strong>
                  <div className="text-[11px] text-[#64748b]">{sub.role} • {sub.model}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
