import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { FileNode } from '../../types';
import { Folder, FolderOpen, FileCode, ChevronRight, ChevronDown, RefreshCw, Plus } from 'lucide-react';

const FileTreeItem: React.FC<{ node: FileNode; level?: number }> = ({ node, level = 0 }) => {
  const [isOpen, setIsOpen] = useState(false);
  const { openFile } = useAppStore();

  const handleClick = () => {
    if (node.isDirectory) {
      setIsOpen(!isOpen);
    } else {
      openFile(node.path);
    }
  };

  return (
    <div>
      <div
        onClick={handleClick}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        className="flex items-center space-x-1.5 py-1 px-2 rounded hover:bg-[#1e293b] cursor-pointer text-xs text-[#cbd5e1] group"
      >
        {node.isDirectory ? (
          <>
            {isOpen ? <ChevronDown size={13} className="text-[#64748b]" /> : <ChevronRight size={13} className="text-[#64748b]" />}
            {isOpen ? <FolderOpen size={14} className="text-sky-400" /> : <Folder size={14} className="text-sky-400" />}
          </>
        ) : (
          <>
            <span className="w-3" />
            <FileCode size={14} className="text-[#94a3b8] group-hover:text-sky-400" />
          </>
        )}
        <span className="truncate">{node.name}</span>
      </div>

      {node.isDirectory && isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeItem key={child.path} node={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
};

export const ExplorerView: React.FC = () => {
  const { fileTree, refreshWorkspace, workspacePath } = useAppStore();
  const [newFileName, setNewFileName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!newFileName.trim()) return;
    const api = (window as any).localCodersAPI;
    await api.fs.writeFile(newFileName.trim(), '');
    setNewFileName('');
    setCreating(false);
    refreshWorkspace();
  };

  return (
    <div className="flex flex-col h-full text-xs">
      {/* Header */}
      <div className="p-3 border-b border-[#1f2937] flex items-center justify-between">
        <span className="font-semibold uppercase tracking-wider text-[11px] text-[#94a3b8]">
          Files
        </span>
        <div className="flex items-center space-x-1">
          <button
            onClick={() => setCreating(!creating)}
            className="p-1 hover:bg-[#1e293b] rounded text-[#94a3b8] hover:text-[#f8fafc]"
            title="New File"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={refreshWorkspace}
            className="p-1 hover:bg-[#1e293b] rounded text-[#94a3b8] hover:text-[#f8fafc]"
            title="Refresh"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {creating && (
        <div className="p-2 border-b border-[#1f2937] bg-[#0b0f19]">
          <input
            type="text"
            placeholder="filename.ts..."
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            className="w-full bg-[#1e293b] border border-[#334155] rounded px-2 py-1 text-xs text-[#f8fafc] outline-none"
            autoFocus
          />
        </div>
      )}

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {fileTree.length === 0 ? (
          <div className="p-4 text-center text-[#64748b]">No files in workspace</div>
        ) : (
          fileTree.map((node) => <FileTreeItem key={node.path} node={node} />)
        )}
      </div>
    </div>
  );
};
