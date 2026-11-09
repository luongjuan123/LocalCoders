import React, { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { TitleBar } from './components/TitleBar';
import { ActivityBar } from './components/ActivityBar';
import { Sidebar } from './components/sidebar/Sidebar';
import { EditorArea } from './components/editor/EditorArea';
import { AiPanel } from './components/ai/AiPanel';
import { BottomPanel } from './components/bottom/BottomPanel';
import { StatusBar } from './components/StatusBar';
import { SetupWizard } from './components/wizard/SetupWizard';

export const App: React.FC = () => {
  const { init, setupCompleted, aiSidebarOpen } = useAppStore();

  useEffect(() => {
    init();
  }, [init]);

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0f172a] text-[#f8fafc] overflow-hidden font-sans">
      {/* Top Window Titlebar */}
      <TitleBar />

      {/* Main Workbench Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Leftmost Activity Bar */}
        <ActivityBar />

        {/* Left Sidebar (Explorer / Search / Git / Agents / Models) */}
        <Sidebar />

        {/* Center Editor + Bottom Panel Container */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <EditorArea />
          <BottomPanel />
        </div>

        {/* Right AI Multi-Agent Sidebar */}
        {aiSidebarOpen && <AiPanel />}
      </div>

      {/* Bottom Status Bar */}
      <StatusBar />

      {/* First-Run Setup Wizard */}
      {!setupCompleted && <SetupWizard />}
    </div>
  );
};
