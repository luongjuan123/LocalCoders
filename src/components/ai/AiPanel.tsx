import React, { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Send, Square, AlertTriangle, Check, X } from 'lucide-react';

export const AiPanel: React.FC = () => {
  const {
    agentMessages,
    agentStatus,
    activeAgentActivity,
    currentPlan,
    pendingApproval,
    submitAiPrompt,
    cancelAiTask,
    resolveApproval,
  } = useAppStore();

  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'agent' | 'plan' | 'ask' | 'review'>('agent');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [agentMessages, currentPlan, pendingApproval]);

  const handleSend = () => {
    if (!prompt.trim()) return;
    const p = prompt;
    setPrompt('');
    submitAiPrompt(mode === 'review' ? `[Review Mode] ${p}` : p);
  };

  return (
    <div className="w-80 bg-[#16171a] border-l border-[#27272a] flex flex-col h-full overflow-hidden select-none">
      {/* Top Mode Selector Bar */}
      <div className="p-2 border-b border-[#27272a] bg-[#111214] flex justify-between items-center text-xs">
        <div className="flex space-x-1">
          {(['agent', 'plan', 'ask', 'review'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-1 rounded text-[11px] font-medium capitalize transition-colors ${
                mode === m ? 'bg-[#27272a] text-[#f4f4f5]' : 'text-[#71717a] hover:text-[#e4e4e7]'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="flex items-center space-x-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${agentStatus === 'working' ? 'bg-zinc-200' : 'bg-emerald-500'}`} />
          <span className="text-[11px] text-[#8b8f98] capitalize">{agentStatus}</span>
        </div>
      </div>

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
        {agentMessages.length === 0 && (
          <div className="p-4 text-center text-[#71717a] space-y-1 mt-8">
            <p className="font-medium text-[#e4e4e7]">New session</p>
            <p className="text-[11px]">Type a task or question below.</p>
          </div>
        )}

        {agentMessages.map((msg) => (
          <div
            key={msg.id}
            className={`p-3 rounded-lg border leading-relaxed ${
              msg.senderRole === 'user'
                ? 'bg-[#1e2025] border-[#2e3138] text-[#f4f4f5]'
                : 'bg-transparent border-[#27272a] text-[#d4d4d8]'
            }`}
          >
            <div className="flex items-center justify-between mb-1 font-medium text-[11px]">
              <span className="text-[#a1a1aa]">{msg.senderName}</span>
              <span className="text-[10px] text-[#71717a]">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>

            <div className="whitespace-pre-wrap">{msg.content}</div>
          </div>
        ))}

        {currentPlan.length > 0 && (
          <div className="bg-[#111214] border border-[#27272a] rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between text-[#a1a1aa] font-medium text-[11px]">
              <span>Execution Plan</span>
            </div>
            <div className="space-y-1.5">
              {currentPlan.map((p, i) => (
                <div key={p.id} className="flex items-center justify-between py-1 border-b border-[#1f2937]/50 text-[11px]">
                  <span className="truncate pr-2 text-[#e2e8f0]">
                    {i + 1}. {p.title}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                      p.status === 'completed'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : p.status === 'in_progress'
                        ? 'bg-sky-500/20 text-sky-400'
                        : 'bg-[#1e293b] text-[#64748b]'
                    }`}
                  >
                    {p.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pending Approval Card */}
        {pendingApproval && (
          <div className="bg-amber-500/10 border border-amber-500/40 rounded-lg p-3 space-y-2">
            <div className="flex items-center space-x-1.5 text-amber-400 font-bold text-[11px]">
              <AlertTriangle size={14} />
              <span>Approval Required</span>
            </div>
            <p className="text-[#cbd5e1] text-[11px]">{pendingApproval.description}</p>
            {pendingApproval.filePath && (
              <div className="text-[10px] text-[#94a3b8] font-mono bg-[#0b0f19] p-1.5 rounded">
                Target: {pendingApproval.filePath}
              </div>
            )}
            <div className="flex space-x-2 pt-1">
              <button
                onClick={() => resolveApproval(true)}
                className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-1 rounded text-xs flex items-center justify-center space-x-1"
              >
                <Check size={13} />
                <span>Approve</span>
              </button>
              <button
                onClick={() => resolveApproval(false)}
                className="flex-1 bg-rose-500 hover:bg-rose-600 text-white font-bold py-1 rounded text-xs flex items-center justify-center space-x-1"
              >
                <X size={13} />
                <span>Reject</span>
              </button>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-3 border-t border-[#27272a] bg-[#111214] space-y-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Type a task or question..."
          rows={3}
          className="w-full bg-[#18191d] border border-[#27272a] rounded-lg p-2.5 text-xs text-[#e4e4e7] resize-none outline-none focus:border-[#52525b]"
        />
        <div className="flex justify-between items-center">
          <button
            onClick={cancelAiTask}
            disabled={agentStatus === 'idle'}
            className="px-2.5 py-1 border border-[#27272a] hover:bg-[#1e2025] text-[#a1a1aa] rounded text-[11px] font-medium flex items-center space-x-1 disabled:opacity-40"
          >
            <Square size={11} />
            <span>Stop</span>
          </button>
          <button
            onClick={handleSend}
            disabled={!prompt.trim() || agentStatus === 'working'}
            className="px-3 py-1 bg-[#e4e4e7] hover:bg-white disabled:opacity-40 text-[#111214] font-medium rounded text-xs flex items-center space-x-1"
          >
            <Send size={12} />
            <span>Send</span>
          </button>
        </div>
      </div>
    </div>
  );
};
