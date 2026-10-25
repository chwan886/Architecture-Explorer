import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { prepareTaskPush, runTaskPush, taskPushEnvironment, taskPushGitArguments, classifyTaskPushGitFailure, type TaskPushInput, type TaskGitRunner } from '../Tools/dev-app-git.ts';

const gitExecutable = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : '/usr/bin/git';
const secret = 'synthetic-installation-token-never-save';
const authorization = `Authorization: Basic ${Buffer.from('x-access-token:' + secret).toString('base64')}`;
async function execute(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ code: number; output: string; errors: string }>((resolve, reject) => {
    const child = spawn(gitExecutable, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code: code ?? -1, output, errors }));
  });
}
async function fixture(t: test.TestContext, repository = 'sample-owner/architecture-tool') {
  const parent = path.join(TOOL_ROOT, '.tmp'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'app-git-fixture-'));
  t.after(async () => { assert.ok(directory.startsWith(parent + path.sep)); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  const cwd = path.join(directory, 'source'), home = path.join(directory, 'fixture-home'); await mkdir(cwd); await mkdir(home);
  const env = { ...taskPushEnvironment(), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home };
  const git = async (...args: string[]) => {
    const result = await execute(['-c', `safe.directory=${cwd}`, '-C', cwd, ...args], env, directory);
    assert.equal(result.code, 0, `Synthetic Git ${args[0]} failed`); return result.output.trim();
  };
  await git('init', '--initial-branch=codex/transport-fixture', '--template=');
  await git('config', 'user.name', 'Synthetic contributor'); await git('config', 'user.email', 'fixture@example.invalid');
  await git('remote', 'add', 'origin', `https://github.com/${repository}.git`);
  await writeFile(path.join(cwd, 'fixture.txt'), 'Synthetic fixture\n'); await git('add', '.'); await git('commit', '-m', 'Synthetic fixture');
  await git('update-ref', 'refs/remotes/origin/main', await git('rev-parse', 'HEAD'));
  const input: TaskPushInput = { repository, baseBranch: 'main', workingDirectory: cwd, branch: 'codex/transport-fixture', expectedHead: await git('rev-parse', 'HEAD') };
  return { directory, cwd, home, env, git, input };
}
async function noSecretFiles(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await noSecretFiles(file);
    else if (entry.isFile()) {
      const bytes = await readFile(file);
      assert.ok(!bytes.includes(Buffer.from(secret)) && !bytes.includes(Buffer.from(authorization)), 'credentials must never reach a temporary file');
    }
  }
}
function offlineRunner(head: string, branch: string, options: { failPush?: boolean; wrongRemote?: boolean } = {}) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
  const run: TaskGitRunner = async (args, env, cwd) => {
    calls.push({ args, env: { ...env }, cwd });
    assert.ok(!args.some(value => value.includes(secret) || value.includes(authorization)), 'no credential may appear in process arguments');
    if (args.includes('init')) {
      assert.equal(env.GIT_CONFIG_COUNT, undefined, 'initialization has no token');
      const result = await execute(args, env, cwd); return { code: result.code, output: result.output, failed: false };
    }
    assert.equal(env.GIT_CONFIG_COUNT, '1'); assert.equal(env.GIT_CONFIG_VALUE_0, authorization);
    assert.equal(env.GITHUB_TOKEN, undefined); assert.equal(env.GH_TOKEN, undefined); assert.equal(env.GIT_ASKPASS, undefined);
    assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.HTTP_PROXY, undefined);
    assert.ok(env.HOME && !env.HOME.includes(`${path.sep}source`));
    assert.deepEqual(await readdir(env.HOME!), []);
    assert.deepEqual(await readdir(args.find(value => value.startsWith('core.hooksPath='))!.slice('core.hooksPath='.length)), []);
    await noSecretFiles(cwd);
    if (args.includes('push')) return options.failPush ? { code: 128, output: '', failed: false, diagnosticCode: 'AUTHENTICATION_REJECTED' }
      : { code: 0, output: '', failed: false };
    assert.ok(args.includes('ls-remote'));
    return { code: 0, output: `${options.wrongRemote ? '0'.repeat(40) : head}\trefs/heads/${branch}\n`, failed: false };
  };
  return { run, calls };
}

test('explicit single-repository preflight freezes exact clean plans without changing source or using network', async t => {
  for (const repository of ['sample-owner/architecture-tool', 'other-team/another-tool']) {
    const f = await fixture(t, repository), before = await readFile(path.join(f.cwd, '.git/config'), 'utf8');
    const plan = await prepareTaskPush(f.input);
    assert.equal(plan.repository, repository); assert.equal(plan.origin, `https://github.com/${repository}.git`);
    assert.equal(plan.requiresWorkflows, false); assert.ok(Object.isFrozen(plan));
    assert.equal(plan.baseHead, f.input.expectedHead);
    assert.equal(await readFile(path.join(f.cwd, '.git/config'), 'utf8'), before);
    assert.equal(await f.git('status', '--porcelain=v1', '--untracked-files=all'), '');
    assert.ok(!JSON.stringify(plan).includes(secret));
  }
});

test('task destinations reject main, tags, arbitrary URLs, malformed refs, dirty worktrees and changed or detached heads', async t => {
  const f = await fixture(t);
  for (const branch of ['main', 'refs/tags/v1', 'codex/a:main', 'codex/a..b', 'codex/-delete', 'codex/a.lock', 'codex/a//b', 'codex/a@{b', 'codex/a\n', 'codex/a\0'])
    await assert.rejects(prepareTaskPush({ ...f.input, branch }));
  for (const repository of ['https://github.com/owner/repo', 'owner/repo\n', 'owner/../repo', 'owner/repo:main'])
    await assert.rejects(prepareTaskPush({ ...f.input, repository }));
  await assert.rejects(prepareTaskPush({ ...f.input, baseBranch: f.input.branch }), /BASE_BRANCH_REQUIRED/);
  await assert.rejects(prepareTaskPush({ ...f.input, operation: 'push' } as TaskPushInput), /TASK_ARGUMENTS_INVALID/);
  await assert.rejects(prepareTaskPush({ ...f.input, expectedHead: 'a'.repeat(40) }), /TASK_HEAD_CHANGED/);
  for (const origin of [`https://owner:credential@github.com/${f.input.repository}.git`, `git@github.com:${f.input.repository}.git`,
    `https://github.com/${f.input.repository}`, 'https://example.invalid/owner/repo.git']) {
    await f.git('remote', 'set-url', 'origin', origin); await assert.rejects(prepareTaskPush(f.input), /ORIGIN_MISMATCH/);
  }
  await f.git('remote', 'set-url', 'origin', `https://github.com/${f.input.repository}.git`);
  await writeFile(path.join(f.cwd, 'untracked.txt'), 'pending'); await assert.rejects(prepareTaskPush(f.input), /TASK_WORKTREE_DIRTY/);
  await rm(path.join(f.cwd, 'untracked.txt')); await f.git('checkout', '--detach', f.input.expectedHead);
  await assert.rejects(prepareTaskPush(f.input), /LOCAL_GIT_READ_FAILED/);
});

test('raw local configuration rejects external includes, credential helpers, URL rewrites, hooks and executable filters before status', async t => {
  const f = await fixture(t), marker = path.join(f.directory, 'executed-marker');
  for (const [key, value] of [['include.path', path.join(f.directory, 'outside-config')], ['includeIf.gitdir:**.path', 'outside'], ['credential.helper', 'manager'],
    ['url.https://example.invalid/.insteadOf', 'https://github.com/'], ['remote.origin.pushurl', 'https://example.invalid/'],
    ['remote.origin.mirror', 'true'], ['http.extraHeader', 'Authorization: owner'], ['filter.fixture.clean', `touch ${marker}`],
    ['core.fsmonitor', `touch ${marker}`], ['core.hooksPath', f.directory], ['core.sshCommand', 'malicious-command']]) {
    await f.git('config', key, value); await assert.rejects(prepareTaskPush(f.input), /UNSAFE_LOCAL_GIT_CONFIG/); await f.git('config', '--unset-all', key);
  }
  await assert.rejects(lstat(marker), { code: 'ENOENT' }); assert.equal((await prepareTaskPush(f.input)).requiresWorkflows, false);
  const configPath = path.join(f.cwd, '.git/config'), config = await readFile(configPath);
  await writeFile(configPath, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(prepareTaskPush(f.input), /GIT_METADATA_INVALID/);
  await writeFile(configPath, config);
});

test('environment and Git arguments remove owner credential fallback, process injection and proxy or redirect paths', () => {
  const env = taskPushEnvironment({ PATH: 'malicious-path', HOME: 'owner-home', USERPROFILE: 'owner-profile', GITHUB_TOKEN: 'owner-token', GH_TOKEN: 'owner-token',
    GIT_CONFIG_COUNT: '9', GIT_CONFIG_GLOBAL: 'owner-config', GIT_ASKPASS: 'malicious-helper', GIT_SSH_COMMAND: 'malicious-ssh', GIT_EXEC_PATH: 'malicious-exec',
    NODE_OPTIONS: '--import malicious', NODE_PATH: 'malicious-modules', LD_PRELOAD: 'malicious-loader', DYLD_INSERT_LIBRARIES: 'malicious-loader',
    BASH_ENV: 'malicious-startup', ENV: 'malicious-startup', HTTP_PROXY: 'owner-proxy', HTTPS_PROXY: 'owner-proxy', CURL_HOME: 'owner-curl', SSL_CERT_FILE: 'owner-ca' });
  for (const key of ['HOME', 'USERPROFILE', 'GITHUB_TOKEN', 'GH_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_ASKPASS', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'NODE_OPTIONS', 'NODE_PATH',
    'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ENV', 'HTTP_PROXY', 'HTTPS_PROXY', 'CURL_HOME', 'SSL_CERT_FILE']) assert.equal(env[key], undefined, key);
  assert.notEqual(env.PATH, 'malicious-path'); assert.equal(env.GIT_TERMINAL_PROMPT, '0'); assert.equal(env.GCM_INTERACTIVE, 'never');
  const args = taskPushGitArguments('/empty/hooks');
  for (const setting of ['credential.helper=', 'core.askPass=', 'protocol.allow=never', 'protocol.https.allow=always', 'http.followRedirects=false', 'http.sslVerify=true']) assert.ok(args.includes(setting));
});

test('workflow permission conservatively covers reachable history after workflow deletion', async t => {
  const f = await fixture(t); await mkdir(path.join(f.cwd, '.github/workflows'), { recursive: true });
  await writeFile(path.join(f.cwd, '.github/workflows/fixture.yml'), 'name: Synthetic fixture\n'); await f.git('add', '.'); await f.git('commit', '-m', 'Add fixture workflow');
  await f.git('rm', '.github/workflows/fixture.yml'); await f.git('commit', '-m', 'Remove fixture workflow');
  assert.equal((await prepareTaskPush({ ...f.input, expectedHead: await f.git('rev-parse', 'HEAD') })).requiresWorkflows, true);
});

test('workflow files already in the base do not request write permission for an unrelated change', async t => {
  const f = await fixture(t); await mkdir(path.join(f.cwd, '.github/workflows'), { recursive: true });
  await writeFile(path.join(f.cwd, '.github/workflows/fixture.yml'), 'name: Existing base workflow\n'); await f.git('add', '.'); await f.git('commit', '-m', 'Existing base workflow');
  const baseHead = await f.git('rev-parse', 'HEAD'); await f.git('update-ref', 'refs/remotes/origin/main', baseHead);
  await writeFile(path.join(f.cwd, 'fixture.txt'), 'Unrelated branch edit\n'); await f.git('add', '.'); await f.git('commit', '-m', 'Unrelated task change');
  const plan = await prepareTaskPush({ ...f.input, expectedHead: await f.git('rev-parse', 'HEAD') });
  assert.equal(plan.baseHead, baseHead); assert.equal(plan.requiresWorkflows, false);
});

test('missing, unrelated or subsequently changed local base references fail before token transport', async t => {
  const f = await fixture(t);
  await f.git('update-ref', '-d', 'refs/remotes/origin/main'); await assert.rejects(prepareTaskPush(f.input), /LOCAL_GIT_READ_FAILED/);
  await f.git('update-ref', 'refs/remotes/origin/main', f.input.expectedHead);
  const plan = await prepareTaskPush(f.input), recorder = offlineRunner(plan.expectedHead, plan.branch);
  await f.git('branch', 'codex/unrelated'); await f.git('checkout', '--orphan', 'codex/orphan'); await f.git('rm', '-rf', '.');
  await writeFile(path.join(f.cwd, 'orphan.txt'), 'Orphan fixture\n'); await f.git('add', '.'); await f.git('commit', '-m', 'Unrelated history');
  const unrelated = await f.git('rev-parse', 'HEAD'); await f.git('checkout', f.input.branch);
  await f.git('update-ref', 'refs/remotes/origin/main', unrelated);
  await assert.rejects(prepareTaskPush(f.input), /BASE_NOT_ANCESTOR/);
  const proof = await runTaskPush(plan, secret, recorder.run);
  assert.equal(proof.pushOutcome, 'not-attempted'); assert.equal(proof.failureCode, 'BASE_NOT_ANCESTOR'); assert.equal(recorder.calls.length, 0);
});

test('opaque plans and a second preflight reject forgery, changed configuration and changed HEAD before token transport', async t => {
  const f = await fixture(t), plan = await prepareTaskPush(f.input);
  const recorder = offlineRunner(plan.expectedHead, plan.branch);
  assert.equal((await runTaskPush({ ...plan }, secret, recorder.run)).failureCode, 'PREPARED_TASK_PLAN_REQUIRED');
  await f.git('config', 'user.name', 'Changed local config');
  assert.equal((await runTaskPush(plan, secret, recorder.run)).failureCode, 'TASK_PLAN_CHANGED');
  await f.git('config', 'user.name', 'Synthetic contributor'); await f.git('commit', '--allow-empty', '-m', 'Changed HEAD');
  assert.equal((await runTaskPush(plan, secret, recorder.run)).failureCode, 'TASK_HEAD_CHANGED');
  assert.deepEqual(recorder.calls, []);
});

test('isolated push sends only one exact nonforced codex ref and an environment-only repository-scoped token', async t => {
  const f = await fixture(t), plan = await prepareTaskPush(f.input), recorder = offlineRunner(plan.expectedHead, plan.branch);
  const before = await readFile(path.join(f.cwd, '.git/config'), 'utf8');
  const proof = await runTaskPush(plan, secret, recorder.run);
  assert.equal(proof.outcome, 'passed'); assert.equal(proof.remoteHeadVerified, true);
  assert.equal(proof.ownerAuthenticationUsed, false); assert.equal(proof.secretRecorded, false); assert.ok(!JSON.stringify(proof).includes(secret));
  assert.equal(recorder.calls.length, 3);
  const pushed = recorder.calls[1];
  assert.deepEqual(pushed.args.slice(pushed.args.indexOf('push')), ['push', '--no-verify', '--porcelain', '--no-follow-tags', plan.origin, `${plan.expectedHead}:refs/heads/${plan.branch}`]);
  assert.equal(pushed.env.GIT_CONFIG_KEY_0, `http.${plan.origin}.extraHeader`);
  assert.notEqual(pushed.cwd, f.cwd); await assert.rejects(lstat(pushed.cwd), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.cwd, '.git/config'), 'utf8'), before); assert.equal(await f.git('status', '--porcelain=v1'), '');
});

test('failed App authentication makes one transport attempt and never retries or falls back to owner credentials', async t => {
  const f = await fixture(t), plan = await prepareTaskPush(f.input), recorder = offlineRunner(plan.expectedHead, plan.branch, { failPush: true });
  const proof = await runTaskPush(plan, secret, recorder.run);
  assert.equal(proof.outcome, 'failed'); assert.equal(proof.pushOutcome, 'unconfirmed'); assert.equal(proof.failureCode, 'TASK_PUSH_UNCONFIRMED');
  assert.equal(proof.diagnosticCode, 'AUTHENTICATION_REJECTED'); assert.equal(proof.ownerAuthenticationUsed, false);
  assert.equal(recorder.calls.filter(call => call.args.includes('push')).length, 1); assert.equal(recorder.calls.length, 2);
  assert.ok(!JSON.stringify(proof).includes(secret)); await assert.rejects(lstat(recorder.calls[1].cwd), { code: 'ENOENT' });
});

test('a different remote head remains unconfirmed after successful push, without a retry or false rollback claim', async t => {
  const f = await fixture(t), plan = await prepareTaskPush(f.input), recorder = offlineRunner(plan.expectedHead, plan.branch, { wrongRemote: true });
  const proof = await runTaskPush(plan, secret, recorder.run);
  assert.equal(proof.outcome, 'failed'); assert.equal(proof.pushOutcome, 'succeeded'); assert.equal(proof.remoteHeadVerified, false);
  assert.equal(proof.failureCode, 'REMOTE_HEAD_MISMATCH'); assert.equal(recorder.calls.length, 3);
});

test('token validation and link or object-history boundaries fail before any credential-bearing transport', async t => {
  const f = await fixture(t), plan = await prepareTaskPush(f.input), recorder = offlineRunner(plan.expectedHead, plan.branch);
  for (const token of ['', 'bad\nheader', 'bad token', 'a'.repeat(16385)]) assert.equal((await runTaskPush(plan, token, recorder.run)).failureCode, 'INSTALLATION_TOKEN_INVALID');
  assert.equal(recorder.calls.length, 0);
  const alias = path.join(f.directory, 'linked-source'); await symlink(f.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareTaskPush({ ...f.input, workingDirectory: alias }), /LINK_REJECTED/);
  const alternates = path.join(f.cwd, '.git/objects/info/alternates'); await writeFile(alternates, f.directory + '\n');
  await assert.rejects(prepareTaskPush(f.input), /GIT_HISTORY_OVERRIDE_UNSUPPORTED/); await rm(alternates);
  const actual = path.join(f.directory, 'external-objects'); await mkdir(actual);
  const link = path.join(f.cwd, '.git/objects/linked-objects'); await symlink(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareTaskPush(f.input), /LINK_REJECTED/);
});

test('the scoped extraheader survives credential suppression and is not selected for another repository URL', async t => {
  const f = await fixture(t), hooks = path.join(f.directory, 'empty-hooks'); await mkdir(hooks);
  const origin = `https://github.com/${f.input.repository}.git`, args = taskPushGitArguments(hooks);
  const env = { ...f.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${origin}.extraHeader`, GIT_CONFIG_VALUE_0: authorization };
  const selected = await execute([...args, 'config', '--get-urlmatch', 'http.extraHeader', origin], env, f.directory);
  assert.equal(selected.code, 0); assert.equal(selected.output.trim(), authorization);
  const foreign = await execute([...args, 'config', '--get-urlmatch', 'http.extraHeader', 'https://github.com/other-owner/other-repository.git'], env, f.directory);
  assert.equal(foreign.output.trim(), '');
});

test('transport diagnostics expose only fixed categories', () => {
  assert.equal(classifyTaskPushGitFailure('Authentication failed: secret'), 'AUTHENTICATION_REJECTED');
  assert.equal(classifyTaskPushGitFailure('GH013 repository rule violations'), 'PUSH_REMOTE_RULE_REJECTED');
  assert.equal(classifyTaskPushGitFailure('[rejected] branch (non-fast-forward)'), 'PUSH_NON_FAST_FORWARD');
  assert.equal(classifyTaskPushGitFailure('unknown diagnostic including secret'), 'UNCLASSIFIED_GIT_FAILURE');
});
