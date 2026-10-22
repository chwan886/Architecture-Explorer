import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { createSmokeDirectory, removeSmokeDirectory } from '../Tools/ci-smoke-directories.ts';
import { prepareMainFetch, runMainFetch, taskPushEnvironment, type MainFetchInput } from '../Tools/dev-app-git.ts';
import { DEV_APP, runDevelopmentApp, type AppOperation, type AuthRequest, type Repository } from '../Tools/dev-app-auth.ts';

const gitExe = 'C:\\Program Files\\Git\\cmd\\git.exe';
const token = 'nonsecret-fetch-fixture-token', jwt = 'nonsecret-fetch-fixture-jwt';
const now = Date.parse('2026-10-22T01:00:00Z');
const skip = process.platform !== 'win32' ? 'Windows-only shared App entry' : false;
async function execute(file: string, args: string[], cwd: string, env = taskPushEnvironment()) {
  return await new Promise<{ code: number; output: string; errors: string }>((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { errors += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, output, errors }));
  });
}
async function fixture(run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>, repository: Repository = 'chwan886/Architecture-Explorer') {
  const value = await createFixture(repository);
  try { await run(value); } finally { await removeSmokeDirectory(value.owned); }
}
async function createFixture(repository: Repository) {
  const owned = await createSmokeDirectory(path.join(TOOL_ROOT, '.tmp'), TOOL_ROOT, 'dev-app-fetch-test-');
  try {
  const root = owned.directory, cwd = path.join(root, 'source'), remote = path.join(root, 'fixture-main.git'), upstream = path.join(root, 'upstream');
  const git = async (directory: string, ...args: string[]) => {
    const result = await execute(gitExe, ['-c', `safe.directory=${directory}`, '-C', directory, ...args], root);
    assert.equal(result.code, 0, `Fixture Git ${args[0]} failed: ${result.errors}`);
    return result.output.trim();
  };
  for (const directory of [cwd, upstream]) {
    await mkdir(directory); await git(directory, 'init', '--initial-branch=codex/fetch-fixture', '--template=');
    await git(directory, 'config', 'user.name', 'Fixture'); await git(directory, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(directory, 'fixture.txt'), path.basename(directory) + '\n');
    await git(directory, 'add', '.'); await git(directory, 'commit', '-m', 'fixture initial commit');
  }
  await git(cwd, 'remote', 'add', 'origin', `https://github.com/${repository}.git`);
  assert.equal((await execute(gitExe, ['init', '--bare', '--template=', remote], root)).code, 0);
  const expectedHead = await git(upstream, 'rev-parse', 'HEAD');
  await git(upstream, '-c', `safe.directory=${remote}`, '-c', 'protocol.file.allow=always', 'push', remote, 'HEAD:refs/heads/main');
  const input: MainFetchInput = { repository, workingDirectory: cwd, expectedHead };
  return { owned, root, cwd, upstream, remote, git, input };
  } catch (error) { await removeSmokeDirectory(owned); throw error; }
}
async function boundary(f: Awaited<ReturnType<typeof createFixture>>) {
  const optional = async (filename: string) => await readFile(path.join(f.cwd, '.git', filename), 'hex').catch(error => {
    if (error.code === 'ENOENT') return 'absent'; throw error;
  });
  return { head: await optional('HEAD'), index: await optional('index'), fetchHead: await optional('FETCH_HEAD'), config: await optional('config'),
    refs: await f.git(f.cwd, 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)'),
    files: await f.git(f.cwd, 'ls-files', '--stage'), status: await f.git(f.cwd, 'status', '--porcelain=v1', '--untracked-files=all'),
    worktreeBytes: await readFile(path.join(f.cwd, 'fixture.txt'), 'hex') };
}

test('main fetch preflight seals one fixed repo/main plan; the remote SHA need not already exist locally', { skip }, async () => fixture(async f => {
  const before = await boundary(f), plan = await prepareMainFetch(f.input);
  assert.ok(Object.isFrozen(plan)); assert.equal(plan.origin, 'https://github.com/chwan886/Architecture-Explorer.git');
  assert.equal(plan.expectedHead, f.input.expectedHead); assert.notEqual(plan.localHead, plan.expectedHead);
  assert.notEqual((await execute(gitExe, ['-C', f.cwd, 'cat-file', '-e', plan.expectedHead], f.root)).code, 0);
  assert.deepEqual(await boundary(f), before);
  await f.git(f.cwd, 'checkout', '--detach');
  assert.equal((await prepareMainFetch(f.input)).localHead, plan.localHead);
}));

test('main fetch rejects repo/SHA/argument injection, wrong origin, non-root and executable local config before credentials', { skip }, async () => fixture(async f => {
  for (const bad of [
    { ...f.input, repository: 'other/repo' }, { ...f.input, expectedHead: 'a'.repeat(39) },
    { ...f.input, expectedHead: `${f.input.expectedHead}\n` }, { ...f.input, expectedHead: 'refs/heads/main' },
    { ...f.input, branch: 'main' }, { ...f.input, prNumber: 1 }, { ...f.input, workingDirectory: '.' },
  ]) await assert.rejects(prepareMainFetch(bad as MainFetchInput));
  await mkdir(path.join(f.cwd, 'child'));
  await assert.rejects(prepareMainFetch({ ...f.input, workingDirectory: path.join(f.cwd, 'child') }), /WORKTREE_ROOT_REQUIRED/);
  for (const origin of ['https://owner:fixture@github.com/chwan886/Architecture-Explorer.git',
    'https://github.com/chwan886/GameDemo02.git', 'git@github.com:chwan886/Architecture-Explorer.git', 'https://example.invalid/tool.git']) {
    await f.git(f.cwd, 'remote', 'set-url', 'origin', origin);
    await assert.rejects(prepareMainFetch(f.input), /ORIGIN_MISMATCH/);
  }
  await f.git(f.cwd, 'remote', 'set-url', 'origin', 'https://github.com/chwan886/Architecture-Explorer.git');
  for (const [key, value] of [['include.path', 'C:/not-loaded'], ['credential.helper', 'manager'],
    ['url.https://example.invalid/.insteadOf', 'https://github.com/'], ['remote.origin.uploadpack', 'untrusted'], ['core.fsmonitor', 'untrusted']]) {
    await f.git(f.cwd, 'config', key!, value!);
    await assert.rejects(prepareMainFetch(f.input), /UNSAFE_LOCAL_GIT_CONFIG/);
    await f.git(f.cwd, 'config', '--unset-all', key!);
  }
}));

test('existing changes, linked object shards and changed sealed local state stop before any transport', { skip }, async () => fixture(async f => {
  await writeFile(path.join(f.cwd, 'fixture.txt'), 'preserved dirty bytes');
  await assert.rejects(prepareMainFetch(f.input), /MAIN_FETCH_WORKTREE_DIRTY/);
  assert.equal(await readFile(path.join(f.cwd, 'fixture.txt'), 'utf8'), 'preserved dirty bytes');
  await f.git(f.cwd, 'checkout', '--', 'fixture.txt');
  await writeFile(path.join(f.cwd, 'untracked.txt'), 'preserve untracked');
  await assert.rejects(prepareMainFetch(f.input), /MAIN_FETCH_WORKTREE_DIRTY/);
  await rm(path.join(f.cwd, 'untracked.txt'));
  const external = path.join(f.root, 'external'), shard = path.join(f.cwd, '.git', 'objects', 'zz');
  await mkdir(external); await writeFile(path.join(external, 'sentinel.txt'), 'do not change');
  await symlink(external, shard, 'junction');
  try { await assert.rejects(prepareMainFetch(f.input), /MAIN_FETCH_OBJECT_LINK_REJECTED/); }
  finally { await rm(shard); }
  assert.equal(await readFile(path.join(external, 'sentinel.txt'), 'utf8'), 'do not change');
  const plan = await prepareMainFetch(f.input);
  const neverTransport = async () => { throw Error('must not start any transport'); };
  assert.equal((await runMainFetch({ ...plan }, token, neverTransport)).failureCode, 'PREPARED_MAIN_FETCH_PLAN_REQUIRED');
  await f.git(f.cwd, 'branch', 'codex/another-local-ref');
  const changed = await runMainFetch(plan, token, neverTransport);
  assert.equal(changed.outcome, 'failed'); assert.equal(changed.failureCode, 'MAIN_FETCH_PLAN_CHANGED');
  assert.equal(changed.fetchOutcome, 'not-attempted');
}));

type FetchGit = NonNullable<Parameters<typeof runMainFetch>[2]>;
function offlineTransport(f: Awaited<ReturnType<typeof createFixture>>, mode: 'success' | 'changed-main' | 'wrong-fetched-object' = 'success') {
  const calls: { args: string[]; credential: boolean; cwd: string }[] = [];
  let reads = 0, imports = 0;
  const run: FetchGit = async (args, env, cwd) => {
    const credential = env.EXPLORER_DEV_APP_GIT_TOKEN !== undefined;
    calls.push({ args: [...args], credential, cwd });
    assert.equal(env.GH_TOKEN, undefined); assert.equal(env.GITHUB_TOKEN, undefined); assert.equal(env.GIT_CONFIG_GLOBAL, 'NUL');
    assert.equal(env.GIT_CONFIG_SYSTEM, 'NUL'); assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    const actual = [...args], command = args.findIndex(arg => ['ls-remote', 'fetch'].includes(arg));
    if (credential) {
      assert.equal(env.EXPLORER_DEV_APP_GIT_TOKEN, token); assert.equal(env.EXPLORER_DEV_APP_GIT_REPOSITORY, f.input.repository);
      assert.ok(cwd !== f.cwd && cwd.startsWith(path.join(TOOL_ROOT, '.tmp')));
      assert.equal(args[args.indexOf('--git-dir') + 1], path.join(cwd, 'transport.git'));
      assert.equal(env.HOME, path.join(cwd, 'empty-home')); assert.equal(env.USERPROFILE, env.HOME);
      assert.equal(env.GIT_ALTERNATE_OBJECT_DIRECTORIES, undefined);
      assert.ok(!args.includes('-C') && !args.includes('protocol.file.allow=always'));
      assert.equal(args.filter(arg => arg.startsWith('https://')).join(), `https://github.com/${f.input.repository}.git`);
      if (args.includes('ls-remote')) {
        reads++; assert.equal(args.at(-1), 'refs/heads/main');
        if (mode === 'changed-main' && reads === 2) {
          return { code: 0, output: `${'b'.repeat(40)}\trefs/heads/main\n`, failed: false, diagnosticTruncated: false };
        }
      } else {
        assert.ok(args.includes('fetch')); assert.equal(args.at(-1), 'refs/heads/main:refs/heads/main');
      }
      // The fixture alone maps the fixed HTTPS endpoint to its own bare repository. No real network/auth occurs.
      actual[actual.findIndex(arg => arg.startsWith('https://'))] = pathToFileURL(f.remote).href;
      actual.splice(command, 0, '-c', 'protocol.file.allow=always');
    } else if (args.includes('fetch')) {
      imports++;
      assert.ok(args.includes('protocol.file.allow=always') && args.includes('protocol.https.allow=never'));
      for (const flag of ['--no-write-fetch-head', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--refmap=']) assert.ok(args.includes(flag));
      assert.equal(args.at(-1), f.input.expectedHead);
      assert.equal(args.at(-2), pathToFileURL(path.join(cwd, 'transport.git')).href);
      assert.equal(args[args.indexOf('--git-dir') + 1], path.join(f.cwd, '.git'));
      assert.equal(env.EXPLORER_DEV_APP_GIT_REPOSITORY, undefined);
    }
    if (mode === 'wrong-fetched-object' && !credential && args.includes('rev-parse')) {
      return { code: 0, output: `${'c'.repeat(40)}\n`, failed: false, diagnosticTruncated: false };
    }
    const result = await execute(gitExe, actual, cwd, env);
    assert.ok(!result.output.includes(token) && !result.errors.includes(token));
    return { code: result.code, output: result.output, failed: false, diagnosticTruncated: false };
  };
  return { run, calls, imports: () => imports };
}

test('fixed main fetch imports a previously absent commit using tokenless file transport and preserves local boundary in both repos', { skip }, async () => {
  for (const repository of DEV_APP.installedRepositories as Repository[]) await fixture(async f => {
    const before = await boundary(f), plan = await prepareMainFetch(f.input), transport = offlineTransport(f);
    const proof = await runMainFetch(plan, token, transport.run);
    assert.equal(proof.outcome, 'passed', JSON.stringify(proof)); assert.equal(proof.fetchOutcome, 'succeeded');
    assert.equal(proof.remoteHeadVerified, true); assert.equal(proof.localObjectImported, true); assert.equal(proof.localBoundaryVerified, true);
    assert.equal(transport.imports(), 1); assert.equal(transport.calls.filter(call => call.credential).length, 3);
    assert.deepEqual(await boundary(f), before);
    assert.equal(await f.git(f.cwd, 'cat-file', '-t', f.input.expectedHead), 'commit');
    assert.equal(await f.git(f.cwd, 'show', `${f.input.expectedHead}:fixture.txt`), 'upstream');
    assert.ok(!JSON.stringify(proof).includes(token));
  }, repository);
});

test('a changed remote main or mismatched fetched commit never reaches the local import', { skip }, async () => {
  for (const mode of ['changed-main', 'wrong-fetched-object'] as const) await fixture(async f => {
    const before = await boundary(f), plan = await prepareMainFetch(f.input), transport = offlineTransport(f, mode);
    const proof = await runMainFetch(plan, token, transport.run);
    assert.equal(proof.outcome, 'failed'); assert.equal(proof.localObjectImported, false); assert.equal(proof.localBoundaryVerified, true);
    assert.equal(proof.failureCode, mode === 'changed-main' ? 'MAIN_HEAD_CHANGED_OR_MISMATCHED' : 'FETCHED_MAIN_OBJECT_MISMATCH');
    assert.equal(transport.imports(), 0); assert.deepEqual(await boundary(f), before);
    assert.notEqual((await execute(gitExe, ['-C', f.cwd, 'cat-file', '-e', f.input.expectedHead], f.root)).code, 0);
  });
});

function authFixture(options: AppOperation, mutate: (endpoint: string, result: any) => any = (_endpoint, result) => result) {
  const owner = { id: 1, login: DEV_APP.owner, type: 'User' }, repo = { id: 2, full_name: options.repository, owner };
  const permissions = { contents: 'write', metadata: 'read', pull_requests: 'write', workflows: 'write', actions: 'read' };
  const installation = { id: 3, app_id: DEV_APP.id, app_slug: DEV_APP.slug, account: owner, target_type: 'User', repository_selection: 'selected', suspended_at: null, permissions };
  const calls: { method: string; endpoint: string; body?: any }[] = [];
  let revoked = false;
  const request: AuthRequest = async (method, endpoint, _credential, body) => {
    calls.push({ method, endpoint, body });
    let result: any;
    if (endpoint === '/app') result = { status: 200, data: { id: DEV_APP.id, client_id: DEV_APP.clientId, slug: DEV_APP.slug, owner, permissions } };
    else if (endpoint.startsWith('/app/installations?')) result = { status: 200, data: [installation] };
    else if (endpoint.endsWith('/installation')) result = { status: 200, data: installation };
    else if (endpoint.endsWith('/access_tokens')) result = { status: 201, data: { token, expires_at: new Date(now + 3600000).toISOString(), repository_selection: 'selected', repositories: [repo], permissions: { ...body?.permissions, metadata: 'read' } } };
    else if (method === 'DELETE') { revoked = true; result = { status: 204 }; }
    else if (endpoint.startsWith('/installation/repositories')) result = revoked ? { status: 401 } : { status: 200, data: { total_count: 1, repositories: [repo] } };
    else if (endpoint.endsWith('/git/ref/heads/main')) result = { status: 200, data: { ref: 'refs/heads/main', object: { type: 'commit', sha: 'a'.repeat(40) } } };
    else throw Error('Unexpected fixture route');
    return mutate(endpoint, result);
  };
  return { calls, request };
}

test('shared auth requests only one Contents read token, rejects changed API main and revokes 204/401', { skip }, async () => fixture(async f => {
  const options: AppOperation = { operation: 'fetch-main', repository: f.input.repository as Repository, workingDirectory: f.cwd, expectedHead: f.input.expectedHead };
  for (const mode of ['main-mismatch', 'expanded-token', 'wrong-repository'] as const) {
    const fixture = authFixture(options, (endpoint, result) => {
      if (endpoint.endsWith('/access_tokens')) {
        if (mode === 'expanded-token') result.data.permissions.workflows = 'write';
        if (mode === 'wrong-repository') result.data.repositories[0].full_name = 'chwan886/GameDemo02';
      }
      return result;
    });
    const result = await runDevelopmentApp(options, () => jwt, fixture.request, () => now, async () => {});
    assert.equal(result.outcome, 'failed'); assert.equal(result.token.revocation, 'confirmed-204'); assert.equal(result.token.revokedTokenProbe, 'rejected-401');
    assert.deepEqual(fixture.calls.find(call => call.endpoint.endsWith('/access_tokens'))?.body,
      { repositories: ['Architecture-Explorer'], permissions: { contents: 'read' } });
    assert.equal(result.failureCode, mode === 'main-mismatch' ? 'MAIN_HEAD_CHANGED_OR_MISMATCHED' : mode === 'expanded-token' ? 'TOKEN_PERMISSIONS_NOT_READ_ONLY' : 'TOKEN_REPOSITORY_SCOPE_MISMATCH');
    assert.ok(!JSON.stringify(result).includes(token) && !JSON.stringify(result).includes(jwt));
    assert.ok(!fixture.calls.some(call => call.method === 'PATCH' || call.endpoint.includes('/actions/') || call.endpoint.includes('/pulls')));
  }
  await writeFile(path.join(f.cwd, 'fixture.txt'), 'existing uncommitted work');
  let called = false;
  const dirty = await runDevelopmentApp(options, () => { called = true; return jwt; }, async () => { called = true; throw Error('must not authenticate'); });
  assert.equal(dirty.failureCode, 'MAIN_FETCH_PREFLIGHT_FAILED'); assert.equal(called, false);
  assert.equal(await readFile(path.join(f.cwd, 'fixture.txt'), 'utf8'), 'existing uncommitted work');
}));

test('PowerShell FetchMain refuses mixed operations/branch/PR options and invalid SHA before the key directory', { skip }, async () => fixture(async f => {
  const entry = path.join(TOOL_ROOT, 'Tools', 'dev-app-auth.ps1');
  for (const args of [
    ['-FetchMain', '-Verify'], ['-FetchMain', '-Push'], ['-FetchMain', '-InspectMain'],
    ['-FetchMain', '-WorkingDirectory', f.cwd, '-ExpectedHead', f.input.expectedHead, '-Branch', 'codex/x'],
    ['-FetchMain', '-WorkingDirectory', f.cwd, '-ExpectedHead', f.input.expectedHead, '-PrNumber', '1'],
    ['-FetchMain', '-WorkingDirectory', f.cwd, '-ExpectedHead', 'abc'],
    ['-FetchMain', '-ExpectedHead', f.input.expectedHead, '-WorkingDirectory', '.'],
  ]) {
    const result = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', entry, ...args, '-PrivateKeyDirectory', path.join(f.root, 'not-a-key-directory')], f.root);
    assert.equal(result.code, 1); assert.match(result.output + result.errors, /EXACTLY_ONE_OPERATION_REQUIRED|OPERATION_PARAMETER_INVALID|EXACT_HEAD_REQUIRED|WORKING_DIRECTORY_INVALID/);
    assert.doesNotMatch(result.output + result.errors, /KEY_DIRECTORY|PEM|PRIVATE KEY/);
  }
}));
