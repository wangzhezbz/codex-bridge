import { parse } from 'acorn';

const HELPER = '__codexBridgeQuotaApiModel';
const MODEL_ID = /^cb-[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

function failure(code) { return Object.assign(new Error(code), { code }); }

function modelIds(values) {
  if (!Array.isArray(values) || values.length > 4096 || values.some(id => typeof id !== 'string' || !MODEL_ID.test(id))) {
    throw failure('quota_api_registry_invalid');
  }
  return [...new Set(values)].sort();
}

function patchFunction(source, name, replacements) {
  if (typeof source !== 'string' || source.length > 32 * 1024 * 1024 || source.includes(HELPER)) throw failure('quota_source_contract_invalid');
  const tree = parse(source, { ecmaVersion:'latest', sourceType:'module' });
  const matches = tree.body.filter(node => node.type === 'FunctionDeclaration' && node.id?.name === name);
  if (matches.length !== 1) throw failure('quota_source_contract_missing');
  const fn=matches[0]; let body=source.slice(fn.start,fn.end);
  for (const [before,after] of replacements) {
    const first=body.indexOf(before);
    if (first < 0 || body.indexOf(before,first+before.length) >= 0) throw failure('quota_source_contract_changed');
    body=body.slice(0,first)+after+body.slice(first+before.length);
  }
  return source.slice(0,fn.start)+body+source.slice(fn.end);
}

export function patchCodexQuotaUi({ initialSource, primarySource, apiModelIds }) {
  const ids=modelIds(apiModelIds);
  const helper=`\nfunction ${HELPER}(v){const m=typeof v==="string"?v:v?.model;return typeof m==="string"&&(${HELPER}.ids??=new Set(${JSON.stringify(ids)})).has(m)}\n`;
  let initial=patchFunction(initialSource,'cga',[
    ['if(f){','if(f&&!'+HELPER+'(_.model)){'],
  ]);
  const requestBefore='return(r===`tpp`||r===`flora`)&&n(jq,`local`)?yw:e==null?n(rM,r).slug:n(AM,e).slug';
  const requestAfter='return(r===`tpp`||r===`flora`)&&n(jq,`local`)&&!'+HELPER+'((e==null?n(rM,r):n(AM,e))?.slug)?yw:e==null?n(rM,r).slug:n(AM,e).slug';
  const returns=[];
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(node.type==='ReturnStatement'&&initial.slice(node.start,node.end).replace(/;$/u,'')===requestBefore)returns.push(node);
    for(const child of Object.values(node)){if(Array.isArray(child))child.forEach(visit);else if(child&&typeof child==='object')visit(child);}
  }
  visit(parse(initial,{ecmaVersion:'latest',sourceType:'module'}));
  if(returns.length<1||returns.length>2)throw failure('quota_request_contract_changed');
  for(const node of returns.sort((a,b)=>b.start-a.start))initial=initial.slice(0,node.start)+requestAfter+(initial[node.end-1]===';'?';':'')+initial.slice(node.end);
  initial+=helper;
  const primary=patchFunction(primarySource,'y3',[
    ['ue=C&&oe?.isAeon!==!0','ue=C&&oe?.isAeon!==!0&&!'+HELPER+'(J)'],
    ['ue&&(Ce=xe==null?[]:[xe]);',`C&&oe?.isAeon!==!0&&(Ce=[...(xe==null?[]:[xe]),...(Y??[]).filter(${HELPER})].filter((v,i,a)=>a.findIndex(x=>x.model===v.model)===i));`],
  ])+helper;
  parse(initial,{ecmaVersion:'latest',sourceType:'module'});
  parse(primary,{ecmaVersion:'latest',sourceType:'module'});
  return { initialSource:initial, primarySource:primary, apiModelIds:ids };
}

export function collectQuotaIndependentModelIds(models) {
  if (!Array.isArray(models) || models.length > 4096) throw failure('quota_route_registry_invalid');
  const api=new Set(), blocked=new Set();
  for(const model of models) {
    const id=model?.id || model?.slug;
    if(typeof id!=='string' || !MODEL_ID.test(id)) continue;
    const auth=model.authMode ?? model.codexbridge_capabilities?.auth_mode;
    if(['api_key','anthropic_api_key'].includes(auth)) api.add(id); else blocked.add(id);
  }
  return [...api].filter(id=>!blocked.has(id)).sort();
}
