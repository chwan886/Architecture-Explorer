import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { changedJobs, testFiles, testGroup } from './ci-plan.mjs';
import { verifySummary } from './ci-tests.mjs';
import { checkLinks, markdownDestinations } from './check-doc-links.mjs';

test('documentation-only changes do not allocate test runners', () => {
  assert.deepEqual(changedJobs(['README.md', 'docs/ARCHITECTURE.md']), { fast: false, integration: false, web: false });
});
test('shared dependencies and the workflow itself run every layer', () => {
  for (const file of ['packages/schema/src/index.ts', 'pnpm-lock.yaml', '.npmrc', '.gitattributes', '.github/workflows/ci.yml']) {
    assert.deepEqual(changedJobs([file]), { fast: true, integration: true, web: true });
  }
});
test('web and analyzer edits select the affected layers', () => {
  assert.deepEqual(changedJobs(['apps/web/src/App.tsx']), { fast: true, integration: false, web: true });
  assert.deepEqual(changedJobs(['analyzers/python/analyze.py']), { fast: true, integration: true, web: false });
  assert.deepEqual(changedJobs(['tests/semantic-app-navigation.test.ts']), { fast: true, integration: false, web: true });
  assert.deepEqual(changedJobs(['tests/vite-config.test.ts']), { fast: true, integration: false, web: true });
});
test('every discovered test has exactly one group and new tests run by default', () => {
  const files = testFiles();
  assert.ok(files.length > 0);
  assert.equal(new Set(files).size, files.length);
  for (const file of files) assert.ok(['fast', 'integration', 'web'].includes(testGroup(file)), file);
  assert.equal(testGroup('tests/future.test.ts'), 'fast');
  assert.equal(testGroup('tests/semantic-model.test.ts'), 'integration');
  assert.equal(testGroup('tests/semantic-content.test.ts'), 'integration');
  assert.equal(testGroup('tests/semantic-seed.test.ts'), 'integration');
  assert.equal(testGroup('tests/story-acceptance.test.ts'), 'integration');
  assert.equal(testGroup('tests/persistence-lock.test.ts'), 'integration');
  assert.equal(testGroup('tests/bridge-permissions.test.ts'), 'integration');
  assert.equal(testGroup('tests/public-export.test.ts'), 'integration');
  assert.equal(testGroup('tests/vite-config.test.ts'), 'web');
});
test('skipped, pending, failed, cancelled and missing test runs cannot pass CI', () => {
  const summary = '# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(verifySummary(summary).tests, 3);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.throws(() => verifySummary(summary.replace(`# ${key} 0`, `# ${key} 1`)));
  assert.throws(() => verifySummary(''));
  assert.throws(() => verifySummary(summary.replace('# tests 3', '# tests 0')));
});

test('the existing protected check context forwards every CI gate outcome without accepting skipped or missing gates', () => {
  const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  const compatibility = workflow.split(/^  protected-check:\r?$/m)[1];
  assert.ok(compatibility, 'the required status context must always be emitted');
  assert.match(compatibility, /^    name: Tool \/ typecheck, tests and builds\r?$/m);
  assert.match(compatibility, /^    if: always\(\)\r?$/m);
  assert.match(compatibility, /^    needs: gate\r?$/m);
  assert.match(compatibility, /CI_GATE_RESULT: \$\{\{ needs\.gate\.result \}\}/);
  const command = compatibility.match(/^        run: node -e "([^"\r\n]+)"\r?$/m)?.[1];
  assert.ok(command, 'compatibility check must use the evaluated gate result');
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const processResult = spawnSync(process.execPath, ['-e', command], { env: { ...process.env, CI_GATE_RESULT: result }, encoding: 'utf8' });
    assert.ifError(processResult.error);
    assert.equal(processResult.status, result === 'success' ? 0 : 1, `gate=${JSON.stringify(result)}`);
  }
});

test('documentation links skip code, anchors, external protocols and comments', () => {
  const source = [
    '```md', '[example](missing.md)', '```',
    '~~~~', '![example](missing.png)', '~~~~',
    '````', '```', '[still code](missing.md)', '````',
    '`[inline](missing.md)` and ``[nested](missing.md)`text``',
    '<!-- [hidden](missing.md) -->',
    '[anchor](#intro) [web](https://example.com/file.md) [mail](mailto:test@example.com)',
    '[app](codex://review) ![remote](//example.com/image.png)',
  ].join('\n');
  const links = markdownDestinations(source);
  assert.equal(links.length, 5);
  assert.deepEqual(checkLinks(process.cwd(), 'docs/README.md', source), { checked: 0, errors: [] });
});

test('documentation links resolve images, references, encoded paths and nested labels', () => {
  const base = path.resolve('.tmp');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'ci-doc-links-'));
  try {
    mkdirSync(path.join(directory, 'docs'));
    mkdirSync(path.join(directory, 'images'));
    for (const file of ['guide file.md', 'guide(draft).md', 'café.md', 'images/flow chart.png']) writeFileSync(path.join(directory, file), 'fixture');
    const source = [
      '[guide](<../guide file.md#intro>)',
      '![diagram](../images/flow%20chart.png)',
      '[draft](../guide\\(draft\\).md "title")',
      '[encoded](../caf%C3%A9.md?raw=1#intro)',
      '[root](/guide%20file.md)',
      '[nested [label]](../guide%20file.md)',
      '[manual]: <../guide file.md> "Reference title"',
      '<img src="../images/flow%20chart.png" alt="fixture">',
    ].join('\n');
    assert.deepEqual(checkLinks(directory, 'docs/README.md', source), { checked: 8, errors: [] });
    const broken = checkLinks(directory, 'docs/README.md', '[missing](missing.md)\n[invalid](bad%ZZ.md)\n[escape](../../outside.md)');
    assert.equal(broken.errors.length, 3);
    assert.deepEqual(broken.errors.map(error => error.line), [1, 2, 3]);
    assert.match(broken.errors[0].reason, /does not exist/);
    assert.match(broken.errors[1].reason, /encoding/);
    assert.match(broken.errors[2].reason, /escapes/);
  } finally {
    assert.ok(directory.startsWith(base + path.sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
