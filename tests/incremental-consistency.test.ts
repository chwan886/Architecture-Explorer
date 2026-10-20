import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { IndexManager, loadConfig, TOOL_ROOT } from '../packages/indexer/src/index.ts';
import type { ArchitectureIndex } from '../packages/schema/src/index.ts';

function semantic(index: ArchitectureIndex) {
  const ordered=<T extends {id:string}>(items:T[])=>items.map(item=>({ ...item, ...('evidenceIds' in item ? {evidenceIds:[...(item as T & {evidenceIds:string[]}).evidenceIds].sort()}: {}) })).sort((a,b)=>a.id.localeCompare(b.id));
  return {
    nodes:ordered(index.nodes),edges:ordered(index.edges),evidence:ordered(index.evidence),
    files:[...index.files].sort((a,b)=>a.path.localeCompare(b.path)),
    diagnostics:ordered(index.diagnostics.filter(d=>d.code!=='incremental-parser'))
  };
}
test('真实双语言变更、文件移动及符号重命名后，增量与全量索引语义一致', {timeout:60000}, async()=>{
  const tempRoot=path.join(TOOL_ROOT,'.tmp');await mkdir(tempRoot,{recursive:true});
  const directory=await mkdtemp(path.join(tempRoot,'consistency-'));const root=path.join(directory,'target');await mkdir(root);
  const put=(name:string,text:string)=>writeFile(path.join(root,name),text);
  await put('Actor.cs','public class Actor { public int Health; public void Hit(){ Health--; } }');
  await put('View.cs','class View { int Read(Actor a) => a.Health; }');
  await put('actor.py',"def hit(a):\n    a['hp'] -= 1\n");
  await put('reader.py','from actor import hit\ndef step(a):\n    hit(a)\n');
  const configPath=path.join(directory,'config.json');
  await writeFile(configPath,JSON.stringify({cacheDir:'cache',dotnet:path.join(TOOL_ROOT,'.tools/dotnet/dotnet.exe'),projects:[{id:'consistency',name:'双语言一致性夹具',root:'target',include:['**/*.cs','**/*.py'],exclude:[]}]}));
  const manager=new IndexManager(await loadConfig(configPath));
  try{
    await manager.initialize();await manager.requestScan('consistency:primary');const scope=manager.scope('consistency:primary');
    assert.equal(scope.status.state,'synced',scope.status.message);
    await put('Actor.cs','public class Actor { public int Vitality; public void Damage(){ Vitality -= 2; } }');
    await rename(path.join(root,'Actor.cs'),path.join(root,'Renamed.cs'));
    await put('View.cs','class View { int Read(Actor a) { a.Damage(); return a.Vitality; } }');
    await rename(path.join(root,'actor.py'),path.join(root,'creature.py'));
    await put('creature.py',"def damage(a):\n    a['hp'] -= 2\n");
    await put('reader.py','from creature import damage\ndef step(a):\n    damage(a)\n');
    await put('new.py','from reader import step\n');
    await manager.requestScan(scope.id);assert.equal(scope.status.state,'synced',scope.status.message);
    const incremental=semantic(scope.index!);
    assert.ok(!scope.index!.nodes.some(n=>n.qualifiedName==='Actor.Health'||n.qualifiedName==='Actor.Hit()'));
    assert.ok(!scope.index!.files.some(f=>f.path==='Actor.cs'||f.path==='actor.py'));
    await manager.requestScan(scope.id,true);assert.equal(scope.status.state,'synced',scope.status.message);
    assert.deepEqual(semantic(scope.index!),incremental);
  }finally{
    await manager.close();assert.ok(directory.startsWith(path.join(TOOL_ROOT,'.tmp','consistency-')));
    await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:50});
  }
});
