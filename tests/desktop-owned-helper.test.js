import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const {runCommandCaptureWithTimeout}=createRequire(import.meta.url)('../desktop/openai-desktop-compat.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function child(pid){const value=new EventEmitter();value.pid=pid;value.exitCode=null;value.signalCode=null;value.stdout=new EventEmitter();value.kill=()=>true;return value;}

test('owned helper failure waits for process-tree termination before returning',async()=>{
  const root=child(23456),killer=child(34567),spawns=[];let settled=false;
  const pending=runCommandCaptureWithTimeout('fixture-worker',[],{killProcessTree:true,platform:'win32',timeoutMs:1000,maxOutputBytes:2,spawnImpl:(command,args,options)=>{spawns.push({command,args,options});return spawns.length===1?root:killer;}}).then(result=>{settled=true;return result;});
  root.stdout.emit('data',Buffer.from('too much output'));await delay(10);
  assert.equal(settled,false);assert.equal(spawns.length,2);assert.deepEqual(spawns[1].args,['/PID','23456','/T','/F']);assert.equal(spawns[1].options.windowsHide,true);
  root.exitCode=1;root.emit('close',1);await delay(5);assert.equal(settled,false);
  killer.exitCode=0;killer.emit('close',0);const result=await pending;
  assert.equal(result.ok,false);assert.equal(result.outputTooLarge,true);assert.equal(result.stdout,'to');assert.equal(result.terminationConfirmed,true);
});

test('owned helper cleanup failures remain explicit instead of pretending termination succeeded',async()=>{
  const root=child(23457),killer=child(34568);let calls=0;
  const pending=runCommandCaptureWithTimeout('fixture-worker',[],{killProcessTree:true,platform:'win32',timeoutMs:1000,maxOutputBytes:1,spawnImpl:()=>++calls===1?root:killer});
  root.stdout.emit('data',Buffer.from('overflow'));await delay(5);assert.equal(calls,2);killer.emit('error',new Error('fixture denied'));
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.terminationConfirmed,false);assert.equal(result.processId,23457);
});
test('a helper whose process already exited is never targeted through its old PID',async()=>{
  const root=child(23458);root.exitCode=0;let calls=0;
  const resultPromise=runCommandCaptureWithTimeout('fixture-worker',[],{killProcessTree:true,platform:'win32',timeoutMs:1000,maxOutputBytes:1,spawnImpl:()=>{calls++;return root;}});
  root.stdout.emit('data',Buffer.from('overflow'));
  const result=await resultPromise;assert.equal(calls,1);assert.equal(result.terminationConfirmed,false);
});
test('a stuck process-tree terminator has a bounded failure path',async()=>{
  const root=child(23459),killer=child(34569);let calls=0,killerStopped=0;
  killer.kill=()=>{killerStopped++;return true;};
  const pending=runCommandCaptureWithTimeout('fixture-worker',[],{killProcessTree:true,platform:'win32',timeoutMs:1000,terminationTimeoutMs:20,maxOutputBytes:1,spawnImpl:()=>++calls===1?root:killer});
  root.stdout.emit('data',Buffer.from('overflow'));
  const result=await pending;assert.equal(result.terminationConfirmed,false);assert.equal(killerStopped,1);
});
test('a late successful root close cannot turn an owned timeout into success',async()=>{
  const root=child(23460),killer=child(34570);let calls=0;
  const pending=runCommandCaptureWithTimeout('fixture-worker',[],{killProcessTree:true,platform:'win32',timeoutMs:10,spawnImpl:()=>++calls===1?root:killer});
  await delay(25);assert.equal(calls,2);root.exitCode=0;root.emit('close',0);killer.emit('close',0);
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.timedOut,true);assert.equal(result.terminationConfirmed,true);
});

test('Windows timeout does not leave a real child process behind', {skip:process.platform!=='win32',timeout:20000}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cb-owned-process-'));
  const info=path.join(root,'child.json'),token=randomUUID(),parent=path.join(root,'parent.cjs'),grandchild=path.join(root,'child.cjs');
  fs.writeFileSync(grandchild,"const fs=require('node:fs');fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,token:process.argv[3]}));setInterval(()=>{},1000);");
  fs.writeFileSync(parent,"const {spawn}=require('node:child_process');const c=spawn(process.execPath,[process.argv[2],process.argv[3],process.argv[4]],{stdio:'ignore',detached:true,windowsHide:true});c.unref();setInterval(()=>{},1000);");
  const result=await runCommandCaptureWithTimeout(process.execPath,[parent,grandchild,info,token],{killProcessTree:true,timeoutMs:1500,maxOutputBytes:2048});
  assert.equal(result.timedOut,true);assert.ok(fs.existsSync(info),'fixture must start before timeout');
  const saved=JSON.parse(fs.readFileSync(info,'utf8'));assert.equal(saved.token,token);assert.ok(Number.isInteger(saved.pid)&&saved.pid>1);
  let running;try{process.kill(saved.pid,0);running=true;}catch(error){assert.equal(error.code,'ESRCH');running=false;}
  try{assert.equal(running,false,'timed-out helper child must be gone');assert.equal(result.terminationConfirmed,true);}
  finally{if(running){
    const command=execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${saved.pid}').CommandLine`],{windowsHide:true,encoding:'utf8',timeout:4000});
    assert.ok(command.includes(token),'cleanup can target only this test child');
    execFileSync(path.join(process.env.SystemRoot,'System32','taskkill.exe'),['/PID',String(saved.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});
  }}
});
