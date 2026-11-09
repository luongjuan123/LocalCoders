import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { AgentConfig, CriticConfig } from '../../types';
import { Bot, Cpu, Shield, Sparkles, Check, ArrowRight, ArrowLeft, Download, Trash2 } from 'lucide-react';

export const SetupWizard: React.FC = () => {
  const { hardware, installedModels, modelCatalogue, pullModel, deleteModel, saveSetup } = useAppStore();
  const [step, setStep] = useState(1);

  // Form State
  const [mainModel, setMainModel] = useState(installedModels[0]?.name || '');
  const [criticEnabled, setCriticEnabled] = useState(true);
  const [criticModel, setCriticModel] = useState(installedModels[0]?.name || '');
  const [strictness, setStrictness] = useState<'lenient' | 'moderate' | 'strict' | 'paranoid'>('strict');
  const [pulling, setPulling] = useState<string | null>(null);

  const handlePull = async (tag: string) => {
    setPulling(tag);
    try {
      await pullModel(tag);
    } finally {
      setPulling(null);
    }
  };

  const handleFinish = async () => {
    if (!mainModel) {
      alert('You must select a model for the mandatory Main Agent!');
      return;
    }

    const mainConfig: AgentConfig = {
      id: 'main',
      name: 'Main Agent',
      role: 'Lead Architect & Orchestrator',
      model: mainModel,
      systemPrompt: 'Coordinates project implementation, inspects context, executes tools, and delegates tasks.',
      enabled: true,
      maxConcurrency: 1,
      temperature: 0.2,
      contextWindow: 32768,
    };

    const criticConfig: CriticConfig = {
      enabled: criticEnabled,
      model: criticModel || mainModel,
      strictness,
      categories: ['Security vulnerabilities', 'Logical correctness', 'Memory leaks', 'Race conditions'],
      trigger: 'on_diff',
      reviewMode: 'changed_files',
    };

    await saveSetup(mainConfig, [], criticConfig);
  };

  return (
    <div className="fixed inset-0 bg-[#020617]/90 backdrop-blur-sm z-50 flex items-center justify-center p-6 select-none text-xs">
      <div className="w-full max-w-2xl bg-[#0f172a] border border-[#1f2937] rounded-xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden">
        {/* Header */}
        <div className="p-6 border-b border-[#1f2937] flex items-center justify-between bg-[#0b0f19]">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-white font-bold text-sm">
              LC
            </div>
            <div>
              <h1 className="text-base font-bold text-[#f8fafc]">LocalCoders Setup Wizard</h1>
              <p className="text-[11px] text-[#94a3b8]">Configure your local-first multi-agent AI environment</p>
            </div>
          </div>
          <div className="flex space-x-1.5 text-[10px] font-bold">
            {[1, 2, 3, 4, 5].map((s) => (
              <span
                key={s}
                className={`w-5 h-5 rounded-full flex items-center justify-center ${
                  step === s
                    ? 'bg-sky-500 text-[#0f172a]'
                    : step > s
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-[#1e293b] text-[#64748b]'
                }`}
              >
                {step > s ? '✓' : s}
              </span>
            ))}
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* STEP 1: WELCOME & HARDWARE */}
          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold text-[#f8fafc] flex items-center space-x-2">
                <Cpu size={16} className="text-sky-400" />
                <span>System & Hardware Diagnostics</span>
              </h2>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-[#0b0f19] p-3 rounded border border-[#1f2937]">
                  <div className="text-[10px] uppercase text-[#64748b] font-bold">Operating System</div>
                  <div className="text-xs font-semibold text-[#f8fafc] mt-1">{hardware?.os || 'Linux'}</div>
                </div>
                <div className="bg-[#0b0f19] p-3 rounded border border-[#1f2937]">
                  <div className="text-[10px] uppercase text-[#64748b] font-bold">CPU Cores</div>
                  <div className="text-xs font-semibold text-[#f8fafc] mt-1">
                    {hardware?.cpu.model} ({hardware?.cpu.cores} cores)
                  </div>
                </div>
                <div className="bg-[#0b0f19] p-3 rounded border border-[#1f2937]">
                  <div className="text-[10px] uppercase text-[#64748b] font-bold">RAM Memory</div>
                  <div className="text-xs font-semibold text-[#f8fafc] mt-1">
                    {hardware?.ram.totalGb} GB Total ({hardware?.ram.availableGb} GB Available)
                  </div>
                </div>
                <div className="bg-[#0b0f19] p-3 rounded border border-[#1f2937]">
                  <div className="text-[10px] uppercase text-[#64748b] font-bold">GPU Acceleration</div>
                  <div className="text-xs font-semibold text-[#f8fafc] mt-1">
                    {hardware?.gpu ? `${hardware.gpu.name} (${hardware.gpu.memoryTotalMb} MB)` : 'CPU Only'}
                  </div>
                </div>
              </div>
              <p className="text-[11px] text-[#94a3b8] leading-relaxed">
                LocalCoders runs completely offline on your hardware using Ollama. No subscription, cloud API key, or data telemetry required.
              </p>
            </div>
          )}

          {/* STEP 2: OLLAMA STATUS */}
          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold text-[#f8fafc]">Ollama Connection Status</h2>
              <div
                className={`p-4 rounded-lg border ${
                  hardware?.ollamaRunning
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                }`}
              >
                <div className="font-bold text-xs">
                  {hardware?.ollamaRunning ? `Connected to Ollama v${hardware.ollamaVersion}` : 'Ollama Not Detected'}
                </div>
                <p className="text-[11px] mt-1">
                  {hardware?.ollamaRunning
                    ? 'Ollama service is actively running at http://127.0.0.1:11434 and ready for local inference.'
                    : 'Please ensure Ollama is installed and running with `ollama serve`.'}
                </p>
              </div>
            </div>
          )}

          {/* STEP 3: MODEL MANAGER */}
          {step === 3 && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold text-[#f8fafc]">Installed & Available Models</h2>
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-emerald-400 uppercase">Installed in Ollama:</div>
                {installedModels.length === 0 ? (
                  <div className="text-[#64748b]">No models installed yet. Pull one below.</div>
                ) : (
                  installedModels.map((m) => (
                    <div key={m.name} className="flex justify-between items-center p-2 bg-[#0b0f19] rounded border border-[#1f2937]">
                      <div>
                        <strong>{m.name}</strong>
                        <span className="text-[10px] text-[#64748b] ml-2">{(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB</span>
                      </div>
                      <button onClick={() => deleteModel(m.name)} className="text-rose-400 p-1 hover:bg-rose-500/10 rounded">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className="space-y-2 pt-2 border-t border-[#1f2937]">
                <div className="text-[11px] font-semibold text-sky-400 uppercase">Popular Coding Models:</div>
                {modelCatalogue.slice(0, 4).map((c) => (
                  <div key={c.tag} className="flex justify-between items-center p-2 bg-[#0b0f19] rounded border border-[#1f2937]">
                    <div>
                      <strong>{c.name}</strong> ({c.tag})
                      <div className="text-[10px] text-[#64748b]">{c.description}</div>
                    </div>
                    {c.installed ? (
                      <span className="text-emerald-400 font-bold text-[10px]">Installed</span>
                    ) : (
                      <button
                        onClick={() => handlePull(c.tag)}
                        disabled={pulling === c.tag}
                        className="px-2.5 py-1 bg-sky-500 hover:bg-sky-600 text-[#0f172a] font-bold rounded text-[10px] flex items-center space-x-1"
                      >
                        <Download size={11} />
                        <span>{pulling === c.tag ? 'Pulling...' : 'Pull'}</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP 4: AGENT TEAM CONFIGURATION */}
          {step === 4 && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold text-[#f8fafc]">Agent Team Configuration</h2>

              {/* Main Agent */}
              <div className="bg-[#0b0f19] border border-[#1f2937] border-l-2 border-l-indigo-500 rounded p-3 space-y-2">
                <div className="font-semibold text-indigo-400 flex items-center space-x-1.5">
                  <Bot size={14} />
                  <span>Main Agent (Required)</span>
                </div>
                <p className="text-[#64748b] text-[11px]">
                  Understands user requests, creates implementation plans, and coordinates subagents.
                </p>
                <div>
                  <label className="text-[10px] uppercase font-bold text-[#94a3b8] block mb-1">Select Model *</label>
                  <select
                    value={mainModel}
                    onChange={(e) => setMainModel(e.target.value)}
                    className="w-full bg-[#1e293b] border border-[#334155] rounded p-2 text-xs text-[#f8fafc] outline-none"
                  >
                    <option value="">-- Choose an installed model --</option>
                    {installedModels.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Critic Agent */}
              <div className="bg-[#0b0f19] border border-[#1f2937] border-l-2 border-l-rose-500 rounded p-3 space-y-2">
                <div className="flex justify-between items-center">
                  <div className="font-semibold text-rose-400 flex items-center space-x-1.5">
                    <Shield size={14} />
                    <span>Independent Critic Agent</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={criticEnabled}
                    onChange={(e) => setCriticEnabled(e.target.checked)}
                    className="cursor-pointer"
                  />
                </div>
                <p className="text-[#64748b] text-[11px]">
                  Audits Git diffs and code changes independently. Reports bugs, security risks, and edge cases.
                </p>
                {criticEnabled && (
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <div>
                      <label className="text-[10px] uppercase font-bold text-[#94a3b8] block mb-1">Critic Model</label>
                      <select
                        value={criticModel}
                        onChange={(e) => setCriticModel(e.target.value)}
                        className="w-full bg-[#1e293b] border border-[#334155] rounded p-1.5 text-xs text-[#f8fafc] outline-none"
                      >
                        {installedModels.map((m) => (
                          <option key={m.name} value={m.name}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] uppercase font-bold text-[#94a3b8] block mb-1">Strictness</label>
                      <select
                        value={strictness}
                        onChange={(e) => setStrictness(e.target.value as any)}
                        className="w-full bg-[#1e293b] border border-[#334155] rounded p-1.5 text-xs text-[#f8fafc] outline-none"
                      >
                        <option value="strict">Strict (Standard audit)</option>
                        <option value="paranoid">Paranoid (Ultra rigorous)</option>
                        <option value="moderate">Moderate</option>
                        <option value="lenient">Lenient</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP 5: SUMMARY */}
          {step === 5 && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold text-[#f8fafc]">Configuration Summary</h2>
              <div className="space-y-2">
                <div className="p-3 bg-[#0b0f19] rounded border border-[#1f2937]">
                  <div className="text-[10px] uppercase text-[#64748b] font-bold">Main Agent Model</div>
                  <div className="text-xs font-semibold text-indigo-400 mt-0.5">{mainModel || 'None selected'}</div>
                </div>
                <div className="p-3 bg-[#0b0f19] rounded border border-[#1f2937]">
                  <div className="text-[10px] uppercase text-[#64748b] font-bold">Critic Agent</div>
                  <div className="text-xs font-semibold text-rose-400 mt-0.5">
                    {criticEnabled ? `Enabled (${criticModel || mainModel}, Strictness: ${strictness})` : 'Disabled'}
                  </div>
                </div>
                <div className="p-3 bg-[#0b0f19] rounded border border-[#1f2937]">
                  <div className="text-[10px] uppercase text-[#64748b] font-bold">Inference Provider</div>
                  <div className="text-xs font-semibold text-emerald-400 mt-0.5">Ollama Local Service (http://127.0.0.1:11434)</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Navigation */}
        <div className="p-4 border-t border-[#1f2937] flex justify-between items-center bg-[#0b0f19]">
          <button
            onClick={() => setStep(step - 1)}
            disabled={step === 1}
            className="px-4 py-1.5 rounded font-semibold text-[#94a3b8] hover:text-[#f8fafc] disabled:opacity-40 flex items-center space-x-1"
          >
            <ArrowLeft size={13} />
            <span>Back</span>
          </button>

          {step < 5 ? (
            <button
              onClick={() => {
                if (step === 4 && !mainModel) {
                  alert('Please select a model for the Main Agent!');
                  return;
                }
                setStep(step + 1);
              }}
              className="px-5 py-1.5 bg-sky-500 hover:bg-sky-600 text-[#0f172a] font-bold rounded flex items-center space-x-1"
            >
              <span>Next</span>
              <ArrowRight size={13} />
            </button>
          ) : (
            <button
              onClick={handleFinish}
              className="px-6 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white font-bold rounded flex items-center space-x-1"
            >
              <Check size={14} />
              <span>Launch LocalCoders IDE</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
