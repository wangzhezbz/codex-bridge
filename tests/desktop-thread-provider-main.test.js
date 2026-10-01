import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import diagnostics from '../desktop/thread-provider-diagnostics.cjs';
const source=fs.readFileSync(new URL('../desktop/main.cjs',import.meta.url),'utf8');
function extract(name){const match=new RegExp(`(?:async )?function ${name}\\(`).exec(source);if(!match)return '';const tail=source.slice(match.index),next=tail.slice(1).search(/\n(?:async )?function /);return next<0?tail:tail.slice(0,next+1);}
function harness({lease,failRepair=false,repairResult={ok:true,updated:[]}}={}){
  const events=[];
  const settings={loadDesktopOptions:()=>({}),runSharedConfigExclusive:async(fn)=>{events.push('lease-wait');if(lease)await lease;events.push('lease-acquired');return fn();}};
  const context={loadSettings:async()=>settings,dataRootDir:'fixture',codexDesktopLaunchCandidateEntries:async()=>[],buildOpenAIDesktopRestartPlan:()=>({launchTarget:'C:/fixture/ChatGPT.exe',brand:'Codex',processesToStop:[]}),listRunningCodexDesktopProcesses:async()=>[],isLaunchableCodexDesktopTarget:()=>true,stopCodexDesktopProcesses:async()=>{events.push('stop');return{ok:true,stopped:0};},delay:async()=>{},prepareCodexThreadProvidersForRestart:async()=>{events.push('repair');if(failRepair)throw new Error('fixture repair failure');return repairResult;},launchCodexDesktopTarget:async()=>{events.push('launch');}};
  vm.runInNewContext(extract('restartCodexDesktopWindows')+'\n'+extract('restartCodexDesktopWindowsExclusive')+'\nthis.restart=restartCodexDesktopWindows;',Object.assign(context,diagnostics));
  return{events,restart:context.restart};
}
test('a queued configuration lease does not close Codex while another operation owns the lock',async()=>{
  let release;const lease=new Promise(resolve=>{release=resolve;});const h=harness({lease});const task=h.restart();
  await new Promise(resolve=>setImmediate(resolve));
  try{assert.deepEqual(h.events,['lease-wait']);}finally{release();await task;}
  assert.deepEqual(h.events,['lease-wait','lease-acquired','stop','repair','launch']);
});
test('a provider compatibility failure still reopens the verified desktop target',async()=>{
  const h=harness({failRepair:true});const result=await h.restart();
  assert.equal(result.ok,true);assert.equal(result.threadProviderCompatibility.ok,false);assert.equal(h.events.at(-1),'launch');
});
test('a derived cache warning is distinguished from a failed task repair in the restart result',async()=>{
  const h=harness({repairResult:{ok:true,updated:[{id:'fixture'}],failed:[],cacheWarning:'receipt_write_failed'}});const result=await h.restart();
  assert.equal(result.threadProviderCompatibility.ok,true);assert.match(result.message,/缓存.*未保存/);assert.match(result.message,/已兼容/);assert.equal(h.events.at(-1),'launch');
});
test('unconfirmed tasks are described as untouched rather than successfully repaired',async()=>{
  const h=harness({repairResult:{ok:false,updated:[],failed:[{id:'fixture',code:'thread_not_in_active_catalog'}]}});const result=await h.restart();
  assert.match(result.message,/无法确认/);assert.match(result.message,/未改动/);assert.equal(h.events.at(-1),'launch');
});
test('an unconfirmed helper teardown does not launch another client over a potentially live writer',async()=>{
  const h=harness({repairResult:{ok:false,updated:[],failed:[],restartBlocked:true,processId:23456}});
  await assert.rejects(h.restart(),/后台.*23456/);assert.ok(!h.events.includes('launch'));
});
test('the compatibility helper requests tree cleanup and forwards an unconfirmed cleanup result',async()=>{
  let captured;
  const context={desktopHomeDir:()=> 'C:/fixture/home',dataRootDir:'C:/fixture/data',path:{join:(...parts)=>parts.join('/')},app:{isPackaged:false},process:{env:{}},nodeExecutable:()=> 'node',scriptPath:value=>value,listRunningCodexDesktopProcesses:async()=>[],appendLog:()=>{},runCommandCapture:async(_command,_args,options)=>{captured=options;return{ok:false,stdout:'',terminationConfirmed:false,processId:23456};}};
  vm.runInNewContext(extract('prepareCodexThreadProvidersForRestart')+'\nthis.prepare=prepareCodexThreadProvidersForRestart;',Object.assign(context,diagnostics));
  const settings={detectModeFromConfig:()=> 'all_api',readRouterConfig:()=>({}),managedCodexConfigCompatibilityPlan:()=>({reason:'already_compatible',needsRepair:false})};
  const result=await context.prepare(settings,'C:/fixture/Codex.exe');assert.equal(captured.killProcessTree,true);assert.equal(result.restartBlocked,true);assert.equal(result.processId,23456);
});

async function prepareExecution(execution){
  const logs=[];
  const context={desktopHomeDir:()=> 'C:/fixture/home',dataRootDir:'C:/fixture/data',path:{join:(...parts)=>parts.join('/')},app:{isPackaged:false},process:{env:{}},nodeExecutable:()=> 'node',scriptPath:value=>value,listRunningCodexDesktopProcesses:async()=>[],appendLog:message=>logs.push(message),runCommandCapture:async()=>execution};
  vm.runInNewContext(extract('prepareCodexThreadProvidersForRestart')+'\nthis.prepare=prepareCodexThreadProvidersForRestart;',Object.assign(context,diagnostics));
  const settings={detectModeFromConfig:()=> 'all_api',readRouterConfig:()=>({}),managedCodexConfigCompatibilityPlan:()=>({reason:'already_compatible',needsRepair:false})};
  return{result:await context.prepare(settings,'C:/fixture/Codex.exe'),logs};
}

for(const [name,execution,code] of [
  ['timeout',{ok:false,timedOut:true,stdout:''},'compatibility_worker_timeout'],
  ['output limit',{ok:false,outputTooLarge:true,stdout:'{"unfinished'},'compatibility_output_limit'],
])test(`helper ${name} is not hidden behind a generic parse failure`,async()=>{
  const {result}=await prepareExecution(execution);
  assert.equal(result.ok,false);assert.equal(result.code,code);
});

test('a timed-out helper reports the reason even when it printed valid partial results',async()=>{
  const {result}=await prepareExecution({ok:false,timedOut:true,stdout:JSON.stringify({ok:true,updated:[{id:'confirmed-task'}],failed:[]})});
  assert.equal(result.ok,false);assert.equal(result.code,'compatibility_worker_timeout');assert.equal(result.updated.length,1);
});

test('timeout feedback explains the failure while still reopening the client',async()=>{
  const h=harness({repairResult:{ok:false,updated:[],failed:[],code:'compatibility_worker_timeout'}});
  const result=await h.restart();assert.match(result.message,/超时/);assert.equal(h.events.at(-1),'launch');
});

test('unrecognized helper errors do not leak private codes into the runtime log',async()=>{
  const secret='fixture_private_error_C:/sensitive/profile';
  const {result,logs}=await prepareExecution({ok:false,stdout:JSON.stringify({ok:false,updated:[],failed:[],code:secret})});
  assert.equal(result.ok,false);assert.equal(result.code,'thread_provider_compatibility_failed');
  assert.ok(!logs.join('\n').includes(secret));
});

test('unsupported settings still recommends a client update without blocking restart',async()=>{
  const h=harness({repairResult:{ok:false,updated:[],failed:[{id:'fixture',code:'thread_settings_unsupported'}]}});
  const result=await h.restart();assert.match(result.message,/更新 Codex/);assert.equal(h.events.at(-1),'launch');
});

test('repeated failures produce a bounded explanation and never display private unknown causes',async()=>{
  const failed=Array.from({length:1000},()=>({id:'fixture',code:'native_request_timeout'}));
  failed[0]={id:'fixture',code:'fixture-private-key-should-not-display'};
  const h=harness({repairResult:{ok:false,updated:[],failed}});
  const result=await h.restart();assert.match(result.message,/超时/);assert.ok(result.message.length<500);
  assert.ok(!result.message.includes('fixture-private-key'));assert.equal(h.events.at(-1),'launch');
});

test('the scan limit explains its boundary instead of recommending repeated restarts',async()=>{
  const h=harness({repairResult:{ok:false,updated:[],failed:[],code:'thread_compatibility_scan_limit'}});
  const result=await h.restart();assert.match(result.message,/10000/);assert.match(result.message,/上限/);
  assert.doesNotMatch(result.message,/再次通过.*重启/);assert.equal(h.events.at(-1),'launch');
});
