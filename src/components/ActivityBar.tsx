import React from 'react';
import { useAppStore } from '../store/useAppStore';
import { Files, Search, GitBranch, Users, Cpu, BookOpen, Bot, PanelBottom } from 'lucide-react';

export const ActivityBar: React.FC = () => {
  const { activeSidebarTab, setActiveSidebarTab, aiSidebarOpen, toggleAiSidebar, bottomPanelOpen, toggleBottomPanel } =
    useAppStore();

  const tabs: Array<{ id: any; icon: React.FC<any>; label: string }> = [
    { id: 'explorer', icon: Files, label: 'Explorer' },
    { id: 'search', icon: Search, label: 'Search Codebase' },
    { id: 'git', icon: GitBranch, label: 'Source Control' },
    { id: 'agents', icon: Users, label: 'Agent Team' },
    { id: 'models', icon: Cpu, label: 'Model Manager' },
    { id: 'rules', icon: BookOpen, label: 'Project Rules & Memory' },
  ];

  return (
    <div className="w-12 bg-[#0b0f19] border-r border-[#1f2937] flex flex-col justify-between items-center py-2 select-none">
      {/* Top Icons */}
      <div className="flex flex-col space-y-2">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeSidebarTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSidebarTab(tab.id)}
              className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative ${
                isActive ? 'text-sky-400 bg-[#1e293b]' : 'text-[#64748b] hover:text-[#cbd5e1] hover:bg-[#1e293b]/50'
              }`}
              title={tab.label}
            >
              <Icon size={19} />
              {isActive && (
                <div className="absolute left-0 top-1 bottom-1 w-[2.5px] bg-sky-400 rounded-r" />
              )}
            </button>
          );
        })}
      </div>

      {/* Bottom Toggles */}
      <div className="flex flex-col space-y-2">
        <button
          onClick={toggleBottomPanel}
          className={`w-9 h-9 rounded flex items-center justify-center transition-colors ${
            bottomPanelOpen ? 'text-sky-400 bg-[#1e293b]' : 'text-[#64748b] hover:text-[#cbd5e1]'
          }`}
          title="Toggle Bottom Terminal / Critic Panel"
        >
          <PanelBottom size={18} />
        </button>

        <button
          onClick={toggleAiSidebar}
          className={`w-9 h-9 rounded flex items-center justify-center transition-colors ${
            aiSidebarOpen ? 'text-sky-400 bg-[#1e293b]' : 'text-[#64748b] hover:text-[#cbd5e1]'
          }`}
          title="Toggle Right AI Multi-Agent Sidebar"
        >
          <Bot size={18} />
        </button>
      </div>
    </div>
  );
};
