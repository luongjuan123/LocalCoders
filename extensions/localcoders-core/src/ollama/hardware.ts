import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { HardwareInfo } from './types';

const execAsync = promisify(exec);

export async function detectHardware(ollamaHost: string = 'http://127.0.0.1:11434'): Promise<HardwareInfo> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown CPU';
  const cpuCores = cpus.length;

  let ollamaInstalled = false;
  let ollamaRunning = false;
  let ollamaVersion: string | undefined = undefined;

  // 1. Detect if ollama executable exists
  try {
    const { stdout } = await execAsync('which ollama');
    if (stdout.trim().length > 0) {
      ollamaInstalled = true;
    }
  } catch {
    ollamaInstalled = false;
  }

  // 2. Detect if Ollama server is running
  try {
    const res = await fetch(`${ollamaHost}/api/version`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as { version: string };
      ollamaRunning = true;
      ollamaVersion = data.version;
    }
  } catch {
    ollamaRunning = false;
  }

  // 3. GPU detection
  let gpu: { name: string; memoryTotalMb: number; memoryFreeMb: number } | undefined = undefined;
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits');
    const lines = stdout.trim().split('\n');
    if (lines.length > 0 && lines[0].includes(',')) {
      const [name, total, free] = lines[0].split(',').map((s) => s.trim());
      gpu = {
        name,
        memoryTotalMb: parseInt(total, 10) || 0,
        memoryFreeMb: parseInt(free, 10) || 0,
      };
    }
  } catch {
    // GPU check non-critical fallback
  }

  return {
    os: `${os.type()} ${os.release()}`,
    platform: os.platform(),
    cpu: {
      model: cpuModel,
      cores: cpuCores,
    },
    ram: {
      totalBytes: totalMem,
      availableBytes: freeMem,
      usedBytes: totalMem - freeMem,
      totalGb: Math.round((totalMem / (1024 * 1024 * 1024)) * 10) / 10,
      availableGb: Math.round((freeMem / (1024 * 1024 * 1024)) * 10) / 10,
    },
    gpu,
    ollamaInstalled,
    ollamaRunning,
    ollamaVersion,
  };
}
