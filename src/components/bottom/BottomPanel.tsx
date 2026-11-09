import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Terminal, Shield, ListCollapse, X, Play, AlertCircle } from 'lucide-react';

export const BottomPanel: React.FC = () => {
  const {
    activeBottomTab,
    setActiveBottomTab,
    bottomPanelOpen,
    toggleBottomPanel,
    terminalLogs,
    criticReport,
    runTerminalCommand,
    submitAiPrompt,
  } = useAppStore();

  const [cmdInput, setCmdInput] = useState('');

  if (!bottomPanelOpen) return null;

  const handleRunCommand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cmdInput.trim()) return;
    const c = cmdInput.trim();
    setCmdInput('');
    runTerminalCommand(c);
  };

  const handleFixFinding = (finding: any) => {
    submitAiPrompt(
      `Please fix this defect discovered by the Critic Agent:
Severity: ${finding.severity}
File: ${finding.filePath} (lines ${finding.lineRange || 'N/A'})
Evidence: ${finding.evidence}
Problem: ${finding.explanation}
Fix: ${finding.recommendedFix}`
    );
  };

  return (
    <div className="h-56 bg-[#0b0f19] border-t border-[#1f2937] flex flex-col select-none text-xs">
      {/* Tabs Header */}
      <div className="h-8 bg-[#111827] border-b border-[#1f2937] flex items-center justify-between px-3">
        <div className="flex space-x-1">
          <button
            onClick={() => setActiveBottomTab('terminal')}
            className={`px-3 py-1 font-semibold flex items-center space-x-1.5 transition-colors ${
              activeBottomTab === 'terminal'
                ? 'text-sky-400 border-b-2 border-sky-400 bg-[#0b0f19]'
                : 'text-[#64748b] hover:text-[#cbd5e1]'
            }`}
          >
            <Terminal size={13} />
            <span>Terminal</span>
          </button>

          <button
            onClick={() => setActiveBottomTab('critic')}
            className={`px-3 py-1 font-semibold flex items-center space-x-1.5 transition-colors ${
              activeBottomTab === 'critic'
                ? 'text-rose-400 border-b-2 border-rose-400 bg-[#0b0f19]'
                : 'text-[#64748b] hover:text-[#cbd5e1]'
            }`}
          >
            <Shield size={13} />
            <span>Critic Reports {criticReport ? `(${criticReport.findings.length})` : ''}</span>
          </button>

          <button
            onClick={() => setActiveBottomTab('logs')}
            className={`px-3 py-1 font-semibold flex items-center space-x-1.5 transition-colors ${
              activeBottomTab === 'logs'
                ? 'text-indigo-400 border-b-2 border-indigo-400 bg-[#0b0f19]'
                : 'text-[#64748b] hover:text-[#cbd5e1]'
            }`}
          >
            <ListCollapse size={13} />
            <span>Agent Execution Logs</span>
          </button>
        </div>

        <button onClick={toggleBottomPanel} className="text-[#64748b] hover:text-[#f8fafc] p-1">
          <X size={14} />
        </button>
      </div>

      {/* Tab Contents */}
      <div className="flex-1 overflow-hidden p-2 flex flex-col">
        {/* Terminal Tab */}
        {activeBottomTab === 'terminal' && (
          <div className="flex-1 flex flex-col font-mono text-[11px] overflow-hidden">
            <div className="flex-1 overflow-y-auto space-y-0.5 text-[#cbd5e1] p-1">
              {terminalLogs.length === 0 ? (
                <div className="text-[#64748b]">LocalCoders Integrated Terminal ready. Enter a command below.</div>
              ) : (
                terminalLogs.map((log, i) => (
                  <div
                    key={i}
                    className={`whitespace-pre-wrap ${log.stream === 'stderr' ? 'text-rose-400' : 'text-[#cbd5e1]'}`}
                  >
                    {log.text}
                  </div>
                ))
              )}
            </div>
            <form onSubmit={handleRunCommand} className="flex items-center space-x-2 pt-1 border-t border-[#1f2937]">
              <span className="text-emerald-400 font-bold">$</span>
              <input
                type="text"
                value={cmdInput}
                onChange={(e) => setCmdInput(e.target.value)}
                placeholder="npm test, git status, ls -la..."
                className="flex-1 bg-transparent text-xs text-[#f8fafc] outline-none"
              />
              <button type="submit" className="text-sky-400 hover:text-sky-300 px-2 py-0.5">
                <Play size={12} />
              </button>
            </form>
          </div>
        )}

        {/* Critic Reports Tab */}
        {activeBottomTab === 'critic' && (
          <div className="flex-1 overflow-y-auto p-2 space-y-3">
            {!criticReport ? (
              <div className="text-[#64748b] text-center p-4">
                No code review report available yet. Run a task or git review to audit code.
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-[#f8fafc]">
                    Verdict: <span className="uppercase text-rose-400">{criticReport.verdict}</span>
                  </span>
                  <span className="text-[#64748b] text-[11px]">{criticReport.summary}</span>
                </div>

                {criticReport.findings.length === 0 ? (
                  <div className="text-emerald-400 font-semibold p-2 bg-emerald-500/10 rounded border border-emerald-500/30">
                    ✓ All changes verified without defects. Code approved.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {criticReport.findings.map((f) => (
                      <div
                        key={f.id}
                        className="bg-[#111827] border border-[#1f2937] border-l-2 border-l-rose-500 rounded p-2.5 space-y-1"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <span className="bg-rose-500/20 text-rose-400 font-bold text-[10px] px-1.5 py-0.5 rounded">
                              {f.severity}
                            </span>
                            <strong className="text-[#f8fafc]">{f.category}</strong>
                          </div>
                          <span className="font-mono text-[10px] text-sky-400">
                            {f.filePath}:{f.lineRange || ''}
                          </span>
                        </div>
                        <p className="text-[#cbd5e1] text-[11px]">{f.explanation}</p>
                        {f.evidence && (
                          <div className="bg-[#0b0f19] p-1.5 rounded font-mono text-[10px] text-[#94a3b8]">
                            <strong>Evidence:</strong> {f.evidence}
                          </div>
                        )}
                        {f.recommendedFix && (
                          <div className="bg-[#0b0f19] p-1.5 rounded font-mono text-[10px] text-emerald-300">
                            <strong>Recommended Fix:</strong> {f.recommendedFix}
                          </div>
                        )}
                        <button
                          onClick={() => handleFixFinding(f)}
                          className="px-2.5 py-1 bg-emerald-500 hover:bg-emerald-600 text-white font-bold rounded text-[10px] mt-1"
                        >
                          Ask Main Agent to Fix This
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Agent Logs Tab */}
        {activeBottomTab === 'logs' && (
          <div className="flex-1 overflow-y-auto font-mono text-[11px] p-2 space-y-1 text-[#94a3b8]">
            <div className="text-[#64748b]">Multi-agent orchestration execution trace:</div>
            {terminalLogs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {l.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
