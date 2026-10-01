import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { patchCodexQuotaUi, collectQuotaIndependentModelIds } from '../shared/codex-quota-ui-transform.mjs';

// Actual 26.917 model-settings hook and model-picker prefix, captured before
// patching. External RPC/auth/React reads are supplied at their boundary; the
// model coercion and filtering are the real shipped client code.
const original = JSON.parse(fs.readFileSync(new URL('./fixtures/codex-26-917-quota-ui.json', import.meta.url)));
const API = 'cb-deepseek-v4-1-flash';
const GPT = 'cb-gpt-6-sol';
const ids = [API, 'cb-custom-fenno-model'];

function runHook(source, model, limited) {
  const requests = [];
  const settings = { model, reasoningEffort:'high', profile:'saved-profile', isLoading:false };
  const context = {Lq:{c:n=>Array(n).fill(Symbol.for('react.memo_cache_sentinel'))},X:{},
    ns:(_scope,handler)=>handler,
    jr:()=>({set(){}}), uha:()=>({draftSettings:{},isNewThreadDraft:false,updateDraftSettings(){}}),
    sga:()=>({isLunaReserveActive:limited,modelSettings:settings,defaultAdvancedModel:GPT,
      hostId:'local',setModelAndReasoningEffort:(...args)=>{requests.push(args);return true;},setModelAndReasoningEffortForNextTurn(){}}),
    yw:'gpt-reserve',nha(){},Fq:{}};
  vm.runInNewContext(source,context);
  return {value:context.cga('thread'),requests};
}

function runPicker(source, current, limited) {
  const models = [
    {model:'gpt-reserve',displayName:'Luna'},
    {model:GPT,displayName:'GPT-6 Sol'},
    {model:API,displayName:'DeepSeek V4.1 Flash'},
    {model:ids[1],displayName:'Fenno'},
  ];
  const atoms=['tS','SS','Ug','Kl','Vy','$v','Mre','Rw','dT','WN','UN','QT','wC','yf','Wd'];
  const context=Object.fromEntries(atoms.map(name=>[name,name]));
  Object.assign(context,{iat:{c:n=>Array(n).fill(Symbol.for('react.memo_cache_sentinel'))},
    b3:{useRef:()=>({current:null}),useState:()=>['simple',()=>{}]},ut:()=>({value:{kind:'local',placement:'side'}}),
    Lo:()=>({}),F:atom=>atom==='$v'?limited:atom==='dT'?{data:{model_provider:'openai'}}:atom==='Rw'?'openai':false,
    X:atom=>atom==='Mre'?'gpt-reserve':atom==='Vy'?{data:{ultraEffortEnabled:false}}:false,
    Sp:()=>false,Fs:{showUltraInModelPickerSlider:'flag'},Ux:()=>({hostId:'local',cwd:'fixture'}),Rm:()=>({authMethod:'chatgpt'}),
    Of:()=>false,lg:()=>false,pE:()=>null,TP:()=>({modelSettings:{model:current},selectComposerModelAndReasoningEffort(){},setDefaultModelAndReasoningEffort(){},setModelAndReasoningEffort(){}}),
    s3:()=>null,Gce:()=>false,Vie:()=>false,lu:'gpt-reserve',rat:m=>m.model==='gpt-reserve',nat:m=>m.model!=='gpt-reserve',
    Zw:()=>({data:{models},status:'success'})});
  vm.runInNewContext(source,context);
  return context.y3({conversationId:'thread'});
}

test('a registered API model keeps its identity and settings after subscription quota is exhausted', async () => {
  const patched=patchCodexQuotaUi({...original,initialSource:original.initial,primarySource:original.primary,apiModelIds:ids});
  const {value,requests}=runHook(patched.initialSource,API,true);
  assert.equal(value.modelSettings.model,API);
  assert.equal(value.modelSettings.reasoningEffort,'high');
  assert.equal(value.modelSettings.profile,'saved-profile');
  await value.setModelAndReasoningEffort(API,'max');
  assert.deepEqual(requests[0],[API,'max',undefined]);
});

test('the actual turn-request selector keeps API routing instead of sending gpt-reserve',()=>{
  const patched=patchCodexQuotaUi({initialSource:original.initial,primarySource:original.primary,apiModelIds:ids});
  const ctx={Lq:{},X:{},ns:(_scope,handler)=>handler,pj:'origin',jq:'limit',rM:'draft',AM:'thread',yw:'gpt-reserve'};
  vm.runInNewContext(patched.initialSource+'\nglobalThis.readRequest=Hss;',ctx);
  for(const conversationId of [null,'thread'])for(const origin of ['tpp','flora']){
    for(const model of [API,GPT]){
      const result=ctx.readRequest({conversationId,homeOrigin:origin},{get:key=>key==='origin'?origin:key==='limit'?true:{slug:model}});
      assert.equal(result,model===API?API:'gpt-reserve');
    }
  }
});

test('exhausted GPT quota still uses the genuine reserve path and unknown models get no exemption', () => {
  const patched=patchCodexQuotaUi({initialSource:original.initial,primarySource:original.primary,apiModelIds:ids});
  for(const model of [GPT,'gpt-6-astra','cb-unknown']) assert.equal(runHook(patched.initialSource,model,true).value.modelSettings.model,'gpt-reserve');
});

test('Luna mode offers reserve and registered API choices but not quota-blocked GPT choices', () => {
  const patched=patchCodexQuotaUi({initialSource:original.initial,primarySource:original.primary,apiModelIds:ids});
  const selected=runHook(patched.initialSource,API,true).value.modelSettings.model;
  const picker=runPicker(patched.primarySource,selected,true);
  assert.equal(picker.selectedModel,API);
  assert.equal(picker.lunaLock,false);
  assert.deepEqual(Array.from(picker.models,m=>m.model),['gpt-reserve',API,ids[1]]);
  assert.equal(picker.models.find(m=>m.model===API).displayName,'DeepSeek V4.1 Flash');
  const native=runPicker(patched.primarySource,'gpt-reserve',true);
  assert.equal(native.lunaLock,true);
  assert.equal(native.selectedModel,'gpt-reserve');
});

test('normal mode preserves the original picker and requested model', () => {
  const patched=patchCodexQuotaUi({initialSource:original.initial,primarySource:original.primary,apiModelIds:ids});
  assert.equal(runHook(patched.initialSource,API,false).value.modelSettings.model,API);
  const before=runPicker(original.primary,API,false), after=runPicker(patched.primarySource,API,false);
  assert.deepEqual(JSON.parse(JSON.stringify(after)),JSON.parse(JSON.stringify(before)));
});

test('API exemptions derive from explicit route authentication, not a model-name guess', () => {
  const selected=collectQuotaIndependentModelIds([
    {id:API,authMode:'api_key'},{id:ids[1],authMode:'anthropic_api_key'},
    {id:GPT,authMode:'codex_openai'},{id:'cb-unknown'}, {id:'gpt-6-sol',authMode:'api_key'},
  ]);
  assert.deepEqual(selected,[ids[1],API]);
});

test('unsupported source structure fails closed instead of applying a guessed patch', () => {
  assert.throws(()=>patchCodexQuotaUi({initialSource:'function other(){}',primarySource:original.primary,apiModelIds:ids}),/quota_.*contract/);
});
