import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { createSmokeDirectory, removeSmokeDirectory } from '../Tools/ci-smoke-directories.ts';
import { classifyTaskPushGitFailure, prepareTaskPush, runTaskPush, taskPushCredentialHelper, taskPushEnvironment, taskPushGitArguments } from '../Tools/dev-app-git.ts';

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
  const multiple = await execute(process.execPath, [helper, 'get'], f.root,
    `capability[]=authtype\ncapability[]=state\n${credential}wwwauth[]=Basic realm="fixture"\nwwwauth[]=Basic realm="fixture2"\nstate[]=one\nstate[]=two\n`, env);
  assert.equal(multiple.code, 0); assert.equal(multiple.output, allowed.output); assert.equal(multiple.errors, '');
  for (const [input, code] of [[credential.replace('https', 'http'), 'INVALID_PROTOCOL'], [credential.replace('github.com', 'example.invalid'), 'INVALID_HOST'],
    [credential.replace(repository, 'chwan886/GameDemo02'), 'INVALID_PATH'], [credential.replace('.git', ''), 'INVALID_PATH'],
    [credential.replace('host=github.com', 'host=owner@github.com'), 'INVALID_HOST'], [credential + 'host=github.com\n', 'PROTOCOL_PARSE'],
    [credential + 'username=owner\n', 'INVALID_USERNAME'], [credential + 'protocol=https\n', 'PROTOCOL_PARSE'],
    [credential + `path=${repository}.git\n`, 'PROTOCOL_PARSE'], [credential + 'username=x-access-token\nusername=owner\n', 'PROTOCOL_PARSE'],
    ['malformed-line\n', 'PROTOCOL_PARSE']]) {
    const denied = await execute(process.execPath, [helper, 'get'], f.root, input, env);
    assert.equal(denied.code, 1); assert.equal(denied.output, ''); assert.equal(denied.errors, `EXPLORER_GIT_HELPER_${code}\n`);
  }
  const noToken = await execute(process.execPath, [helper, 'get'], f.root, credential, { ...env, EXPLORER_DEV_APP_GIT_TOKEN: '' });
  assert.equal(noToken.code, 1); assert.equal(noToken.output, ''); assert.equal(noToken.errors, 'EXPLORER_GIT_HELPER_NO_TOKEN\n');
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
  for (const key of ['core.hooksPath', 'http.followRedirects', 'http.sslVerify', 'http.sslBackend', 'http.schannelCheckRevoke', 'protocol.allow', 'protocol.https.allow']) {
    const value = await execute(gitExe, [...args, 'config', '--get', key], f.root);
    assert.equal(value.code, 0);
    assert.equal(value.output.trim(), ({ 'core.hooksPath': hooks, 'http.followRedirects': 'false', 'http.sslVerify': 'true', 'http.sslBackend': 'schannel',
      'http.schannelCheckRevoke': 'true', 'protocol.allow': 'never', 'protocol.https.allow': 'always' } as Record<string, string>)[key]);
  }
}));

test('Git diagnostics return only fixed categories even when raw errors contain credentials, URLs or headers', () => {
  const cases = [
    ...['NO_TOKEN', 'INVALID_PROTOCOL', 'INVALID_HOST', 'INVALID_PATH', 'INVALID_USERNAME', 'PROTOCOL_PARSE'].map(code =>
      [`EXPLORER_GIT_HELPER_${code}\nfatal: could not read Password`, `CREDENTIAL_HELPER_${code}`]),
    ['SSL certificate problem: unable to get local issuer certificate', 'TLS_CERTIFICATE_VALIDATION_FAILED'],
    ['schannel: next InitializeSecurityContext failed: SEC_E_UNTRUSTED_ROOT', 'TLS_CERTIFICATE_VALIDATION_FAILED'],
    ["Unsupported SSL backend 'fixture'. Supported SSL backends: schannel, openssl", 'TLS_BACKEND_UNAVAILABLE'],
    ['fatal: could not read Password for https://github.com: terminal prompts disabled', 'CREDENTIAL_HELPER_FAILED'],
    ['sh.exe: fatal error - NtCreateDirectoryObject: 0xC0000022; waitpid for node failed', 'CREDENTIAL_HELPER_FAILED'],
    ['fatal: Authentication failed for https://github.com/chwan886/Architecture-Explorer.git', 'AUTHENTICATION_REJECTED'],
    ['fatal: The requested URL returned error: 403', 'AUTHENTICATION_REJECTED'],
    ['refusing to allow a GitHub App to create or update workflow without workflows permission', 'WORKFLOW_PERMISSION_REJECTED'],
    ['! refs/heads/codex/fixture [rejected] (non-fast-forward)', 'PUSH_NON_FAST_FORWARD'],
    ['remote: GH013: Repository rule violations found', 'PUSH_REMOTE_RULE_REJECTED'],
    ['fatal: bad boolean config value for core.fsmonitor', 'GIT_CONFIGURATION_REJECTED'],
    ['fatal: bad object deadbeef', 'OBJECT_DATABASE_UNAVAILABLE'],
    ['error: object directory E:/fixture/objects does not exist', 'OBJECT_DATABASE_UNAVAILABLE'],
    ['fatal: Could not resolve host: github.com', 'NETWORK_DNS_FAILED'],
    ['fatal: Failed to connect to github.com port 443', 'NETWORK_CONNECTION_FAILED'],
    ['server response containing otherwise unknown failure', 'UNCLASSIFIED_GIT_FAILURE'],
  ];
  for (const [message, expected] of cases) {
    const raw = `${message}\nAuthorization: Bearer ${secret}\nhttps://owner:${secret}@example.invalid/private?secret=${secret}\n`;
    const diagnostic = classifyTaskPushGitFailure(raw);
    assert.equal(diagnostic, expected);
    assert.ok(!diagnostic.includes(secret) && !diagnostic.includes('https:') && !diagnostic.includes('Authorization'));
    assert.match(diagnostic, /^[A-Z_]+$/);
  }
  assert.equal(classifyTaskPushGitFailure(secret), 'UNCLASSIFIED_GIT_FAILURE');
});

test('isolated bare Git resolves the exact fixture SHA through alternates and keeps non-fast-forward protection', { skip }, async () => fixture(async f => {
  const isolated = path.join(f.root, 'transport.git'), target = path.join(f.root, 'target.git'), hooks = path.join(f.root, 'empty-hooks');
  await mkdir(hooks);
  for (const directory of [isolated, target]) assert.equal((await execute(gitExe, ['init', '--bare', '--template=', directory], f.root)).code, 0);
  const env = { ...taskPushEnvironment(), GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(f.cwd, '.git', 'objects') };
  const args = [...taskPushGitArguments(hooks), '-c', `safe.directory=${isolated}`, '--git-dir', isolated];
  const object = await execute(gitExe, [...args, 'cat-file', '-t', f.input.expectedHead], f.root, '', env);
  assert.equal(object.code, 0); assert.equal(object.output.trim(), 'commit');
  // Only this offline fixture enables file transport; production only permits HTTPS.
  const push = async (sha: string) => await execute(gitExe, [...args, '-c', 'protocol.file.allow=always', 'push', '--no-verify', '--porcelain', '--no-follow-tags',
    target, `${sha}:refs/heads/${f.input.branch}`], f.root, '', env);
  assert.equal((await push(f.input.expectedHead)).code, 0);
  const first = f.input.expectedHead;
  await f.git('commit', '--allow-empty', '-m', 'next fixture commit');
  assert.equal((await push(await f.git('rev-parse', 'HEAD'))).code, 0);
  const rejected = await push(first);
  assert.notEqual(rejected.code, 0);
  assert.equal(classifyTaskPushGitFailure(`${rejected.errors}\n${rejected.output}`), 'PUSH_NON_FAST_FORWARD');
}));

test('real Git HTTP Basic negotiation uses the static helper under an empty home (loopback fixture only)', { skip }, async () => fixture(async f => {
  let authenticated = false;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from(`x-access-token:${secret}`).toString('base64')}`) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' }); response.end(); return;
    }
    authenticated = true;
    response.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    response.end('001e# service=git-upload-pack\n00000000');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const home = path.join(f.root, 'empty-home'), hooks = path.join(f.root, 'empty-hooks'), isolated = path.join(f.root, 'http.git');
    await mkdir(home); await mkdir(hooks);
    assert.equal((await execute(gitExe, ['init', '--bare', '--template=', isolated], f.root)).code, 0);
    const helper = path.join(f.root, 'loopback-helper.mjs');
    // The test alone replaces the two fixed endpoints; production only accepts HTTPS github.com.
    await writeFile(helper, taskPushCredentialHelper.replace("values.get('protocol') !== 'https'", "values.get('protocol') !== 'http'")
      .replace("values.get('host') !== 'github.com'", `values.get('host') !== '127.0.0.1:${address.port}'`));
    const env = { ...taskPushEnvironment(), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
      EXPLORER_DEV_APP_GIT_TOKEN: secret, EXPLORER_DEV_APP_GIT_REPOSITORY: repository };
    const args = [...taskPushGitArguments(hooks, helper), '-c', `safe.directory=${isolated}`, '--git-dir', isolated,
      '-c', 'protocol.http.allow=always', 'ls-remote', `http://127.0.0.1:${address.port}/${repository}.git`];
    const result = await execute(gitExe, args, f.root, '', env);
    // A malformed fixture advertisement may fail later; the credential protocol must already have authenticated.
    assert.equal(authenticated, true, classifyTaskPushGitFailure(result.errors));
    assert.ok(!result.errors.includes('EXPLORER_GIT_HELPER_'));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}));
