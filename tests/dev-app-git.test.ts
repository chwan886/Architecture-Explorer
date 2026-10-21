import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { createSmokeDirectory, removeSmokeDirectory } from '../Tools/ci-smoke-directories.ts';
import { prepareTaskPush, runTaskPush, taskPushCredentialHelper, taskPushEnvironment, taskPushGitArguments } from '../Tools/dev-app-git.ts';

const gitExe = 'C:\\Program Files\\Git\\cmd\\git.exe';
const repository = 'chwan886/Architecture-Explorer';
const origin = `https://github.com/${repository}.git`;
const secret = 'fixture-app-token-must-never-be-recorded';
const skip = process.platform !== 'win32' ? 'Windows-only development App transport' : false;
async function execute(file: string, args: string[], cwd: string, input = '', env = taskPushEnvironment()) {
  return await new Promise<{ code: number; output: string; errors: string }>((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', value => { output += value.toString(); });
    child.stderr.on('data', value => { errors += value.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, output, errors }));
    child.stdin.end(input);
  });
}
async function fixture(run: (value: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const value = await createFixture();
  try { await run(value); } finally { await removeSmokeDirectory(value.owned); }
}
async function createFixture() {
  const owned = await createSmokeDirectory(path.join(TOOL_ROOT, '.tmp'), TOOL_ROOT, 'dev-app-git-test-');
  const root = owned.directory;
  const cwd = path.join(root, 'source');
  await mkdir(cwd);
  const git = async (...args: string[]) => {
    const result = await execute(gitExe, ['-c', `safe.directory=${cwd}`, '-C', cwd, ...args], cwd);
    assert.equal(result.code, 0, `Fixture Git ${args[0]} failed`);
    return result.output.trim();
  };
  await git('init', '--initial-branch=codex/transport-fixture', '--template=');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('remote', 'add', 'origin', origin);
  await writeFile(path.join(cwd, 'fixture.txt'), 'fixture\n');
  await git('add', '.');
  await git('commit', '-m', 'fixture');
  const expectedHead = await git('rev-parse', 'HEAD');
  const input = { repository: 'tool' as const, workingDirectory: cwd, branch: 'codex/transport-fixture', expectedHead };
  return { root, cwd, git, input, owned };
}

test('local preflight freezes an exact clean task plan without a token or network', { skip }, async () => fixture(async f => {
  const before = await readFile(path.join(f.cwd, '.git', 'config'), 'utf8');
  const plan = await prepareTaskPush(f.input);
  assert.equal(plan.repository, repository);
  assert.equal(plan.origin, origin);
  assert.equal(plan.requiresWorkflows, false);
  assert.ok(Object.isFrozen(plan));
  assert.ok(!JSON.stringify(plan).includes(secret));
  assert.equal(await readFile(path.join(f.cwd, '.git', 'config'), 'utf8'), before);
  assert.equal(await f.git('status', '--porcelain=v1', '--untracked-files=all'), '');
}));

test('preflight rejects unapproved destinations, unsafe refs, detached or changed HEAD and dirty files', { skip }, async () => fixture(async f => {
  for (const branch of ['main', 'refs/tags/v1', 'codex/feature:main', 'codex/../main', 'codex/-delete', 'codex/a.lock', 'codex/a//b', 'codex/a@{b',
    'codex/transport-fixture\n', 'codex/transport-fixture\r']) {
    await assert.rejects(prepareTaskPush({ ...f.input, branch }), /TASK_BRANCH_REQUIRED/);
  }
  await assert.rejects(prepareTaskPush({ ...f.input, repository: 'someone/else' as any }), /UNAPPROVED_REPOSITORY/);
  await assert.rejects(prepareTaskPush({ ...f.input, expectedHead: 'a'.repeat(40) }), /TASK_HEAD_CHANGED/);
  await assert.rejects(prepareTaskPush({ ...f.input, expectedHead: '' }), /EXACT_TASK_HEAD_REQUIRED/);
  await assert.rejects(prepareTaskPush({ ...f.input, expectedHead: `${f.input.expectedHead}\n` }), /EXACT_TASK_HEAD_REQUIRED/);
  for (const url of ['https://owner:secret@github.com/chwan886/Architecture-Explorer.git', 'git@github.com:chwan886/Architecture-Explorer.git',
    'https://github.com/chwan886/GameDemo02.git', 'https://github.com/chwan886/Architecture-Explorer', 'https://example.invalid/Architecture-Explorer.git']) {
    await f.git('remote', 'set-url', 'origin', url);
    await assert.rejects(prepareTaskPush(f.input), /ORIGIN_MISMATCH/);
  }
  await f.git('remote', 'set-url', 'origin', origin);
  await writeFile(path.join(f.cwd, 'untracked.txt'), 'changed');
  await assert.rejects(prepareTaskPush(f.input), /TASK_WORKTREE_DIRTY/);
  await rm(path.join(f.cwd, 'untracked.txt'));
  await writeFile(path.join(f.cwd, 'fixture.txt'), 'changed');
  await assert.rejects(prepareTaskPush(f.input), /TASK_WORKTREE_DIRTY/);
  await f.git('checkout', '--', 'fixture.txt');
  await f.git('checkout', '--detach', f.input.expectedHead);
  await assert.rejects(prepareTaskPush(f.input), /LOCAL_GIT_READ_FAILED/);
}));

test('raw configuration rejects includes, credential helpers, URL rewrites and executable filters', { skip }, async () => fixture(async f => {
  for (const [key, value] of [['include.path', 'C:/missing'], ['includeIf.gitdir:**.path', 'C:/missing'],
    ['credential.helper', 'manager'], ['url.https://example.invalid/.insteadOf', 'https://github.com/'],
    ['remote.origin.pushurl', 'https://example.invalid/'], ['http.extraHeader', 'Authorization: fixture'],
    ['filter.fixture.clean', 'malicious-command'], ['core.fsmonitor', 'malicious-command']]) {
    await f.git('config', key, value);
    await assert.rejects(prepareTaskPush(f.input), /UNSAFE_LOCAL_GIT_CONFIG/);
    await f.git('config', '--unset-all', key);
  }
  assert.equal((await prepareTaskPush(f.input)).requiresWorkflows, false);
}));

test('workflow permission covers reachable history even when the final tree restores/removes the workflow', { skip }, async () => fixture(async f => {
  await mkdir(path.join(f.cwd, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(f.cwd, '.github', 'workflows', 'fixture.yml'), 'name: fixture\n');
  await f.git('add', '.'); await f.git('commit', '-m', 'add workflow');
  await f.git('rm', '.github/workflows/fixture.yml'); await f.git('commit', '-m', 'remove workflow');
  const expectedHead = await f.git('rev-parse', 'HEAD');
  assert.equal((await prepareTaskPush({ ...f.input, expectedHead })).requiresWorkflows, true);
}));

test('push rechecks clean exact HEAD and refuses forged plans before any credential-bearing transport', { skip }, async () => fixture(async f => {
  const plan = await prepareTaskPush(f.input);
  const forged = await runTaskPush({ ...plan }, secret);
  assert.equal(forged.failureCode, 'PREPARED_TASK_PLAN_REQUIRED');
  assert.equal(forged.pushOutcome, 'not-attempted');
  await writeFile(path.join(f.cwd, 'untracked.txt'), 'changed');
  const dirty = await runTaskPush(plan, secret);
  assert.equal(dirty.failureCode, 'TASK_WORKTREE_DIRTY');
  assert.equal(dirty.pushOutcome, 'not-attempted');
  await rm(path.join(f.cwd, 'untracked.txt'));
  await f.git('commit', '--allow-empty', '-m', 'head changed after preparation');
  const changed = await runTaskPush(plan, secret);
  assert.equal(changed.failureCode, 'TASK_HEAD_CHANGED');
  assert.equal(changed.pushOutcome, 'not-attempted');
  for (const value of [forged, dirty, changed]) {
    assert.ok(!JSON.stringify(value).includes(secret));
    assert.equal(value.ownerAuthenticationUsed, false);
  }
}));

test('credential protocol returns a fixture token only to Git for the exact approved HTTPS repository', { skip }, async () => fixture(async f => {
  const helper = path.join(f.root, 'helper.mjs');
  await writeFile(helper, taskPushCredentialHelper);
  assert.ok(!(await readFile(helper, 'utf8')).includes(secret));
  const env = { ...taskPushEnvironment(), EXPLORER_DEV_APP_GIT_TOKEN: secret, EXPLORER_DEV_APP_GIT_REPOSITORY: repository };
  const credential = `protocol=https\nhost=github.com\npath=${repository}.git\n\n`;
  const allowed = await execute(process.execPath, [helper, 'get'], f.root, credential, env);
  assert.equal(allowed.code, 0);
  assert.equal(allowed.output, `username=x-access-token\npassword=${secret}\n\n`);
  assert.equal(allowed.errors, '');
  for (const input of [credential.replace('https', 'http'), credential.replace('github.com', 'example.invalid'),
    credential.replace(repository, 'chwan886/GameDemo02'), credential.replace('.git', ''), credential.replace('host=github.com', 'host=owner@github.com'),
    credential + 'host=github.com\n', credential + 'username=owner\n']) {
    const denied = await execute(process.execPath, [helper, 'get'], f.root, input, env);
    assert.equal(denied.code, 1); assert.equal(denied.output, ''); assert.equal(denied.errors, '');
  }
  for (const operation of ['store', 'erase']) {
    const ignored = await execute(process.execPath, [helper, operation], f.root, credential, env);
    assert.equal(ignored.code, 0); assert.equal(ignored.output, '');
  }
}));

test('Git credential helper reset blocks owner fallback and all child settings exclude inherited injection', { skip }, async () => fixture(async f => {
  const helper = path.join(f.root, 'helper.mjs'), hooks = path.join(f.root, 'empty-hooks'), isolated = path.join(f.root, 'isolated.git');
  await writeFile(helper, taskPushCredentialHelper); await mkdir(hooks);
  assert.equal((await execute(gitExe, ['init', '--bare', '--template=', isolated], f.root)).code, 0);
  const marker = path.join(f.root, 'owner-fallback-ran');
  assert.equal((await execute(gitExe, ['--git-dir', isolated, 'config', 'credential.helper', `!touch '${marker.replaceAll('\\', '/')}'`], f.root)).code, 0);
  const args = [...taskPushGitArguments(hooks, helper), '-c', `safe.directory=${isolated}`, '--git-dir', isolated];
  const env: NodeJS.ProcessEnv = { ...taskPushEnvironment({ ...process.env, GIT_CONFIG_COUNT: '1', GIT_ASKPASS: 'owner-helper',
    GH_TOKEN: 'owner-token', GITHUB_TOKEN: 'owner-token', HTTPS_PROXY: 'https://proxy.invalid', NODE_OPTIONS: '--require=malicious',
    CURL_CA_BUNDLE: 'untrusted-roots', EXPLORER_DEV_APP_GIT_TOKEN: 'inherited-token' }), EXPLORER_DEV_APP_GIT_TOKEN: secret, EXPLORER_DEV_APP_GIT_REPOSITORY: repository };
  const result = await execute(gitExe, [...args, 'credential', 'fill'], f.root, `protocol=https\nhost=github.com\npath=${repository}.git\n\n`, env);
  assert.equal(result.code, 0, result.errors); assert.ok(result.output.includes(`password=${secret}`));
  await assert.rejects(access(marker));
  assert.equal(env.GIT_ASKPASS, undefined); assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GH_TOKEN, undefined); assert.equal(env.GITHUB_TOKEN, undefined); assert.equal(env.HTTPS_PROXY, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, 'NUL'); assert.equal(env.GIT_TERMINAL_PROMPT, '0'); assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_NO_LAZY_FETCH, '1');
  assert.equal(env.CURL_CA_BUNDLE, undefined);
  assert.ok(!args.join(' ').includes(secret));
  for (const key of ['core.hooksPath', 'http.followRedirects', 'http.sslVerify', 'protocol.allow', 'protocol.https.allow']) {
    const value = await execute(gitExe, [...args, 'config', '--get', key], f.root);
    assert.equal(value.code, 0);
    assert.equal(value.output.trim(), ({ 'core.hooksPath': hooks, 'http.followRedirects': 'false', 'http.sslVerify': 'true', 'protocol.allow': 'never', 'protocol.https.allow': 'always' } as Record<string, string>)[key]);
  }
}));
