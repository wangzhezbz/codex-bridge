import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractFile, getRawHeader, uncacheAll } from '@electron/asar';
import { patchCodexQuotaUi } from '../../shared/codex-quota-ui-transform.mjs';
import { verifyGreenCodexDirectory } from './chatgpt-green-converter.mjs';
import { inspectPackageTree } from './package-inspector.mjs';
import { hashPackageTree, readGreenCodexMarker } from './chatgpt-green-metadata.mjs';

export const QUOTA_PATCH_ID='bridge-api-quota-compat-v1';
export const QUOTA_PROFILE=Object.freeze({
  version:'26.917.9434.0',
  initial:'webview/assets/app-initial-fc9a33fdda88.js',
  primary:'webview/assets/app-primary-a7ff54c980af.js',
  initialSha256:'34a60939a5f44634a65c956b7904d63236178e6d45a049717358fc163ecffe88',
  primarySha256:'e8ac507e0a621099a2b82b9ae17b1d1930ab971b1d088fe4fb81f5437648d043',
});
const MARKERS=['.codexbridge-green-codex.json','.codexbridge-chatgpt-version.json'];
function error(code){return Object.assign(new Error(code),{code});}
function sha(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
function realFile(p){const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink())throw error('quota_file_invalid');return s;}
function entryFor(header,name){let e=header;for(const p of name.split('/'))e=e.files?.[p];if(!e||e.unpacked||typeof e.offset!=='string'||e.integrity?.algorithm!=='SHA256')throw error('quota_asar_entry_invalid');return e;}
function integrity(bytes,blockSize){if(!Number.isSafeInteger(blockSize)||blockSize<1)throw error('quota_integrity_invalid');const blocks=[];for(let i=0;i<bytes.length;i+=blockSize)blocks.push(sha(bytes.subarray(i,i+blockSize)));return{algorithm:'SHA256',hash:sha(bytes),blockSize,blocks};}

// Keep the packed data and its base offset byte-for-byte unchanged. New JS is
// placed in the standard ASAR-unpacked tree; only a same-length header changes.
// A running Electron with the old cached header can still read all old bytes.
export function writeQuotaArchiveOverlay({asarPath,initialSource,primarySource,expectedHashes,apiModelIds}={}){
  realFile(asarPath);uncacheAll();
  const raw=getRawHeader(asarPath),header=structuredClone(raw.header);
  const names=[QUOTA_PROFILE.initial,QUOTA_PROFILE.primary];
  const originals=names.map(name=>extractFile(asarPath,path.normalize(name)));
  if(sha(originals[0])!==expectedHashes?.initial||sha(originals[1])!==expectedHashes?.primary)throw error('quota_source_hash_mismatch');
  const patched=patchCodexQuotaUi({initialSource:initialSource??originals[0].toString(),primarySource:primarySource??originals[1].toString(),apiModelIds});
  const values=[Buffer.from(patched.initialSource),Buffer.from(patched.primarySource)];
  for(let i=0;i<names.length;i++){const e=entryFor(header,names[i]);if(e.integrity.hash!==sha(originals[i]))throw error('quota_integrity_invalid');e.size=values[i].length;e.integrity=integrity(values[i],e.integrity.blockSize);delete e.offset;e.unpacked=true;}
  const originalHeader=Buffer.from(raw.headerString),newJson=Buffer.from(JSON.stringify(header));
  if(newJson.length>originalHeader.length)throw error('quota_header_budget_exceeded');
  const padded=Buffer.concat([newJson,Buffer.alloc(originalHeader.length-newJson.length,32)]);
  const prefix=Buffer.alloc(8+raw.headerSize),fd=fs.openSync(asarPath,'r');
  try{if(fs.readSync(fd,prefix,0,prefix.length,0)!==prefix.length)throw error('quota_asar_truncated');}finally{fs.closeSync(fd);}
  const at=prefix.indexOf(originalHeader);
  if(at<0||prefix.indexOf(originalHeader,at+1)>=0)throw error('quota_header_ambiguous');
  const newFiles=[];
  for(let i=0;i<names.length;i++){
    const dest=path.join(asarPath+'.unpacked',...names[i].split('/'));
    if(fs.existsSync(dest))throw error('quota_asset_target_occupied');
    fs.mkdirSync(path.dirname(dest),{recursive:true});const out=fs.openSync(dest,'wx');
    try{fs.writeFileSync(out,values[i]);fs.fsyncSync(out);}finally{fs.closeSync(out);}
    newFiles.push(dest);
  }
  padded.copy(prefix,at);
  const out=fs.openSync(asarPath,'r+');
  try{fs.writeSync(out,prefix,0,prefix.length,0);fs.fsyncSync(out);}finally{fs.closeSync(out);}
  uncacheAll();const after=getRawHeader(asarPath);
  if(after.headerSize!==raw.headerSize)throw error('quota_asar_header_changed');
  for(let i=0;i<names.length;i++)if(!extractFile(asarPath,path.normalize(names[i])).equals(values[i]))throw error('quota_asar_verification_failed');
  return {patchId:QUOTA_PATCH_ID,apiModelIds:patched.apiModelIds,newFiles,headerSize:raw.headerSize};
}

export async function createQuotaCompatibleGreenCopy({inputPath,outputPath,backupPath,apiModelIds,onProgress=()=>{}}={}){
  for(const p of [inputPath,outputPath,backupPath])if(!p||!path.isAbsolute(p))throw error('quota_path_invalid');
  if(fs.existsSync(outputPath)||fs.existsSync(backupPath))throw error('quota_output_occupied');
  onProgress('正在验证原绿色版');
  const base=await verifyGreenCodexDirectory({inputPath});
  const marker=readGreenCodexMarker(inputPath);
  if(base.officialVersion!==QUOTA_PROFILE.version||marker.formatVersion!==2)throw error('quota_version_unsupported');
  const archive=path.join(inputPath,'resources','app.asar');
  const beforeSha=sha(fs.readFileSync(archive));
  for(const [name,pin] of [[QUOTA_PROFILE.initial,QUOTA_PROFILE.initialSha256],[QUOTA_PROFILE.primary,QUOTA_PROFILE.primarySha256]]){
    if(sha(extractFile(archive,path.normalize(name)))!==pin)throw error('quota_source_hash_mismatch');
  }
  onProgress('正在备份原 ASAR 与版本标记');
  fs.mkdirSync(backupPath,{recursive:true});
  fs.copyFileSync(archive,path.join(backupPath,'app.asar'),fs.constants.COPYFILE_EXCL);
  for(const name of MARKERS)fs.copyFileSync(path.join(inputPath,name),path.join(backupPath,name),fs.constants.COPYFILE_EXCL);
  if(sha(fs.readFileSync(path.join(backupPath,'app.asar')))!==beforeSha)throw error('quota_backup_verification_failed');
  onProgress('正在复制完整绿色版');
  fs.mkdirSync(outputPath,{recursive:true});
  const tree=inspectPackageTree(inputPath);
  for(const entry of tree.entries){const dest=path.join(outputPath,...entry.path.split('/'));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(entry.absolute,dest,fs.constants.COPYFILE_EXCL);}
  if(hashPackageTree(outputPath,{exclude:MARKERS})!==marker.contentTreeSha256)throw error('quota_copy_verification_failed');
  onProgress('正在加入限定额度兼容补丁');
  const receipt=writeQuotaArchiveOverlay({asarPath:path.join(outputPath,'resources','app.asar'),expectedHashes:{initial:QUOTA_PROFILE.initialSha256,primary:QUOTA_PROFILE.primarySha256},apiModelIds});
  const info={schemaVersion:1,patchId:QUOTA_PATCH_ID,officialVersion:base.officialVersion,originalAsarSha256:beforeSha,
    patchedAsarSha256:sha(fs.readFileSync(path.join(outputPath,'resources','app.asar'))),apiModelIds:receipt.apiModelIds};
  fs.writeFileSync(path.join(outputPath,'.codexbridge-quota-compat.json'),JSON.stringify(info,null,2)+'\n',{flag:'wx'});
  const next={...marker,portablePatchIds:[...marker.portablePatchIds,QUOTA_PATCH_ID],
    portableResourceTreeSha256:hashPackageTree(path.join(outputPath,'resources')),
    contentTreeSha256:hashPackageTree(outputPath,{exclude:MARKERS})};
  fs.writeFileSync(path.join(outputPath,MARKERS[0]),JSON.stringify(next,null,2)+'\n');
  onProgress('正在复核文件树与资源哈希');
  const verified=await verifyGreenCodexDirectory({inputPath:outputPath});
  return {...info,...verified,backupPath};
}
