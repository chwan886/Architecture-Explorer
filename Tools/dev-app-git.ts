import path from 'node:path';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { contentHash } from '../packages/schema/src/index.ts';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { canonical, ensureCacheDirectory, isWithin } from '../packages/indexer/src/security.ts';

export interface TaskPushInput { repository: string; baseBranch: string; workingDirectory: string; branch: string; expectedHead: string }
export interface TaskPushPlan extends Readonly<TaskPushInput> { readonly origin: string; readonly baseHead: string; readonly requiresWorkflows: boolean }
export interface TaskPushProof {
  outcome: 'passed' | 'failed'; repository: string; branch: string; expectedHead: string;
  pushOutcome: 'not-attempted' | 'unconfirmed' | 'succeeded'; remoteHeadVerified: boolean;
  ownerAuthenticationUsed: false; secretRecorded: false; failureCode?: string;
  exitCode?: number; diagnosticCode?: TaskPushGitDiagnostic;
}
export type TaskPushGitDiagnostic = 'AUTHENTICATION_REJECTED' | 'WORKFLOW_PERMISSION_REJECTED' | 'PUSH_NON_FAST_FORWARD' |
  'PUSH_REMOTE_RULE_REJECTED' | 'TLS_CERTIFICATE_VALIDATION_FAILED' | 'NETWORK_FAILED' | 'GIT_PROCESS_START_FAILED' |
  'GIT_PROCESS_TIMEOUT' | 'GIT_OUTPUT_LIMIT_REACHED' | 'REMOTE_HEAD_MISMATCH' | 'UNCLASSIFIED_GIT_FAILURE';
export interface TaskGitResult { code: number; output: string; failed: boolean; diagnosticCode?: TaskPushGitDiagnostic }
/** Code-only dependency injection for offline fixtures; no CLI/config flag can select a runner. */
export type TaskGitRunner = (args: string[], env: NodeJS.ProcessEnv, cwd: string, capture?: boolean, timeout?: number) => Promise<TaskGitResult>;
const gitExecutable = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : '/usr/bin/git';
const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
class GitFailure extends Error { constructor(readonly code: string) { super(code); } }
function need(value: unknown, code: string): asserts value { if (!value) throw new GitFailure(code); }
interface Snapshot { commonDirectory: string; objectDirectory: string; fingerprint: string }
const prepared = new WeakMap<TaskPushPlan, Snapshot>();

/** Never inherit owner credentials, Git/Node injection, proxy settings, PATH,
 * shell startup files, loader injection, HOME, or a credential manager session. */
export function taskPushEnvironment(_inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const system = process.platform === 'win32' ? { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\Git\\usr\\bin' }
    : { PATH: '/usr/bin:/bin' };
  return { ...system, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: nullFile, GIT_CONFIG_GLOBAL: nullFile,
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_ATTR_NOSYSTEM: '1' };
}
export function taskPushGitArguments(hooks: string): string[] {
  const settings = ['credential.helper=', 'credential.useHttpPath=true', 'credential.interactive=false', 'core.askPass=',
    `core.hooksPath=${hooks}`, 'core.fsmonitor=false', 'core.untrackedCache=false', 'protocol.allow=never', 'protocol.https.allow=always',
    'http.extraHeader=', 'http.proxy=', 'http.followRedirects=false', 'http.sslVerify=true', 'http.cookieFile=', 'http.saveCookies=false',
    'http.delegation=none', 'http.maxRetries=0', 'submodule.recurse=false', 'fetch.recurseSubmodules=false',
    'push.recurseSubmodules=no', 'push.followTags=false', 'gc.auto=0', 'maintenance.auto=false'];
  if (process.platform === 'win32') settings.push('http.sslBackend=schannel', 'http.schannelCheckRevoke=true');
  return ['--no-pager', ...settings.flatMap(value => ['-c', value])];
}
export function classifyTaskPushGitFailure(value: string): TaskPushGitDiagnostic {
  if (/workflow.*(?:permission|scope)|refusing to allow.*workflow/i.test(value)) return 'WORKFLOW_PERMISSION_REJECTED';
  if (/authentication failed|invalid username or (?:password|token)|returned error: (?:401|403)|permission .* denied|not granted|resource not accessible by integration|repository not found/i.test(value)) return 'AUTHENTICATION_REJECTED';
  if (/non-fast-forward|\[rejected\].*(?:fetch first|stale info)|updates were rejected/i.test(value)) return 'PUSH_NON_FAST_FORWARD';
  if (/gh013|gh006|protected branch|repository rule violations|pre-receive hook declined/i.test(value)) return 'PUSH_REMOTE_RULE_REJECTED';
  if (/ssl certificate|certificate verif|self[- ]signed|untrusted.root|cert.trust/i.test(value)) return 'TLS_CERTIFICATE_VALIDATION_FAILED';
  if (/could not resolve|failed to connect|connection (?:refused|timed out|reset)|operation timed out/i.test(value)) return 'NETWORK_FAILED';
  return 'UNCLASSIFIED_GIT_FAILURE';
}
const runGit: TaskGitRunner = async (args, env, cwd, capture = true, timeout = 30000) => new Promise(resolve => {
  let output = '', diagnostics = '', failed = false, settled = false, killed = false, diagnosticCode: TaskPushGitDiagnostic | undefined;
  const child = spawn(gitExecutable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const finish = (code: number) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    const result = { code, output, failed, diagnosticCode: code === 0 && !failed ? undefined : diagnosticCode ?? classifyTaskPushGitFailure(diagnostics) };
    diagnostics = ''; resolve(result);
  };
  const stop = () => {
    if (killed) return;
    killed = true; failed = true;
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('C:/Windows/System32/taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { env: taskPushEnvironment(), windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => child.kill()); killer.once('close', code => { if (code !== 0) child.kill(); });
    } else child.kill('SIGKILL');
  };
  const timer = setTimeout(() => { diagnosticCode = 'GIT_PROCESS_TIMEOUT'; stop(); }, timeout);
  const diagnostic = (data: Buffer) => { diagnostics += data.subarray(0, Math.max(0, 65536 - Buffer.byteLength(diagnostics))).toString('utf8'); };
  child.stdout.on('data', (data: Buffer) => {
    if (!capture) { diagnostic(data); return; }
    output += data.toString('utf8');
    if (Buffer.byteLength(output) > 4 * 1024 * 1024) { output = ''; diagnosticCode = 'GIT_OUTPUT_LIMIT_REACHED'; stop(); }
  });
  child.stderr.on('data', diagnostic);
  child.once('error', () => { failed = true; diagnosticCode = 'GIT_PROCESS_START_FAILED'; finish(-1); });
  child.once('close', code => finish(code ?? -1));
});

async function noLinks(absolute: string): Promise<void> {
  const resolved = path.resolve(absolute), base = path.parse(resolved).root;
  let current = base;
  for (const part of path.relative(base, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    need(!(await lstat(current)).isSymbolicLink(), 'LINK_REJECTED');
  }
}
async function metadataText(file: string, optional = false): Promise<string> {
  try {
    await noLinks(file);
    const handle = await open(file, 'r');
    try {
      const entry = await handle.stat(), link = await lstat(file), limit = 2 * 1024 * 1024;
      need(entry.isFile() && entry.size <= limit && !link.isSymbolicLink() && entry.ino === link.ino && entry.dev === link.dev, 'GIT_METADATA_INVALID');
      const chunks: Buffer[] = []; let length = 0;
      while (length <= limit) {
        const chunk = Buffer.alloc(Math.min(65536, limit + 1 - length));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead)); length += bytesRead;
      }
      need(length <= limit, 'GIT_METADATA_INVALID');
      const after = await handle.stat();
      need(after.size === entry.size && after.mtimeMs === entry.mtimeMs && after.ctimeMs === entry.ctimeMs, 'GIT_METADATA_CHANGED');
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
    } finally { await handle.close(); }
  } catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
async function sourceMetadata(root: string) {
  await noLinks(root);
  const dotGit = path.join(root, '.git'), entry = await lstat(dotGit);
  need(!entry.isSymbolicLink(), 'LINK_REJECTED');
  let gitDirectory: string;
  if (entry.isDirectory()) gitDirectory = dotGit;
  else {
    const pointer = await metadataText(dotGit);
    const match = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(pointer);
    need(match, 'GIT_DIRECTORY_POINTER_INVALID'); gitDirectory = path.resolve(root, match[1]);
  }
  await noLinks(gitDirectory);
  need((await lstat(gitDirectory)).isDirectory(), 'GIT_DIRECTORY_INVALID');
  const common = await metadataText(path.join(gitDirectory, 'commondir'), true);
  need(!common || /^[^\r\n\0]+\r?\n?$/.test(common), 'GIT_COMMON_DIRECTORY_INVALID');
  const commonDirectory = common ? path.resolve(gitDirectory, common.trimEnd()) : gitDirectory;
  await noLinks(commonDirectory);
  const objectDirectory = path.join(commonDirectory, 'objects'); await noLinks(objectDirectory);
  need(!(objectDirectory.includes(path.delimiter) || /[\r\n\0]/.test(objectDirectory)), 'OBJECT_DIRECTORY_UNSUPPORTED');
  let count = 0;
  const visit = async (directory: string) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      need(++count <= 100000, 'OBJECT_DIRECTORY_BUDGET'); need(!item.isSymbolicLink(), 'LINK_REJECTED');
      if (item.isDirectory()) await visit(path.join(directory, item.name));
      else need(item.isFile(), 'GIT_METADATA_INVALID');
    }
  };
  await visit(objectDirectory);
  for (const relative of ['info/grafts', 'shallow', 'objects/info/alternates', 'objects/info/http-alternates'])
    need(!(await metadataText(path.join(commonDirectory, relative), true)).trim(), 'GIT_HISTORY_OVERRIDE_UNSUPPORTED');
  const configText = await metadataText(path.join(commonDirectory, 'config'));
  const worktreeText = await metadataText(path.join(gitDirectory, 'config.worktree'), true);
  return { commonDirectory: await realpath(commonDirectory), objectDirectory: await realpath(objectDirectory), gitDirectory: await realpath(gitDirectory), configText, worktreeText };
}
function safeConfig(output: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const record of output.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\n'); need(separator > 0, 'LOCAL_GIT_CONFIG_INVALID');
    const key = record.slice(0, separator).toLowerCase(), value = record.slice(separator + 1);
    need(!/^(include\.|includeif\.|url\.|credential\.|http\.|https\.|filter\.|alias\.|protocol\.|extensions\.partialclone|remote\..*\.(?:pushurl|push|proxy|receivepack|uploadpack|mirror|promisor)|core\.(?:askpass|hookspath|fsmonitor|sshcommand|gitproxy|attributesfile)|diff\..*\.(?:command|textconv)$)/.test(key), 'UNSAFE_LOCAL_GIT_CONFIG');
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return values;
}
function validateInput(input: TaskPushInput): void {
  need(Object.keys(input).every(key => ['repository', 'baseBranch', 'workingDirectory', 'branch', 'expectedHead', 'origin', 'baseHead', 'requiresWorkflows'].includes(key)), 'TASK_ARGUMENTS_INVALID');
  need(typeof input.repository === 'string' && !/[\r\n\0]/.test(input.repository) && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.repository), 'REPOSITORY_REQUIRED');
  need(typeof input.branch === 'string' && !/[\r\n\0]/.test(input.branch) && /^codex\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.branch) && !input.branch.includes('..') && !input.branch.includes('//') && !input.branch.includes('@{')
    && !input.branch.endsWith('/') && input.branch.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')), 'TASK_BRANCH_REQUIRED');
  need(typeof input.baseBranch === 'string' && !/[\r\n\0]/.test(input.baseBranch) && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.baseBranch) && !input.baseBranch.includes('..') && !input.baseBranch.includes('//')
    && !input.baseBranch.includes('@{') && !input.baseBranch.endsWith('/') && input.baseBranch.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'))
    && input.baseBranch !== input.branch, 'BASE_BRANCH_REQUIRED');
  need(typeof input.expectedHead === 'string' && /^[a-f0-9]{40}$/.test(input.expectedHead) && input.expectedHead.length === 40, 'EXACT_TASK_HEAD_REQUIRED');
  need(typeof input.workingDirectory === 'string' && path.isAbsolute(input.workingDirectory) && !/[\r\n\0]/.test(input.workingDirectory), 'ABSOLUTE_WORKING_DIRECTORY_REQUIRED');
}
async function scratch() {
  const parent = await ensureCacheDirectory(path.join(TOOL_ROOT, '.tmp'), TOOL_ROOT);
  const root = await mkdtemp(path.join(parent, 'dev-app-git-')), identity = await lstat(root);
  const hooks = path.join(root, 'hooks'), home = path.join(root, 'home');
  const env = { ...taskPushEnvironment(), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, TMP: root, TEMP: root, TMPDIR: root };
  const cleanup = async () => {
    await noLinks(parent); const current = await lstat(root);
    need(isWithin(parent, root) && canonical(parent) !== canonical(root) && current.isDirectory() && !current.isSymbolicLink()
      && current.ino === identity.ino && current.dev === identity.dev && canonical(await realpath(root)) === canonical(root), 'TEMP_DIRECTORY_CHANGED');
    await rm(root, { recursive: true, force: false, maxRetries: 5, retryDelay: 40 });
  };
  try { await mkdir(hooks); await mkdir(home); }
  catch (error) { await cleanup(); throw error; }
  return { root, hooks, env, cleanup };
}
async function inspect(input: TaskPushInput, temporary: Awaited<ReturnType<typeof scratch>>) {
  validateInput(input); await noLinks(input.workingDirectory);
  const workingDirectory = await realpath(input.workingDirectory), metadata = await sourceMetadata(workingDirectory);
  const prefix = [...taskPushGitArguments(temporary.hooks), '-c', `safe.directory=${workingDirectory}`, '-C', workingDirectory];
  const read = async (...args: string[]) => {
    const result = await runGit([...prefix, ...args], temporary.env, temporary.root);
    need(result.code === 0 && !result.failed, 'LOCAL_GIT_READ_FAILED'); return result.output;
  };
  const config = safeConfig(await read('config', '--file', path.join(metadata.commonDirectory, 'config'), '--no-includes', '--list', '-z'));
  if (metadata.worktreeText) safeConfig(await read('config', '--file', path.join(metadata.gitDirectory, 'config.worktree'), '--no-includes', '--list', '-z'));
  const origin = `https://github.com/${input.repository}.git`;
  need(config.get('remote.origin.url')?.length === 1 && config.get('remote.origin.url')![0] === origin, 'ORIGIN_MISMATCH');
  need((await read('config', '--get-all', 'remote.origin.url')).trim() === origin, 'ORIGIN_MISMATCH');
  need(canonical((await read('rev-parse', '--show-toplevel')).trim()) === canonical(workingDirectory), 'WORKTREE_ROOT_REQUIRED');
  need(canonical((await read('rev-parse', '--path-format=absolute', '--git-common-dir')).trim()) === canonical(metadata.commonDirectory), 'GIT_COMMON_DIRECTORY_INVALID');
  need((await read('check-ref-format', '--branch', input.branch)).trim() === input.branch, 'TASK_BRANCH_REQUIRED');
  need((await read('symbolic-ref', '--quiet', '--short', 'HEAD')).trim() === input.branch, 'TASK_BRANCH_MISMATCH');
  need((await read('rev-parse', '--verify', 'HEAD')).trim() === input.expectedHead, 'TASK_HEAD_CHANGED');
  need((await read('cat-file', '-t', input.expectedHead)).trim() === 'commit', 'TASK_COMMIT_REQUIRED');
  need((await read('status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all')).length === 0, 'TASK_WORKTREE_DIRTY');
  const baseHead = (await read('rev-parse', '--verify', `refs/remotes/origin/${input.baseBranch}`)).trim();
  need(/^[a-f0-9]{40}$/.test(baseHead) && baseHead.length === 40 && (await read('cat-file', '-t', baseHead)).trim() === 'commit', 'BASE_COMMIT_REQUIRED');
  const ancestor = await runGit([...prefix, 'merge-base', '--is-ancestor', baseHead, input.expectedHead], temporary.env, temporary.root);
  need(ancestor.code === 0 && !ancestor.failed, 'BASE_NOT_ANCESTOR');
  // The authentication layer must compare baseHead with its live GitHub base
  // reference before publishing. A forged local tracking ref is not authority.
  // --full-history retains workflow edits on merged/reverted side branches.
  const requiresWorkflows = (await read('log', '--full-history', '--format=%H', `${baseHead}..${input.expectedHead}`, '--', '.github/workflows')).trim().length > 0;
  return { plan: { ...input, workingDirectory, origin, baseHead, requiresWorkflows }, snapshot: { commonDirectory: metadata.commonDirectory,
    objectDirectory: metadata.objectDirectory, fingerprint: contentHash(metadata.configText + '\0' + metadata.worktreeText) } };
}
/** No token and no network are needed for preflight. The source repository is read only. */
export async function prepareTaskPush(input: TaskPushInput): Promise<TaskPushPlan> {
  validateInput(input); const temporary = await scratch();
  try { const { plan, snapshot } = await inspect(input, temporary); Object.freeze(plan); prepared.set(plan, snapshot); return plan; }
  finally { await temporary.cleanup(); }
}
/** One exact non-forced task ref. Failed authentication never invokes a user
 * helper or another identity. Tokens exist only in controlled child environments. */
export async function runTaskPush(plan: TaskPushPlan, token: string, runner: TaskGitRunner = runGit): Promise<TaskPushProof> {
  const proof: TaskPushProof = { outcome: 'failed', repository: plan.repository, branch: plan.branch, expectedHead: plan.expectedHead,
    pushOutcome: 'not-attempted', remoteHeadVerified: false, ownerAuthenticationUsed: false, secretRecorded: false };
  let temporary: Awaited<ReturnType<typeof scratch>> | undefined;
  try {
    const baseline = prepared.get(plan); need(baseline, 'PREPARED_TASK_PLAN_REQUIRED');
    need(typeof token === 'string' && token.length > 0 && token.length <= 16384 && !/[\x00-\x20\x7f]/.test(token), 'INSTALLATION_TOKEN_INVALID');
    temporary = await scratch(); const current = await inspect(plan, temporary);
    need(JSON.stringify(current.plan) === JSON.stringify(plan) && JSON.stringify(current.snapshot) === JSON.stringify(baseline), 'TASK_PLAN_CHANGED');
    const isolated = path.join(temporary.root, 'transport.git');
    const args = taskPushGitArguments(temporary.hooks), init = await runner([...args, 'init', '--bare', '--template=', isolated], temporary.env, temporary.root);
    if (init.code !== 0 || init.failed) { proof.diagnosticCode = init.diagnosticCode; throw new GitFailure('ISOLATED_GIT_INIT_FAILED'); }
    const prefix = [...args, '-c', `safe.directory=${isolated}`, '--git-dir', isolated];
    // Scoped to this repository, not to every URL on github.com. Redirects and
    // interactive/helper authentication are disabled by explicit Git settings.
    const env = { ...temporary.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: baseline.objectDirectory, GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${plan.origin}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('x-access-token:' + token).toString('base64')}` };
    proof.pushOutcome = 'unconfirmed';
    const pushed = await runner([...prefix, 'push', '--no-verify', '--porcelain', '--no-follow-tags', plan.origin, `${plan.expectedHead}:refs/heads/${plan.branch}`], env, temporary.root, false, 120000);
    proof.exitCode = pushed.code;
    if (pushed.code !== 0 || pushed.failed) { proof.diagnosticCode = pushed.diagnosticCode; throw new GitFailure('TASK_PUSH_UNCONFIRMED'); }
    proof.pushOutcome = 'succeeded';
    const remote = await runner([...prefix, 'ls-remote', '--exit-code', plan.origin, `refs/heads/${plan.branch}`], env, temporary.root);
    if (remote.code !== 0 || remote.failed || remote.output.trim() !== `${plan.expectedHead}\trefs/heads/${plan.branch}`) {
      proof.diagnosticCode = remote.diagnosticCode ?? 'REMOTE_HEAD_MISMATCH'; throw new GitFailure('REMOTE_HEAD_MISMATCH');
    }
    proof.remoteHeadVerified = true; proof.outcome = 'passed';
  } catch (error) { proof.failureCode = error instanceof GitFailure ? error.code : 'TASK_PUSH_FAILED'; }
  finally {
    token = '';
    if (temporary) try { await temporary.cleanup(); } catch { proof.outcome = 'failed'; proof.failureCode = 'TEMP_DIRECTORY_CLEANUP_FAILED'; }
  }
  return proof;
}
export async function pushDevelopmentBranch(config: { repository: string; baseBranch: string }, options: { workingDirectory: string; branch: string; expectedHead: string }, token: string): Promise<TaskPushProof> {
  return runTaskPush(await prepareTaskPush({ ...options, repository: config.repository, baseBranch: config.baseBranch }), token);
}
