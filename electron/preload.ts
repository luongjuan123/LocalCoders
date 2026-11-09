import { contextBridge, ipcRenderer } from 'electron';

export const localCodersAPI = {
  // Ollama
  ollama: {
    checkConnection: () => ipcRenderer.invoke('ollama:checkConnection'),
    getHardwareInfo: () => ipcRenderer.invoke('ollama:getHardwareInfo'),
    listModels: () => ipcRenderer.invoke('ollama:listModels'),
    getCatalogue: () => ipcRenderer.invoke('ollama:getCatalogue'),
    pullModel: (name: string) => ipcRenderer.invoke('ollama:pullModel', name),
    deleteModel: (name: string) => ipcRenderer.invoke('ollama:deleteModel', name),
  },

  // Filesystem & Workspace
  fs: {
    getWorkspace: () => ipcRenderer.invoke('fs:getWorkspace'),
    setWorkspace: (root: string) => ipcRenderer.invoke('fs:setWorkspace', root),
    listTree: (dir?: string) => ipcRenderer.invoke('fs:listTree', dir),
    readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),
    deleteItem: (path: string) => ipcRenderer.invoke('fs:deleteItem', path),
    getDiffPreview: (path: string, content: string) => ipcRenderer.invoke('fs:getDiffPreview', path, content),
    searchCodebase: (query: string) => ipcRenderer.invoke('fs:searchCodebase', query),
    openDirectoryDialog: () => ipcRenderer.invoke('fs:openDirectoryDialog'),
  },

  // Git
  git: {
    getStatus: () => ipcRenderer.invoke('git:getStatus'),
    getDiff: (path?: string, staged?: boolean) => ipcRenderer.invoke('git:getDiff', path, staged),
    stage: (path: string) => ipcRenderer.invoke('git:stage', path),
    stageAll: () => ipcRenderer.invoke('git:stageAll'),
    unstage: (path: string) => ipcRenderer.invoke('git:unstage', path),
    commit: (msg: string) => ipcRenderer.invoke('git:commit', msg),
    createCheckpoint: (desc: string) => ipcRenderer.invoke('git:createCheckpoint', desc),
  },

  // Terminal
  terminal: {
    execute: (cmd: string) => ipcRenderer.invoke('terminal:execute', cmd),
    kill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
  },

  // DB & State
  db: {
    getSetting: (key: string) => ipcRenderer.invoke('db:getSetting', key),
    setSetting: (key: string, val: string) => ipcRenderer.invoke('db:setSetting', key, val),
    getMessages: () => ipcRenderer.invoke('db:getMessages'),
  },

  // Multi-Agent System
  agents: {
    getMainAgent: () => ipcRenderer.invoke('agents:getMainAgent'),
    setMainAgent: (cfg: any) => ipcRenderer.invoke('agents:setMainAgent', cfg),
    getSubagents: () => ipcRenderer.invoke('agents:getSubagents'),
    addSubagent: (cfg: any) => ipcRenderer.invoke('agents:addSubagent', cfg),
    removeSubagent: (id: string) => ipcRenderer.invoke('agents:removeSubagent', id),
    getCriticConfig: () => ipcRenderer.invoke('agents:getCriticConfig'),
    setCriticConfig: (cfg: any) => ipcRenderer.invoke('agents:setCriticConfig', cfg),
    submitTask: (prompt: string) => ipcRenderer.invoke('agents:submitTask', prompt),
    cancelTask: () => ipcRenderer.invoke('agents:cancelTask'),
    resolveApproval: (reqId: string, approved: boolean) => ipcRenderer.invoke('agents:resolveApproval', reqId, approved),
  },

  // Event Listeners
  on: (channel: string, callback: (...args: any[]) => void) => {
    const sub = (_: any, ...args: any[]) => callback(...args);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },
};

contextBridge.exposeInMainWorld('localCodersAPI', localCodersAPI);
