// Synthetic fixtures only; no real API key, model asset or personal preset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { rhTransportConfig, rhPrepareLocalGraph, rhCreateTask, rhQueryTask } from './transport.mjs';
import { applyPatch } from './apply.mjs';
const root = new URL('../../', import.meta.url);
const sourcePath = new URL('index.upstream.js', root);
const source = fs.readFileSync(fs.existsSync(sourcePath) ? sourcePath : new URL('index.js', root), 'utf8');
const vmContext = vm.createContext({ console, Math });
vm.runInContext(source.slice(source.indexOf('function buildRunningHubWorkflow('), source.indexOf('async function generateRunningHubImage(')), vmContext);
const rawGraph = () => ({
  '51': { class_type:'CLIPTextEncode', inputs: { text: '2D illustration, %prompt%', clip:['56',0] } },
  '52': { class_type:'EmptyLatentImage', inputs: { width:'%width%',height:'%height%',batch_size:1 } },
  '53': { class_type:'KSampler', inputs: { seed:'%seed%',steps:8,cfg:1,scheduler:'simple',model:['108',0],positive:['51',0],negative:['77',0],latent_image:['52',0] } },
  '56': { class_type:'CLIPLoader', inputs: {clip_name:'synthetic-text-encoder.safetensors'} },
  '77': { class_type:'ConditioningZeroOut',inputs:{conditioning:['51',0]} },
  '97': { class_type:'UNETLoader', inputs:{unet_name:'synthetic-base.safetensors'} },
  '107': { class_type:'LoraLoaderModelOnly',inputs:{model:['97',0],lora_name:'synthetic-anime.safetensors',strength_model:0.9} },
  '108': { class_type:'LoraLoaderModelOnly',inputs:{model:['107',0],lora_name:'synthetic-disabled.safetensors',strength_model:0} },
});
function fixture(local = true) {
  const graph = rawGraph();
  if(local) graph._meta = {st_chatu8_runninghub:{version:1,mode:'local'}};
  const rawJson = JSON.stringify(graph);
  const built = vmContext.buildRunningHubWorkflow(rawJson,'A woman near a street.','unused',{width:1536,height:1024,seed:42});
  return {rawJson,promptObj:JSON.parse(JSON.stringify(built.promptObj)),workflowId:'123456789',apiKey:'TEST-ONLY-KEY',payload:{nodeInfoList:[],addMetadata:true,usePersonalQueue:false}};
}
const reply = (data, status = 200) => ({ok:status>=200&&status<300,status,json:async()=>data});
function spy(data, status = 200) {
  const calls = [];
  const fetchImpl = async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return reply(data,status);};
  return {calls,fetchImpl};
}
const okCreate = {code:0,data:{taskId:'2099999999999999999',taskStatus:'QUEUED'}};

test('reproduce upstream bug: static LoRA, weight, steps are absent from nodeInfoList',()=>{
  const f=fixture(false);
  const list=vmContext.extractNodeInfoListFromWorkflow(f.rawJson,f.promptObj);
  assert.deepEqual(Array.from(list,x=>`${x.nodeId}.${x.fieldName}`).sort(),['51.text','52.height','52.width','53.seed']);
});
test('default mode is cloud and explicit cloud remains supported',()=>{
  assert.equal(rhTransportConfig('{}').mode,'cloud');
  assert.equal(rhTransportConfig({_meta:{st_chatu8_runninghub:{version:1,mode:'cloud'}}}).mode,'cloud');
});
test('legacy presets retain exact V2 request URL and body',async()=>{
  const f=fixture(false); f.payload.nodeInfoList=[{nodeId:'51',fieldName:'text',fieldValue:'test'}];
  const s=spy({taskId:'123',status:'QUEUED'});
  assert.equal((await rhCreateTask({...f,...s})).taskId,'123');
  assert.equal(s.calls[0].url,`https://www.runninghub.ai/openapi/v2/run/workflow/${f.workflowId}`);
  assert.deepEqual(s.calls[0].body,f.payload);
  assert.ok(!('workflow' in s.calls[0].body));
});
test('local mode transmits all static inputs and links, not local-template diff',async()=>{
  const f=fixture(); const s=spy(okCreate); const logs=[];
  const result=await rhCreateTask({...f,...s,log:x=>logs.push(x)});
  const req=s.calls[0];const graph=JSON.parse(req.body.workflow);
  assert.equal(req.url,'https://www.runninghub.ai/task/openapi/create');
  assert.equal(graph['107'].inputs.lora_name,'synthetic-anime.safetensors');
  assert.equal(graph['107'].inputs.strength_model,0.9);
  assert.equal(graph['108'].inputs.strength_model,0);
  assert.equal(graph['53'].inputs.steps,8);
  assert.equal(graph['53'].inputs.cfg,1);
  assert.deepEqual(graph['53'].inputs.model,['108',0]);
  assert.equal(graph['51'].inputs.text,'2D illustration, A woman near a street.');
  assert.ok(!('_meta' in graph));
  assert.equal(result.taskId,'2099999999999999999');
  assert.ok(logs[0].includes('完整 API 图'));
  assert.ok(!logs.join('').includes(f.apiKey));
});
test('seed explicitly included so server does not replace a fixed seed',async()=>{
  const f=fixture();const s=spy(okCreate);await rhCreateTask({...f,...s});
  assert.deepEqual(s.calls[0].body.nodeInfoList,[{nodeId:'53',fieldName:'seed',fieldValue:42}]);
});
test('instance, queue and retention options preserved, no extra keys forwarded',async()=>{
  const f=fixture(); f.payload.instanceType='plus';f.payload.retainSeconds=10;f.payload.usePersonalQueue=true;f.payload.arbitrary='not forwarded';
  const s=spy(okCreate);await rhCreateTask({...f,...s});
  assert.equal(s.calls[0].body.instanceType,'plus');assert.equal(s.calls[0].body.retainSeconds,10);
  assert.equal(s.calls[0].body.usePersonalQueue,true);assert.ok(!('arbitrary' in s.calls[0].body));
});
test('local mode preserves a changed node class and added node absent from cloud',async()=>{
  const f=fixture();f.promptObj['77']={class_type:'CLIPTextEncode',inputs:{text:'test',clip:['56',0]}};
  const s=spy(okCreate);await rhCreateTask({...f,...s});
  const g=JSON.parse(s.calls[0].body.workflow);
  assert.equal(g['77'].class_type,'CLIPTextEncode');assert.ok(g['108']);
  assert.ok(!s.calls[0].body.nodeInfoList.some(n=>n.nodeId==='108'));
});
test('graph preparation does not mutate saved or generated graph',()=>{
  const f=fixture();const before=JSON.stringify(f.promptObj);const prepared=rhPrepareLocalGraph(f.rawJson,f.promptObj);
  prepared.graph['53'].inputs.steps=9;assert.equal(JSON.stringify(f.promptObj),before);
});
test('unknown transport version refused before any fetch',async()=>{
  const f=fixture();f.rawJson=JSON.stringify({_meta:{st_chatu8_runninghub:{version:2,mode:'local'}}});const s=spy(okCreate);
  await assert.rejects(rhCreateTask({...f,...s}),/无效/);assert.equal(s.calls.length,0);
});
test('dangling links fail before billing',async()=>{
  const f=fixture();delete f.promptObj['108'];const s=spy(okCreate);
  await assert.rejects(rhCreateTask({...f,...s}),/无效连线/);assert.equal(s.calls.length,0);
});
test('empty or UI-format graphs rejected',()=>{
  assert.throws(()=>rhPrepareLocalGraph('{}',{}),/为空/);
  assert.throws(()=>rhPrepareLocalGraph('{}',{nodes:[]}),/API 节点/);
});
test('unsafe seed rejected, zero seed accepted',()=>{
  const f=fixture();f.promptObj['53'].inputs.seed=Number.MAX_SAFE_INTEGER+1;
  assert.throws(()=>rhPrepareLocalGraph(f.rawJson,f.promptObj),/安全整数/);
  f.promptObj['53'].inputs.seed=0;assert.equal(rhPrepareLocalGraph(f.rawJson,f.promptObj).seeds[0].fieldValue,0);
});
test('unresolved template placeholder fails before billing',()=>{
  const f=fixture();f.promptObj['52'].inputs.width='%width%';assert.throws(()=>rhPrepareLocalGraph(f.rawJson,f.promptObj),/尚未替换/);
});
test('unsupported frontend bypass does not silently run a different graph',()=>{
  const f=fixture();f.promptObj['107'].mode=4;assert.throws(()=>rhPrepareLocalGraph(f.rawJson,f.promptObj),/旁路/);
});
test('create error retained with node detail; no fallback to cloud workflow',async()=>{
  const f=fixture(); const s=spy({code:433,msg:'VALIDATE_PROMPT_FAILED',data:{promptTips:'node 107 missing model'}});
  const r=await rhCreateTask({...f,...s});assert.equal(r.errorCode,433);assert.match(r.errorMessage,/node 107/);assert.equal(s.calls.length,1);
});
test('queue-full code remains available to existing bounded-to-explicit-error retry logic',async()=>{
  const f=fixture();const s=spy({code:421,msg:'TASK_QUEUE_MAXED'});const r=await rhCreateTask({...f,...s});assert.equal(r.errorCode,421);assert.match(r.errorMessage,/TASK_QUEUE_MAXED/);
});
test('network failure does not issue a second paid create',async()=>{
  const f=fixture();let count=0;
  await assert.rejects(rhCreateTask({...f,fetchImpl:async()=>{count++;throw Error('offline');}}),/没有自动重发/);
  assert.equal(count,1);
});
test('HTTP and non-JSON failures are explicit without credential disclosure',async()=>{
  const f=fixture();const s=spy({msg:`server echoed ${f.apiKey}`},401);
  await assert.rejects(rhCreateTask({...f,...s}),e=>e.message.includes('401')&&!e.message.includes(f.apiKey));
  await assert.rejects(rhCreateTask({...f,fetchImpl:async()=>({ok:false,status:502,json:async()=>{throw Error('html');}})}),/非 JSON/);
});
test('abort signal propagated and pre-abort avoids fetch entirely',async()=>{
  const c=new AbortController();const f=fixture();const s=spy(okCreate);await rhCreateTask({...f,...s,signal:c.signal});assert.equal(s.calls[0].options.signal,c.signal);
  c.abort();const s2=spy(okCreate);await assert.rejects(rhCreateTask({...f,...s2,signal:c.signal}));assert.equal(s2.calls.length,0);
});
test('unsafe numeric task id refused without retry after acceptance',async()=>{
  const f=fixture();const s=spy({code:0,data:{taskId:2099999999999999999}});await assert.rejects(rhCreateTask({...f,...s}),/不安全数字/);assert.equal(s.calls.length,1);
});
test('V2 polling remains unchanged for cloud presets',async()=>{
  const f=fixture(false);const s=spy({status:'RUNNING'});const r=await rhQueryTask({...f,...s,taskId:'123'});
  assert.equal(r.status,'RUNNING');assert.equal(s.calls[0].url,'https://www.runninghub.ai/openapi/v2/query');assert.deepEqual(s.calls[0].body,{taskId:'123'});
});
for(const [code,status] of [[804,'RUNNING'],[813,'QUEUED'],[805,'FAILED'],[802,'FAILED']]) {
  test(`legacy outputs ${code} normalized as ${status}`,async()=>{
    const f=fixture();const s=spy({code,msg:'server status'});const r=await rhQueryTask({...f,...s,taskId:'123'});assert.equal(r.status,status);
    assert.equal(s.calls[0].url,'https://www.runninghub.ai/task/openapi/outputs');assert.equal(s.calls[0].body.taskId,'123');
  });
}
test('legacy success maps ZIP/image/video output and cost metadata',async()=>{
  const f=fixture();const s=spy({code:0,data:[{fileUrl:'https://test.invalid/out.zip',fileType:'zip',nodeId:'112',taskCostTime:'6',consumeCoins:'2'},{fileUrl:'https://test.invalid/out.png',fileType:'png',nodeId:'54'}]});
  const r=await rhQueryTask({...f,...s,taskId:'123'});assert.equal(r.status,'SUCCESS');assert.equal(r.results[0].url,'https://test.invalid/out.zip');assert.equal(r.results[0].outputType,'zip');assert.equal(r.taskCostTime,'6');assert.equal(r.consumeCoins,'2');assert.equal(r.results.length,2);
});
test('empty or malformed successful outputs do not poll forever or regenerate',async()=>{
  for(const data of [[],null,[{fileType:'png'}]]) {
    const f=fixture();const s=spy({code:0,data});const r=await rhQueryTask({...f,...s,taskId:'123'});assert.equal(r.status,'FAILED');assert.equal(s.calls.length,1);
  }
});
test('source patch wires all three generation and polling paths, no blind global fetch hook',()=>{
  const patched=applyPatch(source);assert.equal((patched.match(/const createData = await rhCreateTask/g)||[]).length,3);
  assert.equal((patched.match(/const statData = await rhQueryTask/g)||[]).length,3);
  assert.match(patched,/rawJson: rawJson, promptObj, workflowId: workflowId/);
  assert.match(patched,/rawJson: targetWorkerJson, promptObj, workflowId: targetWorkflowId/);
  assert.match(patched,/rawJson: workflowJson, promptObj, workflowId: workflowId, apiKey, payload, log: addLog, signal: abortSignal/);
  assert.ok(!patched.includes('globalThis.fetch ='));assert.throws(()=>applyPatch(patched),/Already patched/);
});
test('unknown source version patch fails without writing a guessed edit',()=>{
  assert.throws(()=>applyPatch(source.replace('const createRes = await fetch','const unexpected = await fetch')),/Unsupported source/);
});
