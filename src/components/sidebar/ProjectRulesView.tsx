import React, { useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Save, BookOpen } from 'lucide-react';

export const ProjectRulesView: React.FC = () => {
  const { workspacePath } = useAppStore();
  const [rules, setRules] = useState('');
  const [saved, setSaved] = useState(false);

  const api = (window as any).localCodersAPI;

  useEffect(() => {
    loadRules();
  }, [workspacePath]);

  const loadRules = async () => {
    try {
      const content = await api.fs.readFile('.localcoders/rules.md');
      setRules(content);
    } catch {
      setRules('# LocalCoders Project Rules\n\n- Maintain clean TypeScript architecture\n- Require comprehensive unit tests\n');
    }
  };

  const handleSave = async () => {
    await api.fs.writeFile('.localcoders/rules.md', rules);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex flex-col h-full text-xs p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold uppercase tracking-wider text-[11px] text-[#94a3b8] flex items-center space-x-1.5">
          <BookOpen size={13} className="text-sky-400" />
          <span>Project Rules & Instructions</span>
        </span>
        <button
          onClick={handleSave}
          className="px-2 py-1 bg-sky-500 hover:bg-sky-600 text-[#0f172a] rounded font-semibold text-[11px] flex items-center space-x-1"
        >
          <Save size={12} />
          <span>{saved ? 'Saved!' : 'Save'}</span>
        </button>
      </div>
      <p className="text-[#64748b] text-[11px] mb-2">
        These rules are injected into the Main Agent, Subagents, and Critic Agent on every task.
      </p>
      <textarea
        value={rules}
        onChange={(e) => setRules(e.target.value)}
        className="flex-1 w-full bg-[#0b0f19] border border-[#334155] rounded p-2 text-xs font-mono text-[#f8fafc] resize-none outline-none focus:border-sky-400"
      />
    </div>
  );
};
