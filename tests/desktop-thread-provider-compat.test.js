import test from 'node:test';
import assert from 'node:assert/strict';
import * as provider from '../desktop/codex-provider.mjs';
const first='11111111-1111-4111-8111-111111111111';
const second='22222222-2222-4222-8222-222222222222';
const row={id:first,model:'tenant/api-exact',modelProvider:'openai',archived:false,hasUserEvent:true,source:'vscode',threadSource:'user'};
function plan(rows,options={}){assert.equal(typeof provider.planThreadProviderCompatibility,'function');return provider.planThreadProviderCompatibility(rows,{mode:'all_api',...options});}
function repair(options){assert.equal(typeof provider.repairThreadProviderCompatibility,'function');return provider.repairThreadProviderCompatibility(options);}

test('provider repair plans user tasks only and does not reinterpret model names',()=>{
  const result=plan([row,{...row,id:second,model:'gpt-reserve'}, {...row,id:'other',modelProvider:'other-provider'}, {...row,id:'archived',archived:true}, {...row,id:'agent',source:'subagent'}, {...row,id:'empty',model:''}]);
  assert.deepEqual(result.map(x=>({id:x.id,model:x.model,provider:x.provider})),[{id:first,model:'tenant/api-exact',provider:'codexbridge'},{id:second,model:'gpt-reserve',provider:'codexbridge'}]);
});
test('successful compatibility markers avoid repeated resumes but mode changes require a new binding',()=>{
  const completed={[first]:{provider:'codexbridge',model:'tenant/api-exact'}};
  assert.deepEqual(plan([row],{completed}),[]);
  assert.equal(plan([row],{mode:'hybrid',completed})[0].provider,'openai');
  assert.equal(plan([{...row,model:'tenant/other'}],{completed})[0].model,'tenant/other');
});
test('unsupported mode and invalid user task ids cannot cause provider repair writes',()=>{
  assert.throws(()=>plan([row],{mode:'unknown'}),/mode/i);
  assert.deepEqual(plan([{...row,id:'../another-file'}]),[]);
});
test('native GUI user tasks remain repairable when has_user_event has not been backfilled',()=>{
  assert.equal(plan([{...row,hasUserEvent:false}]).length,1);
  assert.equal(plan([{...row,hasUserEvent:false,threadSource:null}]).length,0);
});
test('persisting a new provider uses resume then saves the exact original model without a generation turn',async()=>{
  const calls=[];
  const rpc=async(method,params)=>{calls.push({method,params});if(method==='thread/read')return{thread:{id:first,modelProvider:'openai'}};if(method==='thread/resume')return{thread:{id:first},model:'tenant/api-exact',modelProvider:'codexbridge'};return{};};
  const result=await repair({rpc,candidates:[{id:first,model:'tenant/api-exact',provider:'codexbridge'}]});
  assert.equal(result.ok,true);assert.equal(result.updated.length,1);
  assert.deepEqual(calls,[
    {method:'thread/read',params:{threadId:first,includeTurns:false}},
    {method:'thread/resume',params:{threadId:first,model:'tenant/api-exact',modelProvider:'codexbridge',excludeTurns:true}},
    {method:'thread/settings/update',params:{threadId:first,model:'tenant/api-exact'}},
    {method:'thread/unsubscribe',params:{threadId:first}},
  ]);
});
for(const [name,override,code] of [
  ['model changed during resume',{model:'silently-selected-model'},'thread_model_changed'],
  ['wrong task id',{thread:{id:second}},'thread_identity_changed'],
  ['provider ignored',{modelProvider:'openai'},'thread_provider_not_applied'],
])test(`provider repair refuses to save when ${name}`,async()=>{
  const methods=[];const rpc=async(method)=>{methods.push(method);return method==='thread/read'?{thread:{id:first,modelProvider:'openai'}}:{thread:{id:first},model:'tenant/api-exact',modelProvider:'codexbridge',...override};};
  const result=await repair({rpc,candidates:[{id:first,model:'tenant/api-exact',provider:'codexbridge'}]});
  assert.equal(result.ok,false);assert.equal(result.failed[0].code,code);assert.equal(result.updated.length,0);assert.ok(!methods.includes('thread/settings/update'));
});
test('a rejected settings update never marks a task as successfully repaired',async()=>{
  const rpc=async(method)=>{if(method==='thread/settings/update')throw Object.assign(new Error('private upstream details'),{code:-32601});return method==='thread/read'?{thread:{id:first,modelProvider:'openai'}}:{thread:{id:first},model:'tenant/api-exact',modelProvider:'codexbridge'};};
  const result=await repair({rpc,candidates:[{id:first,model:'tenant/api-exact',provider:'codexbridge'}]});
  assert.equal(result.updated.length,0);assert.equal(result.failed[0].code,'thread_settings_unsupported');assert.ok(!JSON.stringify(result).includes('private upstream details'));
});
test('invalid explicit candidates fail before calling the native client',async()=>{
  let called=false;await assert.rejects(()=>repair({rpc:async()=>{called=true;},candidates:[{id:'bad',model:'x',provider:'openai'}]}),/candidate/i);assert.equal(called,false);
});

for(const [name,error,want] of [
  ['native timeout',Object.assign(new Error('private native details'),{code:'native_request_timeout'}),'native_request_timeout'],
  ['invalid native response',Object.assign(new Error('private native details'),{code:'native_response_invalid'}),'native_response_invalid'],
  ['configuration changed',new Error('codex_configuration_changed'),'codex_configuration_changed'],
  ['unsupported read is not an unsupported settings update',Object.assign(new Error('private native details'),{code:-32601}),'thread_provider_rpc_failed'],
])test(`repair preserves the actual cause: ${name}`,async()=>{
  const result=await repair({candidates:[{id:first,model:'tenant/api-exact',provider:'codexbridge'}],rpc:async(method)=>{assert.equal(method,'thread/read');throw error;}});
  assert.equal(result.ok,false);assert.equal(result.updated.length,0);assert.equal(result.failed[0].code,want);
  assert.ok(!JSON.stringify(result).includes('private native details'));
});
