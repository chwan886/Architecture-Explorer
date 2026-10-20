import test from 'node:test';
import assert from 'node:assert/strict';
import { stableId, contentHash, SCHEMA_VERSION } from '../packages/schema/src/index';
import type { ArchitectureIndex } from '../packages/schema/src/index';
import { validateAnalyzerResult, validateIndex } from '../packages/schema/src/validate';

function snapshot(): ArchitectureIndex {
  const hash = contentHash('class Actor {}');
  return {
    metadata: {schemaVersion:SCHEMA_VERSION, analyzerVersion:'0.1.0', projectId:'p',projectName:'P',worktreeId:'w',scopeId:'p:w',rootPath:'C:/project',gitHead:'',gitBranch:'',gitDirty:false,gitStatusHash:'',generatedAt:new Date().toISOString(),configFingerprint:'config',compilationFingerprint:'',revision:'r',fileCount:1,durationMs:0,changedFiles:1,reusedFiles:0,coverage:{languages:['csharp'],limitations:[]}},
    nodes:[{id:'a',kind:'class',label:'Actor',qualifiedName:'Actor',language:'csharp',filePath:'Actor.cs',evidenceIds:['proof']}],
    edges:[], flows:[], diagnostics:[], files:[{path:'Actor.cs',hash,size:14,language:'csharp'}],
    evidence:[{id:'proof',filePath:'Actor.cs',startLine:1,startColumn:1,endLine:1,endColumn:15,fileHash:hash,rule:'declaration'}]
  };
}
test('稳定身份不含位置，内容摘要按源字节改变',()=>{
  assert.equal(stableId('p:w','method','Actor.Hit(int)'),stableId('p:w','method','Actor.Hit(int)'));
  assert.notEqual(stableId('p:w1','method','Actor.Hit(int)'),stableId('p:w2','method','Actor.Hit(int)'));
  assert.notEqual(contentHash('a'),contentHash('a\n'));
});
test('索引验证证据、关系端点与快照一致性',()=>{
  const value=snapshot(); assert.doesNotThrow(()=>validateIndex(value));
  value.edges.push({id:'bad',source:'a',target:'missing',kind:'calls',confidence:'static-confirmed',rule:'semantic',evidenceIds:['proof']});
  assert.throws(()=>validateIndex(value),/端点/);
});
test('证据不能穿越目录或引用不同版本的源码',()=>{
  const value=snapshot();value.evidence[0].fileHash=contentHash('changed');
  assert.throws(()=>validateIndex(value),/哈希/);
  value.evidence[0].filePath='../secret'; assert.throws(()=>validateIndex(value),/路径/);
});
test('不能将静态分析冒充运行时验证或发布重复节点',()=>{
  const value=snapshot();value.edges.push({id:'bad',source:'a',target:'a',kind:'calls',confidence:'runtime-verified',rule:'fake-runtime',evidenceIds:['proof']});
  assert.throws(()=>validateIndex(value),/运行时/);
  value.edges=[];value.nodes.push({...value.nodes[0]}); assert.throws(()=>validateIndex(value),/重复/);
});
test('分析器损坏输出和无源码关系被拒绝',()=>{
  assert.throws(()=>validateAnalyzerResult({nodes:[],edges:[],evidence:[]}),/Schema/);
  const value=snapshot();value.edges.push({id:'bad',source:'a',target:'a',kind:'reads',confidence:'static-confirmed',rule:'fake',evidenceIds:[]});
  assert.throws(()=>validateIndex(value),/缺少证据/);
});
test('拒绝父级循环和悬空模块，避免分层地图失去边界',()=>{
  const value=snapshot();value.nodes[0].parentId='a';assert.throws(()=>validateIndex(value),/循环/);
  delete value.nodes[0].parentId;value.nodes[0].moduleId='missing';assert.throws(()=>validateIndex(value),/模块/);
});
