import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPrivateKey } from 'node:crypto';
import { createAppJwt, parseDevelopmentAppConfig, runDevelopmentApp, githubAppRequest } from './dev-app-auth.ts';
import { prepareTaskPush, runTaskPush } from './dev-app-git.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let phase='arguments';
const fail=(code:string):never=>{throw new Error(code);};
export async function assertUnlinkedPath(candidate:string):Promise<string> {
  if (!path.isAbsolute(candidate)) fail('ABSOLUTE_PATH_REQUIRED');
  const noLinks=async (absolute:string)=>{
    const base=path.parse(absolute).root;
    let cursor=base;
    for (const component of absolute.slice(base.length).split(path.sep).filter(Boolean)) {
      cursor=path.join(cursor,component);
      if ((await lstat(cursor)).isSymbolicLink()) fail('LINK_REJECTED');
    }
  };
  const absolute=path.resolve(candidate);
  await noLinks(absolute);
  const before=await lstat(absolute), canonical=await realpath(absolute);
  // Windows expands legitimate 8.3 names such as RUNNER~1 here. Prove the
  // identity and inspect both spellings instead of treating a spelling as proof.
  await noLinks(canonical);
  const after=await lstat(canonical), current=await lstat(absolute);
  if (before.dev!==after.dev || before.ino!==after.ino || before.dev!==current.dev || before.ino!==current.ino) fail('PATH_CHANGED');
  return canonical;
}

export async function readBoundedFile(candidate:string,limit:number):Promise<Buffer> {
  const absolute=await assertUnlinkedPath(candidate), before=await lstat(absolute);
  if (!before.isFile() || before.nlink!==1 || before.size<1 || before.size>limit) fail('FILE_REJECTED');
  const handle=await open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
    const opened=await handle.stat();
    if (opened.dev!==before.dev || opened.ino!==before.ino || opened.size!==before.size || opened.mtimeMs!==before.mtimeMs) fail('FILE_CHANGED');
    const buffer=Buffer.alloc(limit+1);
    const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
    const after=await lstat(absolute);
    if (bytesRead!==before.size || after.dev!==before.dev || after.ino!==before.ino || after.size!==before.size || after.mtimeMs!==before.mtimeMs) fail('FILE_CHANGED');
    return buffer.subarray(0,bytesRead);
  } finally {await handle.close();}
}

export function parseAppArguments(args:string[]):Record<string,string> {
  const allowed=new Set(['config-file','operation','key-file','working-directory','branch','expected-head','title','body-file','pr-number']);
  const result:Record<string,string>={};
  for (let i=0;i<args.length;i+=2) {
    const name=args[i]?.replace(/^--/,'');
    if (!args[i]?.startsWith('--') || !allowed.has(name) || result[name]!==undefined || !args[i+1] || args[i+1].startsWith('--')) fail('ARGUMENT_REJECTED');
    result[name]=args[i+1];
  }
  const fields:Record<string,string[]>={
    verify:[],push:['working-directory','branch','expected-head'],
    'pull-request':['branch','expected-head','title','body-file'],status:['expected-head','pr-number'],
  };
  const required=fields[result.operation];
  if (!required || !result['config-file'] || !result['key-file']) fail('ARGUMENT_REJECTED');
  const permitted=new Set(['config-file','key-file','operation',...required,...(result.operation==='pull-request'?['pr-number']:[])]);
  if (Object.keys(result).some(key=>!permitted.has(key)) || required.some(key=>!result[key])) fail('ARGUMENT_REJECTED');
  if (result['pr-number'] && !/^[1-9]\d{0,8}$/.test(result['pr-number'])) fail('ARGUMENT_REJECTED');
  return result;
}

async function main() {
  const args=parseAppArguments(process.argv.slice(2));
  phase='runtime';
  if (process.platform!=='win32') fail('WINDOWS_PREFLIGHT_REQUIRED');
  const locked=JSON.parse(await readFile(path.join(root,'toolchain.lock.json'),'utf8')).node.version;
  if (process.versions.node!==locked || process.env.EXPLORER_APP_NODE_VERSION!==locked) fail('LOCKED_NODE_REQUIRED');
  phase='configuration';
  const config=parseDevelopmentAppConfig(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedFile(args['config-file'],16384)).replace(/^\uFEFF/,'')));
  const options:any={operation:args.operation};
  if (args.branch) options.branch=args.branch;
  if (args['expected-head']) options.expectedHead=args['expected-head'];
  if (args['working-directory']) options.workingDirectory=args['working-directory'];
  if (args['pr-number']) options.prNumber=Number(args['pr-number']);
  if (args.title) {
    phase='pull-request-body';
    options.title=args.title;
    options.body=new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedFile(args['body-file'],65536));
    if (/-{5}BEGIN [A-Z0-9 ]+-{5}/.test(options.body)) fail('BODY_REJECTED');
  }
  // Validate all local Git state before reading the private key or issuing a token.
  phase='git-preflight';
  const plan=options.operation==='push'?await prepareTaskPush({repository:config.repository,baseBranch:config.baseBranch,
    workingDirectory:options.workingDirectory,branch:options.branch,expectedHead:options.expectedHead}):undefined;
  phase='key-preflight';
  let input='';
  for await (const chunk of process.stdin) {
    input+=chunk.toString();
    if (Buffer.byteLength(input)>16384) fail('ATTESTATION_TOO_LARGE');
  }
  const attestation=JSON.parse(input);
  if (attestation.schemaVersion!==1 || attestation.acl?.checked!==true || attestation.acl?.scope!=='directory-and-file' || attestation.acl?.linksRejected!==true) fail('PREFLIGHT_REQUIRED');
  const key=await assertUnlinkedPath(args['key-file']), keyDirectory=await assertUnlinkedPath(config.keyDirectory);
  for (let ancestor=keyDirectory;;) {
    try {await lstat(path.join(ancestor,'.git'));fail('KEY_MUST_BE_OUTSIDE_REPOSITORY');}
    catch (error) {if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
    const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent;
  }
  const relativeToRoot=path.relative(root,keyDirectory);
  if (!relativeToRoot || !relativeToRoot.startsWith('..')&&!path.isAbsolute(relativeToRoot)) fail('KEY_MUST_BE_OUTSIDE_REPOSITORY');
  if (key!==await assertUnlinkedPath(attestation.keyFile) || path.dirname(key).toLowerCase()!==keyDirectory.toLowerCase() || !key.toLowerCase().endsWith('.pem')) fail('KEY_REJECTED');
  const metadata=await lstat(key);
  if (metadata.size!==attestation.fileIdentity?.size || Math.trunc(metadata.mtimeMs)!==attestation.fileIdentity?.mtimeMs) fail('KEY_CHANGED');
  phase='key-read';
  const bytes=await readBoundedFile(key,65536);
  let privateKey;
  try {privateKey=createPrivateKey(bytes);} finally {bytes.fill(0);}
  phase='app-operation';
  const receipt=await runDevelopmentApp(config,options,{
    signJwt:()=>createAppJwt(privateKey,config.appId),request:githubAppRequest,
    preparePush:async()=>{if (!plan) fail('PUSH_PLAN_REQUIRED');return plan!;},push:runTaskPush,
  });
  console.log(JSON.stringify(receipt,null,2));
  if (receipt.outcome!=='passed') process.exitCode=1;
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(()=>{console.error(`App operation failed during ${phase}; no personal credential fallback is permitted. Check configuration, key permissions, runtime, and App installation.`);process.exitCode=1;});
}
