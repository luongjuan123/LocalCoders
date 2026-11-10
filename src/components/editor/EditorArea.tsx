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
      <div className="flex-1 bg-[#111214] flex flex-col items-center justify-center text-[#71717a] select-none p-6">
        <FileCode size={24} className="mb-2 text-[#52525b]" />
        <h2 className="text-sm font-medium text-[#e4e4e7] mb-1">No open file</h2>
        <p className="text-xs text-[#71717a] max-w-xs text-center mb-4">
          Select a file from the explorer or type a task in the agent panel.
        </p>
        <div className="text-[11px] text-[#71717a] font-mono">
          Ctrl+S Save
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
