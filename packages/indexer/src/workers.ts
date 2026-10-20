import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import type { AnalyzerRequest, AnalyzerResult } from '../../schema/src/index.ts';
import { contentHash } from '../../schema/src/index.ts';
import { validateAnalyzerResult } from '../../schema/src/validate.ts';
import type { LoadedConfig } from './config.ts';

export async function runWorker(language: 'python' | 'csharp', input: AnalyzerRequest, config: LoadedConfig): Promise<AnalyzerResult> {
  const file = language === 'python' ? path.join(config.toolRoot, 'analyzers/python/analyze.py')
    : path.join(config.toolRoot, 'analyzers/csharp/bin/Release/net10.0/ArchitectureExplorer.Analyzers.dll');
  try { await stat(file); } catch { throw new Error(`${language} 分析器尚未构建或不可用：${file}`); }
  const executable = language === 'python' ? (config.python ?? 'python') : (config.dotnet ?? 'dotnet');
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, language === 'python' ? ['-B', file] : [file], {
      cwd: config.toolRoot, windowsHide: true, shell: false,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(stdout); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${language} 分析超时（120 秒），保留上次有效索引`)); }, 120000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > 64 * 1024 * 1024) { child.kill(); finish(new Error('分析器输出超出预算')); }
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    child.on('error', error => finish(new Error(`无法启动 ${language} 分析器：${error.message}`)));
    child.stdin.on('error', () => { /* The exit handler supplies a bounded diagnostic. */ });
    child.on('close', code => finish(code === 0 ? undefined : new Error(`${language} 分析失败（${code}）：${stderr.slice(0, 1500)}`)));
    child.stdin.end(JSON.stringify(input));
  });
  let result: unknown;
  try { result = JSON.parse(output.replace(/^\uFEFF/, '')); } catch { throw new Error(`${language} 分析器没有输出有效的单个 JSON`); }
  validateAnalyzerResult(result);
  return result;
}

interface Pending {
  resolve: (result: AnalyzerResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface WorkerProcess {
  child: ChildProcessWithoutNullStreams;
  fingerprint: string;
  output: string;
  errors: string;
  pending?: Pending;
}

// Long-lived workers cache syntax trees by scope/path/hash. Every request still binds
// the complete semantic context, so unchanged parses never imply unchanged semantics.
export class WorkerPool {
  private processes = new Map<string, WorkerProcess>();
  constructor(private config: LoadedConfig) {}

  private terminate(key: string, message: string): void {
    const worker = this.processes.get(key); if (!worker) return;
    this.processes.delete(key);
    if (worker.pending) { clearTimeout(worker.pending.timer); worker.pending.reject(new Error(message)); worker.pending = undefined; }
    worker.child.stdin.end(); worker.child.kill();
  }

  async run(language: 'python' | 'csharp', input: AnalyzerRequest): Promise<AnalyzerResult> {
    const key = `${input.scopeId}|${language}`;
    const file = language === 'python' ? path.join(this.config.toolRoot, 'analyzers/python/analyze.py')
      : path.join(this.config.toolRoot, 'analyzers/csharp/bin/Release/net10.0/ArchitectureExplorer.Analyzers.dll');
    let artifact: Buffer;
    try { artifact = await readFile(file); } catch { throw new Error(`${language} 分析器尚未构建：${file}`); }
    const fingerprint = contentHash(artifact);
    let worker = this.processes.get(key);
    if (worker && worker.fingerprint !== fingerprint) { this.terminate(key, '分析器已更新，旧进程失效'); worker = undefined; }
    if (!worker) {
      const executable = language === 'python' ? this.config.python ?? 'python' : this.config.dotnet ?? 'dotnet';
      const child = spawn(executable, language === 'python' ? ['-B', file, '--persistent'] : [file, '--persistent'], {
        cwd: this.config.toolRoot, windowsHide: true, shell: false, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      worker = { child, fingerprint, output: '', errors: '' }; this.processes.set(key, worker);
      const current = worker;
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        current.output += chunk;
        if (Buffer.byteLength(current.output) > 64 * 1024 * 1024) { this.terminate(key, '持久分析器输出超出 64 MiB 预算'); return; }
        let newline = current.output.indexOf('\n');
        while (newline >= 0) {
          const line = current.output.slice(0, newline).replace(/^\uFEFF/, ''); current.output = current.output.slice(newline + 1);
          const pending = current.pending;
          if (line.trim() && pending) {
            current.pending = undefined; clearTimeout(pending.timer);
            try { const result: unknown = JSON.parse(line); validateAnalyzerResult(result); pending.resolve(result); }
            catch (error) { pending.reject(new Error((error instanceof Error ? error.message : String(error)).slice(0, 2400))); }
          } else if (line.trim()) { this.terminate(key, '持久分析器在没有请求时输出数据'); return; }
          newline = current.output.indexOf('\n');
        }
      });
      child.stderr.on('data', (chunk: string) => { current.errors = (current.errors + chunk).slice(-8192); });
      child.stdin.on('error', () => { /* exit/error supplies the diagnostic */ });
      child.on('error', error => { if (this.processes.get(key) === current) this.terminate(key, `无法启动 ${language} 分析器：${error.message}`); });
      child.on('close', code => { if (this.processes.get(key) === current) this.terminate(key, `${language} 分析器退出（${code}）：${current.errors.slice(0, 1500)}`); });
    }
    if (worker.pending) throw new Error('同一作用域分析请求必须串行执行');
    return new Promise<AnalyzerResult>((resolve, reject) => {
      const timer = setTimeout(() => this.terminate(key, `${language} 分析超时（120 秒），保留上次有效索引`), 120000);
      worker!.pending = { resolve, reject, timer };
      worker!.child.stdin.write(JSON.stringify(input) + '\n');
    });
  }

  invalidate(scopeId: string): void {
    for (const key of this.processes.keys()) if (key.startsWith(scopeId + '|')) this.terminate(key, '完整扫描重置语法树缓存');
  }

  close(): void { for (const key of this.processes.keys()) this.terminate(key, '索引器正在关闭'); }
}
