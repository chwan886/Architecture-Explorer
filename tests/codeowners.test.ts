import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const document = await readFile(new URL('../.github/CODEOWNERS', import.meta.url), 'utf8');
const rules = document.split(/\r?\n/).map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
  .map(line => {
    const fields = line.split(/\s+/);
    assert.equal(fields.length, 2, `Unexpected CODEOWNERS rule: ${line}`);
    const [pattern, owner] = fields;
    // This policy deliberately uses only rooted literal files and directory prefixes.
    // Fail instead of pretending this small policy check implements GitHub's full glob grammar.
    assert.match(pattern, /^\/[A-Za-z0-9_./-]+$/, `Use an explicit root path: ${line}`);
    assert.ok(!pattern.includes('//') && !pattern.split('/').includes('..'), `Unsafe rule: ${line}`);
    assert.equal(owner, '@chwan886', 'Only the user-confirmed owner may be assigned');
    return { pattern, owner };
  });

function ownerFor(file: string): string | undefined {
  let owner: string | undefined;
  for (const rule of rules) {
    const target = rule.pattern.slice(1);
    if (rule.pattern.endsWith('/') ? file.startsWith(target) : file === target) owner = rule.owner;
  }
  return owner;
}

test('tool owner policy uses valid explicit paths and protects its own future changes', () => {
  assert.ok(rules.length > 0);
  assert.ok(Buffer.byteLength(document) < 3 * 1024 * 1024, 'GitHub ignores oversized CODEOWNERS files');
  assert.equal(new Set(rules.map(rule => rule.pattern)).size, rules.length, 'Duplicate rules can hide a later owner replacement');
  for (const file of ['.github/CODEOWNERS', '.github/workflows/tool-ci.yml', '.github/workflows/game-index.yml', '.github/workflows/future-gate.yml']) {
    assert.equal(ownerFor(file), '@chwan886', file);
  }
});

test('delivery, supply chain, source access, analyzer, protocol and excerpt changes require the confirmed owner', () => {
  const sensitive = [
    'Tools/ci-authorize.ts', 'Tools/ci-package.ps1', 'Tools/ci-references.ps1', 'Tools/ci-snapshot.ts', 'Tools/explorer.ps1',
    'Start-Explorer.cmd', '.gitignore', '.gitattributes', '.npmrc', '.python-version',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'toolchain.lock.json', 'global.json', 'tsconfig.json', 'apps/web/vite.config.ts',
    'config/projects.example.json', 'analyzers/NuGet.Config', 'analyzers/csharp/packages.lock.json', 'analyzers/python/analyze.py',
    'packages/schema/index.schema.json', 'packages/indexer/src/security.ts', 'packages/indexer/src/workers.ts',
    'packages/control-protocol/src/types.ts', 'packages/semantic-content/src/seed-explanations.ts',
    'apps/server/src/server.ts', 'apps/server/src/bridge-auth.ts', 'apps/server/src/semantic-store.ts', 'apps/mcp/src/client.ts',
    'apps/web/src/control/useLinkController.ts', 'apps/web/src/control/LinkController.test.ts',
    'tests/codeowners.test.ts', 'tests/ci-authorize.test.ts', 'tests/indexer.test.ts',
    'architecture/models/game-demo-02/model.json', 'architecture/semantics/game-demo-02/definitions.json',
    'apps/web/src/delivery/model.ts', 'apps/web/src/delivery/DeliveryWorkspace.tsx', 'apps/web/src/delivery.test.ts',
    'docs/CONTRACT.md', 'docs/SEMANTIC-CONTRACT.md', 'docs/MCP-CONTRACT.md', 'docs/DEVELOPMENT-DELIVERY.md',
    'docs/UNITY-REFERENCE-SUPPLY.md', 'docs/DEV-APP-SETUP.md', 'docs/DELIVERY-VALIDATION.md', 'docs/GAME-EVIDENCE-REVIEW.md',
    'docs/ci/game-trigger.patch', 'docs/ReviewEvidence/receiver-handoff-v1.txt', 'docs/evidence/delivery/package-smoke.json',
  ];
  for (const file of sensitive) assert.equal(ownerFor(file), '@chwan886', file);
});

test('ordinary UI and unrelated paths do not acquire a blanket owner gate', () => {
  for (const file of [
    'apps/web/src/App.tsx', 'apps/web/src/GraphCanvas.tsx', 'apps/web/src/styles.css',
    'apps/web/src/architecture/ArchitectureWorkspace.tsx', 'apps/web/src/delivery/delivery.css',
    'README.md', 'docs/ROADMAP.md', 'future-feature/example.ts',
    'examples/.github/workflows/example.yml', 'apps/serverish/example.ts', 'tests-copy/example.ts',
    'Apps/server/src/server.ts',
  ]) assert.equal(ownerFor(file), undefined, file);
});
