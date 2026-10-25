import path from 'node:path';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_IDENTITY = { name: 'Architecture Explorer contributors', email: 'contributors@example.invalid' };
const historicalDocs = new Set([
  'VALIDATION.md', 'SEMANTIC-VALIDATION.md', 'MCP-VALIDATION.md',
  'EVIDENCE-REVIEW-VALIDATION.md', 'GAME-EVIDENCE-REVIEW.md',
  'OPEN-SOURCE-REVIEW.md', 'PROGRESS-BUBBLE.md', 'CODEX-CONFIG-PENDING.diff',
  'CONTRACT.md', 'SEMANTIC-CONTRACT.md', 'MCP-CONTRACT.md', 'ARCHITECTURE-UPGRADE-CONTRACT.md',
].map(file => file.toLowerCase()));
const PRIVATE_MODEL_FILE_LIMIT = 4 * 1024 * 1024;
const PRIVATE_MODEL_TOTAL_LIMIT = 16 * 1024 * 1024;
const PRIVATE_QUOTE_LIMIT = 20_000;
const PRIVATE_QUOTE_TEXT_LIMIT = 2 * 1024 * 1024;
const runtimeSegments = new Set(['.git', '.release', 'node_modules', '.cache', '.tools', '.tmp', 'test-results', 'dist', 'bin', 'obj', '__pycache__']);
const slash = value => value.replaceAll('\\', '/');
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (root, value) => { const relative = path.relative(canonical(root), canonical(value)); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const safeRelative = value => typeof value === 'string' && value.length > 0 && !/[\0\\:]/.test(value) && !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const runtimeReference = target => target === 'config/local.json' || target.split('/').some(part => runtimeSegments.has(part.toLowerCase()));

function gitEnvironment(extra = {}, isolated = true) {
  // Do not inherit a caller's repository/index, identity, hooks, or trace files.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const configuration = isolated
    ? { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
    : Object.fromEntries(['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return { ...environment, ...configuration, ...extra };
}
async function git(root, args, extra = {}, isolated = true) {
  const result = await execute('git', ['--no-optional-locks', '-c', `safe.directory=${slash(root)}`, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', '-C', root, ...args], { env: gitEnvironment(extra, isolated), maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}

function actionFor(file) {
  if (file === 'PUBLIC-EXPORT.json') return 'exclude'; // Regenerate metadata when exporting a publication copy again.
  const normalized = file.toLowerCase();
  if (normalized.split('/').some(part => runtimeSegments.has(part)) || /\.(?:log|py[co])$/.test(normalized) || normalized === 'config/local.json') return 'exclude';
  const basename = path.posix.basename(normalized);
  if ((basename === '.env' || basename.startsWith('.env.')) && basename !== '.env.example') return 'exclude';
  if (normalized.startsWith('config/') && !['config/demo.json', 'config/projects.example.json', 'config/codex-mcp.example.toml'].includes(normalized) && !/^config\/[^/]+\.example\.[^/]+$/.test(normalized)) return 'exclude';
  const model = /^architecture\/(models|semantics)\/([^/]+)\/(.+)$/.exec(normalized);
  if (model && model[2] !== 'combat-demo') return 'exclude';
  if (/^docs\/(?:en\/)?[^/]+$/.test(normalized) && historicalDocs.has(path.posix.basename(normalized))) return 'stub';
  return 'copy';
}

function privacyStub(file) {
  const english = file.startsWith('docs/en/') || file.endsWith('.en.md');
  if (file.endsWith('.diff')) return Buffer.from('Historical local configuration material is omitted from this public snapshot.\n');
  const isModel = file.startsWith('architecture/');
  const languageLink = isModel
    ? english ? '[简体中文](README.md) | English' : '中文 | [English](README.en.md)'
    : english ? `[简体中文](../${path.posix.basename(file)}) | English` : `中文 | [English](en/${path.posix.basename(file)})`;
  const docs = isModel ? english ? '../../../docs/en/README.md' : '../../../docs/README.md' : 'README.md';
  return Buffer.from(english
    ? `# Private project material omitted\n\n${languageLink}\n\nThis public snapshot omits private target models, source quotations, historical acceptance records, local configuration, and original author/commit metadata. The original repository is retained separately. This placeholder preserves documentation links and makes no claim about historical test results.\n\nUse the independent combat demo and the [documentation index](${docs}) for public setup and validation. Screenshots retained by the maintainer are separate illustrations.\n`
    : `# 私有项目材料未包含在公开快照中\n\n${languageLink}\n\n此公开快照不包含私有目标模型、源码引文、历史验收记录、本机配置或原作者及提交元数据。原始仓库独立保留。此占位页用于保留文档链接，不声明历史测试结果。\n\n公开使用与验证请参考独立 combat 演示和[文档索引](${docs})。维护者保留的界面截图为独立展示材料。\n`);
}

async function regularFile(root, relative) {
  if (!safeRelative(relative)) throw new Error('unsafe-path');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = await lstat(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error('linked-path');
    if (current !== path.join(root, relative) && !stat.isDirectory()) throw new Error('invalid-parent');
  }
  const stat = await lstat(current);
  if (!stat.isFile() || !within(root, await realpath(current))) throw new Error('non-regular-file');
  if (stat.nlink > 1) throw new Error('hardlinked-file');
  if (stat.size > 32 * 1024 * 1024) throw new Error('file-too-large');
  return stat;
}

async function readSnapshotFile(root, file, expected) {
  const full = path.join(root, file);
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size || opened.mtimeMs !== expected.mtimeMs) throw new Error('changed-file');
    const buffer = await handle.readFile();
    const current = await regularFile(root, file);
    if (!current || current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs) throw new Error('changed-file');
    return buffer;
  } finally { await handle.close(); }
}

const normalizedProof = value => value.replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n').replaceAll('\\r', '\n').replaceAll('\\"', '"').replaceAll("\\'", "'").replace(/\s+/g, ' ').trim();
const escapedRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function projectPattern(id) {
  const letters = id.replace(/[^a-z\d]/gi, '');
  if (letters.length < 4) return;
  // Match slugs and their display-name/camel-case spelling without storing names in the export.
  return new RegExp('(?:^|[^a-z\\d])' + [...letters].map(escapedRegex).join('[-_\\s]*') + '(?:$|[^a-z\\d])', 'i');
}

async function privateProofs(root, names, blockers) {
  const projects = new Set(), quotes = new Set();
  let total = 0, quoteText = 0, quoteCount = 0;
  for (const file of names) {
    const model = /^architecture\/(models|semantics)\/([^/]+)\/(.+)$/i.exec(file);
    if (!model || model[2].toLowerCase() === 'combat-demo') continue;
    projects.add(model[2]);
    if (model[1].toLowerCase() !== 'models' || model[3].toLowerCase() !== 'model.json') continue;
    try {
      // Only this tool's already-listed private model is inspected. No selector,
      // quote path, target root, configuration, or environment file is opened.
      const stat = await regularFile(root, file);
      if (!stat) continue;
      total += stat.size;
      if (stat.size > PRIVATE_MODEL_FILE_LIMIT || total > PRIVATE_MODEL_TOTAL_LIMIT) throw new Error('budget');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readSnapshotFile(root, file, stat)).replace(/^\uFEFF/, ''));
      if (typeof value.projectId === 'string') projects.add(value.projectId);
      if (value.anchors !== undefined && !Array.isArray(value.anchors)) throw new Error('format');
      for (const anchor of value.anchors || []) if (typeof anchor?.quote === 'string') {
        quoteCount++; quoteText += anchor.quote.length;
        if (quoteCount > PRIVATE_QUOTE_LIMIT || quoteText > PRIVATE_QUOTE_TEXT_LIMIT) throw new Error('budget');
        const quote = normalizedProof(anchor.quote);
        // Short common statements are unsuitable privacy fingerprints.
        if (quote.length >= 160 || quote.length >= 96 && anchor.quote.split(/\r?\n/).filter(line => line.trim()).length >= 2) quotes.add(quote);
      }
    } catch { blockers.push({ code: 'private-model-audit', file, action: 'Private-model fingerprint checking failed or exceeded its budget. Review this ordinary tool-owned file; no content or target paths are reported.' }); }
  }
  return { projects: [...projects].map(projectPattern).filter(Boolean), quotes: [...quotes] };
}

function references(file, text) {
  const result = [];
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    for (const pattern of [
      /\b(?:import|export)\s+(?:[^'"\n]*?\s+from\s*)?['"](\.[^'"]+)['"]/g,
      /\b(?:import|require)\(\s*['"](\.[^'"]+)['"]/g,
      /new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url/g,
    ]) for (const match of text.matchAll(pattern)) result.push({ target: path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])), kind: 'dependency' });
    for (const match of text.matchAll(/path\.join\(\s*(?:root|TOOL_ROOT)\s*,\s*['"]([^'"]+)['"]/g)) {
      const target = path.posix.normalize(match[1]);
      if (actionFor(target) === 'exclude' && !target.startsWith('.tmp') && !target.startsWith('.cache')) result.push({ target, kind: 'dependency' });
    }
  }
  if (file.endsWith('.md')) for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue;
    result.push({ target: path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(target))), kind: 'document-link' });
  }
  return result;
}

/** Plan before writing. Excluded configuration, environment, and historical
 * documents are never read. Bounded ordinary private model files are inspected
 * only for in-memory privacy comparison; target source paths are never opened. */
export async function planPublicExport(root = toolRoot) {
  root = path.resolve(root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Source root must be a regular, unlinked directory');
  // The source's standard excludes include its global ignore configuration.
  // The destination uses isolated configuration and never inherits that identity.
  const output = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {}, false);
  const names = [...new Set(output.split('\0').filter(Boolean))].sort();
  const files = new Map(), blockers = [], excluded = [];
  const privateContent = await privateProofs(root, names, blockers);
  for (const name of names) {
    if (!safeRelative(name)) { blockers.push({ code: 'unsafe-path', file: '(invalid Git path)', action: 'Remove unsafe paths from the source snapshot.' }); continue; }
    const action = actionFor(name);
    if (action === 'exclude') { excluded.push(name); continue; }
    try {
      const stat = await regularFile(root, name);
      if (!stat) continue; // A tracked deletion belongs to the working snapshot.
      files.set(name, { content: action === 'stub' ? privacyStub(name) : await readSnapshotFile(root, name, stat), mode: stat.mode, stub: action === 'stub' });
    } catch (error) { blockers.push({ code: /^(?:unsafe-path|linked-path|invalid-parent|non-regular-file|hardlinked-file|file-too-large|changed-file)$/.test(error.message) ? error.message : 'file-read-failed', file: name, action: 'Replace links/nonregular files with reviewed ordinary files, or retry after edits stop.' }); }
  }
  const exists = (target, kind) => files.has(target) || (kind === 'dependency' && ['', '.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.tsx'].some(suffix => files.has(target + suffix))) || ((kind === 'document-link' || target.endsWith('/')) && [...files.keys()].some(file => file.startsWith(target.replace(/\/$/, '') + '/')));
  for (const [file, entry] of files) {
    const privatePath = privateContent.projects.some(pattern => pattern.test(file));
    if (privatePath) blockers.push({ code: 'private-project-identifier', file, action: 'Rename files containing an excluded private-project identifier.' });
    if (/\.(?:png|jpe?g|gif|webp|ico)$/i.test(file)) continue; // Maintainer-authorized screenshots/assets.
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(entry.content); }
    catch { blockers.push({ code: 'unreviewed-binary', file, action: 'Review this binary explicitly before adding it to the public export policy.' }); continue; }
    if (!privatePath && privateContent.projects.some(pattern => pattern.test(text))) blockers.push({ code: 'private-project-identifier', file, action: 'Replace private-project identifiers and dependencies with independent public fixtures or documentation.' });
    const proof = normalizedProof(text);
    if (privateContent.quotes.some(quote => proof.includes(quote))) blockers.push({ code: 'private-source-quotation', file, action: 'Remove or replace source quotations from excluded private models. No quotation or fingerprint is written to the export.' });
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-|svcacct-)[A-Za-z0-9_-]{20,}/.test(text)) blockers.push({ code: 'sensitive-content', file, action: 'Remove credentials or private keys; only the path is reported.' });
    for (const reference of references(file, text)) if (!(reference.kind === 'dependency' && runtimeReference(reference.target)) && !exists(reference.target, reference.kind)) blockers.push({ code: reference.kind, file, action: `Decouple the excluded or missing reference: ${reference.target}` });
  }
  return { root, files, excluded, blockers };
}

/** Write a separate single-commit candidate; never mutate source Git metadata or add a remote. */
export async function exportPublicSnapshot(root = toolRoot) {
  const plan = await planPublicExport(root);
  if (plan.blockers.length) return { status: 'blocked', blockers: plan.blockers, excludedCount: plan.excluded.length };
  const parent = path.join(plan.root, '.release');
  try {
    const existing = await lstat(parent);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Release directory must be a regular tool-owned directory');
  } catch (error) { if (error.code === 'ENOENT') await mkdir(parent); else throw error; }
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !within(plan.root, await realpath(parent))) throw new Error('Release directory must be a regular tool-owned directory');
  const destination = await mkdtemp(path.join(parent, 'public-'));
  try {
    for (const [file, entry] of plan.files) {
      const target = path.join(destination, file);
      if (!within(destination, target)) throw new Error('Unsafe destination');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.content, { flag: 'wx' });
      if (process.platform !== 'win32') await chmod(target, entry.mode & 0o777);
    }
    await writeFile(path.join(destination, 'PUBLIC-EXPORT.json'), JSON.stringify({ schemaVersion: 1, kind: 'public-candidate', anonymousIdentity: PUBLIC_IDENTITY, copiedFiles: plan.files.size, omittedFiles: plan.excluded.length, originalHistoryIncluded: false, verification: 'Export does not run tests. Run typecheck, build, CI tests, and privacy review before publication.' }, null, 2) + '\n', { flag: 'wx' });
    await git(destination, ['init', '--initial-branch=main', '--template=']);
    const hooks = path.join(destination, '.git', 'disabled-hooks'); await mkdir(hooks);
    await git(destination, ['config', '--local', 'user.name', PUBLIC_IDENTITY.name]);
    await git(destination, ['config', '--local', 'user.email', PUBLIC_IDENTITY.email]);
    await git(destination, ['config', '--local', 'commit.gpgsign', 'false']);
    await git(destination, ['config', '--local', 'core.hooksPath', '.git/disabled-hooks']);
    await git(destination, ['-c', `core.hooksPath=${slash(hooks)}`, 'add', '--all']);
    await git(destination, ['-c', `core.hooksPath=${slash(hooks)}`, 'commit', '--quiet', '-m', 'Initial public source snapshot'], {
      GIT_AUTHOR_NAME: PUBLIC_IDENTITY.name, GIT_AUTHOR_EMAIL: PUBLIC_IDENTITY.email,
      GIT_COMMITTER_NAME: PUBLIC_IDENTITY.name, GIT_COMMITTER_EMAIL: PUBLIC_IDENTITY.email,
    });
    if ((await git(destination, ['remote'])).trim()) throw new Error('Export must not have a remote');
    return { status: 'candidate', destination, copiedFiles: plan.files.size, omittedFiles: plan.excluded.length, blockers: [] };
  } catch {
    // The only recursive removal target is this freshly created, checked child.
    const actual = await realpath(destination).catch(() => undefined);
    if (actual && within(plan.root, actual) && within(parent, actual) && canonical(actual) !== canonical(parent)) await rm(destination, { recursive: true, force: true });
    throw new Error('Public export failed; no candidate was published. Source repository was not changed.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--export'].includes(args[0])) throw new Error('Usage: node Tools/export-public.mjs --check|--export');
  if (args[0] === '--check') {
    const plan = await planPublicExport();
    console.log(JSON.stringify({ status: plan.blockers.length ? 'blocked' : 'checked', copiedFiles: plan.files.size, omittedFiles: plan.excluded.length, blockers: plan.blockers }, null, 2));
    if (plan.blockers.length) process.exitCode = 1;
  } else {
    const result = await exportPublicSnapshot(); console.log(JSON.stringify(result, null, 2));
    if (result.status === 'blocked') process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => { console.error('Public export failed. Review path safety and Git availability; no private file contents are printed.'); process.exitCode = 1; });
