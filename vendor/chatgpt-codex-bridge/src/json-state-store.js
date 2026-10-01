import {randomBytes} from "node:crypto";
import {mkdir, open, readFile, rename, stat, unlink} from "node:fs/promises";
import path from "node:path";
import {acquireRouterLockGuard} from "./router-lock-guard.js";

export const JSON_STATE_PROTOCOL = "atomic-backup-v1";

function stateError(code, file, cause) {
  const message = code === "BRIDGE_STATE_MISSING"
    ? "Bridge 配置主文件缺失，但存在备份；请核对恢复，未按空数据重建"
    : code === "BRIDGE_STATE_CORRUPT"
      ? "Bridge 配置文件损坏或结构异常；已停止覆盖写入，请核对备份"
      : "Bridge 配置文件读取失败；未按空数据处理";
  return Object.assign(new Error(`${message}：${path.basename(file)}`, {cause}), {code, filePath:file});
}

/** Missing means genuinely new: a remaining backup prevents silent reinitialization. */
export async function readJsonState(file, validate) {
  let text;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw stateError("BRIDGE_STATE_READ_FAILED",file,error);
    try { await stat(file+".bak"); }
    catch (backupError) {
      if (backupError.code === "ENOENT") return {exists:false,value:null,text:null};
      throw stateError("BRIDGE_STATE_READ_FAILED",file,backupError);
    }
    throw stateError("BRIDGE_STATE_MISSING",file,error);
  }
  let value;
  try {
    value = JSON.parse(text);
    if (!validate(value)) throw new Error("Invalid persisted state shape");
  } catch (error) { throw stateError("BRIDGE_STATE_CORRUPT",file,error); }
  return {exists:true,value,text};
}

/** Enclose the complete read/modify/write operation, not only the final write. */
export async function withJsonStateLock(file, operation) {
  await mkdir(path.dirname(file), {recursive:true});
  const release = await acquireRouterLockGuard(file+".state-write");
  let failure;
  try { return await operation(); }
  catch (error) { failure=error; throw error; }
  finally {
    try { await release(); }
    catch (error) { if (failure) failure.cleanupError=error; else throw error; }
  }
}

async function replaceFile(file, text, operations) {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const openFile=operations.open || open, renameFile=operations.rename || rename;
  let handle, created=false;
  try {
    handle=await openFile(temporary,"wx",0o600); created=true;
    await handle.writeFile(text,"utf8");
    await handle.sync();
    await handle.close(); handle=null;
    const deadline=Date.now()+2000;
    for (;;) {
      try { await renameFile(temporary,file); created=false; break; }
      catch (error) {
        if (process.platform!=="win32" || !["EPERM","EACCES","EBUSY"].includes(error.code) || Date.now()>=deadline) throw error;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
    }
  } catch (error) {
    if(handle) try { await handle.close(); } catch(cleanupError) { error.closeError=cleanupError; }
    if(created) try { await unlink(temporary); } catch(cleanupError) { if(cleanupError.code!=="ENOENT")error.cleanupError=cleanupError; }
    throw error;
  }
}

/** Caller must hold withJsonStateLock(file) from its first read through this commit. */
export async function writeJsonState(file, value, validate, operations = {}) {
  if (!validate(value)) throw stateError("BRIDGE_STATE_CORRUPT",file,new Error("Invalid new state shape"));
  const next=JSON.stringify(value,null,2)+"\n";
  if (!validate(JSON.parse(next))) throw stateError("BRIDGE_STATE_CORRUPT",file,new Error("Serialization changed persisted state shape"));
  const previous=await readJsonState(file,validate);
  if(previous.exists) await replaceFile(file+".bak",previous.text,operations);
  await replaceFile(file,next,operations);
}
