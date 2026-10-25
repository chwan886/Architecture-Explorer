import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// These files start a real analyzer, exercise filesystem security, or test the
// complete HTTP/stdio boundary. New tests default to fast instead of being lost.
const integrationTests = new Set([
  'tests/persistence-lock.test.ts',
  'tests/public-export.test.ts',
  'tests/analyzers.test.ts',
  'tests/architecture-api.test.ts',
  'tests/bridge-activity.test.ts',
  'tests/bridge-control.test.ts',
  'tests/bridge-query.test.ts',
  'tests/bridge-permissions.test.ts',
  'tests/csharp-bindings.test.ts',
  'tests/incremental-consistency.test.ts',
  'tests/indexer.test.ts',
  'tests/mcp-client.test.ts',
  'tests/mcp-stdio.test.ts',
  'tests/python-resolution.test.ts',
  'tests/semantic-api.test.ts',
  'tests/semantic-content.test.ts',
  'tests/semantic-seed.test.ts',
  'tests/story-acceptance.test.ts',
  'tests/semantic-model.test.ts',
]);

export function testGroup(file) {
  if (file.startsWith('apps/web/') || ['tests/semantic-app-navigation.test.ts', 'tests/vite-config.test.ts'].includes(file)) return 'web';
  return integrationTests.has(file) ? 'integration' : 'fast';
}

export function testFiles(root = process.cwd()) {
  const files = ['tests', 'apps/web/src'].flatMap(directory => readdirSync(path.join(root, directory), { recursive: true })
    .filter(file => file.endsWith('.test.ts'))
    .map(file => `${directory}/${file.replaceAll('\\', '/')}`)).sort();
  for (const file of integrationTests) if (!files.includes(file)) throw new Error(`Update the CI test manifest: ${file} is missing`);
  return files;
}

export function changedJobs(files) {
  const jobs = { fast: false, integration: false, web: false };
  for (const file of files) {
    if (file.startsWith('.github/') || ['.npmrc', '.gitattributes', 'package.json', 'pnpm-lock.yaml', 'toolchain.lock.json', 'global.json', 'tsconfig.json'].includes(file)) {
      return { fast: true, integration: true, web: true };
    }
    if (file.startsWith('apps/web/') || ['tests/semantic-app-navigation.test.ts', 'tests/vite-config.test.ts'].includes(file)) {
      jobs.fast = true; // TypeScript also checks the web sources.
      jobs.web = true;
    } else if (/^(packages|apps\/server|apps\/mcp|analyzers|tests|architecture|config|examples|Tools)\//.test(file)) {
      jobs.fast = true;
      jobs.integration = true;
      if (file.startsWith('packages/')) jobs.web = true;
    } else if (/\.(?:[cm]?js|tsx?|json|ya?ml)$/.test(file)) {
      return { fast: true, integration: true, web: true };
    }
  }
  return jobs;
}

function plan() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = event.pull_request?.base.sha ?? event.before;
  const head = process.env.GITHUB_SHA;
  let jobs = { fast: true, integration: true, web: true };
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' && /^[a-f0-9]{40}$/.test(base ?? '') && !/^0+$/.test(base)) {
    if (!/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('Invalid GitHub head SHA');
    const files = execFileSync('git', ['diff', '--name-only', '-z', base, head], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0').filter(Boolean);
    jobs = changedJobs(files);
    console.log('Changed paths:', files);
  }
  const lock = JSON.parse(readFileSync('toolchain.lock.json', 'utf8'));
  const versions = { node: lock.node.version, pnpm: lock.pnpm.version, dotnet: lock.dotnet.version };
  for (const [name, version] of Object.entries(versions)) if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid locked ${name} version`);
  const output = { ...jobs, ...versions };
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log('CI plan:', output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) plan();
