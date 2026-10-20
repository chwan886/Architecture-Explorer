import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import type { ProjectConfig, WorktreeInfo } from '../../schema/src/index.ts';
import { contentHash } from '../../schema/src/index.ts';
import { canonical } from './security.ts';

const execute = promisify(execFile);
export async function git(root: string, args: string[]): Promise<string> {
  const result = await execute('git', ['--no-optional-locks', '-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-c', 'core.quotepath=false', '-C', root, ...args], {
    cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.stdout;
}

export interface GitState { head: string; branch: string; dirty: boolean; statusHash: string; }
export async function gitState(root: string): Promise<GitState> {
  try {
    const results = await Promise.allSettled([
      git(root, ['rev-parse', 'HEAD']), git(root, ['branch', '--show-current']),
      git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    ]);
    if (results.some(result => result.status === 'rejected')) throw new Error('Git metadata unavailable');
    const [head, branch, status] = results.map(result => (result as PromiseFulfilledResult<string>).value);
    return { head: head.trim(), branch: branch.trim() || '游离 HEAD', dirty: status.length > 0, statusHash: contentHash(status) };
  } catch {
    return { head: '', branch: '非 Git 项目或 Git 信息不可用', dirty: false, statusHash: contentHash('unavailable') };
  }
}

export async function discoverWorktrees(project: ProjectConfig): Promise<WorktreeInfo[]> {
  const authorized = new Set([project.root, ...(project.worktrees ?? [])].map(canonical));
  const candidates: Array<{ path: string; branch: string; head: string }> = [];
  try {
    const output = await git(project.root, ['worktree', 'list', '--porcelain']);
    for (const block of output.trim().split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/);
      let sourcePath = lines.find(line => line.startsWith('worktree '))?.slice(9);
      if (!sourcePath) continue;
      if (sourcePath.startsWith('"')) { try { sourcePath = JSON.parse(sourcePath) as string; } catch { continue; } }
      candidates.push({ path: sourcePath, branch: lines.find(line => line.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? '游离 HEAD',
        head: lines.find(line => line.startsWith('HEAD '))?.slice(5) ?? '' });
    }
  } catch { /* Plain directories remain useful analysis targets. */ }
  for (const root of [project.root, ...(project.worktrees ?? [])]) {
    if (!candidates.some(item => canonical(item.path) === canonical(root))) {
      const state = await gitState(root); candidates.push({ path: root, branch: state.branch, head: state.head });
    }
  }
  const result: WorktreeInfo[] = [];
  for (const candidate of candidates) {
    // Do not dereference a discovered, unauthorized worktree. Discovery is not authorization.
    const allowed = authorized.has(canonical(candidate.path));
    let root = candidate.path;
    if (allowed) root = await realpath(root);
    result.push({ id: canonical(root) === canonical(project.root) ? 'primary' : `wt-${contentHash(canonical(root)).slice(0, 12)}`,
      path: root, branch: candidate.branch, head: candidate.head, authorized: allowed });
  }
  return result.sort((a, b) => Number(b.id === 'primary') - Number(a.id === 'primary') || a.path.localeCompare(b.path));
}
