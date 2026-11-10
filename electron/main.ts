import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { OllamaService } from './services/ollama.service';
import { FsService } from './services/fs.service';
import { GitService } from './services/git.service';
import { TerminalService } from './services/terminal.service';
import { DbService } from './services/db.service';
import { DesktopAgentOrchestrator } from './services/agent-orchestrator';

let mainWindow: BrowserWindow | null = null;
let activeOllamaService: OllamaService | null = null;
let activeOrchestrator: DesktopAgentOrchestrator | null = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: 'LocalCoders — Multi-Agent AI IDE',
    backgroundColor: '#0f172a',
    icon: path.join(__dirname, '../branding/localcoders-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  // Initialize Backend Services
  const db = new DbService();
  await db.init();

  const ollama = new OllamaService();
  const fsService = new FsService();
  const git = new GitService();
  const terminal = new TerminalService();
  const orchestrator = new DesktopAgentOrchestrator(ollama, fsService, git, terminal, db);
  orchestrator.setWindow(mainWindow);

  activeOllamaService = ollama;
  activeOrchestrator = orchestrator;

  // Set workspace root to current working dir or argument
  const initialWorkspace = process.argv[2] && !process.argv[2].startsWith('--')
    ? path.resolve(process.argv[2])
    : process.cwd();

  fsService.setWorkspace(initialWorkspace);
  git.setWorkspace(initialWorkspace);
  terminal.setWorkspace(initialWorkspace);

  // Register IPC Handlers
  // 1. Ollama
  ipcMain.handle('ollama:checkConnection', () => ollama.checkConnection());
  ipcMain.handle('ollama:getHardwareInfo', () => ollama.getHardwareInfo());
  ipcMain.handle('ollama:listModels', () => ollama.listModels());
  ipcMain.handle('ollama:getCatalogue', async () => {
    const installed = await ollama.listModels();
    return ollama.getCatalogue(installed);
  });
  ipcMain.handle('ollama:pullModel', async (_, name: string) => {
    return ollama.pullModel(name, (prog) => {
      mainWindow?.webContents.send('pull-progress', { name, ...prog });
    });
  });
  ipcMain.handle('ollama:deleteModel', (_, name: string) => ollama.deleteModel(name));

  // 2. Filesystem
  ipcMain.handle('fs:getWorkspace', () => fsService.getWorkspace());
  ipcMain.handle('fs:setWorkspace', (_, root: string) => {
    fsService.setWorkspace(root);
    git.setWorkspace(root);
    terminal.setWorkspace(root);
    return root;
  });
  ipcMain.handle('fs:listTree', (_, dir?: string) => fsService.listTree(dir));
  ipcMain.handle('fs:readFile', (_, p: string) => fsService.readFile(p));
  ipcMain.handle('fs:writeFile', (_, p: string, content: string) => fsService.writeFile(p, content));
  ipcMain.handle('fs:deleteItem', (_, p: string) => fsService.deleteItem(p));
  ipcMain.handle('fs:getDiffPreview', (_, p: string, content: string) => fsService.getDiffPreview(p, content));
  ipcMain.handle('fs:searchCodebase', (_, q: string) => fsService.searchCodebase(q));
  ipcMain.handle('fs:openDirectoryDialog', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
    });
    if (!res.canceled && res.filePaths.length > 0) {
      const chosen = res.filePaths[0];
      fsService.setWorkspace(chosen);
      git.setWorkspace(chosen);
      terminal.setWorkspace(chosen);
      return chosen;
    }
    return null;
  });

  // 3. Git
  ipcMain.handle('git:getStatus', () => git.getStatus());
  ipcMain.handle('git:getDiff', (_, p?: string, staged?: boolean) => git.getDiff(p, staged));
  ipcMain.handle('git:stage', (_, p: string) => git.stage(p));
  ipcMain.handle('git:stageAll', () => git.stageAll());
  ipcMain.handle('git:unstage', (_, p: string) => git.unstage(p));
  ipcMain.handle('git:commit', (_, msg: string) => git.commit(msg));
  ipcMain.handle('git:createCheckpoint', (_, desc: string) => git.createCheckpoint(desc));

  // 4. Terminal
  ipcMain.handle('terminal:execute', async (_, cmd: string) => {
    const cmdId = `cmd_${Date.now()}`;
    return terminal.execute(cmdId, cmd, (chunk) => {
      mainWindow?.webContents.send('terminal-output', chunk);
    });
  });
  ipcMain.handle('terminal:kill', (_, id: string) => terminal.kill(id));

  // 5. Database
  ipcMain.handle('db:getSetting', (_, k: string) => db.getSetting(k));
  ipcMain.handle('db:setSetting', (_, k: string, v: string) => db.setSetting(k, v));
  ipcMain.handle('db:getMessages', () => db.getMessages());

  // 6. Multi-Agent Orchestrator
  ipcMain.handle('agents:getMainAgent', () => orchestrator.getMainAgent());
  ipcMain.handle('agents:setMainAgent', (_, cfg) => orchestrator.setMainAgent(cfg));
  ipcMain.handle('agents:getSubagents', () => orchestrator.getSubagents());
  ipcMain.handle('agents:addSubagent', (_, cfg) => orchestrator.addSubagent(cfg));
  ipcMain.handle('agents:removeSubagent', (_, id) => orchestrator.removeSubagent(id));
  ipcMain.handle('agents:getCriticConfig', () => orchestrator.getCriticConfig());
  ipcMain.handle('agents:setCriticConfig', (_, cfg) => orchestrator.setCriticConfig(cfg));
  ipcMain.handle('agents:submitTask', (_, prompt: string) => orchestrator.submitTask(prompt));
  ipcMain.handle('agents:cancelTask', () => orchestrator.cancelTask());
  ipcMain.handle('agents:resolveApproval', (_, reqId: string, approved: boolean) => {
    orchestrator.resolveApproval(reqId, approved);
  });

  // Load URL in dev mode if requested, or load bundled production dist
  const distHtml = path.join(__dirname, '../dist/index.html');
  if (process.env.NODE_ENV === 'development' && process.env.VITE_DEV_SERVER === '1') {
    mainWindow.loadURL('http://localhost:5173').catch(() => {
      mainWindow?.loadFile(distHtml);
    });
  } else {
    mainWindow.loadFile(distHtml);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let isQuitting = false;
app.on('before-quit', (e) => {
  if (isQuitting) return;
  e.preventDefault();
  isQuitting = true;
  console.log('[LocalCoders Electron] Quitting application: Stopping tasks, unloading Ollama models, and stopping Ollama server...');
  (async () => {
    try {
      if (activeOrchestrator) {
        activeOrchestrator.cancelTask();
      }
      if (activeOllamaService) {
        await Promise.race([
          activeOllamaService.stopServerAndModels(),
          new Promise((r) => setTimeout(r, 4000)),
        ]);
      }
    } catch (err: any) {
      console.warn('[LocalCoders Electron] Error during quit cleanup:', err.message);
    } finally {
      app.quit();
    }
  })();
});
