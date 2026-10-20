import path from 'node:path';
import { lstat, mkdir, realpath, readFile, stat } from 'node:fs/promises';

export class AccessError extends Error {
  readonly statusCode = 403;
}

export function canonical(value: string): string {
  const absolute = path.resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(canonical(root), canonical(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function ensureCacheDirectory(directory: string, toolRoot: string): Promise<string> {
  if (!isWithin(toolRoot, directory) || canonical(toolRoot) === canonical(directory)) throw new AccessError('缓存必须位于工具目录的独立子目录');
  let current = toolRoot;
  for (const component of path.relative(toolRoot, directory).split(path.sep)) {
    current = path.join(current, component);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new AccessError('缓存路径包含符号链接、目录联接或普通文件；未创建缓存');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  // Validate ancestors before mkdir: checking realpath after mkdir could already
  // have created a directory inside a target repository through a junction.
  await mkdir(directory, { recursive: true });
  const resolved = await realpath(directory);
  if (!isWithin(await realpath(toolRoot), resolved)) throw new AccessError('缓存真实路径越过工具目录');
  return resolved;
}

export function relativeSourcePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.includes(':') || path.isAbsolute(value)) {
    throw new AccessError('无效的项目内文件路径');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new AccessError('路径越过项目安全边界');
  return parts.join('/');
}

// Every component is checked: lexical containment alone does not stop NTFS junctions.
export async function authorizedFile(root: string, relativePath: string): Promise<string> {
  const normalized = relativeSourcePath(relativePath);
  let current = root;
  for (const part of normalized.split('/')) {
    current = path.join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new AccessError('不会读取符号链接或目录联接指向的文件');
  }
  const resolved = await realpath(current);
  if (!isWithin(root, resolved)) throw new AccessError('文件不在授权的工作目录中');
  if (!(await stat(resolved)).isFile()) throw new AccessError('源码证据必须指向普通文件');
  return resolved;
}

export async function readAuthorized(root: string, relativePath: string, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
  const resolved = await authorizedFile(root, relativePath);
  const size = (await stat(resolved)).size;
  if (size > maxBytes) throw new AccessError(`文件超过只读预览限制（${maxBytes} 字节）`);
  const value = await readFile(resolved);
  if (value.length > maxBytes) throw new AccessError('文件在读取期间超过大小限制');
  return value;
}

// Configuration globs support *, ** and ?. They never parse program semantics.
export function globExpression(pattern: string): RegExp {
  const source = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  if (source.startsWith('/') || source.includes('../') || /[{}\[\]]/.test(source)) {
    throw new Error(`不支持的扫描 glob：${pattern}；请使用 *, **, ?`);
  }
  let result = '^';
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (character === '*' && source[i + 1] === '*') {
      i++;
      if (source[i + 1] === '/') { i++; result += '(?:.*/)?'; }
      else result += '.*';
    } else if (character === '*') result += '[^/]*';
    else if (character === '?') result += '[^/]';
    else result += character.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp(result + '$');
}

const protectedDirectories = new Set(['.git', 'node_modules', 'Library', 'Temp', 'Logs', 'obj', 'bin', '.cache', '.tools', 'UserSettings', 'artifacts']);
export function createFilePolicy(include: string[], exclude: string[]) {
  const expand = (pattern: string): RegExp[] => /[*?]/.test(pattern) ? [globExpression(pattern)]
    : [globExpression(pattern.replace(/\/$/, '')), globExpression(pattern.replace(/\/$/, '') + '/**')];
  const inclusions = include.flatMap(expand);
  const exclusions = exclude.flatMap(expand);
  const ignored = (relativePath: string, directory = false): boolean => {
    const normalized = relativePath.replaceAll('\\', '/');
    if (normalized.split('/').some(part => protectedDirectories.has(part))) return true;
    return exclusions.some(pattern => pattern.test(normalized) || (directory && pattern.test(normalized + '/')));
  };
  return {
    ignored,
    included: (relativePath: string) => !ignored(relativePath) && inclusions.some(pattern => pattern.test(relativePath.replaceAll('\\', '/'))),
  };
}
