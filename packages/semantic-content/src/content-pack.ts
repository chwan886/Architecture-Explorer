import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readAuthorized } from '../../indexer/src/security.ts';
import { validateContentPack, type SemanticContentPack } from './seed-explanations.ts';

/** No directory argument means no content pack and no filesystem lookup. */
export async function loadContentPack(directory?: string): Promise<SemanticContentPack | undefined> {
  if (directory === undefined) return undefined;
  if (!directory.trim()) throw new Error('Content pack directory must be explicit');
  const root = await realpath(path.resolve(directory));
  if (!(await stat(root)).isDirectory()) throw new Error('Content pack path must be a directory');
  const bytes = await readAuthorized(root, 'content-pack.json', 512 * 1024);
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
  validateContentPack(value);
  return value;
}
