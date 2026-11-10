import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { HardwareInfo } from './types';

const execAsync = promisify(exec);

export interface LiveSystemTelemetry {
  cpu: {
    model: string;
    shortModel: string;
    cores: number;
    usagePercent: number;
  };
  ram: {
    totalGb: number;
    usedGb: number;
    usagePercent: number;
  };
  gpu?: {
    name: string;
    shortName: string;
    memoryUsedMb: number;
    memoryTotalMb: number;
    utilizationPercent: number;
    temperatureC?: number;
  };
  ollama: {
    running: boolean;
    activeModels: string[];
    totalVramGb?: number;
  };
  platform: string;
  timestamp: number;
}

interface CpuTickSnapshot {
  active: number;
  idle: number;
}

let prevCpuSnapshot: CpuTickSnapshot | undefined;

export function shortCpuModel(model: string): string {
  return String(model || 'CPU')
    .replace(/\(R\)|\(TM\)|CPU|@.*$/gi, '')
    .replace(/^\d+(?:th|st|nd|rd)\s+Gen\s+/i, '')
    .replace(/^Intel\s+Core\s+/i, '')
    .replace(/^AMD\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim() || 'CPU';
}

export function shortGpuName(name: string): string {
  return String(name || 'GPU')
    .replace(/^NVIDIA\s+GeForce\s+/i, '')
    .replace(/^NVIDIA\s+/i, '')
    .replace(/^AMD\s+Radeon\s+/i, 'Radeon ')
    .replace(/\s+/g, ' ')
    .trim() || 'GPU';
}

function sampleCpuUsagePercent(cores: number): number {
  const cpus = os.cpus();
  let active = 0;
  let idle = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    active += t.user + t.nice + t.sys + t.irq;
    idle += t.idle;
  }
  const current: CpuTickSnapshot = { active, idle };
  if (!prevCpuSnapshot) {
    prevCpuSnapshot = current;
    const load1m = os.loadavg()[0] || 0;
    return Math.max(0, Math.min(100, Math.round((load1m / Math.max(1, cores)) * 100)));
  }
  const activeDelta = current.active - prevCpuSnapshot.active;
  const idleDelta = current.idle - prevCpuSnapshot.idle;
  prevCpuSnapshot = current;
  const totalDelta = activeDelta + idleDelta;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((activeDelta / totalDelta) * 100)));
}

function readSystemRamStats(): { totalGb: number; usedGb: number; usagePercent: number } {
  let totalBytes = os.totalmem();
  let availableBytes = os.freemem();
  if (process.platform === 'linux') {
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const totalKbMatch = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
      const availKbMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (totalKbMatch) totalBytes = parseInt(totalKbMatch[1], 10) * 1024;
      if (availKbMatch) availableBytes = parseInt(availKbMatch[1], 10) * 1024;
    } catch {
      // Fallback to os.totalmem() / os.freemem()
    }
  }
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const gib = 1024 * 1024 * 1024;
  const totalGb = Math.round((totalBytes / gib) * 10) / 10;
  const usedGb = Math.round((usedBytes / gib) * 10) / 10;
  const usagePercent = totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((usedBytes / totalBytes) * 100))) : 0;
  return { totalGb, usedGb, usagePercent };
}

export async function collectLiveSystemTelemetry(ollamaHost: string = 'http://127.0.0.1:11434'): Promise<LiveSystemTelemetry> {
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown CPU';
  const cpuCores = cpus.length || 1;
  const usagePercent = sampleCpuUsagePercent(cpuCores);
  const ram = readSystemRamStats();

  const [gpuResult, ollamaResult] = await Promise.all([
    execAsync('nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits', {
      timeout: 2000,
    }).catch(() => null),
    fetch(`${ollamaHost}/api/ps`, {
      method: 'GET',
      signal: AbortSignal.timeout(1200),
    })
      .then(async (r) => (r.ok ? ((await r.json()) as { models?: Array<{ name?: string; model?: string; size_vram?: number }> }) : null))
      .catch(() => null),
  ]);

  let gpu: LiveSystemTelemetry['gpu'];
  if (gpuResult && gpuResult.stdout) {
    const firstLine = gpuResult.stdout.trim().split('\n')[0] || '';
    const parts = firstLine.split(',').map((s) => s.trim());
    if (parts.length >= 4) {
      const name = parts[0] || 'GPU';
      const memoryUsedMb = parseInt(parts[1], 10) || 0;
      const memoryTotalMb = parseInt(parts[2], 10) || 0;
      const utilizationPercent = parseInt(parts[3], 10) || 0;
      const parsedTemp = parts[4] !== undefined ? parseInt(parts[4], 10) : NaN;
      gpu = {
        name,
        shortName: shortGpuName(name),
        memoryUsedMb,
        memoryTotalMb,
        utilizationPercent,
        temperatureC: Number.isFinite(parsedTemp) ? parsedTemp : undefined,
      };
    }
  }

  const runningModels = ollamaResult?.models || [];
  const totalVramBytes = runningModels.reduce((acc, m) => acc + (m.size_vram || 0), 0);
  const activeModels = runningModels.map((m) => m.name || m.model || '').filter(Boolean);

  return {
    cpu: {
      model: cpuModel,
      shortModel: shortCpuModel(cpuModel),
      cores: cpuCores,
      usagePercent,
    },
    ram,
    gpu,
    ollama: {
      running: ollamaResult !== null,
      activeModels,
      totalVramGb: totalVramBytes > 0 ? Math.round((totalVramBytes / (1024 ** 3)) * 10) / 10 : undefined,
    },
    platform: os.platform(),
    timestamp: Date.now(),
  };
}

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
