import React from 'react';
import { useAppStore } from '../store/useAppStore';
import { Bot, Sparkles, FolderOpen, Sliders } from 'lucide-react';

export const TitleBar: React.FC = () => {
  const { workspacePath, agentStatus, activeAgentActivity, mainAgent, openDirectoryDialog } = useAppStore();
  const projectName = workspacePath ? workspacePath.split('/').pop() : 'No Folder Opened';

  return (
    <div className="h-9 bg-[#0b0f19] border-b border-[#1f2937] flex items-center justify-between px-3 select-none text-xs text-[#94a3b8]">
      {/* Left: Branding & Folder */}
      <div className="flex items-center space-x-3">
        <div className="flex items-center space-x-2 font-bold text-[#f8fafc]">
          <span className="w-4 h-4 rounded bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-[10px] text-white">
            LC
          </span>
          <span className="tracking-wide">LocalCoders</span>
        </div>
        <span className="text-[#475569]">|</span>
        <button
          onClick={openDirectoryDialog}
          className="flex items-center space-x-1.5 px-2 py-1 rounded hover:bg-[#1e293b] text-[#cbd5e1] transition-colors"
          title="Open Project Directory"
        >
          <FolderOpen size={13} className="text-sky-400" />
          <span className="font-medium truncate max-w-[200px]">{projectName}</span>
        </button>
      </div>

      {/* Center: Live Agent Activity Status Pill */}
      <div className="flex items-center space-x-2">
        <div className="flex items-center space-x-1.5 px-2.5 py-0.5 rounded-full bg-[#1e293b] border border-[#334155]">
          <Bot size={12} className={agentStatus === 'working' ? 'text-emerald-400 animate-pulse' : 'text-sky-400'} />
          <span className="font-semibold text-[11px] uppercase tracking-wider text-[#f8fafc]">
            {agentStatus}
          </span>
          {activeAgentActivity && (
            <span className="text-[#94a3b8] text-[11px] truncate max-w-[300px]">
              — {activeAgentActivity}
            </span>
          )}
        </div>
      </div>

      {/* Right: Active Model & Controls */}
      <div className="flex items-center space-x-3">
        <div className="flex items-center space-x-1 text-[#64748b]">
          <Sparkles size={12} className="text-indigo-400" />
          <span className="text-[#cbd5e1] font-mono text-[11px]">
            {mainAgent?.model || 'No Model Configured'}
          </span>
        </div>
      </div>
    </div>
  );
};
