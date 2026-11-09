import { ToolDefinition, ToolExecutionContext, ToolResult } from './types';
import { readFileTool, writeFileTool, editFileTool, deleteFileTool, listDirectoryTool } from './fs-tools';
import { readGitDiffTool, inspectGitStatusTool, createCheckpointTool, stageFileTool, revertFileTool } from './git-tools';
import { runCommandTool, runTestsTool, runBuildTool, runLintTool } from './terminal-tools';
import { searchCodebaseTool, searchSymbolsTool, inspectDiagnosticsTool } from './search-tools';

export class ToolManager {
  private definitions: ToolDefinition[] = [
    {
      name: 'read_file',
      description: 'Read the text content of a file within the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file to read.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write full content to a file. Creates file and parent directories if they do not exist.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path of the file to write.' },
          content: { type: 'string', description: 'Complete content to write to the file.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: 'Replace an exact target snippet in a file with a replacement snippet.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path of the file to edit.' },
          target: { type: 'string', description: 'Exact string to be replaced.' },
          replacement: { type: 'string', description: 'New string to insert in place of target.' },
        },
        required: ['path', 'target', 'replacement'],
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file or directory in the workspace. Destructive operation.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to delete.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_directory',
      description: 'List directories and files in the workspace tree.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path to list. Defaults to workspace root.' },
          maxDepth: { type: 'number', description: 'Maximum tree depth (default 3).' },
        },
      },
    },
    {
      name: 'read_git_diff',
      description: 'Read current git diff of working tree or staged changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional specific file path.' },
          staged: { type: 'boolean', description: 'Whether to read staged (--cached) diff.' },
        },
      },
    },
    {
      name: 'inspect_git_status',
      description: 'Inspect git status of the workspace (current branch, modified, staged, untracked).',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'create_checkpoint',
      description: 'Create a safe git stash checkpoint before applying large multi-agent changes.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Brief description of the checkpoint.' },
        },
        required: ['description'],
      },
    },
    {
      name: 'stage_file',
      description: 'Stage a file for commit (git add).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to stage.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'revert_file',
      description: 'Revert working tree changes in a file back to HEAD.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to revert.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'run_command',
      description: 'Execute a terminal command in the workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command string to run.' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
        },
        required: ['command'],
      },
    },
    {
      name: 'run_tests',
      description: 'Run project tests using npm test.',
      parameters: {
        type: 'object',
        properties: {
          testPath: { type: 'string', description: 'Optional specific test file path.' },
        },
      },
    },
    {
      name: 'run_build',
      description: 'Run project build using npm run build.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'run_lint',
      description: 'Run project linter using npm run lint.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'search_codebase',
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
      description: 'Search for code symbols (functions, classes, interfaces, types).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name query.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'inspect_diagnostics',
      description: 'Inspect active IDE diagnostics (compilation errors, linter warnings).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional relative path filter.' },
        },
      },
    },
  ];

  getToolDefinitions(): ToolDefinition[] {
    return this.definitions;
  }

  // Convert to Ollama tool format
  getOllamaTools(): any[] {
    return this.definitions.map((def) => ({
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      },
    }));
  }

  async executeTool(name: string, args: Record<string, any>, ctx: ToolExecutionContext): Promise<ToolResult> {
    switch (name) {
      case 'read_file':
        return readFileTool(args as { path: string }, ctx);
      case 'write_file':
        return writeFileTool(args as { path: string; content: string }, ctx);
      case 'edit_file':
        return editFileTool(args as { path: string; target: string; replacement: string }, ctx);
      case 'delete_file':
        return deleteFileTool(args as { path: string }, ctx);
      case 'list_directory':
        return listDirectoryTool(args as { path?: string; maxDepth?: number }, ctx);
      case 'read_git_diff':
        return readGitDiffTool(args as { path?: string; staged?: boolean }, ctx);
      case 'inspect_git_status':
        return inspectGitStatusTool(args, ctx);
      case 'create_checkpoint':
        return createCheckpointTool(args as { description: string }, ctx);
      case 'stage_file':
        return stageFileTool(args as { path: string }, ctx);
      case 'revert_file':
        return revertFileTool(args as { path: string }, ctx);
      case 'run_command':
        return runCommandTool(args as { command: string; timeoutMs?: number }, ctx);
      case 'run_tests':
        return runTestsTool(args as { testPath?: string }, ctx);
      case 'run_build':
        return runBuildTool(args, ctx);
      case 'run_lint':
        return runLintTool(args, ctx);
      case 'search_codebase':
        return searchCodebaseTool(args as { query: string; caseSensitive?: boolean }, ctx);
      case 'search_symbols':
        return searchSymbolsTool(args as { query: string }, ctx);
      case 'inspect_diagnostics':
        return inspectDiagnosticsTool(args as { path?: string }, ctx);
      default:
        return { success: false, error: `Unrecognized tool name: '${name}'` };
    }
  }
}
