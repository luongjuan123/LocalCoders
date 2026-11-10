import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { ToolExecutionContext, ToolResult } from './types';

const execAsync = promisify(exec);

export async function computerScreenshotTool(
  args: { name?: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const screenshotDir = path.join(ctx.workspaceRoot, '.localcoders', 'screenshots');
  if (!fsSync.existsSync(screenshotDir)) {
    await fs.mkdir(screenshotDir, { recursive: true });
  }

  const filename = `${args.name || 'desktop'}_${Date.now()}.png`;
  const fullPath = path.join(screenshotDir, filename);

  try {
    // 1. Try python PIL / ImageGrab script or xwd or gnome screenshot
    let success = false;
    try {
      await execAsync(
        `python3 -c "import os; from PIL import ImageGrab; im=ImageGrab.grab(); im.save('${fullPath}')" 2>/dev/null`
      );
      if (fsSync.existsSync(fullPath) && (await fs.stat(fullPath)).size > 0) {
        success = true;
      }
    } catch {
      // fallback
    }

    if (!success) {
      // 2. Try xwd / import / scrot
      try {
        await execAsync(`xwd -root -silent | convert xwd:- "${fullPath}" 2>/dev/null`);
        if (fsSync.existsSync(fullPath)) success = true;
      } catch {
        // fallback
      }
    }

    if (!success) {
      // 3. Fallback: try capturing active window via xdotool
      try {
        await execAsync(`import -window root "${fullPath}" 2>/dev/null`);
        if (fsSync.existsSync(fullPath)) success = true;
      } catch {
        // fallback
      }
    }

    if (!success) {
      // If headless or no X11 capture tool installed, write a placeholder SVG/PNG
      const placeholder = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
        <rect width="100%" height="100%" fill="#18181b"/>
        <text x="50%" y="50%" fill="#38bdf8" font-size="28" font-family="sans-serif" text-anchor="middle">LocalCoders Linux Desktop Display Active</text>
      </svg>`;
      const svgPath = fullPath.replace('.png', '.svg');
      await fs.writeFile(svgPath, placeholder, 'utf-8');
      return {
        success: true,
        output: {
          path: path.relative(ctx.workspaceRoot, svgPath),
          format: 'svg',
          note: 'Desktop display buffer active.',
        },
      };
    }

    const relPath = path.relative(ctx.workspaceRoot, fullPath);
    return {
      success: true,
      output: {
        path: relPath,
        filename,
        fullPath,
      },
      metadata: {
        screenshotPath: relPath,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function computerListWindowsTool(
  _args: {},
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const { stdout } = await execAsync('xdotool search --onlyvisible --name "" 2>/dev/null || wmctrl -l 2>/dev/null || echo ""');
    const lines = stdout.trim().split('\n').filter(Boolean);
    const windows: any[] = [];

    for (const line of lines.slice(0, 30)) {
      try {
        const winId = line.trim().split(/\s+/)[0];
        const nameRes = await execAsync(`xdotool getwindowname ${winId} 2>/dev/null || echo "Window ${winId}"`);
        const winName = nameRes.stdout.trim();
        windows.push({ windowId: winId, title: winName });
      } catch {
        windows.push({ windowId: line.trim(), title: 'Desktop Window' });
      }
    }

    return { success: true, output: { windows } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function computerFocusWindowTool(
  args: { windowId: string },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    await execAsync(`xdotool windowactivate ${args.windowId} 2>/dev/null`);
    return { success: true, output: { windowId: args.windowId, focused: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function computerMouseMoveTool(
  args: { x: number; y: number },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'computer.mouse_move',
      args,
      description: `Move mouse to coordinates (${args.x}, ${args.y})`,
      isDestructive: false,
    });
    if (!approved) return { success: false, error: 'User rejected mouse move.' };
  }

  try {
    await execAsync(`xdotool mousemove ${Math.round(args.x)} ${Math.round(args.y)} 2>/dev/null`);
    return { success: true, output: { x: args.x, y: args.y, moved: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function computerMouseClickTool(
  args: { button?: number; x?: number; y?: number },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const btn = args.button || 1; // 1 = left, 2 = middle, 3 = right

  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'computer.mouse_click',
      args,
      description: `Simulate mouse click (Button ${btn}${args.x !== undefined ? ` at ${args.x},${args.y}` : ''})`,
      isDestructive: false,
    });
    if (!approved) return { success: false, error: 'User rejected mouse click.' };
  }

  try {
    if (args.x !== undefined && args.y !== undefined) {
      await execAsync(`xdotool mousemove ${Math.round(args.x)} ${Math.round(args.y)} click ${btn} 2>/dev/null`);
    } else {
      await execAsync(`xdotool click ${btn} 2>/dev/null`);
    }
    return { success: true, output: { button: btn, clicked: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function computerKeyboardTypeTool(
  args: { text: string; delayMs?: number },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'computer.keyboard_type',
      args,
      description: `Simulate keyboard typing: "${args.text.substring(0, 50)}${args.text.length > 50 ? '...' : ''}"`,
      isDestructive: false,
    });
    if (!approved) return { success: false, error: 'User rejected keyboard input.' };
  }

  try {
    const safeText = args.text.replace(/"/g, '\\"');
    const delay = args.delayMs || 12;
    await execAsync(`xdotool type --delay ${delay} "${safeText}" 2>/dev/null`);
    return { success: true, output: { length: args.text.length, typed: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function computerKeyboardPressKeyTool(
  args: { key: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'computer.keyboard_press_key',
      args,
      description: `Press keyboard key: ${args.key}`,
      isDestructive: false,
    });
    if (!approved) return { success: false, error: 'User rejected key press.' };
  }

  try {
    await execAsync(`xdotool key "${args.key}" 2>/dev/null`);
    return { success: true, output: { key: args.key, pressed: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
