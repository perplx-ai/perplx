import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';
import { spawn, spawnSync } from 'child_process';
import { getBinDir, getSettingsPath } from '../config.js';
import { SettingsManager } from '../core/settings-manager.js';

let cachedShellConfig: { shell: string; args: string[] } | null = null;

function findBashOnPath(): string | null {
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('where', ['bash.exe'], { encoding: 'utf-8', timeout: 5000 });
      if (result.status === 0 && result.stdout) {
        const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
        if (firstMatch && existsSync(firstMatch)) return firstMatch;
      }
    } catch {}
    return null;
  }

  try {
    const result = spawnSync('which', ['bash'], { encoding: 'utf-8', timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) return firstMatch;
    }
  } catch {}
  return null;
}

export function getShellConfig(): { shell: string; args: string[] } {
  if (cachedShellConfig) {
    return cachedShellConfig;
  }

  const settings = SettingsManager.create();
  const customShellPath = settings.getShellPath();

  if (customShellPath) {
    if (existsSync(customShellPath)) {
      cachedShellConfig = { shell: customShellPath, args: ['-c'] };
      return cachedShellConfig;
    }
    throw new Error(`Custom shell path not found: ${customShellPath}\nPlease update shellPath in ${getSettingsPath()}`);
  }

  if (process.platform === 'win32') {
    const paths: string[] = [];
    const programFiles = process.env.ProgramFiles;
    if (programFiles) {
      paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
    }
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    if (programFilesX86) {
      paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
    }

    for (const path of paths) {
      if (existsSync(path)) {
        cachedShellConfig = { shell: path, args: ['-c'] };
        return cachedShellConfig;
      }
    }

    const bashOnPath = findBashOnPath();
    if (bashOnPath) {
      cachedShellConfig = { shell: bashOnPath, args: ['-c'] };
      return cachedShellConfig;
    }

    throw new Error(
      `No bash shell found. Options:\n` +
        `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
        `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
        `  3. Set shellPath in ${getSettingsPath()}\n\n` +
        `Searched Git Bash in:\n${paths.map(p => `  ${p}`).join('\n')}`
    );
  }

  if (existsSync('/bin/bash')) {
    cachedShellConfig = { shell: '/bin/bash', args: ['-c'] };
    return cachedShellConfig;
  }

  const bashOnPath = findBashOnPath();
  if (bashOnPath) {
    cachedShellConfig = { shell: bashOnPath, args: ['-c'] };
    return cachedShellConfig;
  }

  cachedShellConfig = { shell: 'sh', args: ['-c'] };
  return cachedShellConfig;
}

export function getShellEnv(): NodeJS.ProcessEnv {
  const binDir = getBinDir();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const currentPath = process.env[pathKey] ?? '';
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const hasBinDir = pathEntries.includes(binDir);
  const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

  return {
    ...process.env,
    [pathKey]: updatedPath
  };
}

export function sanitizeBinaryOutput(str: string): string {
  return Array.from(str)
    .filter(char => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join('');
}

export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true
      });
    } catch {}
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}
