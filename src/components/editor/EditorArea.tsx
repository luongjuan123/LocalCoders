import React, { useEffect } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { useAppStore } from '../../store/useAppStore';
import { X, FileCode, SplitSquareVertical } from 'lucide-react';

export const EditorArea: React.FC = () => {
  const { openTabs, activeTabId, setActiveTab, closeTab, updateTabContent, saveActiveFile } = useAppStore();
  const activeTab = openTabs.find((t) => t.id === activeTabId);

  // Keyboard shortcut Ctrl+S
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveActiveFile();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveActiveFile]);

  if (openTabs.length === 0) {
    return (
      <div className="flex-1 bg-[#0f172a] flex flex-col items-center justify-center text-[#64748b] select-none p-6">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-sky-500/20 to-indigo-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400 mb-4">
          <FileCode size={32} />
        </div>
        <h2 className="text-base font-semibold text-[#f8fafc] mb-1">LocalCoders Multi-Agent IDE</h2>
        <p className="text-xs text-[#94a3b8] max-w-sm text-center mb-4">
          Open a file from the explorer on the left or submit a prompt in the AI sidebar to orchestrate tasks across agents.
        </p>
        <div className="flex space-x-2 text-[11px] text-[#64748b]">
          <span className="bg-[#1e293b] px-2 py-1 rounded">Ctrl+S: Save</span>
          <span className="bg-[#1e293b] px-2 py-1 rounded">Ollama Local Inference</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0f172a] overflow-hidden">
      {/* Tabs Bar */}
      <div className="h-9 bg-[#0b0f19] border-b border-[#1f2937] flex items-center overflow-x-auto select-none">
        {openTabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`h-full px-3 flex items-center space-x-2 border-r border-[#1f2937] cursor-pointer text-xs transition-colors ${
                isActive
                  ? 'bg-[#0f172a] text-[#f8fafc] border-t-2 border-t-sky-400 font-medium'
                  : 'bg-[#0b0f19] text-[#94a3b8] hover:bg-[#1e293b]'
              }`}
            >
              <FileCode size={13} className={isActive ? 'text-sky-400' : 'text-[#64748b]'} />
              <span className="truncate max-w-[150px]">{tab.title}</span>
              {tab.isDirty && <span className="w-2 h-2 rounded-full bg-sky-400" />}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="p-0.5 hover:bg-[#334155] rounded text-[#64748b] hover:text-[#f8fafc]"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Breadcrumb */}
      {activeTab && (
        <div className="h-6 bg-[#0f172a] border-b border-[#1f2937]/50 px-3 flex items-center text-[11px] text-[#64748b] font-mono">
          <span>{activeTab.path}</span>
        </div>
      )}

      {/* Monaco Editor or Diff Editor */}
      <div className="flex-1 relative">
        {activeTab && activeTab.isDiff ? (
          <DiffEditor
            original={activeTab.diffOriginal || ''}
            modified={activeTab.diffModified || activeTab.content}
            language={activeTab.language}
            theme="vs-dark"
            options={{
              readOnly: false,
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />
        ) : activeTab ? (
          <Editor
            value={activeTab.content}
            language={activeTab.language}
            theme="vs-dark"
            onChange={(val) => updateTabContent(activeTab.id, val || '')}
            options={{
              minimap: { enabled: true },
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
            }}
          />
        ) : null}
      </div>
    </div>
  );
};
