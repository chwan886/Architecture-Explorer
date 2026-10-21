import path from 'node:path';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { createSmokeDirectory, removeSmokeDirectory } from './ci-smoke-directories.ts';

const repositories = { tool: 'chwan886/Architecture-Explorer', game: 'chwan886/GameDemo02' } as const;
type Repository = typeof repositories[keyof typeof repositories];
export interface TaskPushInput {
  repository: keyof typeof repositories | Repository;
  workingDirectory: string;
  branch: string;
  expectedHead: string;
}
export interface TaskPushPlan {
  readonly repository: Repository;
  readonly workingDirectory: string;
  readonly branch: string;
  readonly expectedHead: string;
  readonly origin: string;
  /** Conservative: any workflow change in the reachable local history requires this permission. */
  readonly requiresWorkflows: boolean;
}
export interface TaskPushProof {
  outcome: 'passed' | 'failed';
  repository: Repository;
  branch: string;
  expectedHead: string;
  pushOutcome: 'not-attempted' | 'unconfirmed' | 'succeeded';
  remoteHeadVerified: boolean;
  ownerAuthenticationUsed: false;
  secretRecorded: false;
  failureCode?: string;
  exitCode?: number;
}
class GitFailure extends Error { constructor(readonly code: string) { super(code); } }
function need(value: unknown, code: string): asserts value { if (!value) throw new GitFailure(code); }
const prepared = new WeakSet<object>();
const temporaryRoot = path.join(TOOL_ROOT, '.tmp');
const gitExecutable = 'C:\\Program Files\\Git\\cmd\\git.exe';
const tokenVariable = 'EXPLORER_DEV_APP_GIT_TOKEN';
const repositoryVariable = 'EXPLORER_DEV_APP_GIT_REPOSITORY';

/** Static credential protocol program: never contains a token or writes a credential to disk. */
export const taskPushCredentialHelper = String.raw`import process from 'node:process';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 8192) process.exit(1); });
process.stdin.on('end', () => {
  if (process.argv[2] !== 'get') return;
  const values = new Map();
  for (const line of input.split('\n')) {
    if (!line) continue;
    const at = line.indexOf('=');
    if (at <= 0 || values.has(line.slice(0, at))) process.exit(1);
    values.set(line.slice(0, at), line.slice(at + 1));
  }
  const repo = process.env.EXPLORER_DEV_APP_GIT_REPOSITORY;
  const token = process.env.EXPLORER_DEV_APP_GIT_TOKEN;
  if (!['chwan886/Architecture-Explorer', 'chwan886/GameDemo02'].includes(repo) ||
      values.get('protocol') !== 'https' || values.get('host') !== 'github.com' ||
      values.get('path') !== repo + '.git' ||
      (values.has('username') && values.get('username') !== 'x-access-token') ||
      !token || token.length > 16384 || /[\x00-\x20\x7f]/.test(token)) process.exit(1);
  process.stdout.write('username=x-access-token\npassword=' + token + '\n\n');
});
`;

/** Keep inherited credentials, Git configuration, proxies and Node injection out of every child. */
export function taskPushEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!/^(GIT_|GH_|GITHUB_|NODE_|EXPLORER_DEV_APP_|GCM_|SSH_|CURL_|.*_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(key) &&
        !/^(ASKPASS|CURL_HOME|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key)) result[key] = value;
  }
  return { ...result, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: 'NUL', GIT_CONFIG_GLOBAL: 'NUL',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_ATTR_NOSYSTEM: '1' };
}
function shellQuote(value: string) { return `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`; }

export function taskPushGitArguments(hooks: string, helper?: string): string[] {
  const config = ['credential.helper=', 'credential.useHttpPath=true', 'credential.interactive=false',
    'core.askPass=', `core.hooksPath=${hooks}`, 'core.fsmonitor=false', 'core.untrackedCache=false',
    'protocol.allow=never', 'protocol.https.allow=always', 'http.extraHeader=', 'http.proxy=',
    'http.followRedirects=false', 'http.sslVerify=true', 'http.cookieFile=', 'http.saveCookies=false',
    'http.emptyAuth=false', 'http.proactiveAuth=basic', 'http.delegation=none', 'http.maxRetries=0',
    'gc.auto=0', 'maintenance.auto=false'];
  if (helper) config.push(`credential.helper=!${shellQuote(process.execPath)} ${shellQuote(helper)}`);
  return ['--no-pager', ...config.flatMap(value => ['-c', value])];
}
type GitResult = { code: number; output: string; failed: boolean };
async function git(args: string[], env: NodeJS.ProcessEnv, cwd: string, capture = true, timeout = 30000): Promise<GitResult> {
  // Child output is never surfaced. Even Git's fatal errors can echo a secret-bearing server response.
  return await new Promise(resolve => {
    let output = '', failed = false, settled = false, stopped = false;
    const child = spawn(gitExecutable, args, { cwd, env, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
    const finish = (code: number) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, output, failed }); } };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      failed = true;
      // On Windows kill the Git transport/helper tree too; do not pass its credential environment to taskkill.
      const killer = spawn('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
        { env: taskPushEnvironment(), windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
      killer.on('close', code => { if (code !== 0) child.kill(); });
    };
    const timer = setTimeout(stop, timeout);
    child.stdout?.on('data', data => { output += data.toString('utf8'); if (Buffer.byteLength(output) > 4 * 1024 * 1024) stop(); });
    child.on('error', () => { failed = true; finish(-1); });
    child.on('close', code => finish(code ?? -1));
  });
}
async function scratch() {
  const owned = await createSmokeDirectory(temporaryRoot, TOOL_ROOT, 'dev-app-git-');
  const root = owned.directory;
  const hooks = path.join(root, 'hooks');
  try { await mkdir(hooks); }
  catch (error) { await removeSmokeDirectory(owned); throw error; }
  return { root, hooks, owned };
}
async function removeScratch(temporary: Awaited<ReturnType<typeof scratch>>) {
  await removeSmokeDirectory(temporary.owned);
}
function validateInput(input: TaskPushInput): Repository {
  need(process.platform === 'win32', 'WINDOWS_REQUIRED');
  const repository = input.repository === 'tool' || input.repository === 'game' ? repositories[input.repository] : input.repository;
  need(Object.values(repositories).includes(repository as Repository), 'UNAPPROVED_REPOSITORY');
  need(typeof input.branch === 'string' && !/[\r\n]/.test(input.branch) && /^codex\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.branch) &&
    !input.branch.includes('..') && !input.branch.includes('//') && input.branch.split('/').every(part =>
      part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')) && !input.branch.endsWith('/'), 'TASK_BRANCH_REQUIRED');
  need(typeof input.expectedHead === 'string' && input.expectedHead.length === 40 && /^[a-f0-9]{40}$/.test(input.expectedHead), 'EXACT_TASK_HEAD_REQUIRED');
  need(typeof input.workingDirectory === 'string' && path.isAbsolute(input.workingDirectory), 'ABSOLUTE_WORKING_DIRECTORY_REQUIRED');
  return repository as Repository;
}
function localConfiguration(output: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const entry of output.split('\0').filter(Boolean)) {
    const at = entry.indexOf('\n');
    need(at > 0, 'LOCAL_GIT_CONFIG_INVALID');
    const key = entry.slice(0, at).toLowerCase(), value = entry.slice(at + 1);
    // These settings can run programs, inject credentials or alter the destination. They are never needed here.
    need(!/^(include\.|includeif\.|url\.|credential\.|http\.|https\.|filter\.|alias\.|protocol\.|core\.(askpass|fsmonitor|sshcommand|gitproxy|attributesfile)|diff\..*\.(command|textconv)$)/.test(key) &&
      !/^remote\..*\.(pushurl|push|proxy|receivepack|uploadpack|mirror)$/.test(key), 'UNSAFE_LOCAL_GIT_CONFIG');
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  return result;
}
async function inspect(input: TaskPushInput, hooks: string) {
  const repository = validateInput(input);
  const workingDirectory = await realpath(input.workingDirectory);
  const env = taskPushEnvironment();
  const prefix = [...taskPushGitArguments(hooks), '-c', `safe.directory=${workingDirectory}`, '-C', workingDirectory];
  const read = async (...args: string[]) => {
    const result = await git([...prefix, ...args], env, workingDirectory);
    need(result.code === 0 && !result.failed, 'LOCAL_GIT_READ_FAILED');
    return result.output;
  };
  // Inspect raw local configuration before status; --no-includes prevents following untrusted config files.
  const config = localConfiguration(await read('config', '--local', '--no-includes', '--list', '-z'));
  const commonDirectory = await realpath((await read('rev-parse', '--path-format=absolute', '--git-common-dir')).trim());
  const gitDirectory = await realpath((await read('rev-parse', '--absolute-git-dir')).trim());
  if (config.get('extensions.worktreeconfig')?.includes('true')) {
    const worktreeFile = path.join(gitDirectory, 'config.worktree');
    try { await lstat(worktreeFile); localConfiguration(await read('config', '--file', worktreeFile, '--no-includes', '--list', '-z')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const origin = `https://github.com/${repository}.git`;
  need(config.get('remote.origin.url')?.length === 1 && config.get('remote.origin.url')?.[0] === origin, 'ORIGIN_MISMATCH');
  need((await read('config', '--get-all', 'remote.origin.url')).trim() === origin, 'ORIGIN_MISMATCH');
  const top = await realpath((await read('rev-parse', '--show-toplevel')).trim());
  need(top.toLowerCase() === workingDirectory.toLowerCase(), 'WORKTREE_ROOT_REQUIRED');
  need((await read('check-ref-format', '--branch', input.branch)).trim() === input.branch, 'TASK_BRANCH_REQUIRED');
  need((await read('symbolic-ref', '--quiet', '--short', 'HEAD')).trim() === input.branch, 'TASK_BRANCH_MISMATCH');
  need((await read('rev-parse', '--verify', 'HEAD')).trim() === input.expectedHead, 'TASK_HEAD_CHANGED');
  need((await read('cat-file', '-t', input.expectedHead)).trim() === 'commit', 'TASK_COMMIT_REQUIRED');
  need((await read('status', '--porcelain=v1', '-z', '--untracked-files=all')).length === 0, 'TASK_WORKTREE_DIRTY');
  // Grafts can hide workflow-changing history. Replacement objects are disabled in the environment.
  try { need((await readFile(path.join(commonDirectory, 'info', 'grafts'), 'utf8')).trim().length === 0, 'GRAFTED_HISTORY_UNSUPPORTED'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let shallow = false;
  try { shallow = (await lstat(path.join(commonDirectory, 'shallow'))).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const requiresWorkflows = shallow || (await read('log', '-1', '--format=%H', input.expectedHead, '--', '.github/workflows')).trim().length > 0;
  return { repository, workingDirectory, branch: input.branch, expectedHead: input.expectedHead, origin, requiresWorkflows, commonDirectory };
}

/** Local inspection only: no token, network request, config mutation, hook, fetch or owner credential. */
export async function prepareTaskPush(input: TaskPushInput): Promise<TaskPushPlan> {
  validateInput(input);
  const temporary = await scratch();
  try {
    const { commonDirectory: _unused, ...plan } = await inspect(input, temporary.hooks);
    Object.freeze(plan);
    prepared.add(plan);
    return plan;
  } finally { await removeScratch(temporary); }
}

/** One non-forced HTTPS push of an exact commit to one codex branch. No owner fallback or automatic retry. */
export async function runTaskPush(plan: TaskPushPlan, token: string): Promise<TaskPushProof> {
  const proof: TaskPushProof = { outcome: 'failed', repository: plan.repository, branch: plan.branch, expectedHead: plan.expectedHead,
    pushOutcome: 'not-attempted', remoteHeadVerified: false, ownerAuthenticationUsed: false, secretRecorded: false };
  let temporary: Awaited<ReturnType<typeof scratch>> | undefined;
  try {
    need(prepared.has(plan), 'PREPARED_TASK_PLAN_REQUIRED');
    need(typeof token === 'string' && token.length > 0 && token.length <= 16384 && !/[\x00-\x20\x7f]/.test(token), 'INSTALLATION_TOKEN_INVALID');
    temporary = await scratch();
    const current = await inspect(plan, temporary.hooks);
    need(current.origin === plan.origin && current.requiresWorkflows === plan.requiresWorkflows && current.workingDirectory === plan.workingDirectory,
      'TASK_PLAN_CHANGED');
    // Never load the source repository's configuration in any process receiving a token.
    const isolated = path.join(temporary.root, 'transport.git');
    const baseEnv = taskPushEnvironment();
    const init = await git([...taskPushGitArguments(temporary.hooks), 'init', '--bare', '--template=', isolated], baseEnv, temporary.root);
    need(init.code === 0 && !init.failed, 'ISOLATED_GIT_INIT_FAILED');
    const helper = path.join(temporary.root, 'credential-helper.mjs');
    await writeFile(helper, taskPushCredentialHelper, { flag: 'wx', mode: 0o600 });
    const home = path.join(temporary.root, 'empty-home');
    await mkdir(home);
    const env = { ...baseEnv, HOME: home, USERPROFILE: home, HOMEDRIVE: path.parse(home).root.slice(0, 2),
      HOMEPATH: home.slice(2), XDG_CONFIG_HOME: home, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(current.commonDirectory, 'objects'),
      [tokenVariable]: token, [repositoryVariable]: plan.repository };
    const prefix = [...taskPushGitArguments(temporary.hooks, helper), '-c', `safe.directory=${isolated}`, '--git-dir', isolated];
    proof.pushOutcome = 'unconfirmed';
    const pushed = await git([...prefix, 'push', '--no-verify', '--porcelain', '--no-follow-tags', plan.origin,
      `${plan.expectedHead}:refs/heads/${plan.branch}`], env, temporary.root, false, 120000);
    proof.exitCode = pushed.code;
    need(pushed.code === 0 && !pushed.failed, 'TASK_PUSH_UNCONFIRMED');
    proof.pushOutcome = 'succeeded';
    const remote = await git([...prefix, 'ls-remote', '--exit-code', plan.origin, `refs/heads/${plan.branch}`], env, temporary.root);
    need(remote.code === 0 && !remote.failed && remote.output.trim() === `${plan.expectedHead}\trefs/heads/${plan.branch}`, 'PUSHED_HEAD_NOT_CONFIRMED');
    proof.remoteHeadVerified = true;
    proof.outcome = 'passed';
  } catch (error) { proof.failureCode = error instanceof GitFailure ? error.code : 'TASK_PUSH_INTERNAL_FAILURE'; }
  finally {
    token = '';
    if (temporary) {
      try { await removeScratch(temporary); }
      catch { proof.outcome = 'failed'; proof.failureCode = 'TASK_PUSH_CLEANUP_FAILED'; }
    }
  }
  return proof;
}
