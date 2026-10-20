import { ArrowUpRight, FileCode2 } from 'lucide-react';
import type { EvidenceContent } from './api';

function CodeLine({ line }: { line: string }) {
  const tokens = line.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*|#.*|\b(?:public|private|protected|internal|static|readonly|class|interface|struct|enum|void|int|string|float|double|bool|var|new|return|if|else|for|foreach|while|switch|case|break|continue|try|catch|throw|using|namespace|this|base|async|await|def|from|import|as|self|with|in|not|and|or|is|None|True|False|true|false|null|lambda|yield|raise|except|finally|pass)\b|\b\d+(?:\.\d+)?\b)/g);
  return <>{tokens.map((token, index) => index % 2 === 0 ? token : <span key={index} className={token.startsWith('"') || token.startsWith("'") ? 'syntax-string' : token.startsWith('//') || token.startsWith('#') ? 'syntax-comment' : /^\d/.test(token) ? 'syntax-number' : 'syntax-keyword'}>{token}</span>)}</>;
}

export default function SourcePreview({ source, rootPath, nodeId }: { source: EvidenceContent; rootPath: string; nodeId?: string }) {
  return <><div className="source-location" data-evidence-id={source.evidence.id} data-node-id={nodeId || ''}><FileCode2 size={12} /><span title={source.evidence.filePath}>{source.evidence.filePath}</span><span className="source-line-location">L{source.evidence.startLine}–{source.evidence.endLine}</span>{source.stale && <span className="warning-text">源码已变化 · 证据过期</span>}{rootPath && <a title="使用 VS Code 打开此授权文件" href={`vscode://file/${encodeURI(`${rootPath.replaceAll('\\', '/')}/${source.evidence.filePath}`)}:${source.evidence.startLine}:${source.evidence.startColumn}`}><ArrowUpRight size={12} />VS Code</a>}</div><div className="source-code">{source.content.split('\n').map((line, index) => { const startLine = source.contextStartLine ?? source.startLine; const number = startLine === undefined ? undefined : startLine + index; return <div className={`code-line ${number !== undefined && number >= source.evidence.startLine && number <= source.evidence.endLine ? 'highlight' : ''}`} key={index}><span className="line-number">{number ?? ''}</span><code><CodeLine line={line.replace(/\r$/, '') || ' '} /></code></div>; })}</div></>;
}
