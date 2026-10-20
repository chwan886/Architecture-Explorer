import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { LoadedConfig } from '../../../packages/indexer/src/config.ts';
import { authorizedFile, canonical, ensureCacheDirectory, isWithin, readAuthorized } from '../../../packages/indexer/src/security.ts';
import { contentHash } from '../../../packages/schema/src/index.ts';
import { semanticRevision, validateDefinitions, validateOverlay } from '../../../packages/semantic-model/src/index.ts';
import type { SemanticDefinitionEnvelope, SemanticDefinitions, SemanticOverlay } from '../../../packages/semantic-model/src/types.ts';

const failure = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const decoder = new TextDecoder('utf-8', { fatal: true });
export class SemanticStore {
  constructor(readonly config: LoadedConfig) {}
  private paths(projectId: string, scopeId: string) {
    const project = this.config.projects.find(item => item.id === projectId);
    if (!project || !/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) throw failure('语义项目未授权', 403);
    const roots = [project.root, ...(project.worktrees ?? [])];
    const ids = roots.map(root => canonical(root) === canonical(project.root) ? 'primary' : `wt-${contentHash(canonical(root)).slice(0, 12)}`);
    const worktreeId = ids.find(id => scopeId === `${projectId}:${id}`);
    if (!worktreeId) throw failure('语义 Scope 不在明确授权的工作目录中', 403);
    const parent = `architecture/semantics/${projectId}`;
    const relative = `${parent}/worktrees/${worktreeId}.json`;
    const absolute = path.join(this.config.toolRoot, relative);
    if (this.config.projects.some(item => [item.root, ...(item.worktrees ?? [])].some(root => isWithin(root, absolute))))
      throw failure('语义覆盖文件不能写入分析目标目录', 403);
    return { definitions: `${parent}/definitions.json`, relative, absolute };
  }
  async read(projectId: string, scopeId: string): Promise<SemanticDefinitionEnvelope> {
    const paths = this.paths(projectId, scopeId);
    let definitions: SemanticDefinitions;
    try {
      const value: unknown = JSON.parse(decoder.decode(await readAuthorized(this.config.toolRoot, paths.definitions)));
      validateDefinitions(value); definitions = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      definitions = { schemaVersion: '1.0.0', projectId, flows: [] };
    }
    if (definitions.projectId !== projectId) throw failure('语义定义项目与授权项目不一致');
    const definitionRevision = semanticRevision(definitions);
    let overlay: SemanticOverlay;
    try {
      const value: unknown = JSON.parse(decoder.decode(await readAuthorized(this.config.toolRoot, paths.relative)));
      validateOverlay(value); overlay = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      overlay = { schemaVersion: '1.0.0', scopeId, baseDefinitionRevision: definitionRevision, flowOverrides: [], reviews: [], history: [] };
    }
    if (overlay.scopeId !== scopeId) throw failure('语义覆盖文件来自其他 Scope', 403);
    const overrides = new Map(overlay.flowOverrides.map(flow => [flow.id, flow]));
    const effectiveFlows = definitions.flows.map(flow => overrides.get(flow.id) ?? flow);
    const originalIds = new Set(definitions.flows.map(flow => flow.id));
    effectiveFlows.push(...overlay.flowOverrides.filter(flow => !originalIds.has(flow.id)));
    return { definitions, overlay, definitionRevision, overlayRevision: semanticRevision(overlay), effectiveFlows };
  }
  async save(projectId: string, scopeId: string, expectedOverlayRevision: string,
    transform: (overlay: SemanticOverlay) => SemanticOverlay, beforeCommit?: () => Promise<void>): Promise<SemanticDefinitionEnvelope> {
    const paths = this.paths(projectId, scopeId);
    const directory = await ensureCacheDirectory(path.dirname(paths.absolute), this.config.toolRoot);
    const lockPath = path.join(directory, `${path.basename(paths.absolute)}.lock`);
    const token = `${process.pid}:${randomUUID()}`;
    let lock;
    try { lock = await open(lockPath, 'wx'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw failure('另一个窗口或进程正在保存语义覆盖，请稍后重试', 409); throw error; }
    const temporary = path.join(directory, `${path.basename(paths.absolute)}.${randomUUID()}.tmp`);
    try {
      await lock.writeFile(token); await lock.close();
      const current = await this.read(projectId, scopeId);
      if (expectedOverlayRevision !== current.overlayRevision) throw failure('语义覆盖已变化；保留草稿并重新读取后合并', 409);
      const next = transform(structuredClone(current.overlay));
      if (next.scopeId !== scopeId) throw failure('不能更换语义覆盖的授权 Scope', 403);
      const changed = next.flowOverrides.filter(flow => {
        const previous = current.overlay.flowOverrides.find(item => item.id === flow.id);
        return !previous || semanticRevision(flow) !== semanticRevision(previous);
      });
      const removed = current.overlay.flowOverrides.filter(flow => !next.flowOverrides.some(item => item.id === flow.id));
      const affected = [...new Set([...changed.map(flow => flow.id), ...removed.map(flow => flow.id),
        ...next.reviews.filter(review => !current.overlay.reviews.some(previous => JSON.stringify(previous) === JSON.stringify(review))).map(review => review.flowId),
        ...current.overlay.reviews.filter(review => !next.reviews.some(item => JSON.stringify(item) === JSON.stringify(review))).map(review => review.flowId)])];
      const supersededIds = removed.flatMap(flow => [flow.id, ...flow.groups.map(group => group.id), ...flow.steps.map(step => step.id)]);
      for (const flow of changed) {
        const previous = current.effectiveFlows.find(item => item.id === flow.id);
        if (previous) supersededIds.push(...previous.groups.filter(group => !flow.groups.some(item => item.id === group.id)).map(group => group.id));
      }
      // Audit history is store-owned. A client transform cannot erase or forge it.
      next.history = [...current.overlay.history, { id: randomUUID(), at: new Date().toISOString(), operation: changed.length || removed.length ? 'edit-flow' : 'review',
        flowId: affected[0] ?? current.effectiveFlows[0]?.id ?? 'document', previousRevision: current.overlayRevision, supersededIds: [...new Set(supersededIds)] }].slice(-100);
      next.baseDefinitionRevision = current.definitionRevision;
      validateDefinitions(current.definitions); validateOverlay(next);
      try { await authorizedFile(this.config.toolRoot, paths.relative); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // Revalidate ancestors before replacement; never traverse a junction for writes.
      await ensureCacheDirectory(directory, this.config.toolRoot);
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
      if (beforeCommit) await beforeCommit();
      const latest = await this.read(projectId, scopeId);
      if (latest.definitionRevision !== current.definitionRevision) throw failure('基础解释在保存期间变化，请保留草稿并重新读取', 409);
      if (latest.overlayRevision !== current.overlayRevision) throw failure('语义覆盖在保存期间变化，未替换现有文件', 409);
      await rename(temporary, paths.absolute);
      return await this.read(projectId, scopeId);
    } finally {
      await lock.close().catch(() => {}); await unlink(temporary).catch(() => {});
      if (await readFile(lockPath, 'utf8').catch(() => '') === token) await unlink(lockPath);
    }
  }
}
