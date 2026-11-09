import React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { ExplorerView } from './ExplorerView';
import { SearchView } from './SearchView';
import { GitView } from './GitView';
import { AgentTeamView } from './AgentTeamView';
import { ModelManagerView } from './ModelManagerView';
import { ProjectRulesView } from './ProjectRulesView';

export const Sidebar: React.FC = () => {
  const { activeSidebarTab } = useAppStore();

  return (
    <div className="w-64 bg-[#111827] border-r border-[#1f2937] flex flex-col h-full overflow-hidden select-none">
      {activeSidebarTab === 'explorer' && <ExplorerView />}
      {activeSidebarTab === 'search' && <SearchView />}
      {activeSidebarTab === 'git' && <GitView />}
      {activeSidebarTab === 'agents' && <AgentTeamView />}
      {activeSidebarTab === 'models' && <ModelManagerView />}
      {activeSidebarTab === 'rules' && <ProjectRulesView />}
    </div>
  );
};
