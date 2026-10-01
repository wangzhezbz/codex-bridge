import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {createPackage,getRawHeader,extractFile} from '@electron/asar';
import {writeQuotaArchiveOverlay,QUOTA_PROFILE} from '../scripts/software-manager/green-quota-compat.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/codex-26-917-quota-ui.json',import.meta.url)));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function archive(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'quota-asar-'));const src=path.join(root,'src');
 for(const [p,value] of [[QUOTA_PROFILE.initial,fixture.initial],[QUOTA_PROFILE.primary,fixture.primary],['other.txt','keep this file']]){const dest=path.join(src,...p.split('/'));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,value);}
 // Real Codex modules live at multi-digit offsets, providing header room when
 // the packed offset is replaced with the standard unpacked flag.
 fs.writeFileSync(path.join(src,'aaa-padding.bin'),Buffer.alloc(10*1024*1024));
 const target=path.join(root,'app.asar');await createPackage(src,target);return{target,before:fs.readFileSync(target),hashes:{initial:hash(fixture.initial),primary:hash(fixture.primary)}};}
test('quota overlay preserves every packed data byte and verifies both new unpacked scripts',async()=>{
 const f=await archive(),before=getRawHeader(f.target),other=extractFile(f.target,'other.txt');
 const result=writeQuotaArchiveOverlay({asarPath:f.target,expectedHashes:f.hashes,apiModelIds:['cb-deepseek-v4-1-flash']});
 const after=getRawHeader(f.target),bytes=fs.readFileSync(f.target);
 assert.equal(after.headerSize,before.headerSize);
 assert.ok(bytes.subarray(8+before.headerSize).equals(f.before.subarray(8+before.headerSize)));
 assert.ok(extractFile(f.target,'other.txt').equals(other));
 assert.match(extractFile(f.target,path.normalize(QUOTA_PROFILE.initial)).toString(),/__codexBridgeQuotaApiModel/);
 assert.match(extractFile(f.target,path.normalize(QUOTA_PROFILE.primary)).toString(),/__codexBridgeQuotaApiModel/);
 assert.equal(result.newFiles.length,2);
});
test('a mismatched native source hash leaves the archive and unpacked tree untouched',async()=>{
 const f=await archive();assert.throws(()=>writeQuotaArchiveOverlay({asarPath:f.target,expectedHashes:{initial:'0'.repeat(64),primary:f.hashes.primary},apiModelIds:[]}),/quota_source_hash_mismatch/);
 assert.ok(fs.readFileSync(f.target).equals(f.before));assert.equal(fs.existsSync(f.target+'.unpacked'),false);
});
