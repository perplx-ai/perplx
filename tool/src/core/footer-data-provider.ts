import { type ExecFileException, execFile, spawnSync } from 'child_process';
import { existsSync, type FSWatcher, readFileSync, statSync, watch } from 'fs';
import { dirname, join, resolve } from 'path';

type GitPaths = {
  repoDir: string;
  commonGitDir: string;
  headPath: string;
};

function findGitPaths(): GitPaths | null {
  let dir = process.cwd();
  while (true) {
    const gitPath = join(dir, '.git');
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          const content = readFileSync(gitPath, 'utf8').trim();
          if (content.startsWith('gitdir: ')) {
            const gitDir = resolve(dir, content.slice(8).trim());
            const headPath = join(gitDir, 'HEAD');
            if (!existsSync(headPath)) return null;
            const commonDirPath = join(gitDir, 'commondir');
            const commonGitDir = existsSync(commonDirPath) ? resolve(gitDir, readFileSync(commonDirPath, 'utf8').trim()) : gitDir;
            return { repoDir: dir, commonGitDir, headPath };
          }
        } else if (stat.isDirectory()) {
          const headPath = join(gitPath, 'HEAD');
          if (!existsSync(headPath)) return null;
          return { repoDir: dir, commonGitDir: gitPath, headPath };
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveBranchWithGitSync(repoDir: string): string | null {
  const result = spawnSync('git', ['--no-optional-locks', 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const branch = result.status === 0 ? result.stdout.trim() : '';
  return branch || null;
}

function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
  return new Promise(resolvePromise => {
    execFile(
      'git',
      ['--no-optional-locks', 'symbolic-ref', '--quiet', '--short', 'HEAD'],
      {
        cwd: repoDir,
        encoding: 'utf8'
      },
      (error: ExecFileException | null, stdout: string) => {
        if (error) {
          resolvePromise(null);
          return;
        }
        const branch = stdout.trim();
        resolvePromise(branch || null);
      }
    );
  });
}

export class FooterDataProvider {
  private static readonly WATCH_DEBOUNCE_MS = 500;
  private cachedBranch: string | null | undefined = undefined;
  private gitPaths: GitPaths | null | undefined = undefined;
  private headWatcher: FSWatcher | null = null;
  private reftableWatcher: FSWatcher | null = null;
  private branchChangeCallbacks = new Set<() => void>();
  private availableProviderCount = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight = false;
  private refreshPending = false;
  private disposed = false;

  constructor() {
    this.gitPaths = findGitPaths();
    this.setupGitWatcher();
  }

  getGitBranch(): string | null {
    if (this.cachedBranch === undefined) {
      this.cachedBranch = this.resolveGitBranchSync();
    }
    return this.cachedBranch;
  }

  onBranchChange(callback: () => void): () => void {
    this.branchChangeCallbacks.add(callback);
    return () => this.branchChangeCallbacks.delete(callback);
  }

  getAvailableProviderCount(): number {
    return this.availableProviderCount;
  }

  setAvailableProviderCount(count: number): void {
    this.availableProviderCount = count;
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.headWatcher) {
      this.headWatcher.close();
      this.headWatcher = null;
    }
    if (this.reftableWatcher) {
      this.reftableWatcher.close();
      this.reftableWatcher = null;
    }
    this.branchChangeCallbacks.clear();
  }

  private notifyBranchChange(): void {
    for (const cb of this.branchChangeCallbacks) cb();
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshGitBranchAsync();
    }, FooterDataProvider.WATCH_DEBOUNCE_MS);
  }

  private async refreshGitBranchAsync(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshInFlight) {
      this.refreshPending = true;
      return;
    }

    this.refreshInFlight = true;
    try {
      const nextBranch = await this.resolveGitBranchAsync();
      if (this.disposed) return;
      if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
        this.cachedBranch = nextBranch;
        this.notifyBranchChange();
        return;
      }
      this.cachedBranch = nextBranch;
    } finally {
      this.refreshInFlight = false;
      if (this.refreshPending && !this.disposed) {
        this.refreshPending = false;
        this.scheduleRefresh();
      }
    }
  }

  private resolveGitBranchSync(): string | null {
    try {
      if (!this.gitPaths) return null;
      const content = readFileSync(this.gitPaths.headPath, 'utf8').trim();
      if (content.startsWith('ref: refs/heads/')) {
        const branch = content.slice(16);
        return branch === '.invalid' ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? 'detached') : branch;
      }
      return 'detached';
    } catch {
      return null;
    }
  }

  private async resolveGitBranchAsync(): Promise<string | null> {
    try {
      if (!this.gitPaths) return null;
      const content = readFileSync(this.gitPaths.headPath, 'utf8').trim();
      if (content.startsWith('ref: refs/heads/')) {
        const branch = content.slice(16);
        return branch === '.invalid' ? ((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ?? 'detached') : branch;
      }
      return 'detached';
    } catch {
      return null;
    }
  }

  private setupGitWatcher(): void {
    if (!this.gitPaths) return;

    try {
      this.headWatcher = watch(dirname(this.gitPaths.headPath), (_eventType, filename) => {
        if (!filename || filename.toString() === 'HEAD') {
          this.scheduleRefresh();
        }
      });
    } catch {}

    const reftableDir = join(this.gitPaths.commonGitDir, 'reftable');
    if (existsSync(reftableDir)) {
      try {
        this.reftableWatcher = watch(reftableDir, () => {
          this.scheduleRefresh();
        });
      } catch {}
    }
  }
}

export type ReadonlyFooterDataProvider = Pick<FooterDataProvider, 'getGitBranch' | 'getAvailableProviderCount' | 'onBranchChange'>;
