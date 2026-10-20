import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4310' } },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: { outDir: '../../dist', emptyOutDir: true },
});
