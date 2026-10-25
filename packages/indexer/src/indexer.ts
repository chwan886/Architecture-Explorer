import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, unlink, writeFile, realpath } from 'node:fs/promises';
import { withFileLock } from './file-lock.ts';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  ANALYZER_VERSION, SCHEMA_VERSION, contentHash, fileId, stableId,
  type AnalyzerRequest, type AnalyzerResult, type ArchitectureIndex, type ArchitectureNode,
  type ArchitectureEdge, type Diagnostic, type Evidence, type FileRecord, type IndexStatus,
  type Language, type ProjectConfig, type SourceFile, type WorktreeInfo,
} from '../../schema/src/index.ts';
import { validateAnalyzerResult, validateIndex } from '../../schema/src/validate.ts';
import type { LoadedConfig } from './config.ts';
import { discoverWorktrees, gitState } from './git.ts';
import { AccessError, canonical, createFilePolicy, ensureCacheDirectory, isWithin, readAuthorized } from './security.ts';
import { WorkerPool } from './workers.ts';

type Worker = (language: 'csharp' | 'python', input: AnalyzerRequest, config: LoadedConfig) => Promise<AnalyzerResult>;
interface WorkerCache { fingerprint: string; result: AnalyzerResult; }
export interface ScopeRuntime {
  id: string; project: ProjectConfig; worktree: WorktreeInfo; cachePath: string;
  status: IndexStatus; index?: ArchitectureIndex; queue: Promise<void>; running: boolean;
  failureDiagnostics: Diagnostic[];
  requested: boolean; full: boolean; workerCaches: Map<string, WorkerCache>;
  watcher?: FSWatcher; debounce?: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setInterval>;
}
export interface ManagerOptions { worker?: Worker; debounceMs?: number; pollMs?: number; }
const supportedExtensions = new Set(['.cs', '.py', '.json', '.asmdef', '.asset', '.prefab', '.unity', '.meta', '.shader', '.uss', '.tss', '.uxml']);

function languageFor(file: string): Language {
  const extension = path.extname(file).toLowerCase();
  return extension === '.cs' ? 'csharp' : extension === '.py' ? 'python' : ['.json', '.asmdef'].includes(extension) ? 'json' : 'unity';
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
  // rename replaces the destination atomically; never delete lastgood first.
  await rename(temporary, file);
}

function diagnostic(scope: string, code: string, message: string, filePath?: string, severity: Diagnostic['severity'] = 'warning'): Diagnostic {
  return { id: stableId(scope, 'diagnostic', `${code}|${filePath ?? ''}|${message}`), code, message, filePath, severity };
}

interface Snapshot { sources: SourceFile[]; files: FileRecord[]; diagnostics: Diagnostic[]; }
async function capture(scope: ScopeRuntime): Promise<Snapshot> {
  const policy = createFilePolicy(scope.project.include, scope.project.exclude);
  const sources: SourceFile[] = []; const files: FileRecord[] = []; const diagnostics: Diagnostic[] = [];
  let bytes = 0; let ignoredTypes = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (policy.ignored(relative, entry.isDirectory())) continue;
      if (entry.isSymbolicLink()) {
        diagnostics.push(diagnostic(scope.id, 'symlink-skipped', '符号链接／目录联接未扫描，避免越过授权目录', relative)); continue;
      }
      if (entry.isDirectory()) { await visit(path.join(directory, entry.name), relative); continue; }
      if (!entry.isFile() || !policy.included(relative)) continue;
      if (!supportedExtensions.has(path.extname(relative).toLowerCase())) { ignoredTypes++; continue; }
      let buffer: Buffer;
      try { buffer = await readAuthorized(scope.worktree.path, relative); }
      catch (error) {
        if (error instanceof AccessError) { diagnostics.push(diagnostic(scope.id, 'source-skipped', error.message, relative)); continue; }
        throw error;
      }
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { diagnostics.push(diagnostic(scope.id, 'encoding-unsupported', '只分析 UTF-8 文本文件，未解析此文件', relative)); continue; }
      if (content.includes('\0')) { diagnostics.push(diagnostic(scope.id, 'binary-skipped', '未解析二进制文件', relative)); continue; }
      if (sources.length >= 50000 || bytes + buffer.length > 256 * 1024 * 1024) throw new Error('扫描达到 50,000 文件／256 MiB 文本预算，请收窄 include');
      bytes += buffer.length;
      const hash = contentHash(content);
      sources.push({ path: relative, content, hash });
      files.push({ path: relative, hash, size: buffer.length, language: languageFor(relative) });
    }
  };
  await visit(scope.worktree.path, '');
  if (ignoredTypes) diagnostics.push(diagnostic(scope.id, 'unsupported-file-types', `${ignoredTypes} 个匹配文件的格式不受支持，未作为源码解析`));
  return { sources, files, diagnostics };
}

function signature(files: FileRecord[]): string { return contentHash(JSON.stringify(files.map(file => [file.path, file.hash]))); }
function emptyResult(): AnalyzerResult { return { nodes: [], edges: [], evidence: [], diagnostics: [] }; }

function makeHierarchy(scope: ScopeRuntime, snapshot: Snapshot, results: AnalyzerResult[]): AnalyzerResult {
  const nodes = new Map<string, ArchitectureNode>(); const edges = new Map<string, ArchitectureEdge>();
  const evidence = new Map<string, Evidence>(); const diagnostics = [...snapshot.diagnostics];
  const rootId = stableId(scope.id, 'project', scope.project.id);
  nodes.set(rootId, { id: rootId, kind: 'project', label: scope.project.name, qualifiedName: scope.project.name, language: 'unknown', evidenceIds: [],
    summary: '以当前授权工作目录的真实源码构建；模块分组与语义关系分别保留来源。' });
  const files = new Map(snapshot.sources.map(file => [file.path, file]));
  const assemblies: Array<{ directory: string; name: string; source: SourceFile; references: string[]; moduleId: string }> = [];
  for (const source of snapshot.sources.filter(file => file.path.endsWith('.asmdef'))) {
    try {
      const value = JSON.parse(source.content);
      if (typeof value.name !== 'string') throw new Error('缺少 name');
      assemblies.push({ directory: path.posix.dirname(source.path), name: value.name, source,
        references: Array.isArray(value.references) ? value.references.filter((item: unknown) => typeof item === 'string') : [],
        moduleId: stableId(scope.id, 'module', `asmdef|${source.path}|${value.name}`) });
    } catch { diagnostics.push(diagnostic(scope.id, 'asmdef-invalid', '程序集定义不是可识别的 JSON，已回退目录分组', source.path)); }
  }
  assemblies.sort((a, b) => b.directory.length - a.directory.length);
  const ensureSystem = (key: string, label: string, language: Language): string => {
    const id = stableId(scope.id, 'system', key);
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'system', label, qualifiedName: label, parentId: rootId, language, evidenceIds: [],
      summary: '按解析语言和文件类型聚合；该分组不代表已经证明的运行时子系统。' });
    return id;
  };
  const fileModule = new Map<string, string>();
  for (const source of snapshot.sources) {
    const language = languageFor(source.path);
    const assembly = language === 'csharp' ? assemblies.find(item => source.path.startsWith(item.directory + '/')) : undefined;
    const systemId = ensureSystem(language === 'csharp' ? 'csharp' : language === 'python' ? 'python' : 'resources',
      language === 'csharp' ? 'C# 程序集与代码' : language === 'python' ? 'Python 服务与模块' : '配置与资源', language);
    const directory = path.posix.dirname(source.path);
    const group = language === 'python' ? (source.path.split('/').length > 1 ? source.path.split('/')[0] : '根目录')
      : language === 'csharp' ? (assembly?.name ?? directory) : (source.path.split('/').length > 1 ? source.path.split('/')[0] : '根目录配置');
    const moduleId = assembly?.moduleId ?? stableId(scope.id, 'module', `${language === 'python' ? 'python' : language === 'csharp' ? 'csharp' : 'resources'}|${group}`);
    if (!nodes.has(moduleId)) nodes.set(moduleId, { id: moduleId, kind: 'module', label: group, qualifiedName: group, parentId: systemId,
      language, filePath: assembly?.source.path, evidenceIds: [], summary: assembly ? '分组来自 .asmdef 程序集定义。' : '按源码目录聚合，未推断业务职责。' });
    fileModule.set(source.path, moduleId);
    const id = fileId(scope.id, source.path);
    const firstLine = source.content.split(/\r?\n/, 1)[0] ?? '';
    const evidenceId = stableId(scope.id, 'evidence', `file|${source.path}|${source.hash}`);
    evidence.set(evidenceId, { id: evidenceId, filePath: source.path, startLine: 1, startColumn: 1, endLine: 1,
      endColumn: firstLine.length + 1, fileHash: source.hash, rule: 'indexer:authorized-source-file', excerpt: firstLine });
    nodes.set(id, { id, kind: 'file', label: path.posix.basename(source.path), qualifiedName: source.path, language,
      filePath: source.path, parentId: moduleId, moduleId, evidenceIds: [evidenceId] });
  }
  for (const result of results) {
    diagnostics.push(...result.diagnostics);
    for (const item of result.evidence) {
      const source = files.get(item.filePath);
      if (!source || source.hash !== item.fileHash) throw new Error('分析器证据不属于本次授权源码快照');
      evidence.set(item.id, item);
    }
    for (const node of result.nodes) {
      if (node.filePath && !files.has(node.filePath)) throw new Error('分析器节点指向未授权的源码文件');
      if (node.kind === 'file') {
        const existing = nodes.get(node.id);
        if (existing) nodes.set(node.id, { ...node, parentId: existing.parentId, moduleId: existing.moduleId,
          evidenceIds: [...new Set([...existing.evidenceIds, ...node.evidenceIds])] });
        else throw new Error('分析器文件 ID 与统一稳定 ID 不一致');
      } else nodes.set(node.id, { ...node, moduleId: node.filePath ? fileModule.get(node.filePath) : node.moduleId,
        parentId: node.parentId ?? (node.filePath ? fileId(scope.id, node.filePath) : undefined) });
    }
    for (const edge of result.edges) edges.set(edge.id, edge);
  }
  // .asmdef references are explicit configuration dependencies, separate from inferred C# calls.
  for (const assembly of assemblies) {
    const module = nodes.get(assembly.moduleId);
    if (!module) continue;
    const file = nodes.get(fileId(scope.id, assembly.source.path));
    module.evidenceIds = file?.evidenceIds ?? [];
    for (const reference of assembly.references) {
      const target = assemblies.find(item => item.name === reference);
      if (!target || !nodes.has(target.moduleId)) continue;
      const id = stableId(scope.id, 'edge', `asmdef|${assembly.moduleId}|${target.moduleId}`);
      edges.set(id, { id, source: assembly.moduleId, target: target.moduleId, kind: 'references', confidence: 'static-confirmed',
        evidenceIds: module.evidenceIds, rule: 'unity:asmdef-explicit-reference', limitations: ['程序集配置依赖，不代表其中任意两个方法之间存在调用。'] });
    }
  }
  const containment = new Set([...edges.values()].filter(edge => edge.kind === 'contains').map(edge => `${edge.source}|${edge.target}`));
  for (const node of nodes.values()) {
    if (!node.parentId) continue;
    if (!nodes.has(node.parentId)) throw new Error(`节点父项不存在：${node.label}`);
    const id = stableId(scope.id, 'edge', `contains|${node.parentId}|${node.id}`);
    if (!containment.has(`${node.parentId}|${node.id}`)) {
      edges.set(id, { id, source: node.parentId, target: node.id, kind: 'contains', confidence: 'static-confirmed',
        evidenceIds: node.evidenceIds, rule: node.kind === 'system' || node.kind === 'module' ? 'indexer:explicit-directory-or-assembly-group' : 'indexer:source-containment' });
    }
  }
  const allEvidence = new Set(evidence.keys());
  for (const edge of edges.values()) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new Error('分析器输出悬空关系，索引未发布');
    if (edge.evidenceIds.some(id => !allEvidence.has(id))) throw new Error('关系引用的证据不存在');
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], evidence: [...evidence.values()],
    diagnostics: [...new Map(diagnostics.map(item => [item.id, item])).values()] };
}

export class IndexManager extends EventEmitter {
  readonly scopes = new Map<string, ScopeRuntime>();
  readonly worktrees = new Map<string, WorktreeInfo[]>();
  private readonly worker: Worker;
  private readonly workerPool?: WorkerPool;
  private exclusive = Promise.resolve();
  private closing = false;
  constructor(readonly config: LoadedConfig, readonly options: ManagerOptions = {}) {
    super();
    if (options.worker) this.worker = options.worker;
    else { this.workerPool = new WorkerPool(config); this.worker = (language, request) => this.workerPool!.run(language, request); }
  }

  async initialize(): Promise<void> {
    const resolvedCache = await ensureCacheDirectory(this.config.cacheDir, this.config.toolRoot);
    if (!isWithin(this.config.toolRoot, resolvedCache) || this.config.projects.some(project => [project.root, ...(project.worktrees ?? [])].some(root => isWithin(root, resolvedCache)))) {
      throw new AccessError('缓存真实路径越过工具目录或指向目标仓库');
    }
    for (const project of this.config.projects) {
      const worktrees = await discoverWorktrees(project); this.worktrees.set(project.id, worktrees);
      for (const worktree of worktrees.filter(item => item.authorized)) {
        const id = `${project.id}:${worktree.id}`;
        const cachePath = path.join(resolvedCache, contentHash(id + '|' + canonical(worktree.path)).slice(0, 24));
        const scope: ScopeRuntime = { id, project, worktree, cachePath,
          status: { scopeId: id, state: 'empty', message: '尚未生成索引' }, queue: Promise.resolve(), running: false,
          requested: false, full: false, workerCaches: new Map(), failureDiagnostics: [] };
        this.scopes.set(id, scope);
        try {
          const cached: unknown = JSON.parse(await readFile(path.join(cachePath, 'lastgood.json'), 'utf8'));
          validateIndex(cached);
          if (cached.metadata.scopeId === id && canonical(cached.metadata.rootPath) === canonical(worktree.path) &&
              cached.metadata.configFingerprint === contentHash(this.config.fingerprint + '|' + id)) {
            scope.index = cached;
            scope.status = { scopeId: id, state: 'stale', message: '已载入上次有效索引，等待源码一致性校验', revision: cached.metadata.revision, generatedAt: cached.metadata.generatedAt };
          }
        } catch { /* A missing or incompatible cache is never exposed as current. */ }
      }
    }
  }

  scope(id?: string): ScopeRuntime {
    if (!id) throw Object.assign(new Error('必须指定 scope'), { statusCode: 400 });
    const scope = this.scopes.get(id);
    if (!scope) throw new AccessError('项目工作目录不存在或未授权；请在配置中明确列入 worktrees');
    return scope;
  }

  private publish(scope: ScopeRuntime, value: Omit<IndexStatus, 'scopeId'>): void {
    scope.status = { scopeId: scope.id, ...value };
    this.emit('status', scope.status);
  }

  requestScan(id: string, full = false): Promise<void> {
    const scope = this.scope(id);
    if (this.closing) return Promise.reject(new Error('索引器正在关闭'));
    scope.requested = true; scope.full ||= full;
    if (scope.running) return scope.queue;
    scope.running = true;
    scope.queue = (async () => {
      try {
        while (scope.requested && !this.closing) {
          scope.requested = false; const force = scope.full; scope.full = false;
          this.publish(scope, { ...scope.status, state: 'analyzing', message: '正在分析授权源码', progress: '等待串行扫描任务' });
          let unlock!: () => void;
          const previous = this.exclusive;
          this.exclusive = new Promise<void>(resolve => { unlock = resolve; });
          await previous;
          scope.failureDiagnostics = [];
          try { await this.perform(scope, force); }
          catch (error) {
            const message = (error instanceof Error ? error.message : String(error)).slice(0, 3000);
            if (!scope.failureDiagnostics.length) scope.failureDiagnostics = [diagnostic(scope.id, 'scan-failed', message, undefined, 'error')];
            this.publish(scope, { state: 'failed', message,
              revision: scope.index?.metadata.revision, generatedAt: scope.index?.metadata.generatedAt,
              diagnostics: (scope.index?.diagnostics.length ?? 0) + scope.failureDiagnostics.length });
          } finally { unlock(); }
        }
      } finally { scope.running = false; }
    })();
    return scope.queue;
  }

  private async compilationFingerprint(scope: ScopeRuntime): Promise<string> {
    const references: Array<[string, string]> = [];
    for (const reference of scope.project.references ?? []) {
      references.push([reference, contentHash(await readFile(reference))]);
    }
    const workers: Array<[string, string]> = [];
    for (const relative of ['analyzers/python/analyze.py', 'analyzers/csharp/bin/Release/net10.0/ArchitectureExplorer.Analyzers.dll']) {
      try { workers.push([relative, contentHash(await readFile(path.join(this.config.toolRoot, relative)))]); }
      catch { workers.push([relative, 'missing']); }
    }
    return contentHash(JSON.stringify({ references, defines: scope.project.defines, workers, version: ANALYZER_VERSION }));
  }

  private async perform(scope: ScopeRuntime, full: boolean): Promise<void> {
    const resolved = await ensureCacheDirectory(scope.cachePath, this.config.toolRoot);
    if (!isWithin(this.config.cacheDir, resolved)) throw new AccessError('缓存子目录指向授权缓存外部');
    const lockPath = path.join(resolved, 'scan.lock');
    return withFileLock({ toolRoot: this.config.toolRoot, lockPath,
      locked: () => new Error('此工作目录已有其他扫描进程持有缓存锁，或锁的持有者无法验证；保留上次有效索引。') }, async () => {
      if (full) this.workerPool?.invalidate(scope.id);
      await this.performLocked(scope, full);
    });
  }

  private async performLocked(scope: ScopeRuntime, full: boolean): Promise<void> {
    const started = Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      this.publish(scope, { ...scope.status, state: 'analyzing', message: '读取文件哈希并核对 Git 状态', progress: '读取授权文件' });
      const before = await gitState(scope.worktree.path);
      const snapshot = await capture(scope);
      const compilationFingerprint = await this.compilationFingerprint(scope);
      const configFingerprint = contentHash(this.config.fingerprint + '|' + scope.id);
      const validPrevious = scope.index?.metadata.analyzerVersion === ANALYZER_VERSION && scope.index.metadata.schemaVersion === SCHEMA_VERSION &&
        scope.index.metadata.configFingerprint === configFingerprint && scope.index.metadata.compilationFingerprint === compilationFingerprint;
      const oldFiles = new Map((scope.index?.files ?? []).map(file => [file.path, file.hash]));
      const changedFiles = snapshot.files.filter(file => oldFiles.get(file.path) !== file.hash).length + [...oldFiles.keys()].filter(key => !snapshot.files.some(file => file.path === key)).length;
      const results: AnalyzerResult[] = []; const pendingCaches = new Map<string, WorkerCache>();
      for (const language of ['python', 'csharp'] as const) {
        const languageFiles = snapshot.sources.filter(file => languageFor(file.path) === language);
        if (!languageFiles.length) continue;
        const fingerprint = contentHash(JSON.stringify({ files: languageFiles.map(file => [file.path, file.hash]), configFingerprint, compilationFingerprint, language, version: ANALYZER_VERSION }));
        let cached = scope.workerCaches.get(language);
        if (!cached && !full && validPrevious) {
          try { cached = JSON.parse(await readFile(path.join(scope.cachePath, `${language}.json`), 'utf8')) as WorkerCache; validateAnalyzerResult(cached.result); }
          catch { cached = undefined; }
        }
        if (!full && cached?.fingerprint === fingerprint) results.push(cached.result);
        else {
          this.publish(scope, { ...scope.status, state: 'analyzing', message: `正在执行 ${language === 'python' ? 'Python AST' : 'C# Roslyn'} 语义分析`,
            progress: `${languageFiles.length} 个 ${language} 文件；以语言编译单元为安全失效范围` });
          const result = await this.worker(language, { scopeId: scope.id, files: languageFiles,
            references: language === 'csharp' ? scope.project.references : undefined, defines: scope.project.defines, assemblyName: 'ArchitectureExplorer.Target' }, this.config);
          validateAnalyzerResult(result); cached = { fingerprint, result }; results.push(result);
        }
        pendingCaches.set(language, cached!);
      }
      const failures = results.flatMap(result => result.diagnostics).filter(item => item.severity === 'error');
      if (failures.length) {
        scope.failureDiagnostics = failures;
        throw new Error(`分析器报告 ${failures.length} 个错误，保留上次有效索引：` + failures.slice(0, 4).map(item => `${item.code} ${item.filePath ?? ''}${item.line ? ':' + item.line : ''} ${item.message}`).join('；'));
      }
      const hierarchy = makeHierarchy(scope, snapshot, results);
      const after = await gitState(scope.worktree.path);
      const check = await capture(scope);
      if (signature(check.files) !== signature(snapshot.files) || before.head !== after.head || before.statusHash !== after.statusHash) {
        if (attempt < 2) continue;
        throw new Error('源码在分析期间持续变化；保留上次有效索引，稳定后将重新分析');
      }
      const generatedAt = new Date().toISOString();
      const revision = contentHash(`${scope.id}|${signature(snapshot.files)}|${configFingerprint}|${compilationFingerprint}|${after.head}|${after.statusHash}`).slice(0, 24);
      const limitations = [
        '静态访问关系并非完整运行时数据流；没有运行或插桩目标代码。',
        '持久 Worker 按 scope、文件内容哈希缓存 AST／SyntaxTree，仅重新解析变化文件；跨文件语义绑定保守扩大到该语言上下文。进程重启后首次重新解析。',
        '文件 IO 仍在每次更新时两次枚举完整授权清单并读取文本复核内容哈希；尚未实现 dirty-path／stat 缓存或符号级增量失效。',
        '跨语言 HTTP／JSON 字段映射未自动确认，反射、动态分发和未解析调用见诊断。',
        'C# 使用配置指定的元数据引用与预处理符号；当前为合并分析上下文，未验证 Unity 实际逐程序集构建。',
        '资源目前仅按授权文件和 .asmdef 显式依赖索引；未声称完整 Unity 场景／Prefab 引用语义。',
      ];
      const index: ArchitectureIndex = { ...hierarchy, flows: [], files: snapshot.files,
        metadata: { schemaVersion: SCHEMA_VERSION, analyzerVersion: ANALYZER_VERSION, projectId: scope.project.id, projectName: scope.project.name,
          worktreeId: scope.worktree.id, scopeId: scope.id, rootPath: scope.worktree.path, gitHead: after.head, gitBranch: after.branch,
          gitDirty: after.dirty, gitStatusHash: after.statusHash, generatedAt, configFingerprint, compilationFingerprint, revision,
          fileCount: snapshot.files.length, durationMs: Date.now() - started, changedFiles, reusedFiles: snapshot.files.length - snapshot.files.filter(file => oldFiles.get(file.path) !== file.hash).length,
          coverage: { languages: [...new Set(snapshot.files.map(file => file.language))], limitations } } };
      if (!after.head) index.diagnostics.push(diagnostic(scope.id, 'git-unavailable', '无法读取 Git 元数据；该目录可能不是 Git 仓库，gitDirty=false 不代表已确认工作区干净。'));
      const accesses = new Map<string, ArchitectureEdge[]>();
      const dataIds = new Set(index.nodes.filter(node => ['field', 'property', 'data', 'parameter'].includes(node.kind)).map(node => node.id));
      for (const edge of index.edges) {
        if (!['reads', 'writes', 'initializes'].includes(edge.kind) || !dataIds.has(edge.target)) continue;
        const entries = accesses.get(edge.target) ?? []; entries.push(edge); accesses.set(edge.target, entries);
      }
      for (const [target, edges] of accesses) {
        if (index.flows.length >= 1000) break;
        const bounded = edges.slice(0, 100); const node = index.nodes.find(item => item.id === target)!;
        index.flows.push({ id: stableId(scope.id, 'flow', `static-access|${target}`), label: `${node.label} 的静态读写引用`, scope: 'static-access',
          nodeIds: [...new Set([target, ...bounded.map(edge => edge.source)])], edgeIds: bounded.map(edge => edge.id),
          limitations: ['这是源码读写引用集合，并非已经验证的值传播、时序或完整运行时数据流。', ...(edges.length > bounded.length ? ['此集合仅保留前 100 条关系，图查询可按节点继续探索。'] : [])] });
      }
      validateIndex(index);
      for (const [language, cached] of pendingCaches) await atomicJson(path.join(scope.cachePath, `${language}.json`), cached);
      await atomicJson(path.join(scope.cachePath, 'lastgood.json'), index);
      scope.index = index; scope.workerCaches = pendingCaches;
      scope.worktree.head = after.head; scope.worktree.branch = after.branch;
      this.publish(scope, { state: scope.requested ? 'stale' : 'synced', message: scope.requested ? '分析期间有新变更，继续更新' : `已同步 ${snapshot.files.length} 个文件`,
        revision, generatedAt, diagnostics: index.diagnostics.length, changedFiles, progress: undefined });
      return;
    }
  }

  async startWatching(id: string): Promise<void> {
    const scope = this.scope(id);
    if (scope.watcher) return;
    const policy = createFilePolicy(scope.project.include, scope.project.exclude);
    const queueChange = () => {
      if (this.closing) return;
      this.publish(scope, { ...scope.status, state: 'stale', message: '检测到源码变化，等待防抖分析' });
      if (scope.debounce) clearTimeout(scope.debounce);
      scope.debounce = setTimeout(() => { scope.debounce = undefined; void this.requestScan(id); }, this.options.debounceMs ?? 450);
    };
    scope.watcher = chokidar.watch(scope.worktree.path, { ignoreInitial: true, followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 180, pollInterval: 50 },
      ignored: (candidate, stats) => {
        const relative = path.relative(scope.worktree.path, candidate).replaceAll('\\', '/');
        if (!relative) return false;
        return policy.ignored(relative, stats?.isDirectory() ?? true);
      } });
    scope.watcher.on('all', (event, file) => {
      const relative = path.relative(scope.worktree.path, file).replaceAll('\\', '/');
      if (event === 'unlinkDir' || policy.included(relative)) queueChange();
    });
    scope.watcher.on('error', () => this.publish(scope, { ...scope.status, state: 'failed', message: '文件监听失败；可手动扫描，保留上次有效索引' }));
    // Git worktree metadata can live outside the source root; query through read-only Git instead of watching arbitrary paths.
    scope.poll = setInterval(() => {
      if (scope.running || this.closing) return;
      void gitState(scope.worktree.path).then(state => {
        const metadata = scope.index?.metadata;
        if (metadata && (metadata.gitHead !== state.head || metadata.gitStatusHash !== state.statusHash)) queueChange();
      });
    }, this.options.pollMs ?? 10000);
    scope.poll.unref();
    await new Promise<void>(resolve => scope.watcher!.once('ready', resolve));
  }

  async verify(id: string): Promise<{ valid: boolean; reasons: string[]; revision?: string }> {
    const scope = this.scope(id); const index = scope.index;
    if (!index) return { valid: false, reasons: ['没有有效索引'] };
    const reasons: string[] = [];
    try { validateIndex(index); } catch { reasons.push('索引 Schema 或引用完整性校验失败'); }
    try {
      const disk: unknown = JSON.parse(await readFile(path.join(scope.cachePath, 'lastgood.json'), 'utf8')); validateIndex(disk);
      if (disk.metadata.scopeId !== scope.id || disk.metadata.revision !== index.metadata.revision || signature(disk.files) !== signature(index.files)) reasons.push('磁盘缓存与当前有效索引不一致');
    } catch { reasons.push('磁盘缓存缺失、损坏或 Schema 无效'); }
    const [snapshot, state, fingerprint] = await Promise.all([capture(scope), gitState(scope.worktree.path), this.compilationFingerprint(scope)]);
    if (signature(snapshot.files) !== signature(index.files)) reasons.push('文件新增、修改、删除或重命名');
    if (state.head !== index.metadata.gitHead || state.statusHash !== index.metadata.gitStatusHash) reasons.push('Git HEAD 或工作区状态已变化');
    if (fingerprint !== index.metadata.compilationFingerprint) reasons.push('解析器或程序集上下文已变化');
    if (index.metadata.configFingerprint !== contentHash(this.config.fingerprint + '|' + scope.id)) reasons.push('扫描配置已变化');
    if (reasons.length) this.publish(scope, { ...scope.status, state: 'stale', message: reasons.join('；') });
    else this.publish(scope, { ...scope.status, state: 'synced', message: '缓存、源码哈希和 Git 状态一致' });
    return { valid: reasons.length === 0, reasons, revision: index.metadata.revision };
  }

  async evidence(id: string, evidenceId: string): Promise<{ evidence: Evidence; content: string; contextStartLine: number; stale: boolean; revision: string }> {
    const scope = this.scope(id); const index = scope.index;
    if (!index) throw Object.assign(new Error('索引尚未就绪'), { statusCode: 409 });
    const evidence = index.evidence.find(item => item.id === evidenceId);
    if (!evidence || !index.files.some(file => file.path === evidence.filePath) || !createFilePolicy(scope.project.include, scope.project.exclude).included(evidence.filePath)) {
      throw Object.assign(new Error('证据不存在于当前授权作用域'), { statusCode: 404 });
    }
    try {
      const buffer = await readAuthorized(scope.worktree.path, evidence.filePath);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (contentHash(content) !== evidence.fileHash) return { evidence, content: evidence.excerpt ?? '', contextStartLine: evidence.startLine, stale: true, revision: index.metadata.revision };
      const lines = content.split(/\r?\n/); const start = Math.max(0, evidence.startLine - 5);
      return { evidence, content: lines.slice(start, Math.min(lines.length, start + 100, evidence.endLine + 5)).join('\n').slice(0, 20000),
        contextStartLine: start + 1, stale: false, revision: index.metadata.revision };
    } catch (error) {
      if (error instanceof AccessError) throw error;
      return { evidence, content: evidence.excerpt ?? '', contextStartLine: evidence.startLine, stale: true, revision: index.metadata.revision };
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.workerPool?.close();
    await Promise.all([...this.scopes.values()].map(async scope => {
      if (scope.debounce) clearTimeout(scope.debounce);
      if (scope.poll) clearInterval(scope.poll);
      await scope.watcher?.close(); await scope.queue;
    }));
    this.removeAllListeners();
  }
}
