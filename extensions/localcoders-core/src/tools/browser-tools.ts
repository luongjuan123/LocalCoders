import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { ToolExecutionContext, ToolResult } from './types';

export class BrowserManager {
  private static instance: BrowserManager;
  private browser: any = null;
  private context: any = null;
  private page: any = null;
  private consoleLogs: Array<{ type: string; text: string; location?: string }> = [];
  private networkErrors: Array<{ url: string; status?: number; errorText?: string }> = [];

  public static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager();
    }
    return BrowserManager.instance;
  }

  private async getPlaywright(): Promise<any> {
    try {
      return require('playwright');
    } catch {
      return require('/home/juan/localcoders-oss/node_modules/playwright');
    }
  }

  public async launch(headless: boolean = true): Promise<any> {
    if (this.browser && this.page) {
      return this.page;
    }

    const pw = await this.getPlaywright();
    this.browser = await pw.chromium.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    this.page = await this.context.newPage();
    this.consoleLogs = [];
    this.networkErrors = [];

    // Capture console logs
    this.page.on('console', (msg: any) => {
      this.consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        location: msg.location() ? `${msg.location().url}:${msg.location().lineNumber}` : undefined,
      });
      if (this.consoleLogs.length > 500) this.consoleLogs.shift();
    });

    // Capture network failures
    this.page.on('requestfailed', (req: any) => {
      this.networkErrors.push({
        url: req.url(),
        errorText: req.failure()?.errorText,
      });
      if (this.networkErrors.length > 200) this.networkErrors.shift();
    });

    this.page.on('response', (res: any) => {
      if (res.status() >= 400) {
        this.networkErrors.push({
          url: res.url(),
          status: res.status(),
          errorText: res.statusText(),
        });
        if (this.networkErrors.length > 200) this.networkErrors.shift();
      }
    });

    return this.page;
  }

  public async ensurePage(): Promise<any> {
    if (!this.page) {
      await this.launch(true);
    }
    return this.page;
  }

  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  public getLogs(): Array<{ type: string; text: string; location?: string }> {
    return [...this.consoleLogs];
  }

  public getErrors(): Array<{ url: string; status?: number; errorText?: string }> {
    return [...this.networkErrors];
  }

  public clearLogs(): void {
    this.consoleLogs = [];
    this.networkErrors = [];
  }
}

export async function browserLaunchTool(
  args: { headless?: boolean },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    await bm.launch(args.headless !== false);
    return { success: true, output: { status: 'launched', headless: args.headless !== false } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function browserCloseTool(_args: {}, _ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    await bm.close();
    return { success: true, output: { status: 'closed' } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function browserNavigateTool(
  args: { url: string; timeoutMs?: number },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    const page = await bm.ensurePage();
    const timeout = args.timeoutMs || 30000;

    await page.goto(args.url, { timeout, waitUntil: 'load' });
    const title = await page.title();
    const currentUrl = page.url();

    return {
      success: true,
      output: {
        url: currentUrl,
        title,
        status: 'navigated',
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function browserClickTool(
  args: { selector: string; timeoutMs?: number },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    const page = await bm.ensurePage();
    await page.click(args.selector, { timeout: args.timeoutMs || 10000 });
    return { success: true, output: { selector: args.selector, clicked: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function browserFillTool(
  args: { selector: string; text: string; timeoutMs?: number },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    const page = await bm.ensurePage();
    await page.fill(args.selector, args.text, { timeout: args.timeoutMs || 10000 });
    return { success: true, output: { selector: args.selector, filled: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function browserTypeTool(
  args: { selector: string; text: string; delayMs?: number },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    const page = await bm.ensurePage();
    await page.type(args.selector, args.text, { delay: args.delayMs || 50 });
    return { success: true, output: { selector: args.selector, typed: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function browserPressKeyTool(
  args: { key: string },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    const page = await bm.ensurePage();
    await page.keyboard.press(args.key);
    return { success: true, output: { key: args.key, pressed: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function browserSelectTool(
  args: { selector: string; value: string },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    const page = await bm.ensurePage();
    const selected = await page.selectOption(args.selector, args.value);
    return { success: true, output: { selector: args.selector, selected } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function browserGetContentTool(
  args: { selector?: string },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    const page = await bm.ensurePage();
    let text = '';
    if (args.selector) {
      text = await page.innerText(args.selector);
    } else {
      text = await page.innerText('body');
    }
    return { success: true, output: { text: text.trim() } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function browserGetConsoleLogsTool(
  _args: {},
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    const logs = bm.getLogs();
    const errors = logs.filter((l) => l.type === 'error');
    return {
      success: true,
      output: {
        totalLogs: logs.length,
        errorCount: errors.length,
        logs,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function browserGetNetworkErrorsTool(
  _args: {},
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    const errors = bm.getErrors();
    return {
      success: true,
      output: {
        networkErrors: errors,
        count: errors.length,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function browserTakeScreenshotTool(
  args: { name?: string; fullPage?: boolean },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    const page = await bm.ensurePage();
    const screenshotDir = path.join(ctx.workspaceRoot, '.localcoders', 'screenshots');
    if (!fsSync.existsSync(screenshotDir)) {
      await fs.mkdir(screenshotDir, { recursive: true });
    }

    const filename = `${args.name || 'screenshot'}_${Date.now()}.png`;
    const fullPath = path.join(screenshotDir, filename);

    const buffer = await page.screenshot({
      path: fullPath,
      fullPage: args.fullPage || false,
    });

    const relPath = path.relative(ctx.workspaceRoot, fullPath);
    const base64 = buffer.toString('base64');

    return {
      success: true,
      output: {
        path: relPath,
        filename,
        fullPath,
        sizeBytes: buffer.length,
        base64Preview: `data:image/png;base64,${base64.substring(0, 100)}...`,
      },
      metadata: {
        screenshotPath: relPath,
        base64: `data:image/png;base64,${base64}`,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function browserGetCurrentUrlTool(
  _args: {},
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const bm = BrowserManager.getInstance();
    const page = await bm.ensurePage();
    return {
      success: true,
      output: {
        url: page.url(),
        title: await page.title(),
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
