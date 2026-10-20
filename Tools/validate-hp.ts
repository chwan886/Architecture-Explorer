import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IndexManager, loadConfig, graph } from '../packages/indexer/src/index.ts';

// GameDemo02 acceptance story; project root still comes exclusively from configuration.
const config=await loadConfig();
const manager=new IndexManager(config);
try {
  await manager.initialize();
  const project=process.argv[2] ?? config.projects[0].id;
  const runtime=manager.scope(`${project}:primary`);
  await manager.requestScan(runtime.id);
  assert.equal(runtime.status.state,'synced',runtime.status.message);
  const index=runtime.index!;
  const damage=index.nodes.find(n=>n.language==='python'&&n.label==='damage'&&n.filePath?.endsWith('/sect_combat.py'));
  const hp=index.nodes.find(n=>n.language==='csharp'&&n.kind==='field'&&n.qualifiedName.endsWith('SectBattleActor.hp'));
  assert.ok(damage,'真实服务端 damage 方法必须存在');
  assert.ok(hp,'真实客户端 SectBattleActor.hp 字段必须存在');
  const byId=new Map(index.nodes.map(n=>[n.id,n]));
  const hpWrites=index.edges.filter(e=>e.source===damage.id&&e.kind==='writes'&&byId.get(e.target)?.label.includes("['hp']"));
  const hpHudReads=index.edges.filter(e=>e.target===hp.id&&e.kind==='reads'&&e.evidenceIds.some(id=>index.evidence.find(x=>x.id===id)?.filePath.endsWith('/SectGameHost.Theme.cs')));
  const callers=index.edges.filter(e=>e.target===damage.id&&e.kind==='calls'&&byId.get(e.source)?.label==='apply_hit');
  assert.ok(hpWrites.length,'damage 的字典 hp 写入必须有证据');
  assert.ok(hpHudReads.length,'HUD 对真实 hp 字段的读取必须有证据');
  assert.ok(callers.length,'apply_hit 到 damage 的静态调用必须有证据');
  const proofEdges=[...hpWrites,...hpHudReads,...callers];
  const proofs=[];
  for(const edge of proofEdges){
    assert.notEqual(edge.confidence,'runtime-verified');
    const evidenceId=edge.evidenceIds[0];assert.ok(evidenceId);
    const source=await manager.evidence(runtime.id,evidenceId);assert.equal(source.stale,false);
    proofs.push({kind:edge.kind,confidence:edge.confidence,source:byId.get(edge.source)?.qualifiedName,target:byId.get(edge.target)?.qualifiedName,file:source.evidence.filePath,line:source.evidence.startLine,rule:edge.rule});
  }
  const data=graph(index,{view:'data',rootId:hp.id,depth:1,limit:80});
  assert.ok(data.edges.some(e=>e.kind==='reads'));
  const verified=await manager.verify(runtime.id);assert.equal(verified.valid,true);
  const report={checkedAt:new Date().toISOString(),scope:runtime.id,metadata:index.metadata,counts:{nodes:index.nodes.length,edges:index.edges.length,evidence:index.evidence.length,diagnostics:index.diagnostics.length},proofs,dataGraph:{nodes:data.nodes.length,edges:data.edges.length,truncated:data.truncated},cacheVerification:verified,boundary:'以上是静态调用与访问证据；Python字典和C#DTO之间尚未自动建立已验证运行时数据流。'};
  await mkdir(config.cacheDir,{recursive:true});
  await writeFile(path.join(config.cacheDir,'validation-hp.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{await manager.close();}
