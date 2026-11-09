import React, { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Send, Square, Bot, Sparkles, CheckCircle2, AlertTriangle, Shield, Check, X } from 'lucide-react';

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
    <div className="w-80 bg-[#111827] border-l border-[#1f2937] flex flex-col h-full overflow-hidden select-none">
      {/* Top Mode Selector Bar */}
      <div className="p-2 border-b border-[#1f2937] bg-[#0b0f19] flex justify-between items-center text-xs">
        <div className="flex space-x-1">
          {(['agent', 'plan', 'ask', 'review'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-1 rounded text-[11px] font-semibold uppercase transition-colors ${
                mode === m ? 'bg-sky-500/20 text-sky-400 border border-sky-500/40' : 'text-[#64748b] hover:text-[#cbd5e1]'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="flex items-center space-x-1">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[10px] text-[#94a3b8] font-bold uppercase">{agentStatus}</span>
        </div>
      </div>

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
        {agentMessages.length === 0 && (
          <div className="p-4 text-center text-[#64748b] space-y-2 mt-4">
            <Bot size={28} className="mx-auto text-sky-400" />
            <p className="font-semibold text-[#f8fafc]">LocalCoders AI Orchestration</p>
            <p className="text-[11px]">
              Submit a task. The Main Agent will create a plan, delegate tasks to subagents, call tools, and invoke the Critic Agent.
            </p>
          </div>
        )}

        {agentMessages.map((msg) => (
          <div
            key={msg.id}
            className={`p-3 rounded-lg border leading-relaxed ${
              msg.senderRole === 'user'
                ? 'bg-sky-500/10 border-sky-500/30 text-[#f8fafc]'
                : 'bg-[#0b0f19] border-[#1f2937] text-[#cbd5e1]'
            }`}
          >
            <div className="flex items-center justify-between mb-1 font-semibold text-[11px]">
              <span className={msg.senderRole === 'user' ? 'text-sky-300' : 'text-indigo-400'}>
                {msg.senderName}
              </span>
              <span className="text-[10px] text-[#64748b]">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>

            {msg.thinking && (
              <div className="bg-[#1e293b]/50 border-l-2 border-indigo-400 p-2 rounded text-[11px] text-[#94a3b8] font-mono mb-2 whitespace-pre-wrap">
                {msg.thinking}
              </div>
            )}

            <div className="whitespace-pre-wrap">{msg.content}</div>
          </div>
        ))}

        {/* Live Multi-Agent Plan Checklist */}
        {currentPlan.length > 0 && (
          <div className="bg-[#0b0f19] border border-sky-500/30 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between text-sky-400 font-bold text-[11px] uppercase tracking-wider">
              <span>Live Execution Plan</span>
              <Sparkles size={13} />
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
      <div className="p-3 border-t border-[#1f2937] bg-[#0b0f19] space-y-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Ask Main Agent or delegate coding task..."
          rows={3}
          className="w-full bg-[#1e293b] border border-[#334155] rounded-lg p-2.5 text-xs text-[#f8fafc] resize-none outline-none focus:border-sky-400"
        />
        <div className="flex justify-between items-center">
          <button
            onClick={cancelAiTask}
            disabled={agentStatus === 'idle'}
            className="px-2.5 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 rounded text-[11px] font-semibold flex items-center space-x-1 disabled:opacity-40"
          >
            <Square size={11} />
            <span>Stop</span>
          </button>
          <button
            onClick={handleSend}
            disabled={!prompt.trim() || agentStatus === 'working'}
            className="px-3.5 py-1 bg-sky-500 hover:bg-sky-600 disabled:opacity-50 text-[#0f172a] font-bold rounded text-xs flex items-center space-x-1"
          >
            <Send size={12} />
            <span>Send</span>
          </button>
        </div>
      </div>
    </div>
  );
};
