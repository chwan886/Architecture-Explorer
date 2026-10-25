import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const blank = value => value.replace(/[^\r\n]/g, ' ');
function escaped(text, index) {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

function prose(source) {
  let fence;
  let text = source.split('\n').map(line => {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && opening) { fence = opening[1]; return blank(line); }
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = undefined;
      return blank(line);
    }
    return line;
  }).join('\n').replace(/<!--[\s\S]*?-->/g, blank);
  // Match complete backtick runs so nested or longer code delimiters work.
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '`' || escaped(text, index)) continue;
    let end = index + 1;
    while (text[end] === '`') end++;
    const delimiter = text.slice(index, end);
    let close = text.indexOf(delimiter, end);
    while (close !== -1 && (text[close - 1] === '`' || text[close + delimiter.length] === '`')) close = text.indexOf(delimiter, close + delimiter.length);
    if (close === -1) { index = end - 1; continue; }
    const stop = close + delimiter.length;
    text = text.slice(0, index) + blank(text.slice(index, stop)) + text.slice(stop);
    index = stop - 1;
  }
  return text;
}

function destinationAt(text, start) {
  if (text[start] === '<') {
    for (let index = start + 1; index < text.length && text[index] !== '\n'; index++) {
      if (text[index] === '>' && !escaped(text, index)) return text.slice(start + 1, index);
    }
    return undefined;
  }
  let depth = 0;
  let end = start;
  for (; end < text.length; end++) {
    const character = text[end];
    if (escaped(text, end)) continue;
    if (character === '(') depth++;
    else if (character === ')') { if (!depth) break; depth--; }
    else if (/\s/.test(character)) break;
  }
  return text.slice(start, end);
}

export function markdownDestinations(source) {
  const text = prose(source);
  const links = [];
  const add = (destination, index) => {
    if (destination) links.push({ destination: destination.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, '$1'), line: text.slice(0, index).split('\n').length });
  };
  // This also handles images and labels containing nested brackets.
  for (const match of text.matchAll(/\]\(\s*/g)) {
    if (!escaped(text, match.index)) add(destinationAt(text, match.index + match[0].length), match.index);
  }
  // Reference destinations are checked once, regardless of reference style.
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*/gm)) add(destinationAt(text, match.index + match[0].length), match.index);
  for (const match of text.matchAll(/<(?:a|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["'][^>]*>/gi)) add(match[1], match.index);
  return links;
}

export function checkLinks(root, file, source) {
  const errors = [];
  let checked = 0;
  for (const link of markdownDestinations(source)) {
    if (/^(?:#|\/\/|[a-z][a-z0-9+.-]*:)/i.test(link.destination)) continue;
    let relative;
    try { relative = decodeURIComponent(link.destination.split(/[?#]/, 1)[0]); }
    catch { errors.push({ ...link, reason: 'Invalid URL encoding' }); continue; }
    if (!relative) continue;
    checked++;
    const target = relative.startsWith('/') ? path.resolve(root, '.' + relative) : path.resolve(root, path.dirname(file), relative);
    const boundary = path.relative(root, target);
    if (boundary === '..' || boundary.startsWith('..' + path.sep) || path.isAbsolute(boundary)) errors.push({ ...link, reason: 'Local link escapes the repository' });
    else if (!existsSync(target)) errors.push({ ...link, reason: 'Local destination does not exist' });
  }
  return { checked, errors };
}

function main() {
  const root = process.cwd();
  // Include pending documentation locally; ignored build/runtime trees never
  // enter the inventory. This is read-only and changes no Git configuration.
  const files = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    .split('\0').filter(file => /\.md$/i.test(file) && existsSync(path.join(root, file)));
  let checked = 0;
  let failed = 0;
  for (const file of new Set(files)) {
    const result = checkLinks(root, file, readFileSync(path.join(root, file), 'utf8'));
    checked += result.checked;
    for (const error of result.errors) { console.error(`${file}:${error.line}: ${error.reason}: ${error.destination}`); failed++; }
  }
  console.log(`Checked ${checked} local links in ${new Set(files).size} Markdown files; ${failed} errors.`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
