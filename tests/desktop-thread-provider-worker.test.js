import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readCompatibilitySessions,runThreadProviderCompatibility} from '../desktop/thread-provider-compat-worker.mjs';
const id='11111111-1111-4111-8111-111111111111';
function fixture({count=1}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cb-provider-compat-'));
  const home=path.join(root,'codex-home'),sql=path.join(home,'sqlite');fs.mkdirSync(sql,{recursive:true});
  const dbPath=path.join(sql,'state_5.sqlite'),db=new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads(id TEXT, model TEXT, model_provider TEXT, source TEXT, archived INTEGER, has_user_event INTEGER, thread_source TEXT)');
  const ids=Array.from({length:count},(_,index)=>index===0?id:`22222222-2222-4222-8222-${String(index).padStart(12,'0')}`);
  for(const threadId of ids)db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(threadId,'tenant/api-exact','openai','vscode',0,1,'user');db.close();
  fs.writeFileSync(path.join(home,'config.toml'),'model_provider = "codexbridge"\nmodel = "another-default"\n');
  const audit=path.join(root,'rpc.jsonl');
  fs.writeFileSync(path.join(home,'app-server'),`const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;fs.appendFileSync(process.env.TEST_PROVIDER_RPC_AUDIT,JSON.stringify(m)+'\\n');let result={};if(m.method==='thread/list')result={data:process.env.TEST_PROVIDER_LIST_EMPTY==='1'?[]:JSON.parse(process.env.TEST_PROVIDER_IDS).map(id=>({id})),nextCursor:process.env.TEST_PROVIDER_EXTRA_PAGES==='1'?'unused-next-page':null};if(m.method==='thread/read')result={thread:{id:m.params.threadId,modelProvider:'openai'}};if(m.method==='thread/resume')result={thread:{id:m.params.threadId},model:'tenant/api-exact',modelProvider:m.params.modelProvider};if(m.method==='thread/settings/update'&&process.env.TEST_PROVIDER_REJECT==='1'){process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:'private-details'}})+'\\n');return;}process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`);
  const env={...process.env,CODEX_SQLITE_HOME:sql,TEST_PROVIDER_RPC_AUDIT:audit,TEST_PROVIDER_IDS:JSON.stringify(ids)};
  return{root,home,sql,dbPath,audit,ids,env,options:{codexHome:home,markerPath:path.join(root,'receipts.json'),mode:'all_api',executable:process.execPath,env}};
}
test('compatibility scanning reads the native metadata database without modifying it',()=>{
  const f=fixture(),before=fs.readFileSync(f.dbPath);
  assert.deepEqual(readCompatibilitySessions(f.home,f.env),[{id,model:'tenant/api-exact',modelProvider:'openai',source:'vscode',archived:false,hasUserEvent:true,threadSource:'user'}]);
  assert.deepEqual(fs.readFileSync(f.dbPath),before);
});
test('database scanning retains explicit GUI user tasks whose legacy user-event flag is zero',()=>{
  const f=fixture(),db=new DatabaseSync(f.dbPath);db.exec('UPDATE threads SET has_user_event = 0');db.close();
  assert.equal(readCompatibilitySessions(f.home,f.env).length,1);
});

test('configuration validation and its baseline hash describe the same snapshot',async(t)=>{
  const f=fixture(),config=path.join(f.home,'config.toml'),createHash=crypto.createHash;
  const changedConfig='model_provider = "openai"\nmodel = "changed-default"\n';
  let changed=false;
  t.mock.method(crypto,'createHash',(...args)=>{
    if(!changed){changed=true;fs.writeFileSync(config,changedConfig);}
    return createHash(...args);
  });
  syncBuiltinESMExports();
  try{
    await assert.rejects(runThreadProviderCompatibility(f.options),/codex_configuration_changed/);
    assert.equal(changed,true);assert.equal(fs.existsSync(f.audit),false);
    assert.equal(fs.existsSync(f.options.markerPath),false);assert.equal(fs.readFileSync(config,'utf8'),changedConfig);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('configuration growth during a task is rejected without an unbounded reread',async(t)=>{
  const f=fixture(),config=path.join(f.home,'config.toml'),script=path.join(f.home,'app-server');
  fs.writeFileSync(script,fs.readFileSync(script,'utf8').replace("let result={};", "if(m.method==='thread/read')fs.writeFileSync('config.toml','model_provider = \"codexbridge\"\\n#'+'x'.repeat(2*1024*1024));let result={};"));
  const readFile=fs.readFileSync;let oversizedReads=0;
  t.mock.method(fs,'readFileSync',(file,...args)=>{
    if(typeof file==='string' && path.resolve(file)===config && fs.statSync(file).size>2*1024*1024)oversizedReads++;
    return readFile(file,...args);
  });
  try{
    const result=await runThreadProviderCompatibility(f.options);
    assert.equal(oversizedReads,0);assert.equal(result.updated.length,0);
    assert.equal(result.failed[0].code,'codex_configuration_too_large');
    const calls=readFile(f.audit,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(!calls.some(call=>call.method==='thread/resume'||call.method==='thread/settings/update'));
    assert.equal(fs.existsSync(f.options.markerPath),false);
  }finally{t.mock.restoreAll();}
});

test('a valid linked configuration stays supported and its target is unchanged',async()=>{
  const f=fixture(),config=path.join(f.home,'config.toml'),target=path.join(f.home,'shared-config.toml');
  fs.renameSync(config,target);fs.symlinkSync(target,config,'file');
  const before=fs.readFileSync(target);
  try{
    const result=await runThreadProviderCompatibility(f.options);
    assert.equal(result.ok,true);assert.equal(result.updated.length,1);
    assert.deepEqual(fs.readFileSync(target),before);assert.equal(fs.lstatSync(config).isSymbolicLink(),true);
  }finally{if(fs.lstatSync(config).isSymbolicLink())fs.unlinkSync(config);}
});

test('an initially oversized configuration fails before any native request',async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.home,'config.toml'),'#'+'x'.repeat(2*1024*1024));
  await assert.rejects(runThreadProviderCompatibility(f.options),/codex_configuration_too_large/);
  assert.equal(fs.existsSync(f.audit),false);assert.equal(fs.existsSync(f.options.markerPath),false);
});

test('a configuration changed during its bounded read retains the configuration-change diagnosis',async(t)=>{
  const f=fixture(),config=path.join(f.home,'config.toml'),open=fs.openSync,read=fs.readSync;
  const descriptors=new Set();let changed=false;
  t.mock.method(fs,'openSync',(file,...args)=>{
    const fd=open(file,...args);
    if(typeof file==='string' && path.resolve(file)===config)descriptors.add(fd);
    return fd;
  });
  t.mock.method(fs,'readSync',(fd,...args)=>{
    const count=read(fd,...args);
    if(descriptors.has(fd) && !changed){changed=true;fs.appendFileSync(config,'\n# concurrent edit\n');}
    return count;
  });
  try{
    await assert.rejects(runThreadProviderCompatibility(f.options),/codex_configuration_changed/);
    assert.equal(changed,true);assert.equal(fs.existsSync(f.audit),false);
    assert.equal(fs.existsSync(f.options.markerPath),false);
  }finally{t.mock.restoreAll();}
});

test('multi-digit state database versions do not prefer an older model record',async()=>{
  const f=fixture(),oldFile=path.join(f.sql,'state_9.sqlite'),newFile=path.join(f.sql,'state_10.sqlite');
  fs.copyFileSync(f.dbPath,oldFile);fs.copyFileSync(f.dbPath,newFile);
  const oldDb=new DatabaseSync(oldFile);oldDb.exec("UPDATE threads SET model = 'obsolete-model'");oldDb.close();
  const oldBytes=fs.readFileSync(oldFile),newBytes=fs.readFileSync(newFile);
  assert.equal(readCompatibilitySessions(f.home,f.env)[0].model,'tenant/api-exact');
  const result=await runThreadProviderCompatibility(f.options);assert.equal(result.ok,true);
  const calls=fs.readFileSync(f.audit,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.find(call=>call.method==='thread/resume').params.model,'tenant/api-exact');
  assert.deepEqual(fs.readFileSync(oldFile),oldBytes);assert.deepEqual(fs.readFileSync(newFile),newBytes);
});

for(const [label,older,newer] of [
  ['unnumbered legacy database','state.sqlite','state_0.sqlite'],
  ['large version without numeric precision loss','state_99999999999999999999.sqlite','state_100000000000000000000.sqlite'],
  ['equal numeric versions retain deterministic filename order','state_09.sqlite','state_9.sqlite'],
])test(`state database precedence preserves ${label}`,()=>{
  const f=fixture(),directory=path.join(f.root,'versioned-sqlite');fs.mkdirSync(directory);
  const oldFile=path.join(directory,older),newFile=path.join(directory,newer);
  fs.copyFileSync(f.dbPath,oldFile);fs.copyFileSync(f.dbPath,newFile);
  const db=new DatabaseSync(oldFile);db.exec("UPDATE threads SET model = 'obsolete-model'");db.close();
  assert.equal(readCompatibilitySessions(f.home,{...f.env,CODEX_SQLITE_HOME:directory})[0].model,'tenant/api-exact');
});

function addScanRows(file,start,count){
  const db=new DatabaseSync(file);
  try{
    db.exec('CREATE TABLE IF NOT EXISTS threads(id TEXT, model TEXT, model_provider TEXT, source TEXT, archived INTEGER, has_user_event INTEGER, thread_source TEXT)');
    db.exec('BEGIN');
    const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)');
    for(let index=start;index<start+count;index++)insert.run(`44444444-4444-4444-8444-${String(index).padStart(12,'0')}`,'tenant/api-exact','openai','vscode',0,1,'user');
    db.exec('COMMIT');
  }finally{db.close();}
}

test('the scan budget also bounds unique tasks merged from multiple state databases',async()=>{
  const f=fixture(),other=path.join(f.sql,'state_6.sqlite');
  addScanRows(f.dbPath,0,6000);addScanRows(other,6000,6000);
  const before=fs.readFileSync(f.dbPath),otherBefore=fs.readFileSync(other);
  await assert.rejects(runThreadProviderCompatibility({...f.options,executable:path.join(f.root,'missing-cli-must-not-start.exe')}),/thread_compatibility_scan_limit/);
  assert.deepEqual(fs.readFileSync(f.dbPath),before);assert.deepEqual(fs.readFileSync(other),otherBefore);
  assert.equal(fs.existsSync(f.audit),false);assert.equal(fs.existsSync(f.options.markerPath),false);
});

test('overlapping databases do not count duplicate task records twice against the scan budget',()=>{
  const f=fixture();addScanRows(f.dbPath,0,6000);
  fs.copyFileSync(f.dbPath,path.join(f.sql,'state_6.sqlite'));
  assert.equal(readCompatibilitySessions(f.home,f.env).length,6001);
});

test('exactly 10000 unique tasks across state databases remain within the scan budget',()=>{
  const f=fixture();addScanRows(f.dbPath,0,6000);addScanRows(path.join(f.sql,'state_6.sqlite'),6000,3999);
  assert.equal(readCompatibilitySessions(f.home,f.env).length,10000);
});
test('worker persists only confirmed provider bindings and a second run does not resume them again',async()=>{
  const f=fixture(),before=fs.readFileSync(f.dbPath),first=await runThreadProviderCompatibility(f.options);
  assert.equal(first.ok,true);assert.equal(first.updated.length,1);
  const profiles=Object.values(JSON.parse(fs.readFileSync(f.options.markerPath,'utf8')).profiles);
  assert.equal(profiles.length,1);assert.deepEqual(profiles[0].completed[id],{model:'tenant/api-exact',provider:'codexbridge'});
  const audit=fs.readFileSync(f.audit,'utf8');
  const second=await runThreadProviderCompatibility({...f.options,executable:'missing-command-must-not-run'});
  assert.equal(second.planned,0);assert.equal(fs.readFileSync(f.audit,'utf8'),audit);assert.deepEqual(fs.readFileSync(f.dbPath),before);
  const calls=audit.trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(!calls.some(call=>call.method==='turn/start'));
  assert.deepEqual(calls.find(call=>call.method==='thread/settings/update').params,{threadId:id,model:'tenant/api-exact'});
});
test('unsupported native settings update leaves no successful receipt and can be retried',async()=>{
  const f=fixture();const result=await runThreadProviderCompatibility({...f.options,env:{...f.env,TEST_PROVIDER_REJECT:'1'}});
  assert.equal(result.ok,false);assert.equal(result.updated.length,0);assert.equal(result.failed[0].code,'thread_settings_unsupported');assert.equal(fs.existsSync(f.options.markerPath),false);assert.ok(!JSON.stringify(result).includes('private-details'));
});
test('worker refuses a mode/config mismatch before starting the native client',async()=>{
  const f=fixture();await assert.rejects(()=>runThreadProviderCompatibility({...f.options,mode:'hybrid'}),/mode_mismatch/);assert.equal(fs.existsSync(f.audit),false);
});

test('the CLI result preserves a safe preflight cause without exposing input paths',async()=>{
  const f=fixture();
  const {env:ignored,...options}=f.options;
  const result=await new Promise(resolve=>childProcess.execFile(process.execPath,[path.resolve('desktop/thread-provider-compat-worker.mjs'),JSON.stringify({...options,mode:'hybrid'})],{env:f.env,windowsHide:true,encoding:'utf8',timeout:10000},(error,stdout)=>resolve({exitCode:error?.code||0,stdout})));
  assert.notEqual(result.exitCode,0);
  const report=JSON.parse(result.stdout);
  assert.equal(report.code,'codex_configuration_mode_mismatch');
  assert.ok(!result.stdout.includes(f.home));
  assert.equal(fs.existsSync(f.audit),false);
});

test('the CLI identifies the metadata scan limit without starting a native client or changing data',async()=>{
  const f=fixture(),db=new DatabaseSync(f.dbPath);
  try{
    db.exec('BEGIN');
    const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)');
    for(let index=0;index<10000;index++)insert.run(`33333333-3333-4333-8333-${String(index).padStart(12,'0')}`,'tenant/api-exact','openai','vscode',0,1,'user');
    db.exec('COMMIT');
  }finally{db.close();}
  const before=fs.readFileSync(f.dbPath),{env:ignored,...options}=f.options;
  const result=await new Promise(resolve=>childProcess.execFile(process.execPath,[path.resolve('desktop/thread-provider-compat-worker.mjs'),JSON.stringify(options)],{env:f.env,windowsHide:true,encoding:'utf8',timeout:10000},(error,stdout)=>resolve({exitCode:error?.code||0,stdout})));
  assert.notEqual(result.exitCode,0);assert.equal(JSON.parse(result.stdout).code,'thread_compatibility_scan_limit');
  assert.equal(fs.existsSync(f.audit),false);assert.deepEqual(fs.readFileSync(f.dbPath),before);
});
test('once all requested tasks are found the helper does not fetch irrelevant later catalog pages',async()=>{
  const f=fixture();const result=await runThreadProviderCompatibility({...f.options,env:{...f.env,TEST_PROVIDER_EXTRA_PAGES:'1'}});
  assert.equal(result.ok,true);assert.equal(result.updated.length,1);
  const reads=fs.readFileSync(f.audit,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(item=>item.method==='thread/list');assert.equal(reads.length,1);
});

test('a response without a result cannot be recorded as a successful native settings save',async()=>{
  const f=fixture();
  const script=path.join(f.home,'app-server');
  fs.writeFileSync(script,fs.readFileSync(script,'utf8').replace("let result={};", "if(m.method==='thread/settings/update'){process.stdout.write(JSON.stringify({id:m.id})+'\\n');return;}let result={};"));
  const result=await runThreadProviderCompatibility(f.options);
  assert.equal(result.ok,false);
  assert.equal(result.updated.length,0);
  assert.equal(result.failed[0].code,'native_response_invalid');
  assert.equal(fs.existsSync(f.options.markerPath),false);
});

test('conflicting result and error fields cannot create a successful receipt',async()=>{
  const f=fixture();
  const script=path.join(f.home,'app-server');
  fs.writeFileSync(script,fs.readFileSync(script,'utf8').replace("let result={};", "if(m.method==='thread/settings/update'){process.stdout.write(JSON.stringify({id:m.id,result:{},error:null})+'\\n');return;}let result={};"));
  const result=await runThreadProviderCompatibility(f.options);
  assert.equal(result.ok,false);
  assert.equal(result.updated.length,0);
  assert.equal(fs.existsSync(f.options.markerPath),false);
});

test('later tasks retain the first connection failure instead of inventing a timeout',async()=>{
  const f=fixture({count:2});
  const script=path.join(f.home,'app-server');
  fs.writeFileSync(script,fs.readFileSync(script,'utf8').replace("let result={};", "if(m.method==='thread/settings/update'){process.stdout.write(JSON.stringify({id:m.id})+'\\n');return;}let result={};"));
  const result=await runThreadProviderCompatibility(f.options);
  assert.deepEqual(result.failed.map(item=>item.code),['native_response_invalid','native_response_invalid']);
  const calls=fs.readFileSync(f.audit,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.filter(call=>call.method==='thread/read').length,1);
  assert.equal(result.updated.length,0);assert.equal(fs.existsSync(f.options.markerPath),false);
});

test('a malformed initialization response stops before task listing or mutation',async()=>{
  const f=fixture();
  const script=path.join(f.home,'app-server');
  fs.writeFileSync(script,fs.readFileSync(script,'utf8').replace("let result={};", "if(m.method==='initialize'){process.stdout.write(JSON.stringify({id:m.id})+'\\n');return;}let result={};"));
  await assert.rejects(runThreadProviderCompatibility(f.options),{code:'native_response_invalid'});
  const calls=fs.readFileSync(f.audit,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(calls.map(call=>call.method),['initialize']);
  assert.equal(fs.existsSync(f.options.markerPath),false);
});

test('an explicit null result remains a valid native settings acknowledgement',async()=>{
  const f=fixture();
  const script=path.join(f.home,'app-server');
  fs.writeFileSync(script,fs.readFileSync(script,'utf8').replace("let result={};", "if(m.method==='thread/settings/update'){process.stdout.write(JSON.stringify({id:m.id,result:null})+'\\n');return;}let result={};"));
  const result=await runThreadProviderCompatibility(f.options);
  assert.equal(result.ok,true);
  assert.equal(result.updated.length,1);
  assert.equal(fs.existsSync(f.options.markerPath),true);
});

test('Windows native cleanup uses the absolute system tool and terminates its own stubborn child', {skip:process.platform!=='win32',timeout:15000},async(t)=>{
  const f=fixture();
  fs.appendFileSync(path.join(f.home,'app-server'),'\nsetInterval(()=>{},1000);\n');
  const originalSpawn=childProcess.spawn,originalExecFile=childProcess.execFile;
  let nativeChild;
  const commands=[];
  t.mock.method(childProcess,'spawn',(...args)=>{
    assert.equal(args[0],process.execPath);
    assert.deepEqual(args[1],['app-server']);
    nativeChild=originalSpawn(...args);
    return nativeChild;
  });
  t.mock.method(childProcess,'execFile',(command,args,options,callback)=>{
    assert.ok(nativeChild?.pid>1);
    assert.deepEqual(args,['/PID',String(nativeChild.pid),'/T','/F']);
    commands.push({command,options});
    return originalExecFile(command,args,options,callback);
  });
  syncBuiltinESMExports();
  try{
    const result=await runThreadProviderCompatibility(f.options);
    assert.equal(result.ok,true);
    assert.equal(commands.length,1);
    assert.equal(commands[0].command,path.win32.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows','System32','taskkill.exe'));
    assert.equal(commands[0].options.windowsHide,true);
    if(nativeChild.exitCode===null && nativeChild.signalCode===null){
      await new Promise((resolve,reject)=>{
        const onClose=()=>{clearTimeout(timer);resolve();};
        const timer=setTimeout(()=>{nativeChild.removeListener('close',onClose);reject(new Error('the system cleanup must terminate its owned child'));},2000);
        nativeChild.once('close',onClose);
      });
    }
    assert.throws(()=>process.kill(nativeChild.pid,0),{code:'ESRCH'});
  }finally{
    t.mock.restoreAll();syncBuiltinESMExports();
    if(nativeChild && nativeChild.exitCode===null && nativeChild.signalCode===null){
      const stopped=new Promise(resolve=>nativeChild.once('close',resolve));
      nativeChild.kill('SIGKILL');
      await stopped;
    }
  }
});
test('worker does not resume a stale database row absent from the native active-task list',async()=>{
  const f=fixture();const result=await runThreadProviderCompatibility({...f.options,env:{...f.env,TEST_PROVIDER_LIST_EMPTY:'1'}});
  assert.equal(result.updated.length,0);assert.equal(fs.existsSync(f.options.markerPath),false);
  assert.ok(!fs.readFileSync(f.audit,'utf8').includes('thread/resume'));
  assert.equal(result.ok,false);assert.deepEqual(result.failed,[{id,code:'thread_not_in_active_catalog'}]);
});
test('a corrupt derived receipt is backed up and rebuilt without blocking task compatibility',async()=>{
  const f=fixture(),broken='{unfinished cache';fs.writeFileSync(f.options.markerPath,broken);
  const result=await runThreadProviderCompatibility(f.options);
  assert.equal(result.ok,true);assert.equal(result.updated.length,1);assert.equal(result.cacheRecovered,true);
  assert.equal(fs.readFileSync(result.cacheBackupPath,'utf8'),broken);
  assert.ok(JSON.parse(fs.readFileSync(f.options.markerPath,'utf8')));
});
test('a copied receipt cannot suppress compatibility work in a different Codex profile',async()=>{
  const first=fixture(),second=fixture();await runThreadProviderCompatibility(first.options);
  fs.copyFileSync(first.options.markerPath,second.options.markerPath);
  const result=await runThreadProviderCompatibility(second.options);
  assert.equal(result.planned,1);assert.equal(result.updated.length,1);assert.equal(result.ok,true);
  assert.ok(fs.readFileSync(second.audit,'utf8').includes('thread/settings/update'));
  const reused=await runThreadProviderCompatibility({...first.options,markerPath:second.options.markerPath,executable:'missing-must-not-run'});
  assert.equal(reused.planned,0);assert.equal(Object.keys(JSON.parse(fs.readFileSync(second.options.markerPath,'utf8')).profiles).length,2);
});
test('switching the native SQLite directory invalidates compatibility receipts even with the same Codex home',async()=>{
  const f=fixture();await runThreadProviderCompatibility(f.options);
  const other=path.join(f.root,'other-sqlite');fs.mkdirSync(other);fs.copyFileSync(f.dbPath,path.join(other,'state_5.sqlite'));
  const result=await runThreadProviderCompatibility({...f.options,env:{...f.env,CODEX_SQLITE_HOME:other}});
  assert.equal(result.planned,1);assert.equal(result.updated.length,1);
});
test('replacing a native state database does not keep a receipt for its previous file identity',async()=>{
  const f=fixture();await runThreadProviderCompatibility(f.options);
  const previous=path.join(f.sql,'previous-state.sqlite');fs.renameSync(f.dbPath,previous);fs.copyFileSync(previous,f.dbPath);
  const result=await runThreadProviderCompatibility(f.options);
  assert.equal(result.planned,1);assert.equal(result.updated.length,1);
});
test('batch compatibility coalesces derived receipt writes while recording every confirmed task',async()=>{
  const f=fixture({count:10}),rename=fs.renameSync;let receiptWrites=0;
  fs.renameSync=(from,to)=>{if(to===f.options.markerPath)receiptWrites++;return rename(from,to);};
  let result;try{result=await runThreadProviderCompatibility(f.options);}finally{fs.renameSync=rename;}
  assert.equal(result.updated.length,10);assert.equal(result.failed.length,0);assert.equal(receiptWrites,1);
  const cached=await runThreadProviderCompatibility({...f.options,executable:'missing-must-not-run'});assert.equal(cached.planned,0);
});
test('receipt writes do not overwrite an existing predictable temporary file',async()=>{
  const f=fixture(),existing=`${f.options.markerPath}.${process.pid}.tmp`;fs.writeFileSync(existing,'keep this file');
  const result=await runThreadProviderCompatibility(f.options);assert.equal(result.ok,true);
  assert.equal(fs.existsSync(existing),true);assert.equal(fs.readFileSync(existing,'utf8'),'keep this file');
});
test('legacy unscoped cache entries are preserved as a backup instead of being trusted for this profile',async()=>{
  const f=fixture(),old={version:1,completed:{[id]:{model:'tenant/api-exact',provider:'codexbridge'}}};fs.writeFileSync(f.options.markerPath,JSON.stringify(old));
  const result=await runThreadProviderCompatibility(f.options);
  assert.equal(result.updated.length,1);assert.equal(result.cacheRecovered,true);assert.deepEqual(JSON.parse(fs.readFileSync(result.cacheBackupPath,'utf8')),old);
});
test('an unexpected directory at the receipt path is never moved or replaced',async()=>{
  const f=fixture();fs.mkdirSync(f.options.markerPath);const protectedFile=path.join(f.options.markerPath,'keep.txt');fs.writeFileSync(protectedFile,'untouched');
  const result=await runThreadProviderCompatibility(f.options);
  assert.equal(result.ok,true);assert.equal(result.updated.length,1);assert.equal(result.cacheWarning,'receipt_unavailable');assert.equal(fs.readFileSync(protectedFile,'utf8'),'untouched');
});
test('cache write failure keeps confirmed task results and removes only its own temporary file',async()=>{
  const f=fixture(),rename=fs.renameSync;
  fs.renameSync=(from,to)=>{if(to===f.options.markerPath)throw Object.assign(new Error('fixture cache is read-only'),{code:'EACCES'});return rename(from,to);};
  let result;try{result=await runThreadProviderCompatibility(f.options);}finally{fs.renameSync=rename;}
  assert.equal(result.ok,true);assert.equal(result.updated.length,1);assert.equal(result.cacheWarning,'receipt_write_failed');
  assert.equal(fs.existsSync(f.options.markerPath),false);assert.equal(fs.readdirSync(f.root).filter(name=>name.endsWith('.tmp')).length,0);
});
test('longer batches save bounded checkpoints plus a final checkpoint without losing confirmed entries',async()=>{
  const f=fixture({count:60}),rename=fs.renameSync;let writes=0;
  fs.renameSync=(from,to)=>{if(to===f.options.markerPath)writes++;return rename(from,to);};
  let result;try{result=await runThreadProviderCompatibility(f.options);}finally{fs.renameSync=rename;}
  assert.equal(result.updated.length,60);assert.ok(writes>=2&&writes<=4);
  const again=await runThreadProviderCompatibility({...f.options,executable:'missing-must-not-run'});assert.equal(again.planned,0);
});
