const Module = require('module');
const originalRequire = Module.prototype.require;

const path = require('path');
const mockWorkspacePath = path.resolve(__dirname, 'mock-workspace');

const mockVsCode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: mockWorkspacePath } }],
    getConfiguration: () => ({
      get: (k) => undefined,
    }),
    createFileSystemWatcher: () => ({
      onDidChange: () => ({ dispose: () => {} }),
      onDidCreate: () => ({ dispose: () => {} }),
      onDidDelete: () => ({ dispose: () => {} }),
      dispose: () => {},
    }),
  },
  languages: {
    getDiagnostics: () => [],
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  window: {
    showInformationMessage: async () => {},
    showWarningMessage: async () => {},
    showErrorMessage: async () => {},
    createStatusBarItem: () => ({ show: () => {}, text: '', command: '', tooltip: '' }),
  },
  commands: {
    executeCommand: async () => {},
    registerCommand: () => ({ dispose: () => {} }),
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  Uri: {
    file: (p) => ({ fsPath: p }),
    joinPath: (base, ...segments) => ({ fsPath: [base.fsPath, ...segments].join('/') }),
  },
  EventEmitter: class {
    constructor() {
      this._listeners = [];
      this.event = (listener) => {
        this._listeners.push(listener);
        return {
          dispose: () => {
            this._listeners = this._listeners.filter((l) => l !== listener);
          },
        };
      };
    }
    fire(data) {
      for (const l of [...this._listeners]) {
        try {
          l(data);
        } catch {}
      }
    }
  },
};

Module.prototype.require = function (id) {
  if (id === 'vscode') {
    return mockVsCode;
  }
  return originalRequire.apply(this, arguments);
};

module.exports = mockVsCode;
