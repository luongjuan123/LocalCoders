import React from 'react';
import { useAppStore } from '../store/useAppStore';
import { GitBranch, Sparkles, CheckCircle, Radio } from 'lucide-react';

export const StatusBar: React.FC = () => {
  const { gitStatus, mainAgent, hardware } = useAppStore();

  return (
    <div className="h-6 bg-[#0b0f19] border-t border-[#1f2937] px-3 flex items-center justify-between text-[11px] text-[#64748b] select-none">
      <div className="flex items-center space-x-3">
        {/* Git Branch */}
        <div className="flex items-center space-x-1 text-[#94a3b8]">
          <GitBranch size={12} className="text-sky-400" />
          <span>{gitStatus.branch || 'main'}</span>
          {(gitStatus.staged.length > 0 || gitStatus.modified.length > 0) && (
            <span className="text-sky-400 font-bold">
              *{gitStatus.staged.length + gitStatus.modified.length}
            </span>
          )}
        </div>

        {/* Diagnostics */}
        <div className="flex items-center space-x-1">
          <CheckCircle size={11} className="text-emerald-400" />
          <span>0 Errors</span>
        </div>
      </div>

      <div className="flex items-center space-x-4">
        {/* Ollama Status */}
        <div className="flex items-center space-x-1 text-emerald-400">
          <Radio size={11} className="animate-pulse" />
          <span>Ollama v{hardware?.ollamaVersion || '0.40'}</span>
        </div>

        {/* Model */}
        <div className="flex items-center space-x-1 text-indigo-300 font-mono">
          <Sparkles size={11} />
          <span>{mainAgent?.model || 'No model selected'}</span>
        </div>

        <span>UTF-8</span>
        <span>TypeScript</span>
      </div>
    </div>
  );
};
