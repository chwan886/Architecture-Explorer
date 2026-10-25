import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const { exportPublicSnapshot, planPublicExport, PUBLIC_IDENTITY } = await import(pathToFileURL(path.join(root, 'Tools/export-public.mjs')).href);
const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
async function git(directory: string, ...args: string[]) { return (await execute('git', ['-c', `safe.directory=${directory.replaceAll('\\', '/')}`, '-c', 'commit.gpgsign=false', '-C', directory, ...args], { env: environment() })).stdout.trim(); }

const privateProject = 'private-sample';
const privateQuote = 'function confidentialSettlement(account, amount) {\n  const privateLedgerBalance = account.privateLedgerBalance + amount;\n  return commitPrivateLedger(account, privateLedgerBalance);\n}';
async function fixture(t: test.TestContext, includePrivate = true) {
  await mkdir(path.join(root, '.tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.tmp/public-export-test-'));
  const source = path.join(directory, 'source'); await mkdir(source);
  const write = async (file: string, content: string) => { const destination = path.join(source, file); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, content); };
  await git(source, 'init', '--initial-branch=main', '--template=');
  await git(source, 'config', 'user.name', 'Private fixture author');
  await git(source, 'config', 'user.email', 'private-author@example.invalid');
  await write('.gitignore', '.release/\n.cache/\nnode_modules/\nconfig/local.json\n');
  await write('README.md', '# Public fixture\n\n[record](docs/VALIDATION.md)\n');
  await write('docs/README.md', '# Documentation\n');
  await write('docs/en/README.md', '# Documentation\n');
  await write('docs/VALIDATION.md', 'PRIVATE_SOURCE_MARKER_OLD_HISTORY\n');
  await write('docs/en/VALIDATION.md', 'PRIVATE_SOURCE_MARKER_OLD_HISTORY\n');
  await write('architecture/models/combat-demo/model.json', '{"public":true}\n');
  if (includePrivate) {
    await write(`architecture/models/${privateProject}/model.json`, JSON.stringify({ projectId: privateProject, anchors: [{ quote: privateQuote, filePath: '/must-not-open-any-target-source' }] }));
    await write(`architecture/semantics/${privateProject}/definitions.json`, 'PRIVATE_SOURCE_MARKER_TARGET_DEFINITION\n');
    await write(`architecture/models/${privateProject}/README.md`, 'PRIVATE_SOURCE_MARKER_TARGET_TEXT\n');
    await write(`architecture/models/${privateProject}/README.en.md`, 'PRIVATE_SOURCE_MARKER_TARGET_TEXT\n');
  }
  for (const file of ['Tools/validate-hp.ts', 'Tools/validate-story.ts', 'packages/semantic-content/seed.ts', 'packages/semantic-content/src/seed.ts', 'packages/semantic-content/src/seed-explanations.ts', 'tests/demo-architecture.test.ts', 'tests/demo-semantic-flows.test.ts']) await write(file, 'export const portablePublicFixture = true;\n');
  await write('current.ts', 'export const current = 1;\n');
  await git(source, 'add', '--all');
  await git(source, 'commit', '--quiet', '-m', 'Private historical message');
  await git(source, 'tag', 'private-historical-tag');
  await git(source, 'remote', 'add', 'private-origin', 'https://example.invalid/private');
  t.after(async () => { assert.ok(directory.startsWith(path.join(root, '.tmp/public-export-test-'))); await rm(directory, { recursive: true, force: true }); });
  return { directory, source, write };
}

test('public export captures uncommitted files, omits private/runtime content, and creates only an anonymous root commit', async t => {
  const f = await fixture(t);
  await f.write('current.ts', 'export const current = 2;\n');
  await f.write('untracked.ts', 'export const added = true;\n');
  await f.write('PUBLIC-EXPORT.json', JSON.stringify({ originalPrivateMetadata: 'DO_NOT_COPY_PREVIOUS_MANIFEST' }));
  await f.write('.cache/local-secret.json', 'IGNORED_RUNTIME_MARKER\n');
  await f.write('node_modules/ignored.txt', 'IGNORED_DEPENDENCY_MARKER\n');
  await f.write('config/local.json', 'IGNORED_LOCAL_CONFIG_MARKER\n');
  const privateKey = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  for (const file of ['config/my-project.json', 'config/credentials.toml', '.env', '.env.production', 'nested/.env.local']) await f.write(file, privateKey + '\nPRIVATE_CONFIGURATION_MARKER\n');
  await f.write('config/projects.example.json', '{"projects":[]}\n');
  await f.write('.env.example', 'PUBLIC_PORT=4310\n');
  const globalIgnore = path.join(f.directory, 'global-ignore'); await writeFile(globalIgnore, 'global-private.txt\n');
  const globalConfig = path.join(f.directory, 'global-config'); await writeFile(globalConfig, `[core]\n\texcludesFile = ${globalIgnore.replaceAll('\\', '/')}\n`);
  await f.write('global-private.txt', 'GLOBAL_IGNORED_MARKER\n');
  const before = { head: await git(f.source, 'rev-parse', 'HEAD'), status: await git(f.source, 'status', '--porcelain'), config: await readFile(path.join(f.source, '.git/config'), 'utf8') };
  const oldIdentity = Object.fromEntries(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_CONFIG_GLOBAL'].map(name => [name, process.env[name]]));
  let result;
  try {
    process.env.GIT_AUTHOR_NAME = 'Inherited private name'; process.env.GIT_AUTHOR_EMAIL = 'inherited-author@example.invalid';
    process.env.GIT_COMMITTER_NAME = 'Inherited committer'; process.env.GIT_COMMITTER_EMAIL = 'inherited-committer@example.invalid';
    process.env.GIT_DIR = path.join(f.source, '.git');
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    result = await exportPublicSnapshot(f.source);
  } finally { for (const [name, value] of Object.entries(oldIdentity)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  assert.equal(result.status, 'candidate', JSON.stringify(result.blockers));
  const destination = result.destination as string;
  assert.equal(await readFile(path.join(destination, 'current.ts'), 'utf8'), 'export const current = 2;\n');
  assert.equal(await readFile(path.join(destination, 'untracked.ts'), 'utf8'), 'export const added = true;\n');
  for (const file of [`architecture/models/${privateProject}`, `architecture/semantics/${privateProject}`, '.cache', 'node_modules', 'config/local.json', 'config/my-project.json', 'config/credentials.toml', '.env', '.env.production', 'nested/.env.local', 'global-private.txt']) await assert.rejects(readFile(path.join(destination, file)), { code: 'ENOENT' });
  for (const file of ['Tools/validate-hp.ts', 'Tools/validate-story.ts', 'packages/semantic-content/seed.ts', 'packages/semantic-content/src/seed.ts', 'packages/semantic-content/src/seed-explanations.ts', 'tests/demo-architecture.test.ts', 'tests/demo-semantic-flows.test.ts']) assert.equal(await readFile(path.join(destination, file), 'utf8'), 'export const portablePublicFixture = true;\n');
  assert.equal(await readFile(path.join(destination, '.env.example'), 'utf8'), 'PUBLIC_PORT=4310\n');
  assert.equal(await readFile(path.join(destination, 'config/projects.example.json'), 'utf8'), '{"projects":[]}\n');
  assert.doesNotMatch(await readFile(path.join(destination, 'docs/VALIDATION.md'), 'utf8'), /PRIVATE_SOURCE_MARKER/);
  assert.ok(!(await git(destination, 'ls-files')).includes(privateProject), 'no excluded project identifier survives in a directory name');
  assert.equal(await git(destination, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal((await git(destination, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ').length, 1);
  assert.equal(await git(destination, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s'), `${PUBLIC_IDENTITY.name} <${PUBLIC_IDENTITY.email}>|${PUBLIC_IDENTITY.name} <${PUBLIC_IDENTITY.email}>|Initial public source snapshot`);
  assert.equal(await git(destination, 'config', '--local', 'user.name'), PUBLIC_IDENTITY.name);
  assert.equal(await git(destination, 'config', '--local', 'user.email'), PUBLIC_IDENTITY.email);
  assert.equal(await git(destination, 'remote'), ''); assert.equal(await git(destination, 'tag'), '');
  assert.equal((await git(destination, 'for-each-ref', '--format=%(refname)')).split('\n').length, 1);
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), before.head);
  assert.equal(await git(f.source, 'status', '--porcelain'), before.status);
  assert.equal(await readFile(path.join(f.source, '.git/config'), 'utf8'), before.config);
  assert.doesNotMatch(await readFile(path.join(destination, 'PUBLIC-EXPORT.json'), 'utf8'), new RegExp(before.head + '|private-author|Inherited|Private historical'));
  assert.doesNotMatch(await readFile(path.join(destination, 'PUBLIC-EXPORT.json'), 'utf8'), /DO_NOT_COPY_PREVIOUS_MANIFEST/);
});

test('private dependencies and missing documentation block export before a candidate is created', async t => {
  const f = await fixture(t);
  await f.write('generic.test.ts', 'const source = new URL(' + JSON.stringify(`./architecture/models/${privateProject}/model.json`) + ', import.meta.url);\n');
  const result = await exportPublicSnapshot(f.source);
  assert.equal(result.status, 'blocked'); assert.ok(result.blockers.some((item: { code: string }) => item.code === 'dependency'));
  await assert.rejects(readdir(path.join(f.source, '.release')), { code: 'ENOENT' });
  await f.write('generic.test.ts', 'export const independentFixture = true;\n');
  await f.write('README.md', '# Public\n\n[missing](not-present.md)\n');
  const plan = await planPublicExport(f.source);
  assert.ok(plan.blockers.some((item: { code: string }) => item.code === 'document-link'));
});

test('private project names and long source quotations cannot escape through ordinary public files', async t => {
  const f = await fixture(t);
  await f.write('leaked-source.ts', privateQuote);
  let result = await exportPublicSnapshot(f.source);
  assert.equal(result.status, 'blocked'); assert.ok(result.blockers.some((item: { code: string }) => item.code === 'private-source-quotation'));
  assert.ok(!JSON.stringify(result).includes('confidentialSettlement'), 'diagnostics contain no quotation');
  await f.write('leaked-source.ts', 'export const publicSource = true;\n');
  await f.write('leaked-value.json', JSON.stringify({ accidentallyCopiedSource: privateQuote }));
  result = await exportPublicSnapshot(f.source);
  assert.ok(result.blockers.some((item: { code: string }) => item.code === 'private-source-quotation'), 'JSON-escaped source is detected too');
  await f.write('leaked-value.json', '{}');
  await f.write('public-note.md', 'This operation requires PrivateSample as its initial data.\n');
  result = await exportPublicSnapshot(f.source);
  assert.ok(result.blockers.some((item: { code: string }) => item.code === 'private-project-identifier'), 'display spelling cannot bypass slug checks');
  await assert.rejects(readdir(path.join(f.source, '.release')), { code: 'ENOENT' });
});

test('independent public code exports and reexports without any private model directory', async t => {
  const f = await fixture(t, false);
  const first = await exportPublicSnapshot(f.source); assert.equal(first.status, 'candidate', JSON.stringify(first.blockers));
  const again = await exportPublicSnapshot(first.destination); assert.equal(again.status, 'candidate', JSON.stringify(again.blockers));
  assert.equal(await git(again.destination, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(await readFile(path.join(again.destination, 'packages/semantic-content/src/seed.ts'), 'utf8'), 'export const portablePublicFixture = true;\n');
});

test('short common statements are not privacy fingerprints and private-model audit budgets fail closed', async t => {
  const f = await fixture(t);
  const model = `architecture/models/${privateProject}/model.json`;
  await f.write(model, JSON.stringify({ projectId: privateProject, anchors: [{ quote: 'return amount;' }] }));
  await f.write('shared-statement.ts', 'export function publicValue(amount) { return amount; }\n');
  let plan = await planPublicExport(f.source);
  assert.equal(plan.blockers.length, 0, JSON.stringify(plan.blockers));
  await truncate(path.join(f.source, model), 5 * 1024 * 1024);
  plan = await planPublicExport(f.source);
  assert.ok(plan.blockers.some((item: { code: string }) => item.code === 'private-model-audit'));
  await assert.rejects(readdir(path.join(f.source, '.release')), { code: 'ENOENT' });
});

test('export rejects source links, release-directory junctions, and private keys without printing their contents', async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'payload.ts'), 'OUTSIDE_TARGET_MARKER\n');
  await symlink(outside, path.join(f.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await planPublicExport(f.source);
  assert.ok(plan.blockers.some((item: { code: string }) => item.code === 'linked-path'));
  await rm(path.join(f.source, 'linked'), { recursive: true });
  await symlink(outside, path.join(f.source, '.release'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(exportPublicSnapshot(f.source), /Release directory/);
  assert.deepEqual(await readdir(outside), ['payload.ts']);
  await rm(path.join(f.source, '.release'), { recursive: true });
  const secret = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  await f.write('untracked-key.txt', secret + '\nDO_NOT_PRINT_SECRET\n');
  const blocked = await exportPublicSnapshot(f.source);
  assert.equal(blocked.status, 'blocked'); assert.ok(blocked.blockers.some((item: { code: string }) => item.code === 'sensitive-content'));
  assert.doesNotMatch(JSON.stringify(blocked), /DO_NOT_PRINT_SECRET|OUTSIDE_TARGET_MARKER/);
});
