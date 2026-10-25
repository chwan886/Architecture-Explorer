import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function apiTarget() {
  const selected = process.env.EXPLORER_CONFIG;
  const file = selected ? path.resolve(selected) : fileURLToPath(new URL('../../config/local.json', import.meta.url));
  let raw: unknown;
  try { raw = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) {
    if (!selected && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'http://127.0.0.1:4310';
    throw new Error(`Cannot read API port from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('API port configuration must be an object');
  const configured = (raw as Record<string, unknown>).port;
  const port = configured === undefined ? 4310 : configured;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('API port must be an integer between 1024 and 65535');
  return `http://127.0.0.1:${port}`;
}

export default defineConfig(async ({ command }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': command === 'serve' ? await apiTarget() : 'http://127.0.0.1:4310' } },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: { outDir: '../../dist', emptyOutDir: true },
}));
