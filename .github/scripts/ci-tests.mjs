import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { testFiles, testGroup } from './ci-plan.mjs';

export function verifySummary(tap) {
  const counts = Object.fromEntries([...tap.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/gm)].map(([, key, value]) => [key, Number(value)]));
  if (!counts.tests || ['pass', 'fail', 'cancelled', 'skipped', 'todo'].some(key => !(key in counts))) throw new Error('Tests did not produce a complete TAP summary');
  if (counts.fail || counts.cancelled || counts.skipped || counts.todo) throw new Error(`CI requires every test to run and pass: ${JSON.stringify(counts)}`);
  return counts;
}

async function main() {
  const group = process.argv[2];
  if (!['fast', 'integration', 'web'].includes(group)) throw new Error('Usage: node .github/scripts/ci-tests.mjs fast|integration|web [--list]');
  const files = testFiles().filter(file => testGroup(file) === group);
  if (!files.length) throw new Error(`No tests assigned to ${group}`);
  console.log(`${group}: ${files.length} test files\n${files.join('\n')}`);
  if (process.argv.includes('--list')) return;
  for (const directory of ['.cache', '.tmp', 'test-results']) mkdirSync(directory, { recursive: true });
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--test', '--test-reporter=tap', ...files], {
    stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', PYTHONDONTWRITEBYTECODE: '1' },
  });
  let tap = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { tap += chunk; process.stdout.write(chunk); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (status, signal) => resolve(signal ? 1 : status ?? 1)); });
  writeFileSync(`test-results/ci-${group}.tap`, tap);
  if (code !== 0) { process.exitCode = code; return; }
  console.log('Verified:', verifySummary(tap));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
