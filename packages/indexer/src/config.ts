import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { ExplorerConfig, ProjectConfig } from '../../schema/src/index.ts';
import { contentHash } from '../../schema/src/index.ts';
import { canonical, createFilePolicy, isWithin } from './security.ts';

export const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export interface LoadedConfig extends ExplorerConfig {
  cacheDir: string;
  configPath: string;
  fingerprint: string;
  toolRoot: string;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${name} 必须为字符串数组`);
  return value;
}

export async function loadConfig(configFile = process.env.EXPLORER_CONFIG ?? path.join(TOOL_ROOT, 'config/local.json')): Promise<LoadedConfig> {
  const configPath = path.resolve(configFile);
  let input: unknown;
  try { input = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`无法读取项目配置 ${configPath}：${error instanceof Error ? error.message : String(error)}`); }
  if (!input || typeof input !== 'object' || !Array.isArray((input as ExplorerConfig).projects)) throw new Error('配置缺少 projects 数组');
  const raw = input as ExplorerConfig;
  if (!raw.projects.length) throw new Error('至少需要配置一个明确授权的项目');
  const parent = path.dirname(configPath);
  const projects: ProjectConfig[] = [];
  const ids = new Set<string>();
  for (const project of raw.projects) {
    if (!project || !/^[a-zA-Z0-9_-]{1,64}$/.test(project.id) || ids.has(project.id)) throw new Error('项目 ID 必须唯一且仅包含字母、数字、下划线或短横线');
    ids.add(project.id);
    if (typeof project.name !== 'string' || !project.name.trim() || typeof project.root !== 'string') throw new Error(`项目 ${project.id} 缺少名称或路径`);
    const root = await realpath(path.resolve(parent, project.root));
    if (!(await stat(root)).isDirectory()) throw new Error(`项目 ${project.id} 的 root 不是目录`);
    const include = strings(project.include, `${project.id}.include`);
    if (!include.length) throw new Error('扫描 include 不能为空');
    const exclude = strings(project.exclude ?? [], `${project.id}.exclude`);
    createFilePolicy(include, exclude);
    const worktrees = await Promise.all(strings(project.worktrees ?? [], `${project.id}.worktrees`).map(item => realpath(path.resolve(parent, item))));
    const references = strings(project.references ?? [], `${project.id}.references`).map(item => path.resolve(parent, item));
    if (references.some(item => path.extname(item).toLowerCase() !== '.dll')) throw new Error('C# 显式 references 只接受程序集元数据 .dll');
    projects.push({ id: project.id, name: project.name.trim(), root, worktrees, include, exclude,
      references, defines: strings(project.defines ?? [], `${project.id}.defines`) });
  }
  const cacheDir = raw.cacheDir ? path.resolve(parent, raw.cacheDir) : path.join(TOOL_ROOT, '.cache');
  if (!isWithin(TOOL_ROOT, cacheDir) || canonical(cacheDir) === canonical(TOOL_ROOT)) throw new Error('缓存必须位于 Architecture Explorer 工具目录内部的独立子目录');
  if (projects.some(project => [project.root, ...(project.worktrees ?? [])].some(root => isWithin(root, cacheDir)))) throw new Error('缓存不能写入任何分析目标目录');
  const port = raw.port ?? 4310;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port 必须为 1024–65535 之间的整数');
  const executable = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw new Error('分析器运行时路径必须是非空字符串');
    return /[\\/]/.test(value) ? path.resolve(parent, value) : value;
  };
  const python = executable(raw.python); const dotnet = executable(raw.dotnet);
  return { projects, cacheDir, port, python, dotnet, configPath, toolRoot: TOOL_ROOT,
    fingerprint: contentHash(JSON.stringify({ projects, python, dotnet, schema: 1 })) };
}
