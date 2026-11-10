import { ToolDefinition, ToolExecutionContext, ToolResult, ToolCategory, ToolAuditEvent } from './types';
import {
  readFileTool,
  readLinesTool,
  writeFileTool,
  editFileTool,
  renameFileTool,
  deleteFileTool,
  getMetadataTool,
  listDirectoryTool,
  getProjectStructureTool,
} from './fs-tools';
import {
  readGitDiffTool,
  inspectGitStatusTool,
  gitLogTool,
  gitShowTool,
  gitBranchListTool,
  gitCreateBranchTool,
  gitCheckoutTool,
  stageFileTool,
  unstageFileTool,
  gitCommitTool,
  revertFileTool,
  createCheckpointTool,
  gitWorktreeCreateTool,
  gitWorktreeRemoveTool,
  gitMergeAnalysisTool,
} from './git-tools';
import {
  runCommandTool,
  startProcessTool,
  readOutputTool,
  writeStdinTool,
  terminateProcessTool,
  listProcessesTool,
  listPortsTool,
  runTestsTool,
  runBuildTool,
  runLintTool,
} from './terminal-tools';
import {
  appLaunchTool,
  appOpenUrlTool,
  appOpenFileTool,
  appGetRunningApplicationsTool,
  appTerminateTool,
} from './app-tools';
import {
  browserLaunchTool,
  browserCloseTool,
  browserNavigateTool,
  browserClickTool,
  browserFillTool,
  browserTypeTool,
  browserPressKeyTool,
  browserSelectTool,
  browserGetContentTool,
  browserGetConsoleLogsTool,
  browserGetNetworkErrorsTool,
  browserTakeScreenshotTool,
  browserGetCurrentUrlTool,
} from './browser-tools';
import {
  computerScreenshotTool,
  computerListWindowsTool,
  computerFocusWindowTool,
  computerMouseMoveTool,
  computerMouseClickTool,
  computerKeyboardTypeTool,
  computerKeyboardPressKeyTool,
} from './computer-use-tools';
import {
  dockerListContainersTool,
  dockerListImagesTool,
  dockerBuildImageTool,
  dockerStartContainerTool,
  dockerStopContainerTool,
  dockerReadLogsTool,
  dockerExecuteCommandTool,
  dockerComposeUpTool,
  dockerComposeDownTool,
} from './docker-tools';
import {
  databaseListTablesTool,
  databaseDescribeTableTool,
  databaseQueryReadonlyTool,
  databaseExecuteTool,
} from './database-tools';
import { httpGetTool, httpPostTool, httpDownloadFileTool } from './http-tools';
import { searchCodebaseTool, searchSymbolsTool, inspectDiagnosticsTool } from './search-tools';
import { McpHost } from '../mcp/mcp-host';
import { PermissionManager } from '../security/permission-manager';

const TOOL_ALIASES: Record<string, string> = {
  // Filesystem
  'create_file': 'write_file',
  'createfile': 'write_file',
  'save_file': 'write_file',
  'writefile': 'write_file',
  'put_file': 'write_file',
  'new_file': 'write_file',

  'modify_file': 'edit_file',
  'editfile': 'edit_file',
  'patch_file': 'edit_file',
  'replace_in_file': 'edit_file',
  'replace_file_content': 'edit_file',
  'update_file': 'edit_file',

  'readfile': 'read_file',
  'view_file': 'read_file',
  'cat': 'read_file',
  'load_file': 'read_file',
  'get_file': 'read_file',

  'list_files': 'list_directory',
  'listfiles': 'list_directory',
  'listdirectory': 'list_directory',
  'list_dir': 'list_directory',
  'ls': 'list_directory',
  'dir': 'list_directory',
  'find_files': 'list_directory',

  'deletefile': 'delete_file',
  'remove_file': 'delete_file',
  'rm': 'delete_file',

  // Terminal
  'execute_command': 'run_command',
  'exec_command': 'run_command',
  'run_terminal_command': 'run_command',
  'runcommand': 'run_command',
  'bash': 'run_command',
  'sh': 'run_command',
  'shell': 'run_command',
  'terminal': 'run_command',
  'command': 'run_command',
  'cmd': 'run_command',

  // Tests & Build
  'run_test': 'run_tests',
  'test': 'run_tests',
  'pytest': 'run_tests',
  'run_build_command': 'run_build',
  'build': 'run_build',

  // Search
  'search_files': 'search_codebase',
  'grep': 'search_codebase',
  'find_in_files': 'search_codebase',
  'ripgrep': 'search_codebase',
};

export class ToolManager {
  private mcpHost?: McpHost;
  private permissionManager?: PermissionManager;

  private staticDefinitions: ToolDefinition[] = [
    // --- FILESYSTEM ---
    {
      name: 'read_file',
      category: 'filesystem',
      permissionLevel: 'read',
      description: 'Read the full text content of a file within the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path to file.' } },
        required: ['path'],
      },
    },
    {
      name: 'read_lines',
      category: 'filesystem',
      permissionLevel: 'read',
      description: 'Read a specific line range from a file (e.g. lines 1 to 100).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to file.' },
          startLine: { type: 'number', description: '1-based starting line number.' },
          endLine: { type: 'number', description: 'Ending line number.' },
        },
        required: ['path', 'startLine'],
      },
    },
    {
      name: 'write_file',
      category: 'filesystem',
      permissionLevel: 'write',
      description: 'Write full content to a file. Creates directories automatically if they do not exist.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path.' },
          content: { type: 'string', description: 'Complete content to write.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      category: 'filesystem',
      permissionLevel: 'write',
      description: 'Replace an exact target snippet in a file with a replacement snippet.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path.' },
          target: { type: 'string', description: 'Exact string to be replaced.' },
          replacement: { type: 'string', description: 'New string to insert in place of target.' },
        },
        required: ['path', 'target', 'replacement'],
      },
    },
    {
      name: 'rename_file',
      category: 'filesystem',
      permissionLevel: 'write',
      description: 'Rename or move a file within the workspace.',
      parameters: {
        type: 'object',
        properties: {
          oldPath: { type: 'string', description: 'Current relative path.' },
          newPath: { type: 'string', description: 'New relative path.' },
        },
        required: ['oldPath', 'newPath'],
      },
    },
    {
      name: 'delete_file',
      category: 'filesystem',
      permissionLevel: 'destructive',
      description: 'Delete a file or directory in the workspace. Destructive operation.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path to delete.' } },
        required: ['path'],
      },
    },
    {
      name: 'list_directory',
      category: 'filesystem',
      permissionLevel: 'read',
      description: 'List directories and files in the workspace tree.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path. Defaults to root.' },
          maxDepth: { type: 'number', description: 'Maximum depth (default 3).' },
        },
      },
    },
    {
      name: 'get_metadata',
      category: 'filesystem',
      permissionLevel: 'read',
      description: 'Get file or directory metadata (size, modified time, isDirectory).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path.' } },
        required: ['path'],
      },
    },
    {
      name: 'get_project_structure',
      category: 'filesystem',
      permissionLevel: 'read',
      description: 'Discover key configuration files, frameworks, and top-level directories of the project.',
      parameters: { type: 'object', properties: {} },
    },

    // --- TERMINAL & PROCESSES ---
    {
      name: 'run_command',
      category: 'terminal',
      permissionLevel: 'execute',
      description:
        'Execute a terminal shell command synchronously and capture output. Pass optional `stdin` text (newline-delimited) for interactive CLI scripts that call input()/readline(). For long-running GUIs or servers, use start_process.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command string.' },
          stdin: {
            type: 'string',
            description: 'Optional input text sent to standard input (stdin), separated by newlines for sequential prompts.',
          },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 45000).' },
          cwd: { type: 'string', description: 'Optional working directory.' },
        },
        required: ['command'],
      },
    },
    {
      name: 'start_process',
      category: 'terminal',
      permissionLevel: 'execute',
      description: 'Start a long-running background or interactive process (e.g. GUI app, dev server, interactive CLI session). Use write_stdin to send input and read_output to inspect logs.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute in background.' },
          processId: { type: 'string', description: 'Optional unique ID for process tracking.' },
          cwd: { type: 'string', description: 'Optional working directory.' },
        },
        required: ['command'],
      },
    },
    {
      name: 'read_output',
      category: 'terminal',
      permissionLevel: 'read',
      description: 'Read recent output logs from a background process.',
      parameters: {
        type: 'object',
        properties: {
          processId: { type: 'string', description: 'Managed process ID.' },
          tailLines: { type: 'number', description: 'Number of recent lines to return.' },
        },
        required: ['processId'],
      },
    },
    {
      name: 'write_stdin',
      category: 'terminal',
      permissionLevel: 'execute',
      description: 'Send input text into the standard input (stdin) of a running process.',
      parameters: {
        type: 'object',
        properties: {
          processId: { type: 'string', description: 'Managed process ID.' },
          input: { type: 'string', description: 'Input text to send.' },
        },
        required: ['processId', 'input'],
      },
    },
    {
      name: 'terminate_process',
      category: 'terminal',
      permissionLevel: 'destructive',
      description: 'Stop and terminate a running background process.',
      parameters: {
        type: 'object',
        properties: { processId: { type: 'string', description: 'Process ID to kill.' } },
        required: ['processId'],
      },
    },
    {
      name: 'list_processes',
      category: 'terminal',
      permissionLevel: 'read',
      description: 'List all active and recent background processes managed by LocalCoders.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'list_ports',
      category: 'terminal',
      permissionLevel: 'read',
      description: 'Check whether localhost ports (e.g. 3000, 5173, 8000) are currently listening.',
      parameters: {
        type: 'object',
        properties: { checkPorts: { type: 'array', items: { type: 'number' } } },
      },
    },
    {
      name: 'run_tests',
      category: 'terminal',
      permissionLevel: 'execute',
      description: 'Run project automated tests (npm test).',
      parameters: {
        type: 'object',
        properties: { testPath: { type: 'string', description: 'Specific test file path.' } },
      },
    },
    {
      name: 'run_build',
      category: 'terminal',
      permissionLevel: 'execute',
      description: 'Build the application using npm run build.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'run_lint',
      category: 'terminal',
      permissionLevel: 'execute',
      description: 'Run project linter to check code quality.',
      parameters: { type: 'object', properties: {} },
    },

    // --- APPLICATION LAUNCHER ---
    {
      name: 'app_launch',
      category: 'app',
      permissionLevel: 'execute',
      description: 'Launch a desktop application or script on the system.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Executable command or path.' },
          args: { type: 'array', items: { type: 'string' } },
        },
        required: ['command'],
      },
    },
    {
      name: 'app_open_url',
      category: 'app',
      permissionLevel: 'network',
      description: 'Open a URL in the default system browser.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL to open.' } },
        required: ['url'],
      },
    },
    {
      name: 'app_open_file',
      category: 'app',
      permissionLevel: 'execute',
      description: 'Open a document or image with its default system application.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative file path.' } },
        required: ['path'],
      },
    },
    {
      name: 'app_get_running_applications',
      category: 'app',
      permissionLevel: 'read',
      description: 'List active graphical desktop applications and windows.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'app_terminate',
      category: 'app',
      permissionLevel: 'destructive',
      description: 'Terminate an application process by PID or process name.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: 'Process PID.' },
          processName: { type: 'string', description: 'Process name.' },
        },
      },
    },

    // --- PLAYWRIGHT BROWSER AUTOMATION ---
    {
      name: 'browser_launch',
      category: 'browser',
      permissionLevel: 'execute',
      description: 'Launch a Playwright Chromium browser session.',
      parameters: {
        type: 'object',
        properties: { headless: { type: 'boolean', description: 'Run headless (default true).' } },
      },
    },
    {
      name: 'browser_close',
      category: 'browser',
      permissionLevel: 'execute',
      description: 'Close active browser session.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'browser_navigate',
      category: 'browser',
      permissionLevel: 'network',
      description: 'Navigate browser to a URL (e.g. http://localhost:3000).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Target URL.' } },
        required: ['url'],
      },
    },
    {
      name: 'browser_click',
      category: 'browser',
      permissionLevel: 'execute',
      description: 'Click an element matching a CSS or semantic selector in the page.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS/text selector.' } },
        required: ['selector'],
      },
    },
    {
      name: 'browser_fill',
      category: 'browser',
      permissionLevel: 'execute',
      description: 'Fill an input element with text.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Input selector.' },
          text: { type: 'string', description: 'Text to fill.' },
        },
        required: ['selector', 'text'],
      },
    },
    {
      name: 'browser_type',
      category: 'browser',
      permissionLevel: 'execute',
      description: 'Type text keystroke-by-keystroke into an element.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Selector.' },
          text: { type: 'string', description: 'Text to type.' },
        },
        required: ['selector', 'text'],
      },
    },
    {
      name: 'browser_press_key',
      category: 'browser',
      permissionLevel: 'execute',
      description: 'Press a keyboard key on the browser page (e.g. Enter, Tab, Escape).',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Key name.' } },
        required: ['key'],
      },
    },
    {
      name: 'browser_select',
      category: 'browser',
      permissionLevel: 'execute',
      description: 'Select an option in a dropdown selector.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Select element selector.' },
          value: { type: 'string', description: 'Option value.' },
        },
        required: ['selector', 'value'],
      },
    },
    {
      name: 'browser_get_content',
      category: 'browser',
      permissionLevel: 'read',
      description: 'Extract visible text from page or specified element.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'Optional element selector.' } },
      },
    },
    {
      name: 'browser_get_console_logs',
      category: 'browser',
      permissionLevel: 'read',
      description: 'Inspect captured console messages (errors, warnings, logs) from the browser page.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'browser_get_network_errors',
      category: 'browser',
      permissionLevel: 'read',
      description: 'Inspect failed HTTP network requests (4xx, 5xx, connection aborts) on the page.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'browser_take_screenshot',
      category: 'browser',
      permissionLevel: 'read',
      description: 'Take a screenshot of the current page and save it to project screenshots.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Screenshot name label.' },
          fullPage: { type: 'boolean', description: 'Capture full scrollable page.' },
        },
      },
    },
    {
      name: 'browser_get_current_url',
      category: 'browser',
      permissionLevel: 'read',
      description: 'Get current browser URL and page title.',
      parameters: { type: 'object', properties: {} },
    },

    // --- COMPUTER USE ---
    {
      name: 'computer_screenshot',
      category: 'computer_use',
      permissionLevel: 'read',
      description: 'Capture screenshot of the desktop screen.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Image filename label.' } },
      },
    },
    {
      name: 'computer_list_windows',
      category: 'computer_use',
      permissionLevel: 'read',
      description: 'List visible desktop application windows.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'computer_focus_window',
      category: 'computer_use',
      permissionLevel: 'execute',
      description: 'Focus a specific desktop application window by ID.',
      parameters: {
        type: 'object',
        properties: { windowId: { type: 'string', description: 'Window ID.' } },
        required: ['windowId'],
      },
    },
    {
      name: 'computer_mouse_move',
      category: 'computer_use',
      permissionLevel: 'execute',
      description: 'Move mouse cursor to screen coordinates (x, y).',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate.' },
          y: { type: 'number', description: 'Y coordinate.' },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'computer_mouse_click',
      category: 'computer_use',
      permissionLevel: 'execute',
      description: 'Simulate a mouse button click.',
      parameters: {
        type: 'object',
        properties: {
          button: { type: 'number', description: '1=Left, 2=Middle, 3=Right.' },
          x: { type: 'number', description: 'Optional X coordinate.' },
          y: { type: 'number', description: 'Optional Y coordinate.' },
        },
      },
    },
    {
      name: 'computer_keyboard_type',
      category: 'computer_use',
      permissionLevel: 'execute',
      description: 'Simulate typing keyboard text into the active window.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to type.' } },
        required: ['text'],
      },
    },
    {
      name: 'computer_keyboard_press_key',
      category: 'computer_use',
      permissionLevel: 'execute',
      description: 'Press a keyboard key or hotkey combination (e.g. Return, ctrl+s, alt+Tab).',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Key name or shortcut.' } },
        required: ['key'],
      },
    },

    // --- GIT & VERSION CONTROL ---
    {
      name: 'read_git_diff',
      category: 'git',
      permissionLevel: 'read',
      description: 'Read current git diff of working tree or staged changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional specific file.' },
          staged: { type: 'boolean', description: 'Whether to read staged (--cached) diff.' },
        },
      },
    },
    {
      name: 'inspect_git_status',
      category: 'git',
      permissionLevel: 'read',
      description: 'Inspect git status of the workspace (branch, modified, staged, untracked).',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'git_log',
      category: 'git',
      permissionLevel: 'read',
      description: 'Inspect Git commit history.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of commits to return.' },
          file: { type: 'string', description: 'Optional file path filter.' },
        },
      },
    },
    {
      name: 'git_show',
      category: 'git',
      permissionLevel: 'read',
      description: 'Show commit details or view a file at a specific Git revision.',
      parameters: {
        type: 'object',
        properties: {
          revision: { type: 'string', description: 'Commit hash or tag (default HEAD).' },
          file: { type: 'string', description: 'Optional file path.' },
        },
      },
    },
    {
      name: 'git_branch_list',
      category: 'git',
      permissionLevel: 'read',
      description: 'List local and remote Git branches.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'git_create_branch',
      category: 'git',
      permissionLevel: 'write',
      description: 'Create a new Git branch and optionally check it out.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Branch name.' },
          checkout: { type: 'boolean', description: 'Checkout immediately.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'git_checkout',
      category: 'git',
      permissionLevel: 'write',
      description: 'Checkout a Git branch, tag, or commit.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: 'Branch or commit hash.' } },
        required: ['target'],
      },
    },
    {
      name: 'stage_file',
      category: 'git',
      permissionLevel: 'write',
      description: 'Stage a file for commit (git add).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path to stage.' } },
        required: ['path'],
      },
    },
    {
      name: 'unstage_file',
      category: 'git',
      permissionLevel: 'write',
      description: 'Unstage a staged file (git restore --staged).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path to unstage.' } },
        required: ['path'],
      },
    },
    {
      name: 'git_commit',
      category: 'git',
      permissionLevel: 'write',
      description: 'Create a Git commit with a structured commit message.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message.' },
          stageAll: { type: 'boolean', description: 'Stage all modified files before commit.' },
        },
        required: ['message'],
      },
    },
    {
      name: 'revert_file',
      category: 'git',
      permissionLevel: 'destructive',
      description: 'Discard uncommitted changes in a file back to HEAD.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path to revert.' } },
        required: ['path'],
      },
    },
    {
      name: 'create_checkpoint',
      category: 'git',
      permissionLevel: 'write',
      description: 'Create a safe git stash checkpoint before applying large multi-agent changes.',
      parameters: {
        type: 'object',
        properties: { description: { type: 'string', description: 'Checkpoint description.' } },
        required: ['description'],
      },
    },
    {
      name: 'git_worktree_create',
      category: 'git',
      permissionLevel: 'write',
      description: 'Create an isolated Git worktree directory for parallel subagent development.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Worktree name.' },
          branch: { type: 'string', description: 'Branch name for worktree.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'git_worktree_remove',
      category: 'git',
      permissionLevel: 'destructive',
      description: 'Remove an isolated Git worktree after task completion.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Worktree name to remove.' } },
        required: ['name'],
      },
    },
    {
      name: 'git_merge_analysis',
      category: 'git',
      permissionLevel: 'read',
      description: 'Analyze whether a branch can be cleanly merged without conflicts.',
      parameters: {
        type: 'object',
        properties: { targetBranch: { type: 'string', description: 'Branch to compare against.' } },
        required: ['targetBranch'],
      },
    },

    // --- DOCKER ---
    {
      name: 'docker_list_containers',
      category: 'docker',
      permissionLevel: 'read',
      description: 'List Docker containers on the host.',
      parameters: {
        type: 'object',
        properties: { all: { type: 'boolean', description: 'Show all (including stopped).' } },
      },
    },
    {
      name: 'docker_list_images',
      category: 'docker',
      permissionLevel: 'read',
      description: 'List local Docker images.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'docker_build_image',
      category: 'docker',
      permissionLevel: 'execute',
      description: 'Build a Docker image from a Dockerfile.',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Image tag name.' },
          dockerfilePath: { type: 'string', description: 'Path to Dockerfile.' },
          contextPath: { type: 'string', description: 'Build context directory.' },
        },
        required: ['tag'],
      },
    },
    {
      name: 'docker_start_container',
      category: 'docker',
      permissionLevel: 'execute',
      description: 'Start an existing Docker container.',
      parameters: {
        type: 'object',
        properties: { containerId: { type: 'string', description: 'Container ID or name.' } },
        required: ['containerId'],
      },
    },
    {
      name: 'docker_stop_container',
      category: 'docker',
      permissionLevel: 'destructive',
      description: 'Stop a running Docker container.',
      parameters: {
        type: 'object',
        properties: { containerId: { type: 'string', description: 'Container ID.' } },
        required: ['containerId'],
      },
    },
    {
      name: 'docker_read_logs',
      category: 'docker',
      permissionLevel: 'read',
      description: 'Read stdout/stderr logs from a Docker container.',
      parameters: {
        type: 'object',
        properties: {
          containerId: { type: 'string', description: 'Container ID.' },
          tailLines: { type: 'number', description: 'Number of lines.' },
        },
        required: ['containerId'],
      },
    },
    {
      name: 'docker_execute_command',
      category: 'docker',
      permissionLevel: 'execute',
      description: 'Execute a command inside a running Docker container.',
      parameters: {
        type: 'object',
        properties: {
          containerId: { type: 'string', description: 'Container ID.' },
          command: { type: 'string', description: 'Command to run.' },
        },
        required: ['containerId', 'command'],
      },
    },
    {
      name: 'docker_compose_up',
      category: 'docker',
      permissionLevel: 'execute',
      description: 'Start services defined in docker-compose.yml in detached mode.',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string', description: 'Compose file path.' } },
      },
    },
    {
      name: 'docker_compose_down',
      category: 'docker',
      permissionLevel: 'destructive',
      description: 'Stop and remove services defined in docker-compose.yml.',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string', description: 'Compose file path.' } },
      },
    },

    // --- DATABASE ---
    {
      name: 'database_list_tables',
      category: 'database',
      permissionLevel: 'read',
      description: 'List all tables in SQLite, PostgreSQL, or MySQL database.',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['sqlite', 'postgres', 'mysql'] },
          databasePath: { type: 'string', description: 'Path to SQLite database file.' },
        },
      },
    },
    {
      name: 'database_describe_table',
      category: 'database',
      permissionLevel: 'read',
      description: 'Describe table schema, columns, and types.',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name.' },
          databasePath: { type: 'string', description: 'Path to SQLite database file.' },
        },
        required: ['table'],
      },
    },
    {
      name: 'database_query_readonly',
      category: 'database',
      permissionLevel: 'read',
      description: 'Execute a read-only SELECT query against the database.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'SELECT SQL query.' },
          databasePath: { type: 'string', description: 'Path to SQLite db.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'database_execute',
      category: 'database',
      permissionLevel: 'destructive',
      description: 'Execute a database mutation or schema statement (INSERT, UPDATE, DELETE, CREATE, ALTER).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'SQL statement.' },
          databasePath: { type: 'string', description: 'Path to SQLite db.' },
        },
        required: ['query'],
      },
    },

    // --- HTTP ---
    {
      name: 'http_get',
      category: 'http',
      permissionLevel: 'network',
      description: 'Send an HTTP GET request to an API endpoint or web URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL.' },
          headers: { type: 'object', description: 'HTTP headers.' },
        },
        required: ['url'],
      },
    },
    {
      name: 'http_post',
      category: 'http',
      permissionLevel: 'network',
      description: 'Send an HTTP POST request with a payload to an API endpoint.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL.' },
          body: { description: 'Request payload (object or string).' },
          headers: { type: 'object', description: 'HTTP headers.' },
        },
        required: ['url'],
      },
    },
    {
      name: 'http_download_file',
      category: 'http',
      permissionLevel: 'network',
      description: 'Download a remote file over HTTP and save it into the workspace.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Remote URL.' },
          destinationPath: { type: 'string', description: 'Destination file path.' },
        },
        required: ['url', 'destinationPath'],
      },
    },

    // --- CODEBASE SEARCH & DIAGNOSTICS ---
    {
      name: 'search_codebase',
      category: 'filesystem',
      permissionLevel: 'read',
      description: 'Search for text across all text files in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term or text snippet.' },
          caseSensitive: { type: 'boolean', description: 'Case sensitive matching.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_symbols',
      category: 'filesystem',
      permissionLevel: 'read',
      description: 'Search for code symbols (functions, classes, interfaces, types).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Symbol name query.' } },
        required: ['query'],
      },
    },
    {
      name: 'inspect_diagnostics',
      category: 'filesystem',
      permissionLevel: 'read',
      description: 'Inspect active IDE diagnostics (compilation errors, linter warnings).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Optional relative path filter.' } },
      },
    },
  ];

  constructor(mcpHostOrPm?: any, permissionManager?: PermissionManager) {
    if (mcpHostOrPm && typeof mcpHostOrPm.getMode === 'function') {
      this.permissionManager = mcpHostOrPm;
      this.mcpHost = undefined;
    } else {
      this.mcpHost = mcpHostOrPm;
      this.permissionManager = permissionManager;
    }
  }

  public setMcpHost(mcpHost: McpHost): void {
    this.mcpHost = mcpHost;
  }

  public setPermissionManager(permissionManager: PermissionManager): void {
    this.permissionManager = permissionManager;
  }

  public getPermissionManager(): PermissionManager | undefined {
    return this.permissionManager;
  }

  public getToolDefinitions(
    roleFilter?: string,
    taskContext?: { affectedFiles?: string[]; prompt?: string }
  ): ToolDefinition[] {
    const staticTools = [...this.staticDefinitions];
    const mcpTools = (this.mcpHost && typeof this.mcpHost.getDiscoveredToolDefinitions === 'function') ? this.mcpHost.getDiscoveredToolDefinitions() : [];
    const all = [...staticTools, ...mcpTools];

    // If a task context is provided, scope tools intelligently to reduce prompt size for local models
    if (taskContext && (taskContext.prompt || (taskContext.affectedFiles && taskContext.affectedFiles.length > 0))) {
      const text = `${taskContext.prompt || ''} ${(taskContext.affectedFiles || []).join(' ')}`.toLowerCase();

      const CORE_TOOL_NAMES = new Set([
        'write_file',
        'edit_file',
        'read_file',
        'list_directory',
        'get_project_structure',
        'run_command',
        'run_tests',
        'inspect_git_status',
        'read_git_diff',
        'search_codebase',
      ]);

      const needsBrowser =
        /\b(browser|web|url|html|dom|scrape|css|frontend|click|navigate|page|link|href)\b/i.test(text) ||
        roleFilter === 'Frontend Developer';
      const needsDocker =
        /\b(docker|container|compose|dockerfile|image)\b/i.test(text) ||
        roleFilter === 'DevOps Engineer';
      const needsDatabase =
        /\b(database|sql|sqlite|postgres|mysql|table|query|migration|schema)\b/i.test(text) ||
        roleFilter === 'Database Engineer';
      const needsComputer =
        /\b(desktop|gui|screenshot|window|mouse|keyboard|screen|display)\b/i.test(text) ||
        roleFilter === 'OS Operator';
      const needsGitAdvanced =
        /\b(branch|commit|checkout|merge|stash|revert|worktree|history|log)\b/i.test(text);
      const needsHttp =
        /\b(http|api|request|download|fetch|curl)\b/i.test(text);
      const needsMcp =
        /\bmcp\b/i.test(text) || (mcpTools.length > 0 && !roleFilter);

      const needsInteractiveProcess =
        /\b(run|start|launch|serve|interactive|input|prompt|ui|gui|window|server|watch|daemon)\b/i.test(text);
      const INTERACTIVE_PROCESS_TOOLS = new Set([
        'start_process',
        'read_output',
        'write_stdin',
        'terminate_process',
      ]);

      return all.filter((t) => {
        if (CORE_TOOL_NAMES.has(t.name)) return true;
        if (needsInteractiveProcess && INTERACTIVE_PROCESS_TOOLS.has(t.name)) return true;
        if (needsBrowser && (t.category === 'browser' || t.category === 'app')) return true;
        if (needsDocker && t.category === 'docker') return true;
        if (needsDatabase && t.category === 'database') return true;
        if (needsComputer && (t.category === 'computer_use' || t.category === 'app')) return true;
        if (needsGitAdvanced && t.category === 'git') return true;
        if (needsHttp && t.category === 'http') return true;
        if (needsMcp && t.category === 'mcp') return true;
        return false;
      });
    }

    if (!roleFilter) return all;

    // Filter tools relevant to agent role
    switch (roleFilter) {
      case 'Frontend Developer':
        return all.filter((t) =>
          ['filesystem', 'browser', 'terminal', 'app', 'mcp'].includes(t.category)
        );
      case 'Backend Developer':
        return all.filter((t) =>
          ['filesystem', 'terminal', 'database', 'docker', 'http', 'mcp'].includes(t.category)
        );
      case 'Test Engineer':
        return all.filter((t) =>
          ['filesystem', 'terminal', 'browser', 'mcp'].includes(t.category)
        );
      case 'Security Auditor':
      case 'Critic Agent':
        return all.filter((t) =>
          t.permissionLevel === 'read' || ['filesystem', 'git'].includes(t.category)
        );
      case 'Database Engineer':
        return all.filter((t) =>
          ['database', 'filesystem', 'docker', 'terminal'].includes(t.category)
        );
      case 'DevOps Engineer':
        return all.filter((t) =>
          ['docker', 'terminal', 'git', 'filesystem', 'http'].includes(t.category)
        );
      default:
        return all;
    }
  }

  public getOllamaTools(
    roleFilter?: string,
    taskContext?: { affectedFiles?: string[]; prompt?: string }
  ): any[] {
    return this.getToolDefinitions(roleFilter, taskContext).map((def) => ({
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      },
    }));
  }

  private normalizeArgs(name: string, args: Record<string, any>): Record<string, any> {
    const normalized: Record<string, any> = { ...args };

    // Path aliases
    if (!normalized.path) {
      normalized.path = args.filePath || args.filepath || args.file || args.filename || args.target || args.dir || args.directory || args.folder;
    }

    // Content aliases
    if (normalized.content === undefined) {
      normalized.content = args.code ?? args.text ?? args.source ?? args.body ?? args.contents;
    }

    // Command aliases
    if (!normalized.command) {
      normalized.command = args.cmd || args.script || args.input || args.commandLine;
    }

    // Edit aliases
    if (!normalized.target) {
      normalized.target = args.search || args.old_string || args.oldText || args.find || args.expected;
    }
    if (normalized.replacement === undefined) {
      normalized.replacement = args.replace ?? args.new_string ?? args.newText;
    }

    return normalized;
  }

  public async executeTool(rawName: string, rawArgs: Record<string, any>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const startTime = Date.now();
    const cleanName = (rawName || '').trim();
    const aliasKey = cleanName.toLowerCase();
    const name = TOOL_ALIASES[aliasKey] || cleanName;
    const args = this.normalizeArgs(name, rawArgs || {});
    const toolDef = this.getToolDefinitions().find((t) => t.name === name) || this.getToolDefinitions().find((t) => t.name === cleanName);

    // Permission Check
    if (this.permissionManager && toolDef) {
      ctx.requireApproval = this.permissionManager.isApprovalRequired(toolDef, ctx.taskId, args);
    }

    let result: ToolResult;

    // Check if MCP tool
    if (name.startsWith('mcp__') && this.mcpHost) {
      const parts = name.split('__');
      const serverId = parts[1];
      const mcpToolName = parts.slice(2).join('__');
      result = await this.mcpHost.executeMcpTool(serverId, mcpToolName, args, ctx);
    } else {
      switch (name) {
        // Filesystem
        case 'read_file':
          result = await readFileTool(args as { path: string }, ctx);
          break;
        case 'read_lines':
          result = await readLinesTool(args as { path: string; startLine: number; endLine?: number }, ctx);
          break;
        case 'write_file':
          result = await writeFileTool(args as { path: string; content: string }, ctx);
          break;
        case 'edit_file':
          result = await editFileTool(args as { path: string; target: string; replacement: string }, ctx);
          break;
        case 'rename_file':
          result = await renameFileTool(args as { oldPath: string; newPath: string }, ctx);
          break;
        case 'delete_file':
          result = await deleteFileTool(args as { path: string }, ctx);
          break;
        case 'list_directory':
          result = await listDirectoryTool(args as { path?: string; maxDepth?: number }, ctx);
          break;
        case 'get_metadata':
          result = await getMetadataTool(args as { path: string }, ctx);
          break;
        case 'get_project_structure':
          result = await getProjectStructureTool(args, ctx);
          break;

        // Terminal
        case 'run_command':
          result = await runCommandTool(
            args as { command: string; stdin?: string; input?: string; timeoutMs?: number; cwd?: string },
            ctx
          );
          break;
        case 'start_process':
          result = await startProcessTool(args as { processId?: string; command: string; cwd?: string }, ctx);
          break;
        case 'read_output':
          result = await readOutputTool(args as { processId: string; tailLines?: number }, ctx);
          break;
        case 'write_stdin':
          result = await writeStdinTool(args as { processId: string; input: string }, ctx);
          break;
        case 'terminate_process':
          result = await terminateProcessTool(args as { processId: string }, ctx);
          break;
        case 'list_processes':
          result = await listProcessesTool(args, ctx);
          break;
        case 'list_ports':
          result = await listPortsTool(args as { checkPorts?: number[] }, ctx);
          break;
        case 'run_tests':
          result = await runTestsTool(args as { testPath?: string }, ctx);
          break;
        case 'run_build':
          result = await runBuildTool(args, ctx);
          break;
        case 'run_lint':
          result = await runLintTool(args, ctx);
          break;

        // App
        case 'app_launch':
          result = await appLaunchTool(args as { command: string; args?: string[] }, ctx);
          break;
        case 'app_open_url':
          result = await appOpenUrlTool(args as { url: string }, ctx);
          break;
        case 'app_open_file':
          result = await appOpenFileTool(args as { path: string }, ctx);
          break;
        case 'app_get_running_applications':
          result = await appGetRunningApplicationsTool(args, ctx);
          break;
        case 'app_terminate':
          result = await appTerminateTool(args as { pid?: number; processName?: string }, ctx);
          break;

        // Browser
        case 'browser_launch':
          result = await browserLaunchTool(args as { headless?: boolean }, ctx);
          break;
        case 'browser_close':
          result = await browserCloseTool(args, ctx);
          break;
        case 'browser_navigate':
          result = await browserNavigateTool(args as { url: string; timeoutMs?: number }, ctx);
          break;
        case 'browser_click':
          result = await browserClickTool(args as { selector: string; timeoutMs?: number }, ctx);
          break;
        case 'browser_fill':
          result = await browserFillTool(args as { selector: string; text: string; timeoutMs?: number }, ctx);
          break;
        case 'browser_type':
          result = await browserTypeTool(args as { selector: string; text: string; delayMs?: number }, ctx);
          break;
        case 'browser_press_key':
          result = await browserPressKeyTool(args as { key: string }, ctx);
          break;
        case 'browser_select':
          result = await browserSelectTool(args as { selector: string; value: string }, ctx);
          break;
        case 'browser_get_content':
          result = await browserGetContentTool(args as { selector?: string }, ctx);
          break;
        case 'browser_get_console_logs':
          result = await browserGetConsoleLogsTool(args, ctx);
          break;
        case 'browser_get_network_errors':
          result = await browserGetNetworkErrorsTool(args, ctx);
          break;
        case 'browser_take_screenshot':
          result = await browserTakeScreenshotTool(args as { name?: string; fullPage?: boolean }, ctx);
          break;
        case 'browser_get_current_url':
          result = await browserGetCurrentUrlTool(args, ctx);
          break;

        // Computer Use
        case 'computer_screenshot':
          result = await computerScreenshotTool(args as { name?: string }, ctx);
          break;
        case 'computer_list_windows':
          result = await computerListWindowsTool(args, ctx);
          break;
        case 'computer_focus_window':
          result = await computerFocusWindowTool(args as { windowId: string }, ctx);
          break;
        case 'computer_mouse_move':
          result = await computerMouseMoveTool(args as { x: number; y: number }, ctx);
          break;
        case 'computer_mouse_click':
          result = await computerMouseClickTool(args as { button?: number; x?: number; y?: number }, ctx);
          break;
        case 'computer_keyboard_type':
          result = await computerKeyboardTypeTool(args as { text: string; delayMs?: number }, ctx);
          break;
        case 'computer_keyboard_press_key':
          result = await computerKeyboardPressKeyTool(args as { key: string }, ctx);
          break;

        // Git
        case 'read_git_diff':
          result = await readGitDiffTool(args as { path?: string; staged?: boolean }, ctx);
          break;
        case 'inspect_git_status':
          result = await inspectGitStatusTool(args, ctx);
          break;
        case 'git_log':
          result = await gitLogTool(args as { limit?: number; file?: string }, ctx);
          break;
        case 'git_show':
          result = await gitShowTool(args as { revision?: string; file?: string }, ctx);
          break;
        case 'git_branch_list':
          result = await gitBranchListTool(args, ctx);
          break;
        case 'git_create_branch':
          result = await gitCreateBranchTool(args as { name: string; checkout?: boolean }, ctx);
          break;
        case 'git_checkout':
          result = await gitCheckoutTool(args as { target: string }, ctx);
          break;
        case 'stage_file':
          result = await stageFileTool(args as { path: string }, ctx);
          break;
        case 'unstage_file':
          result = await unstageFileTool(args as { path: string }, ctx);
          break;
        case 'git_commit':
          result = await gitCommitTool(args as { message: string; stageAll?: boolean }, ctx);
          break;
        case 'revert_file':
          result = await revertFileTool(args as { path: string }, ctx);
          break;
        case 'create_checkpoint':
          result = await createCheckpointTool(args as { description: string }, ctx);
          break;
        case 'git_worktree_create':
          result = await gitWorktreeCreateTool(args as { name: string; branch?: string }, ctx);
          break;
        case 'git_worktree_remove':
          result = await gitWorktreeRemoveTool(args as { name: string }, ctx);
          break;
        case 'git_merge_analysis':
          result = await gitMergeAnalysisTool(args as { targetBranch: string }, ctx);
          break;

        // Docker
        case 'docker_list_containers':
          result = await dockerListContainersTool(args as { all?: boolean }, ctx);
          break;
        case 'docker_list_images':
          result = await dockerListImagesTool(args, ctx);
          break;
        case 'docker_build_image':
          result = await dockerBuildImageTool(args as { tag: string; dockerfilePath?: string }, ctx);
          break;
        case 'docker_start_container':
          result = await dockerStartContainerTool(args as { containerId: string }, ctx);
          break;
        case 'docker_stop_container':
          result = await dockerStopContainerTool(args as { containerId: string }, ctx);
          break;
        case 'docker_read_logs':
          result = await dockerReadLogsTool(args as { containerId: string; tailLines?: number }, ctx);
          break;
        case 'docker_execute_command':
          result = await dockerExecuteCommandTool(args as { containerId: string; command: string }, ctx);
          break;
        case 'docker_compose_up':
          result = await dockerComposeUpTool(args as { file?: string }, ctx);
          break;
        case 'docker_compose_down':
          result = await dockerComposeDownTool(args as { file?: string }, ctx);
          break;

        // Database
        case 'database_list_tables':
          result = await databaseListTablesTool(args as { databasePath?: string }, ctx);
          break;
        case 'database_describe_table':
          result = await databaseDescribeTableTool(args as { table: string; databasePath?: string }, ctx);
          break;
        case 'database_query_readonly':
          result = await databaseQueryReadonlyTool(args as { query: string; databasePath?: string }, ctx);
          break;
        case 'database_execute':
          result = await databaseExecuteTool(args as { query: string; databasePath?: string }, ctx);
          break;

        // HTTP
        case 'http_get':
          result = await httpGetTool(args as { url: string; headers?: Record<string, string> }, ctx);
          break;
        case 'http_post':
          result = await httpPostTool(args as { url: string; body?: any; headers?: Record<string, string> }, ctx);
          break;
        case 'http_download_file':
          result = await httpDownloadFileTool(args as { url: string; destinationPath: string }, ctx);
          break;

        // Codebase search
        case 'search_codebase':
          result = await searchCodebaseTool(args as { query: string; caseSensitive?: boolean }, ctx);
          break;
        case 'search_symbols':
          result = await searchSymbolsTool(args as { query: string }, ctx);
          break;
        case 'inspect_diagnostics':
          result = await inspectDiagnosticsTool(args as { path?: string }, ctx);
          break;

        default:
          result = { success: false, error: `Unrecognized tool name: '${name}'` };
      }
    }

    // Audit Logging
    const durationMs = Date.now() - startTime;
    if (this.permissionManager) {
      const event: ToolAuditEvent = {
        id: `aud_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        toolName: name,
        category: toolDef?.category || 'custom',
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        taskId: ctx.taskId,
        argsSummary: JSON.stringify(args),
        environment: 'native',
        startTime,
        endTime: Date.now(),
        durationMs,
        status: result.success ? 'completed' : 'failed',
        error: result.error,
        approved: ctx.requireApproval,
      };
      this.permissionManager.recordEvent(event);
      if (ctx.logEvent) {
        ctx.logEvent(event);
      }
    }

    return result;
  }
}
