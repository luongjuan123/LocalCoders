import React from 'react';
import { useAppStore } from '../store/useAppStore';
import { GitBranch, CheckCircle, Terminal } from 'lucide-react';

export const StatusBar: React.FC = () => {
  const { gitStatus, mainAgent, hardware } = useAppStore();

  return (
    <div className="h-6 bg-[#111214] border-t border-[#27272a] px-3 flex items-center justify-between text-[11px] text-[#71717a] select-none">
      <div className="flex items-center space-x-3">
        <div className="flex items-center space-x-1 text-[#a1a1aa]">
          <GitBranch size={12} />
          <span>{gitStatus.branch || 'main'}</span>
          {(gitStatus.staged.length > 0 || gitStatus.modified.length > 0) && (
            <span className="text-[#e4e4e7] font-medium">
              *{gitStatus.staged.length + gitStatus.modified.length}
            </span>
          )}
        </div>

        <div className="flex items-center space-x-1">
          <CheckCircle size={11} />
          <span>0 Errors</span>
        </div>
      </div>

      <div className="flex items-center space-x-4">
        <div className="flex items-center space-x-1 text-[#a1a1aa]">
          <span>Ollama v{hardware?.ollamaVersion || '0.40'}</span>
        </div>

        <div className="flex items-center space-x-1 text-[#d4d4d8] font-mono">
          <Terminal size={11} />
          <span>{mainAgent?.model || 'No model selected'}</span>
        </div>

        <span>UTF-8</span>
        <span>TypeScript</span>
      </div>
    </div>
  );
};
