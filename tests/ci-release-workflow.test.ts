import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// A deliberately narrow structural reader for this reviewed workflow shape, not a permissive YAML interpreter.
// Exact indentation and duplicate-field rejection keep a matching comment, script literal or another job from satisfying a gate.
type Lines = string[];
function lines(text: string): Lines { assert.ok(!text.includes('\t')); return text.replaceAll('\r\n', '\n').split('\n'); }
function mapping(source: Lines, indent: number): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of source) {
    const found = new RegExp(`^ {${indent}}([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$`).exec(line);
    if (!found) continue;
    assert.ok(!Object.hasOwn(result, found[1]), `Duplicate contract field ${found[1]}`);
    result[found[1]] = found[2] ?? '';
  }
  return result;
}
function section(source: Lines, indent: number, key: string): Lines {
  const matches = source.flatMap((line, index) => line === ' '.repeat(indent) + key + ':' ? [index] : []);
  assert.equal(matches.length, 1, `Exactly one ${key} section is required`);
  const begin = matches[0] + 1;
  let end = begin;
  while (end < source.length && (!source[end].trim() || source[end].search(/\S/) > indent)) end++;
  return source.slice(begin, end);
}
function steps(job: Lines) {
  const body = section(job, 4, 'steps'), starts = body.flatMap((line, index) => /^ {6}- /.test(line) ? [index] : []);
  return starts.map((begin, index) => {
    const source = body.slice(begin, starts[index + 1] ?? body.length);
    source[0] = '        ' + source[0].slice(8);
    const fields = mapping(source, 8);
    const child = (key: string) => mapping(section(source, 8, key), 10);
    const run = () => {
      assert.ok(Object.hasOwn(fields, 'run'));
      if (fields.run !== '|') { assert.ok(fields.run && fields.run !== '>'); return fields.run; }
      const start = source.findIndex(line => line === '        run: |') + 1;
      return source.slice(start).map(line => { assert.ok(!line.trim() || line.startsWith('          ')); return line.slice(10); }).join('\n').trim();
    };
    return { source, fields, child, run };
  });
}
type Step = ReturnType<typeof steps>[number];
function byId(list: Step[], id: string) { const found = list.filter(step => step.fields.id === id); assert.equal(found.length, 1, `Step ${id}`); return found[0]; }
function clauses(value: string) { assert.ok(value && !value.includes('||')); return value.split(/\s*&&\s*/).sort(); }
function exactClauses(value: string, expected: string[]) { assert.deepEqual(clauses(value), [...expected].sort()); }
function literal(source: Lines, indent: number, key: string): string {
  const begin = source.indexOf(' '.repeat(indent) + key + ': |') + 1; assert.ok(begin > 0);
  let end = begin;
  while (end < source.length && (!source[end].trim() || source[end].search(/\S/) > indent)) end++;
  return source.slice(begin, end).map(line => { assert.ok(!line.trim() || line.startsWith(' '.repeat(indent + 2))); return line.slice(indent + 2); }).join('\n').trim();
}
const inputMap = { CI_CONTRACT_VERSION: 'contract_version', CI_SOURCE_REPO: 'source_repo', CI_SOURCE_REF: 'source_ref', CI_SOURCE_SHA: 'source_sha',
  CI_SOURCE_RUN_ID: 'source_run_id', CI_SOURCE_RUN_ATTEMPT: 'source_run_attempt', CI_SOURCE_RUN_URL: 'source_run_url' };
const inputExpressions = Object.fromEntries(Object.entries(inputMap).map(([env, input]) => [env, '${{ inputs.' + input + ' }}']));
const actions = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-python': '5fda3b95a4ea91299a34e894583c3862153e4b97',
  'actions/create-github-app-token': '64ab729a6294000f5aa4a4bc0b73d1f32bc45510',
  'actions/upload-artifact': 'cf430e030ddbb5b0abf93d22962f4752f3646cd9',
  'actions/download-artifact': '9000827ccba6bdab643e8b6fd33ac0654aef8333',
};
function action(step: Step) { return step.fields.uses?.split(' #')[0]; }
function model(text: string) {
  const source = lines(text), jobs = section(source, 0, 'jobs'), producer = section(jobs, 2, 'build-index'), draft = section(jobs, 2, 'draft-release');
  return { source, jobs, producer, draft, producerFields: mapping(producer, 4), draftFields: mapping(draft, 4), buildSteps: steps(producer), draftSteps: steps(draft) };
}
function isolation(text: string) {
  const m = model(text);
  assert.deepEqual(mapping(section(m.source, 0, 'permissions'), 2), { contents: 'read' });
  assert.ok(!Object.hasOwn(m.producerFields, 'permissions'), 'The producer must not inherit publisher write permissions');
  assert.deepEqual(mapping(section(m.draft, 4, 'permissions'), 6), { contents: 'write', actions: 'read' });
  exactClauses(m.draftFields.if, ["needs.build-index.result == 'success'", "github.event_name == 'workflow_dispatch'",
    "github.repository == 'chwan886/Architecture-Explorer'", "github.ref == 'refs/heads/main'", 'github.event.repository.private']);
  assert.equal(m.draftFields.needs, 'build-index'); assert.equal(m.draftFields.environment, 'architecture-delivery');
  assert.equal(m.draftFields['runs-on'], 'windows-2025'); assert.equal(m.draftFields['timeout-minutes'], '20');
  exactClauses(m.producerFields.if, ["github.repository == 'chwan886/Architecture-Explorer'", "github.ref == 'refs/heads/main'"]);
  assert.equal(m.producerFields.environment, 'architecture-delivery');
  assert.deepEqual(mapping(section(m.draft, 4, 'concurrency'), 6), {
    group: 'private-tool-draft-${{ github.run_id }}-${{ needs.build-index.outputs.producer_attempt }}', 'cancel-in-progress': 'false',
  });
  assert.doesNotMatch(m.draft.join('\n'), /secrets\.|GAME_READ_TOKEN|GAME_READ_APP_|DEV_APP|create-github-app-token|continue-on-error|pull_request_target/);
  assert.ok(!Object.hasOwn(m.draftFields, 'env'), 'The write token may not leak into bootstrap, checkout or downloads through job env');
  assert.ok(m.draftSteps.every(step => step.fields['continue-on-error'] === undefined));
}
function frozenInputs(text: string) {
  const m = model(text), output = mapping(section(m.producer, 4, 'outputs'), 6), expected: Record<string, string> = {};
  for (const name of ['producer_run_id', 'producer_attempt', 'producer_tool_sha']) expected[name] = '${{ steps.release-inputs.outputs.' + name + ' }}';
  for (const kind of ['tool', 'index', 'checks']) for (const [suffix, actionOutput] of [['id', 'id'], ['digest', 'digest']]) {
    expected[`${kind}_artifact_${suffix}`] = '${{ steps.' + kind + '-artifact.outputs.artifact-' + actionOutput + ' }}';
  }
  assert.deepEqual(output, expected);
  const freeze = byId(m.buildSteps, 'release-inputs');
  exactClauses(freeze.fields.if, ['success()', "steps.package-runtime.outcome == 'success'", "steps.snapshot.outcome == 'success'"]);
  assert.equal(m.buildSteps.at(-1), freeze, 'Freeze follows every producer upload and outcome step');
  assert.deepEqual(freeze.child('env'), Object.fromEntries(['tool', 'index', 'checks'].flatMap(kind => [
    [kind.toUpperCase() + '_ID', '${{ steps.' + kind + '-artifact.outputs.artifact-id }}'],
    [kind.toUpperCase() + '_DIGEST', '${{ steps.' + kind + '-artifact.outputs.artifact-digest }}'],
  ])));
  const script = freeze.run();
  assert.ok(script.includes("foreach ($kind in @('TOOL','INDEX','CHECKS'))"));
  assert.match(script, /GetEnvironmentVariable\(\$kind\+'_ID'\) -cnotmatch '\^\[1-9\]\[0-9\]\*\$'\) \{ throw /);
  assert.match(script, /GetEnvironmentVariable\(\$kind\+'_DIGEST'\) -cnotmatch '\^\[a-f0-9\]\{64\}\$'\) \{ throw /);
  for (const [key, source] of [['producer_run_id', 'GITHUB_RUN_ID'], ['producer_attempt', 'GITHUB_RUN_ATTEMPT'], ['producer_tool_sha', 'GITHUB_SHA']]) {
    assert.ok(script.includes(`'${key}='+$env:${source} | Add-Content $env:GITHUB_OUTPUT`));
  }
  const entry = byId(m.draftSteps, 'draft'), env = entry.child('env');
  assert.equal(env.BUILD_RESULT, '${{ needs.build-index.result }}');
  for (const key of Object.keys(expected)) assert.equal(env[key.toUpperCase()], '${{ needs.build-index.outputs.' + key + ' }}');
  assert.notEqual(env.PRODUCER_ATTEMPT, '${{ github.run_attempt }}', 'A publisher-only retry must retain the successful producer attempt');
}
function exactDispatch(text: string) {
  const m = model(text), dispatch = section(section(m.source, 0, 'on'), 2, 'workflow_dispatch'), inputs = section(dispatch, 4, 'inputs');
  assert.deepEqual(Object.keys(mapping(section(m.source, 0, 'on'), 2)), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(mapping(inputs, 6)).sort(), Object.values(inputMap).sort());
  for (const name of Object.values(inputMap)) {
    const definition = mapping(section(inputs, 6, name), 8);
    assert.equal(definition.required, 'true'); assert.equal(definition.type, 'string');
  }
  assert.deepEqual(mapping(section(m.producer, 4, 'env'), 6), inputExpressions);
  const entryEnv = byId(m.draftSteps, 'draft').child('env');
  assert.deepEqual(Object.fromEntries(Object.entries(entryEnv).filter(([key]) => key.startsWith('CI_'))), inputExpressions);
  assert.equal(entryEnv.RELEASE_PUBLISH_TOKEN, '${{ github.token }}');
  assert.equal(entryEnv.INDEX_ACCESS_APPROVED, '${{ vars.INDEX_ACCESS_APPROVED }}');
  assert.equal(entryEnv.RULE_BYPASS_REVIEWED, '${{ vars.RULE_BYPASS_REVIEWED }}');
}
function pinnedActionsAndRawZips(text: string) {
  const m = model(text);
  for (const step of [...m.buildSteps, ...m.draftSteps].filter(step => step.fields.uses)) {
    const [name, pin] = action(step)!.split('@');
    assert.ok(Object.hasOwn(actions, name), `Unreviewed action ${name}`);
    assert.equal(pin, actions[name as keyof typeof actions]); assert.match(pin, /^[a-f0-9]{40}$/);
  }
  const checkout = m.draftSteps.filter(step => action(step)?.startsWith('actions/checkout@'));
  assert.equal(checkout.length, 1); assert.deepEqual(checkout[0].child('with'), { ref: '${{ github.sha }}', path: 'tool', 'persist-credentials': 'false' });
  const downloads = m.draftSteps.filter(step => action(step)?.startsWith('actions/download-artifact@'));
  assert.equal(downloads.length, 3);
  const seen = new Set<string>();
  for (const step of downloads) {
    const settings = step.child('with'), kind = /^tool\/\.ci-release\/raw\/(tool|index|checks)$/.exec(settings.path)?.[1];
    assert.ok(kind && !seen.has(kind)); seen.add(kind);
    assert.deepEqual(settings, { 'artifact-ids': '${{ needs.build-index.outputs.' + kind + '_artifact_id }}', 'github-token': '${{ github.token }}',
      repository: 'chwan886/Architecture-Explorer', 'run-id': '${{ needs.build-index.outputs.producer_run_id }}',
      path: `tool/.ci-release/raw/${kind}`, 'skip-decompress': 'true', 'digest-mismatch': 'error' });
  }
  assert.deepEqual([...seen].sort(), ['checks', 'index', 'tool']);
}
function trustedNodeOnly(text: string, runtime: string, lock: { node: { version: string; url: string; sha256: string } }) {
  const m = model(text), bootstrap = byId(m.draftSteps, 'runtime'), entry = byId(m.draftSteps, 'draft');
  assert.equal(bootstrap.run(), './Tools/ci-release-runtime.ps1'); assert.ok(!Object.hasOwn(bootstrap.fields, 'env'));
  assert.deepEqual(m.draftSteps.filter(step => Object.hasOwn(step.fields, 'run')), [bootstrap, entry]);
  assert.equal(entry.run(), "& '${{ steps.runtime.outputs.node }}' Tools/ci-release-draft.ts\nif ($LASTEXITCODE -ne 0) { throw 'Private tool Release draft validation or upload failed' }");
  assert.doesNotMatch(m.draftSteps.map(step => step.fields.run ? step.run() : '').join('\n'), /tsx|node_modules|npm|pnpm|dotnet|python|ci-check|ci-package|\.ci-release\/raw/);
  assert.match(lock.node.version, /^24\.[0-9]+\.[0-9]+$/); assert.match(lock.node.sha256, /^[a-f0-9]{64}$/);
  assert.equal(lock.node.url, `https://nodejs.org/dist/v${lock.node.version}/node-v${lock.node.version}-win-x64.zip`);
  const executable = lines(runtime).filter(line => !line.trim().startsWith('#')).join('\n');
  assert.ok(executable.includes("'toolchain.lock.json'"));
  assert.ok(executable.includes("$expectedUrl='https://nodejs.org/dist/v'+$lock.node.version+'/node-v'+$lock.node.version+'-win-x64.zip'"));
  assert.ok(executable.includes('if($lock.node.url -cne $expectedUrl){throw'));
  assert.match(executable, /Invoke-WebRequest -Uri \$expectedUrl -OutFile \$archive -MaximumRedirection 0 -TimeoutSec 120/);
  const pin = executable.indexOf('if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $lock.node.sha256){throw');
  const expand = executable.indexOf('Expand-Archive -LiteralPath $archive -DestinationPath $directory');
  const invoke = executable.indexOf('$version=& $node --version');
  assert.ok(pin >= 0 && expand > pin && invoke > expand, 'Verify the official archive before extraction or executing Node');
  assert.ok(executable.includes("$version -cne ('v'+$lock.node.version)"));
  assert.ok(executable.includes('$env:NODE_OPTIONS=$null') && executable.includes('$env:NODE_PATH=$null'));
  assert.doesNotMatch(executable, /RELEASE_PUBLISH_TOKEN|GITHUB_TOKEN|node_modules|tsx|npm|pnpm|dotnet|python|Invoke-Expression|Start-Process/);
  assert.equal((executable.match(/& \$node/g) ?? []).length, 1, 'Bootstrap executes only the pinned Node version probe');
}
function producerAndEvidenceGates(text: string) {
  const m = model(text), check = byId(m.buildSteps, 'checks'), packaged = byId(m.buildSteps, 'package'), runtime = byId(m.buildSteps, 'package-runtime'),
    authorize = byId(m.buildSteps, 'authorize'), snapshot = byId(m.buildSteps, 'snapshot');
  assert.equal(check.run(), './Tools/ci-check.ps1 -Prepare'); assert.equal(packaged.run(), './Tools/ci-package.ps1');
  for (const step of [check, packaged, runtime, authorize, snapshot]) assert.ok(!Object.hasOwn(step.fields, 'if') && !Object.hasOwn(step.fields, 'continue-on-error'));
  assert.ok(m.buildSteps.indexOf(runtime) > m.buildSteps.indexOf(packaged) && m.buildSteps.indexOf(authorize) > m.buildSteps.indexOf(runtime) &&
    m.buildSteps.indexOf(snapshot) > m.buildSteps.indexOf(authorize));
  assert.ok(runtime.run().includes('Tools/ci-package-smoke.ts')); assert.ok(runtime.run().includes("if ($LASTEXITCODE -ne 0) { throw 'Packaged runtime verification failed' }"));
  assert.ok(snapshot.run().includes('Tools/ci-snapshot.ts')); assert.ok(snapshot.run().includes("$env:CI_GAME_ROOT=Join-Path $env:GITHUB_WORKSPACE 'game'"));
  assert.ok(snapshot.run().includes("if ($LASTEXITCODE -ne 0) { throw 'Game snapshot failed; rerun after resolving diagnostics' }"));
  const gameCheckout = m.buildSteps.find(step => step.fields.uses && step.child('with').repository === 'chwan886/GameDemo02');
  assert.ok(gameCheckout); assert.equal(gameCheckout.child('with').ref, '${{ inputs.source_sha }}'); assert.equal(gameCheckout.child('with')['persist-credentials'], 'false');
  const tool = byId(m.buildSteps, 'tool-artifact'), index = byId(m.buildSteps, 'index-artifact'), checks = byId(m.buildSteps, 'checks-artifact');
  exactClauses(tool.fields.if, ['always()', "steps.package.outcome == 'success'", "steps.package-runtime.outcome == 'success'", "steps.authorize.outputs.index_access == 'allowed'"]);
  exactClauses(index.fields.if, ['always()', "steps.authorize.outputs.index_access == 'allowed'"]);
  exactClauses(checks.fields.if, ['always()', 'github.event.repository.private']);
  assert.equal(tool.child('with').path, '${{ steps.package.outputs.path }}'); assert.equal(tool.child('with')['include-hidden-files'], 'true');
  for (const artifact of [tool, index, checks]) {
    assert.equal(artifact.child('with').overwrite, undefined, 'Producer retries must never replace an earlier artifact');
    assert.equal(artifact.child('with')['retention-days'], '14');
  }
  assert.equal(tool.child('with').name, 'tool-build-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.equal(checks.child('with').name, 'tool-checks-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.equal(index.child('with').name, 'game-index-${{ inputs.source_sha }}-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.equal(checks.child('with').path, 'tool/test-results/');
  assert.equal(tool.child('with')['if-no-files-found'], 'error'); assert.equal(index.child('with')['if-no-files-found'], 'error');
  assert.equal(index.child('with').path, '|');
  assert.equal(literal(section(index.source, 8, 'with'), 10, 'path'), 'tool/.ci-output/*/*/index-evidence/\ntool/.ci-output/authorization/authorization.json');
  const report = m.buildSteps.find(step => step.fields.name === 'Record independent build and index outcomes'); assert.ok(report);
  assert.equal(report.fields.if, 'always()'); assert.equal(report.child('env').PACKAGE_RUNTIME_OUTCOME, '${{ steps.package-runtime.outcome }}');
  assert.ok(report.run().includes("$env:PACKAGE_RUNTIME_OUTCOME -eq 'success'"));
  const receipt = m.draftSteps.filter(step => action(step)?.startsWith('actions/upload-artifact@'));
  assert.equal(receipt.length, 1); exactClauses(receipt[0].fields.if, ['always()', 'github.event.repository.private']);
  assert.deepEqual(receipt[0].child('with'), { name: 'release-draft-receipt-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
    path: 'tool/.ci-release/receipts/*.json', 'include-hidden-files': 'true', 'retention-days': '14', 'if-no-files-found': 'warn' });
}

const root = process.cwd();
const workflow = await readFile(path.join(root, '.github/workflows/game-index.yml'), 'utf8');
const bootstrap = await readFile(path.join(root, 'Tools/ci-release-runtime.ps1'), 'utf8');
const lock = JSON.parse(await readFile(path.join(root, 'toolchain.lock.json'), 'utf8'));
test('draft job accepts only successful private main delivery with its own minimal write token and non-cancelling producer lock', () => isolation(workflow));
test('producer success freezes three exact artifact IDs/digests and its original run/attempt/SHA', () => frozenInputs(workflow));
test('all seven dispatch strings reach producer and publisher without PR/review claims or script interpolation', () => exactDispatch(workflow));
test('official Actions remain pinned and all three producer artifacts are downloaded as digest-checked raw ZIPs', () => pinnedActionsAndRawZips(workflow));
test('write job restores only the locked official Node runtime and runs trusted source without dependency or target execution', () => trustedNodeOnly(workflow, bootstrap, lock));
test('runtime cleanup, accurate SHA scan and private evidence upload gates remain intact; publisher retains only sanitized receipts', () => producerAndEvidenceGates(workflow));

const validate = (text: string) => { isolation(text); frozenInputs(text); exactDispatch(text); pinnedActionsAndRawZips(text); trustedNodeOnly(text, bootstrap, lock); producerAndEvidenceGates(text); };
for (const [name, before, after] of [
  ['publisher accepts failed producer', "if: needs.build-index.result == 'success'", "if: needs.build-index.result != 'cancelled'"],
  ['publisher loses private condition', " && github.event.repository.private\n    runs-on: windows-2025\n    timeout-minutes: 20", "\n    runs-on: windows-2025\n    timeout-minutes: 20"],
  ['write permission leaks globally', 'permissions:\n  contents: read', 'permissions:\n  contents: write'],
  ['publisher adds workflow write', '      actions: read\n    concurrency:', '      actions: read\n      workflows: write\n    concurrency:'],
  ['download falls back to mutable name', '          artifact-ids: ${{ needs.build-index.outputs.tool_artifact_id }}', '          name: tool-latest'],
  ['download extracts untrusted code', '          skip-decompress: true', '          skip-decompress: false'],
  ['digest mismatch becomes warning', '          digest-mismatch: error', '          digest-mismatch: warn'],
  ['Action tag replaces fixed SHA', 'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333', 'actions/download-artifact@v8'],
  ['retry rewrites producer attempt', '          PRODUCER_ATTEMPT: ${{ needs.build-index.outputs.producer_attempt }}', '          PRODUCER_ATTEMPT: ${{ github.run_attempt }}'],
  ['source attempt input is swapped', '          CI_SOURCE_RUN_ATTEMPT: ${{ inputs.source_run_attempt }}', '          CI_SOURCE_RUN_ATTEMPT: ${{ inputs.source_run_id }}'],
  ['package upload ignores runtime cleanup', " && steps.package-runtime.outcome == 'success' && steps.authorize.outputs.index_access", " && steps.authorize.outputs.index_access"],
  ['game checkout silently tracks latest main', '          ref: ${{ inputs.source_sha }}', '          ref: refs/heads/main'],
  ['receiver gains a PR-target trigger', 'on:\n  workflow_dispatch:', 'on:\n  pull_request_target:\n  workflow_dispatch:'],
  ['index upload adds local configuration', '            tool/.ci-output/authorization/authorization.json', '            tool/.ci-output/authorization/authorization.json\n            tool/config/local.json'],
] as const) test(`security contract rejects regression: ${name}`, () => {
  const canonical = workflow.replaceAll('\r\n', '\n'); assert.ok(canonical.includes(before), `Mutation anchor missing: ${name}`);
  assert.throws(() => validate(canonical.replace(before, after)), name);
});
