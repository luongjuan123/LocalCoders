import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { GitCommit, Sparkles, Check, Plus, RefreshCw } from 'lucide-react';

export const GitView: React.FC = () => {
  const { gitStatus, refreshGit, openFile } = useAppStore();
  const [commitMsg, setCommitMsg] = useState('');
  const [loadingAi, setLoadingAi] = useState(false);

  const api = (window as any).localCodersAPI;

  const handleStageAll = async () => {
    await api.git.stageAll();
    refreshGit();
  };

  const handleCommit = async () => {
    if (!commitMsg.trim()) return;
    await api.git.commit(commitMsg.trim());
    setCommitMsg('');
    refreshGit();
  };

  const generateAiCommitMsg = async () => {
    setLoadingAi(true);
    try {
      const diff = await api.git.getDiff();
      const res = await api.agents.submitTask(
        `Generate a conventional, concise 1-line git commit message for this diff:\n${diff.slice(0, 3000)}`
      );
      if (res?.title) {
        setCommitMsg(res.title);
      }
    } catch {
      setCommitMsg('feat: multi-agent code update');
    } finally {
      setLoadingAi(false);
    }
  };

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="p-3 border-b border-[#1f2937] flex items-center justify-between">
        <span className="font-semibold uppercase tracking-wider text-[11px] text-[#94a3b8]">
          Source Control ({gitStatus.branch || 'detached'})
        </span>
        <button onClick={refreshGit} className="p-1 hover:bg-[#1e293b] rounded text-[#94a3b8]">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Commit Box */}
      <div className="p-3 border-b border-[#1f2937] flex flex-col space-y-2">
        <div className="relative">
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Message (Ctrl+Enter to commit)..."
            rows={2}
            className="w-full bg-[#0b0f19] border border-[#334155] rounded p-2 text-xs text-[#f8fafc] resize-none outline-none focus:border-sky-400"
          />
          <button
            onClick={generateAiCommitMsg}
            disabled={loadingAi}
            className="absolute right-2 bottom-2 text-indigo-400 hover:text-indigo-300 p-1"
            title="Generate AI Commit Message"
          >
            <Sparkles size={13} className={loadingAi ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="flex space-x-2">
          <button
            onClick={handleCommit}
            disabled={!commitMsg.trim()}
            className="flex-1 bg-sky-500 hover:bg-sky-600 disabled:opacity-50 text-[#0f172a] font-semibold py-1.5 rounded flex items-center justify-center space-x-1"
          >
            <GitCommit size={14} />
            <span>Commit</span>
          </button>
          <button
            onClick={handleStageAll}
            className="px-3 bg-[#1e293b] hover:bg-[#334155] text-[#cbd5e1] rounded font-medium"
            title="Stage All"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Changed Files Lists */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {/* Staged */}
        {gitStatus.staged.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider mb-1">
              Staged Changes ({gitStatus.staged.length})
            </div>
            {gitStatus.staged.map((f) => (
              <div
                key={f}
                onClick={() => openFile(f)}
                className="flex items-center justify-between py-1 px-2 rounded hover:bg-[#1e293b] cursor-pointer text-[#cbd5e1]"
              >
                <span className="truncate">{f}</span>
                <span className="text-[10px] text-emerald-400 font-bold">A</span>
              </div>
            ))}
          </div>
        )}

        {/* Modified */}
        {gitStatus.modified.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold text-sky-400 uppercase tracking-wider mb-1">
              Changes ({gitStatus.modified.length})
            </div>
            {gitStatus.modified.map((f) => (
              <div
                key={f}
                onClick={() => openFile(f)}
                className="flex items-center justify-between py-1 px-2 rounded hover:bg-[#1e293b] cursor-pointer text-[#cbd5e1]"
              >
                <span className="truncate">{f}</span>
                <span className="text-[10px] text-sky-400 font-bold">M</span>
              </div>
            ))}
          </div>
        )}

        {/* Untracked */}
        {gitStatus.untracked.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold text-[#64748b] uppercase tracking-wider mb-1">
              Untracked ({gitStatus.untracked.length})
            </div>
            {gitStatus.untracked.map((f) => (
              <div
                key={f}
                onClick={() => openFile(f)}
                className="flex items-center justify-between py-1 px-2 rounded hover:bg-[#1e293b] cursor-pointer text-[#cbd5e1]"
              >
                <span className="truncate">{f}</span>
                <span className="text-[10px] text-[#64748b] font-bold">U</span>
              </div>
            ))}
          </div>
        )}

        {gitStatus.staged.length === 0 && gitStatus.modified.length === 0 && gitStatus.untracked.length === 0 && (
          <div className="p-4 text-center text-[#64748b]">Working tree clean. No changes.</div>
        )}
      </div>
    </div>
  );
};
