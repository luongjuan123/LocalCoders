import React from 'react';
import { useAppStore } from '../store/useAppStore';
import { Cpu, FolderOpen } from 'lucide-react';

export const TitleBar: React.FC = () => {
  const { workspacePath, agentStatus, activeAgentActivity, mainAgent, openDirectoryDialog } = useAppStore();
  const projectName = workspacePath ? workspacePath.split('/').pop() : 'No Folder Opened';

  return (
    <div className="h-9 bg-[#111214] border-b border-[#27272a] flex items-center justify-between px-3 select-none text-xs text-[#8b8f98]">
      {/* Left: Workspace */}
      <div className="flex items-center space-x-3">
        <span className="inline-flex items-center gap-1.5 font-semibold text-[#e4e4e7]">
          <svg width="16" height="16" viewBox="0 0 512 512" aria-hidden="true">
            <defs>
              <linearGradient id="tbLcAura" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#22d3ee"/><stop offset="50%" stopColor="#818cf8"/><stop offset="100%" stopColor="#34d399"/></linearGradient>
            </defs>
            <rect x="20" y="20" width="472" height="472" rx="116" fill="#090c15" stroke="url(#tbLcAura)" strokeOpacity="0.6" strokeWidth="16"/>
            <circle cx="256" cy="256" r="168" fill="none" stroke="url(#tbLcAura)" strokeWidth="14" strokeOpacity="0.72"/>
            <path d="M 158 192 L 158 310 Q 158 320 168 320 L 220 320" fill="none" stroke="#f8fafc" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M 354 206 C 336 178 270 182 270 256 C 270 330 336 334 354 306" fill="none" stroke="#f8fafc" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span>LocalCoders</span>
        </span>
        <span className="text-[#3f3f46]">/</span>
        <button
          onClick={openDirectoryDialog}
          className="flex items-center space-x-1.5 px-2 py-1 rounded hover:bg-[#1e2025] text-[#d4d4d8] transition-colors"
          title="Open Project Directory"
        >
          <FolderOpen size={13} className="text-[#8b8f98]" />
          <span className="font-medium truncate max-w-[200px]">{projectName}</span>
        </button>
      </div>

      {/* Center: Agent Status */}
      <div className="flex items-center space-x-2">
        <div className="flex items-center space-x-1.5 px-2.5 py-0.5 rounded bg-[#16171a] border border-[#27272a]">
          <span className={`w-1.5 h-1.5 rounded-full ${agentStatus === 'working' ? 'bg-zinc-200' : 'bg-emerald-500'}`} />
          <span className="font-medium text-[11px] capitalize text-[#d4d4d8]">
            {agentStatus}
          </span>
          {activeAgentActivity && (
            <span className="text-[#8b8f98] text-[11px] truncate max-w-[300px]">
              - {activeAgentActivity}
            </span>
          )}
        </div>
      </div>

      {/* Right: Active Model */}
      <div className="flex items-center space-x-3">
        <div className="flex items-center space-x-1 text-[#71717a]">
          <Cpu size={12} />
          <span className="text-[#d4d4d8] font-mono text-[11px]">
            {mainAgent?.model || 'No model selected'}
          </span>
        </div>
      </div>
    </div>
  );
};
