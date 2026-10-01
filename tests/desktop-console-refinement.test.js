import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext as runVm } from 'node:vm';

function runInNewContext(code, sandbox, ...options) {
  if (!Object.hasOwn(sandbox, 'modeSwitchDraftsToKeep')) sandbox.modeSwitchDraftsToKeep = new WeakSet();
  if (!Object.hasOwn(sandbox, 'pendingModeSwitch')) sandbox.pendingModeSwitch = null;
  if (!Object.hasOwn(sandbox, 'unresolvedModeSwitch')) sandbox.unresolvedModeSwitch = null;
  return runVm(code, sandbox, ...options);
}

const source = readFileSync(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && (end < 0 || end > start), `Missing renderer function ${name}`);
  return source.slice(start, end < 0 ? source.length : end);
}

function loadModeSwitchHelpers(sandbox) {
  sandbox.pendingModeSwitch = null;
  sandbox.unresolvedModeSwitch = null;
  sandbox.refresh ??= async () => {};
  sandbox.modeSwitchDraftsToKeep = new WeakSet();
  const end=source.indexOf('function resourceSummaryReadStatus(');
  runInNewContext(source.slice(0,end),sandbox);
}

test('retired built-in cards are hidden in the picker without hiding a user custom model', () => {
  const sandbox={modelCatalogQuery:'',providerName:()=> 'OpenAI',providerFor:()=>({})};
  runInNewContext(functionSource('modelMatchesCatalogQuery'),sandbox);
  assert.equal(sandbox.modelMatchesCatalogQuery({presetId:'openai-gpt-4-1',hiddenFromPicker:true}),false);
  assert.equal(sandbox.modelMatchesCatalogQuery({presetId:'my-model',custom:true,model:'gpt-4.1'}),true);
});

test('manual API mode cancellation changes neither billing mode nor model selection', async () => {
  const state={mode:'hybrid',selectedModelIds:['deepseek-v4-flash']};
  let writes=0;
  const sandbox={state,draftSelection:[...state.selectedModelIds],runAction:(_button,action)=>action(),
    showConfirmDialog:async ()=>false,api:{selectMode:async ()=>{writes++;}},showToast(){}};
  loadModeSwitchHelpers(sandbox);
  await sandbox.changeBillingMode({dataset:{mode:'all_api'}});
  assert.equal(writes,0);
  assert.equal(sandbox.state,state);
});

test('manual API mode requires unsaved model edits to be resolved before changing billing', async () => {
  let confirmations=0,writes=0;
  const sandbox={state:{mode:'hybrid',selectedModelIds:['api-a']},draftSelection:['api-a','api-b'],
    runAction:(_button,action)=>action(),showConfirmDialog:async ()=>{confirmations++;return true;},
    api:{selectMode:async ()=>{writes++;}},showToast(){}};
  loadModeSwitchHelpers(sandbox);
  await assert.rejects(sandbox.changeBillingMode({dataset:{mode:'all_api'}}),/未保存/);
  assert.equal(confirmations,0);
  assert.equal(writes,0);
});

test('manual API mode submits the confirmed selection and does not switch after it changes', async () => {
  for(const changed of [false,true]) {
    const requests=[];
    const state={mode:'hybrid',selectedModelIds:['subscription','api-a']};
    const sandbox={state,draftSelection:[...state.selectedModelIds],runAction:(_button,action)=>action(),
      showConfirmDialog:async ()=>{if(changed)sandbox.draftSelection=['api-b'];return true;},
      api:{selectMode:async (...args)=>{requests.push(args);return {state:{mode:'all_api',selectedModelIds:['api-a']},transaction:{restartRequired:true}};}},
      normalizeModeSelectionResult:value=>value,adoptStateSnapshot:value=>{sandbox.state=value;},render(){},showToast(){}};
    loadModeSwitchHelpers(sandbox);
    if(changed) {
      await assert.rejects(sandbox.changeBillingMode({dataset:{mode:'all_api'}}),/变化|重新/);
      assert.equal(requests.length,0);
    } else {
      await sandbox.changeBillingMode({dataset:{mode:'all_api'}});
      assert.equal(requests.length,1);
      assert.equal(requests[0][0],'all_api');
      assert.equal(requests[0][1].preserveSelection,true);
      assert.deepEqual(Array.from(requests[0][1].expectedSelectedModelIds),['subscription','api-a']);
      assert.equal(sandbox.state.mode,'all_api');
      assert.deepEqual(Array.from(sandbox.draftSelection),['api-a']);
    }
  }
});

test('manual API mode does not present a cached unavailable state as confirmed success', async () => {
  let adopted=0,refreshed=0;
  const messages=[];
  const sandbox={state:{mode:'hybrid',selectedModelIds:['api-a']},draftSelection:['api-a'],
    runAction:(_button,action)=>action(),showConfirmDialog:async ()=>true,
    api:{selectMode:async ()=>({state:{mode:'all_api',stateUnavailable:true,selectedModelIds:['api-a']},transaction:{configRevision:'committed'}})},
    normalizeModeSelectionResult:value=>value,adoptStateSnapshot:()=>{adopted++;},render(){},
    refresh:async ()=>{refreshed++;},showToast:(message,type)=>messages.push({message,type})};
  loadModeSwitchHelpers(sandbox);
  await sandbox.changeBillingMode({dataset:{mode:'all_api'}});
  assert.equal(adopted,0);
  assert.equal(refreshed,1);
  assert.match(messages[0].message,/刷新/);
  assert.equal(messages[0].type,'error');
});

for (const timing of ['reply','broadcast-before-reply','late-broadcast-after-error']) {
  test(`manual mode switching retains edits made during its request: ${timing}`, async () => {
    let finish,markStarted;
    const started=new Promise(resolve=>{markStarted=resolve;});
    const sandbox={state:{mode:'hybrid',selectedModelIds:['subscription','api-a']},draftSelection:['subscription','api-a'],
      modelSelectionDraftsToKeep:new WeakSet(),runAction:(_button,action)=>action(),showConfirmDialog:async()=>true,
      api:{selectMode:()=>new Promise((resolve,reject)=>{finish={resolve,reject};markStarted();})},
      mergeStateWithRetainedDetailSlices:(_old,next)=>next,syncLoadedStateDetails(){},render(){},showToast(){}};
    loadModeSwitchHelpers(sandbox);
    runInNewContext(['adoptStateSnapshot','updateModelSelectionDraft'].map(functionSource).join('\n'),sandbox);
    const pending=sandbox.changeBillingMode({dataset:{mode:'all_api'}});await started;
    sandbox.updateModelSelectionDraft(['api-a','api-added-later']);
    const next={mode:'all_api',selectedModelIds:['api-a']};
    if(timing==='broadcast-before-reply') {
      sandbox.adoptStateSnapshot(next);
      assert.deepEqual(Array.from(sandbox.draftSelection),['api-a','api-added-later']);
    }
    if(timing==='late-broadcast-after-error') {
      finish.reject(new Error('reply lost'));await assert.rejects(pending,/reply lost/);
      sandbox.adoptStateSnapshot(next);
    } else {finish.resolve({state:next,transaction:{revision:'committed'}});await pending;}
    assert.deepEqual(Array.from(sandbox.state.selectedModelIds),['api-a']);
    assert.deepEqual(Array.from(sandbox.draftSelection),['api-a','api-added-later']);
    assert.equal(sandbox.pendingModeSwitch,null);
  });
}

test('billing mode return asks for confirmation and preserves the selected API list', async () => {
  for (const accepted of [false,true]) {
    const calls=[];
    const sandbox={state:{mode:'all_api',selectedModelIds:['api-b','api-a']},draftSelection:['api-b','api-a'],
      runAction:(_button,action)=>action(),showConfirmDialog:async()=>accepted,
      api:{selectMode:async (...args)=>{calls.push(args);return {state:{mode:'hybrid',selectedModelIds:['api-b','api-a']}};}},
      adoptStateSnapshot:next=>{sandbox.state=next;},render(){},showToast(){}};
    loadModeSwitchHelpers(sandbox);
    await sandbox.changeBillingMode({dataset:{mode:'hybrid'}});
    assert.equal(calls.length,accepted?1:0);
    if(accepted) {
      assert.equal(calls[0][0],'hybrid');
      assert.equal(calls[0][1].preserveSelection,true);
      assert.deepEqual(Array.from(calls[0][1].expectedSelectedModelIds),['api-b','api-a']);
      assert.deepEqual(Array.from(sandbox.draftSelection),['api-b','api-a']);
    }
  }
});

test('a retained incompatible mode draft cannot be saved as a replacement API model', async () => {
  let writes=0;
  const draft=['subscription','api-a'];
  const sandbox={state:{mode:'all_api',selectedModelIds:['api-a'],modelPresets:[{presetId:'subscription',authMode:'codex_openai'},{presetId:'api-a',authMode:'api_key'}]},
    draftSelection:draft,modeSwitchDraftsToKeep:new WeakSet([draft]),modelSelectionDraftsToKeep:new WeakSet(),
    runAction:(_button,action)=>action(),api:{saveModelSelection:async()=>{writes++;return {mode:'all_api',selectedModelIds:draft};}},
    mergeStateWithRetainedDetailSlices:(_old,next)=>next,render(){},showToast(){}};
  runInNewContext(functionSource('saveModelSelection'),sandbox);
  await assert.rejects(sandbox.saveModelSelection({}),/不可用|不支持/);
  assert.equal(writes,0);
  assert.deepEqual(Array.from(sandbox.draftSelection),['subscription','api-a']);
});

test('a valid retained mode draft can be explicitly saved and releases its protection', async () => {
  const draft=['api-a','api-b'];let writes=0;
  const sandbox={state:{mode:'all_api',selectedModelIds:['api-a'],modelPresets:[{presetId:'api-a',authMode:'api_key'},{presetId:'api-b',authMode:'api_key'}]},
    draftSelection:draft,modeSwitchDraftsToKeep:new WeakSet([draft]),modelSelectionDraftsToKeep:new WeakSet(),
    runAction:(_button,action)=>action(),api:{saveModelSelection:async ids=>{writes++;return {...sandbox.state,selectedModelIds:ids};}},
    mergeStateWithRetainedDetailSlices:(_old,next)=>next,render(){},showToast(){}};
  runInNewContext(functionSource('saveModelSelection'),sandbox);
  await sandbox.saveModelSelection({});
  assert.equal(writes,1);
  assert.deepEqual(Array.from(sandbox.draftSelection),['api-a','api-b']);
  assert.equal(sandbox.modeSwitchDraftsToKeep.has(sandbox.draftSelection),false);
});

test('a model draft cannot be saved while its billing mode is still switching', async () => {
  let writes=0;const draft=['subscription'];
  const sandbox={state:{mode:'hybrid',selectedModelIds:['api-a'],modelPresets:[{presetId:'subscription',authMode:'codex_openai'}]},
    draftSelection:draft,pendingModeSwitch:{mode:'all_api'},modeSwitchDraftsToKeep:new WeakSet([draft]),
    modelSelectionDraftsToKeep:new WeakSet(),runAction:(_button,action)=>action(),
    api:{saveModelSelection:async()=>{writes++;return {mode:'hybrid',selectedModelIds:draft};}},
    mergeStateWithRetainedDetailSlices:(_old,next)=>next,render(){},showToast(){}};
  runInNewContext(functionSource('saveModelSelection'),sandbox);
  await assert.rejects(sandbox.saveModelSelection({}),/切换|确认/);
  assert.equal(writes,0);
});

test('edits made after an unconfirmed mode error survive the later authoritative mode snapshot', async () => {
  const sandbox={state:{mode:'hybrid',selectedModelIds:['api-a']},draftSelection:['api-a'],
    modelSelectionDraftsToKeep:new WeakSet(),runAction:(_button,action)=>action(),showConfirmDialog:async()=>true,
    api:{selectMode:async()=>{throw new Error('reply lost');}},
    mergeStateWithRetainedDetailSlices:(_old,next)=>next,syncLoadedStateDetails(){},render(){},showToast(){}};
  loadModeSwitchHelpers(sandbox);
  runInNewContext(['adoptStateSnapshot','updateModelSelectionDraft'].map(functionSource).join('\n'),sandbox);
  await assert.rejects(sandbox.changeBillingMode({dataset:{mode:'all_api'}}),/reply lost/);
  sandbox.updateModelSelectionDraft(['api-a','api-b']);
  sandbox.adoptStateSnapshot({mode:'all_api',selectedModelIds:['api-a'],stateUnavailable:false});
  assert.deepEqual(Array.from(sandbox.draftSelection),['api-a','api-b']);
  assert.equal(sandbox.unresolvedModeSwitch,null);
});

test('an old-mode refresh after a lost reply does not erase protection for later edits', async () => {
  const sandbox={state:{mode:'hybrid',selectedModelIds:['api-a']},draftSelection:['api-a'],
    modelSelectionDraftsToKeep:new WeakSet(),runAction:(_button,action)=>action(),showConfirmDialog:async()=>true,
    api:{selectMode:async()=>{throw new Error('reply lost');}},
    mergeStateWithRetainedDetailSlices:(_old,next)=>next,syncLoadedStateDetails(){},render(){},showToast(){}};
  loadModeSwitchHelpers(sandbox);
  runInNewContext(['adoptStateSnapshot','updateModelSelectionDraft'].map(functionSource).join('\n'),sandbox);
  await assert.rejects(sandbox.changeBillingMode({dataset:{mode:'all_api'}}));
  sandbox.adoptStateSnapshot({mode:'hybrid',selectedModelIds:['api-a'],stateUnavailable:false});
  sandbox.updateModelSelectionDraft(['api-a','api-b']);
  sandbox.adoptStateSnapshot({mode:'all_api',selectedModelIds:['api-a'],stateUnavailable:false});
  assert.deepEqual(Array.from(sandbox.draftSelection),['api-a','api-b']);
});

// Exercise the renderer's real toast lifecycle with a deterministic clock; native
// hit testing, selection, clipboard IPC and focus events are covered by the UI review.
function toastHarness(copyText = async () => ({ok:true})) {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const listeners = new Map();
  const document = {hidden:false,activeElement:null,
    addEventListener(name, handler) { listeners.set(name, handler); },
    querySelector:() => opener};
  const node = () => ({textContent:'',disabled:false,isConnected:true,attributes:{},handlers:{},
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { document.activeElement = this; },getClientRects:() => [1]});
  const opener = node();
  document.activeElement = opener;
  const message = node(), feedback = node(), copy = node(), close = node();
  const root = {...node(),className:'toast hidden',hovered:false,
    contains:element => [root,message,feedback,copy,close].includes(element),
    matches:() => root.hovered,
    querySelector:selector => ({'[data-toast-message]':message,'[data-toast-feedback]':feedback,
      '[data-toast-copy]':copy,'[data-toast-close]':close})[selector]};
  root.classList = {
    contains:name => root.className.split(' ').includes(name),
    add:name => { if (!root.classList.contains(name)) root.className += ' '+name; },
  };
  const window = {setTimeout(handler, delay) { const id=++sequence; timers.set(id,{handler,at:now+delay}); return id; },
    clearTimeout:id => timers.delete(id)};
  const start=source.indexOf('function showToast(');
  const end=source.indexOf('\nfunction emptyUsageSummary(',start);
  const sandbox={els:{toast:root},api:{copyText},window,document,Date:{now:() => now}};
  runInNewContext(source.slice(start,end),sandbox);
  return {root,message,feedback,copy,close,document,opener,
    show:sandbox.showToast,
    emit:async (target,name,event={}) => target.handlers[name]?.(event),
    visibility:hidden => {document.hidden=hidden; listeners.get('visibilitychange')?.();},
    tick(ms) {
      const deadline=now+ms;
      while (true) {
        const next=[...timers].sort((a,b) => a[1].at-b[1].at)[0];
        if (!next || next[1].at>deadline) break;
        now=next[1].at; timers.delete(next[0]); next[1].handler();
      }
      now=deadline;
    }};
}

test('all notification types close at five seconds and preserve plain text while visible', () => {
  for (const type of ['success','info','error','warning']) {
  const ui=toastHarness();
  const text='安装失败：<img src=x onerror=alert(1)>\nF:\\测试目录\\manifest.json';
  ui.show(text,type); ui.tick(4999);
  assert.equal(ui.root.classList.contains('hidden'),false);
  assert.equal(ui.message.textContent,text);
  ui.tick(1);
  assert.equal(ui.root.classList.contains('hidden'),true);
  }
});

test('long informational notifications use the same five-second timeout', () => {
  const ui=toastHarness();
  ui.show('已保存：'+ '测试目录'.repeat(50),'info');
  ui.tick(4999);
  assert.equal(ui.root.classList.contains('hidden'),false);
  ui.tick(1);
  assert.equal(ui.root.classList.contains('hidden'),true);
});

test('hovering without clicking does not leave a notification stuck on screen', async () => {
  const ui=toastHarness();
  ui.show('设置已保存'); ui.tick(1000);
  ui.root.hovered=true; await ui.emit(ui.root,'mouseenter'); ui.tick(3999);
  assert.equal(ui.root.classList.contains('hidden'),false);
  ui.tick(1); assert.equal(ui.root.classList.contains('hidden'),true);
});

test('focused notifications expire and return focus to the invoking control', async () => {
  const ui=toastHarness();
  ui.show('设置已保存'); ui.close.focus(); await ui.emit(ui.root,'focusin'); ui.tick(5000);
  assert.equal(ui.root.classList.contains('hidden'),true);
  assert.equal(ui.document.activeElement,ui.opener);
});

test('notifications no longer register a clipboard action', async () => {
  const copied=[];
  const ui=toastHarness(async text => {copied.push(text); return {ok:true};});
  ui.show('原始错误\n完整路径','error');
  await ui.emit(ui.copy,'click');
  assert.deepEqual(copied,[]);
  assert.equal(ui.message.textContent,'原始错误\n完整路径');
  assert.equal(ui.copy.handlers.click,undefined);
  assert.equal(ui.root.classList.contains('hidden'),false);
});

test('replacing a notification restarts its five-second timer', () => {
  const ui=toastHarness();
  ui.show('前一条','error');
  ui.tick(4000);
  ui.show('后一条','error');
  ui.tick(4999);
  assert.equal(ui.message.textContent,'后一条');
  assert.equal(ui.root.classList.contains('hidden'),false);
  ui.tick(1);
  assert.equal(ui.root.classList.contains('hidden'),true);
});

test('closing a focused notification restores the invoking control without hiding the next message', async () => {
  const ui=toastHarness();
  ui.show('错误','error'); ui.close.focus(); await ui.emit(ui.close,'click');
  assert.equal(ui.root.classList.contains('hidden'),true);
  assert.equal(ui.document.activeElement,ui.opener);
  ui.show('新的错误','error'); ui.tick(4999);
  assert.equal(ui.root.classList.contains('hidden'),false);
});

test('Escape used to cancel IME composition does not dismiss the notification', async () => {
  const ui=toastHarness();
  ui.show('错误','error'); ui.close.focus();
  const event={key:'Escape',isComposing:true,preventDefault() {},stopPropagation() {}};
  await ui.emit(ui.root,'keydown',event);
  assert.equal(ui.root.classList.contains('hidden'),false);
  await ui.emit(ui.root,'keydown',{...event,isComposing:false});
  assert.equal(ui.root.classList.contains('hidden'),true);
  assert.equal(ui.document.activeElement,ui.opener);
});

test('compact usage rows escape formatted timestamps as well as model and status labels', () => {
  const sandbox = {
    displayRoute: value => value,
    formatNumber: value => String(Number(value || 0)),
    formatTime: value => value || '-',
    formatDuration: value => String(value),
    usageStatusText: row => row.status,
    usageEventStatusText: row => row.status,
  };
  runInNewContext(functionSource('escapeHtml') + '\n' + functionSource('formatInputTokens') + '\n' + functionSource('renderUsageCompactTables'), sandbox);
  const row = {route:'<b>model</b>',status:'<i>status</i>',calls:1,totalTokens:42,
    lastAt:'<img src=x>', finishedAt:'<img src=y>',requestId:'\"unsafe-id',durationMs:100};
  const html = sandbox.renderUsageCompactTables([row], [row]);
  assert.doesNotMatch(html, /<(?:img|b|i)\b/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;img src=y&gt;/);
  assert.match(html, /data-request-detail="&quot;unsafe-id"/);
  assert.equal((html.match(/<table /g) || []).length, 2);
});

test('default usage tables expose total, input, output and cache without hiding the breakdown', () => {
  const sandbox = {displayRoute:v=>v,formatTime:v=>v||'-',formatDuration:v=>String(v),
    usageStatusText:()=> '200',usageEventStatusText:()=> '200'};
  runInNewContext(['escapeHtml','formatNumber','formatInputTokens','renderUsageCompactTables']
    .map(functionSource).join('\n'), sandbox);
  const row={route:'fixture',calls:2,promptTokens:1000,freshPromptTokens:300,
    cacheReadTokens:600,cacheCreationTokens:100,completionTokens:42,totalTokens:1042,requestId:'fixture'};
  const html=sandbox.renderUsageCompactTables([row],[row]);
  for(const label of ['总 Token','输入 Token','输出 Token','缓存 Token']) {
    assert.equal((html.match(new RegExp('>'+label+'<','g'))||[]).length,2,label);
  }
  const bodies=[...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)];
  assert.equal(bodies.length,2);
  for(const [,body] of bodies){
    const cells=[...body.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(x=>x[1]);
    assert.equal(cells.length,8);
    assert.match(cells[2],/1,042/);
    assert.match(cells[3],/1,000/);
    assert.match(cells[4],/42/);
    assert.match(cells[5],/700/);
    assert.match(cells[5],/读 600/);
    assert.match(cells[5],/写 100/);
  }
});

test('input token display includes cached input and preserves explicit zero', () => {
  const sandbox={};
  runInNewContext(functionSource('formatNumber')+'\n'+functionSource('formatInputTokens'),sandbox);
  assert.equal(sandbox.formatInputTokens({promptTokens:1000,freshPromptTokens:300,cacheReadTokens:600,cacheCreationTokens:100}),'1,000');
  assert.equal(sandbox.formatInputTokens({promptTokens:0,freshPromptTokens:300}),'0');
});

test('unrelated full-state updates retain a dirty model draft while clean drafts follow saved state', () => {
  const sandbox = {
    state:{mode:'hybrid',selectedModelIds:['a']}, draftSelection:['a','b'],modelSelectionDraftsToKeep:new WeakSet(),
    mergeStateWithRetainedDetailSlices: (previous,next) => next,
    syncLoadedStateDetails() {},
  };
  runInNewContext(functionSource('adoptStateSnapshot'), sandbox);
  sandbox.adoptStateSnapshot({mode:'hybrid',selectedModelIds:['a'],desktopOptions:{budget:12}});
  assert.deepEqual(Array.from(sandbox.draftSelection), ['a','b']);
  assert.equal(sandbox.state.desktopOptions.budget, 12);
  sandbox.draftSelection = ['a'];
  sandbox.adoptStateSnapshot({mode:'hybrid',selectedModelIds:['c']});
  assert.deepEqual(Array.from(sandbox.draftSelection), ['c']);
  sandbox.draftSelection = ['c','d'];
  sandbox.adoptStateSnapshot({mode:'all_api',selectedModelIds:['api-model']});
  assert.deepEqual(Array.from(sandbox.draftSelection), ['api-model']);
});

test('a completed selection save does not discard edits made while that save was in flight', async () => {
  let resolveSave;
  const sandbox = {
    state:{selectedModelIds:['a']}, draftSelection:['a','b'],
    runAction: (button,action) => action(),
    api:{saveModelSelection: () => new Promise(resolve => { resolveSave = resolve; })},
    mergeStateWithRetainedDetailSlices: (previous,next) => next,
    render() {}, showToast() {},
  };
  runInNewContext(functionSource('saveModelSelection'), sandbox);
  const saving = sandbox.saveModelSelection({});
  sandbox.draftSelection = ['a','b','c'];
  resolveSave({selectedModelIds:['a','b']});
  await saving;
  assert.deepEqual(Array.from(sandbox.state.selectedModelIds), ['a','b']);
  assert.deepEqual(Array.from(sandbox.draftSelection), ['a','b','c']);
});

test('an unconfirmed model selection response retains the draft and last confirmed state', async () => {
  for (const response of [{selectedModelIds:['a']},{stateUnavailable:true,selectedModelIds:['a','b']},{}]) {
    const sandbox = {state:{selectedModelIds:['a']},draftSelection:['a','b'],
      runAction:(_button,action) => action(),api:{saveModelSelection:async () => response},
      mergeStateWithRetainedDetailSlices:(_previous,next) => next,render() {},showToast() {}};
    runInNewContext(functionSource('saveModelSelection'),sandbox);
    await assert.rejects(sandbox.saveModelSelection({}));
    assert.deepEqual(Array.from(sandbox.draftSelection),['a','b']);
    assert.deepEqual(Array.from(sandbox.state.selectedModelIds),['a']);
  }
});

test('typing a model search before the first state snapshot does not render an unready catalog', () => {
  const sandbox = {state:null,draftSelection:[],activeProviderId:'gpt',els:{modelPool:{innerHTML:'loading'}}};
  runInNewContext(functionSource('renderModelPool') + '\n' + functionSource('renderModelCardGroups'), sandbox);
  assert.doesNotThrow(() => sandbox.renderModelPool());
  assert.equal(sandbox.els.modelPool.innerHTML, 'loading');
});

test('model move controls change only the draft and stop at the list boundaries', () => {
  const sandbox = {state:{selectedModelIds:['a','b','c']},draftSelection:['a','b','c'],modelSelectionDraftsToKeep:new WeakSet()};
  runInNewContext(['updateModelSelectionDraft','reorderDraftSelection','moveDraftSelectionBy'].map(functionSource).join('\n'), sandbox);
  assert.equal(sandbox.moveDraftSelectionBy(1,-1), 0);
  assert.deepEqual(Array.from(sandbox.draftSelection), ['b','a','c']);
  assert.equal(sandbox.moveDraftSelectionBy(0,1), 1);
  assert.deepEqual(Array.from(sandbox.draftSelection), ['a','b','c']);
  for (const [index,direction] of [[0,-1],[2,1],[-1,1],[3,-1],[1,0],[1,2],[1.5,1]]) {
    assert.equal(sandbox.moveDraftSelectionBy(index,direction), null);
    assert.deepEqual(Array.from(sandbox.draftSelection), ['a','b','c']);
  }
  assert.deepEqual(sandbox.state.selectedModelIds, ['a','b','c']);
});

test('incoming log lines preserve the reading position when following is paused', () => {
  const output = {textContent:'old line',scrollTop:120,scrollHeight:1200,clientHeight:300,getClientRects:() => [{}]};
  const sandbox = {els:{logOutput:output},logFollowLatest:false,logScrollTop:120,renderLogViewStatus() {}};
  runInNewContext(functionSource('renderLogs'), sandbox);
  sandbox.renderLogs(['old line','new line <not markup>']);
  assert.equal(output.textContent, 'old line\nnew line <not markup>');
  assert.equal(output.scrollTop, 120);
});

test('log updates in a hidden page retain the saved reading position for returning', () => {
  let visible = false;
  const output = {textContent:'old line',scrollTop:0,scrollHeight:1200,clientHeight:300,getClientRects:() => visible ? [{}] : []};
  const sandbox = {els:{logOutput:output},logFollowLatest:false,logScrollTop:120,renderLogViewStatus() {}};
  runInNewContext(functionSource('renderLogs'), sandbox);
  sandbox.renderLogs(['old line','new line']);
  assert.equal(sandbox.logScrollTop, 120);
  visible = true;
  sandbox.renderLogs(['old line','new line']);
  assert.equal(output.scrollTop, 120);
});

test('typing a session search before the first state snapshot leaves a readable loading state', () => {
  const sandbox = {state:null,sessionSearchText:'alpha',loadedDetailSections:new Set(),
    els:{sessionList:{innerHTML:''},sessionSearchCount:{textContent:''},clearSessionSearch:{disabled:false}},
    renderHistoryRecoveryStatus() {},
  };
  runInNewContext(functionSource('escapeHtml') + '\n' + functionSource('renderSessions'), sandbox);
  assert.doesNotThrow(() => sandbox.renderSessions());
  assert.ok(sandbox.els.sessionList.innerHTML.length > 0);
  assert.ok(sandbox.els.sessionSearchCount.textContent.length > 0);
  assert.equal(sandbox.els.clearSessionSearch.disabled, false);
});

test('clearing resource filters resets the hidden source filter without changing resources', () => {
  const saved = {plugins:[{id:'example',enabled:false}]};
  const sandbox = {state:{codexResources:saved},resourceFilterText:'example',resourceStatusFilter:'issues',resourceSourceFilter:'cached',
    els:{resourceSearch:{value:'example',focus() {}},resourceStatusFilter:{value:'issues'},resourceSourceFilter:{value:'cached'}},
    renderResources() {},
  };
  runInNewContext(functionSource('clearResourceFilters'), sandbox);
  sandbox.clearResourceFilters();
  assert.equal(sandbox.resourceFilterText, '');
  assert.equal(sandbox.resourceStatusFilter, 'all');
  assert.equal(sandbox.resourceSourceFilter, 'all');
  assert.deepEqual([sandbox.els.resourceSearch.value,sandbox.els.resourceStatusFilter.value,sandbox.els.resourceSourceFilter.value], ['', 'all', 'all']);
  assert.deepEqual(sandbox.state.codexResources, {plugins:[{id:'example',enabled:false}]});
});

test('active resource filters expose hidden source criteria as text and disappear after reset', () => {
  const sandbox = {resourceFilterText:'<test>',resourceStatusFilter:'issues',resourceSourceFilter:'cached',
    els:{resourceFilterStatus:{textContent:'',title:'',hidden:true},clearResourceFilters:{disabled:true},
      resourceStatusFilter:{selectedOptions:[{textContent:'只看提醒/失败'}]},resourceSourceFilter:{selectedOptions:[{textContent:'本地缓存'}]}},
  };
  runInNewContext(functionSource('renderResourceFilterStatus'), sandbox);
  sandbox.renderResourceFilterStatus();
  for (const text of ['<test>','只看提醒/失败','本地缓存']) assert.ok(sandbox.els.resourceFilterStatus.textContent.includes(text));
  assert.equal(sandbox.els.resourceFilterStatus.title, sandbox.els.resourceFilterStatus.textContent);
  assert.equal(sandbox.els.resourceFilterStatus.hidden, false);
  assert.equal(sandbox.els.clearResourceFilters.disabled, false);
  sandbox.resourceFilterText = ''; sandbox.resourceStatusFilter = 'all'; sandbox.resourceSourceFilter = 'all';
  sandbox.renderResourceFilterStatus();
  assert.equal(sandbox.els.resourceFilterStatus.hidden, true);
  assert.equal(sandbox.els.clearResourceFilters.disabled, true);
});

test('resource search before the first state snapshot leaves a loading state instead of throwing', () => {
  const sandbox = {state:null,resourceDetailItems:new Map(),loadedDetailSections:new Set(),loadingDetailSections:new Set(),resourceRefreshFailed:false,
    els:{resourceSummary:{innerHTML:''},resourceList:{innerHTML:''}},renderResourceFilterStatus() {},
  };
  runInNewContext(functionSource('escapeHtml') + '\n' + functionSource('renderResourceRefreshStatus') + '\n' + functionSource('renderResources'), sandbox);
  assert.doesNotThrow(() => sandbox.renderResources());
  assert.ok(sandbox.els.resourceList.innerHTML.length > 0);
});

test('desktop settings draft values preserve false and blank input rather than replacing them with saved values', () => {
  const sandbox = {desktopSettingsDraft:new Map([
    ['bypassSystemProxy',{value:false,revision:1}],['routerPort',{value:'',revision:2}],
  ])};
  runInNewContext(functionSource('desktopSettingsDraftValue'), sandbox);
  assert.equal(sandbox.desktopSettingsDraftValue('bypassSystemProxy',true), false);
  assert.equal(sandbox.desktopSettingsDraftValue('routerPort','15722'), '');
  assert.equal(sandbox.desktopSettingsDraftValue('autoFailover',true), true);
});

function settingsSaveSandbox(saveOptions) {
  const sandbox = {
    state:{models:[{id:'route-a'},{id:'route-b'}],desktopOptions:{routerPort:15722,bypassSystemProxy:false}},desktopSettingsSaving:false,
    SMART_ROUTING_RULE_CONTROLS:[{key:'code',route:'smartCodeRoute'}],SMART_ROUTING_ROUTE_CONTROLS:['smartFailoverRoute1'],
    desktopSettingsDraft:new Map([['routerPort',{value:'15800',revision:1}],['bypassSystemProxy',{value:true,revision:2}]]),
    els:{routerPort:{value:'15800'},bypassSystemProxy:{checked:true},localRateLimitEnabled:{checked:false},
      duplicateRequestProtection:{checked:false},interceptCodexAuxiliaryTasks:{checked:false},codexAuxiliaryModelId:{value:'route-a'},
      autoSelectModel:{checked:false},autoFailover:{checked:false}},
    api:{saveOptions},runAction:(_button,action) => action(),
    smartRoutingOptionsFromInputs:() => ({autoSelectRules:{},failover:{mode:'off',routeIds:[]}}),
    renderDesktopSettingsDraftStatus() {},renderRouterPortValidation:() => '',render() {},showToast() {},
  };
  sandbox.adoptStateSnapshot = value => { sandbox.state = value; };
  runInNewContext(['smartRoutingModeValue','normalizeSmartRoutingRuleForUi','normalizeSmartRoutingFailoverForUi',
    'focusInvalidControl','incompleteRoutingChoice','basicSettingsReceiptMatches','saveDesktopSettings'].map(functionSource).join('\n'), sandbox);
  return sandbox;
}

function confirmedSettingsSnapshot(overrides = {}) {
  return {desktopOptions:{routerPort:15800,bypassSystemProxy:true,localRateLimitEnabled:false,duplicateRequestProtection:false,
    interceptCodexAuxiliaryTasks:false,codexAuxiliaryModelId:'route-a',autoSelectModel:false,autoFailover:false,
    smartRouting:{autoSelectRules:{},failover:{mode:'off',routeIds:[]}},...overrides}};
}

test('basic settings confirmation requires explicit false and empty fields and matches ordered routing rules', () => {
  const sandbox = settingsSaveSandbox(async () => confirmedSettingsSnapshot());
  const expected = confirmedSettingsSnapshot({bypassSystemProxy:false,codexAuxiliaryModelId:'',smartRouting:{
    autoSelectRules:{code:{mode:'route',routeId:'route-a'}},failover:{mode:'ordered',routeIds:['route-a','route-b']},
  }}).desktopOptions;
  assert.equal(sandbox.basicSettingsReceiptMatches(expected,{desktopOptions:structuredClone(expected)}),true);
  for (const key of Object.keys(expected)) {
    const saved = structuredClone(expected);
    delete saved[key];
    assert.equal(sandbox.basicSettingsReceiptMatches(expected,{desktopOptions:saved}),false,`missing ${key}`);
  }
  for (const mutate of [
    saved => { delete saved.smartRouting.autoSelectRules.code; },
    saved => { saved.smartRouting.autoSelectRules.code.routeId='other-route'; },
    saved => { saved.smartRouting.autoSelectRules.code.mode='off'; },
    saved => { saved.smartRouting.failover.routeIds.reverse(); },
    saved => { delete saved.smartRouting.failover.routeIds; },
  ]) {
    const saved=structuredClone(expected); mutate(saved);
    assert.equal(sandbox.basicSettingsReceiptMatches(expected,{desktopOptions:saved}),false);
  }
  const normalized=structuredClone(expected);
  expected.smartRouting.failover.routeIds=['route-a','route-a',' route-b '];
  expected.smartRouting.autoSelectRules.code.routeId=' route-a ';
  assert.equal(sandbox.basicSettingsReceiptMatches(expected,{desktopOptions:normalized}),true);
});

test('basic settings can retry an unconfirmed save without losing its draft', async () => {
  const sandbox = settingsSaveSandbox(async () => ({desktopOptions:{}}));
  await assert.rejects(sandbox.saveDesktopSettings({}));
  assert.equal(sandbox.desktopSettingsDraft.size,2);
  sandbox.api.saveOptions = async () => confirmedSettingsSnapshot();
  await sandbox.saveDesktopSettings({});
  assert.equal(sandbox.desktopSettingsDraft.size,0);
  assert.equal(sandbox.state.desktopOptions.routerPort,15800);
});

test('an empty model selection is rejected before the backend can substitute a default model', async () => {
  let requests=0;
  const sandbox={state:{selectedModelIds:['a']},draftSelection:[],
    runAction:(_button,action) => action(),api:{saveModelSelection:async () => {requests+=1; return {selectedModelIds:['a']};}},
    mergeStateWithRetainedDetailSlices:(_previous,next) => next,render() {},showToast() {}};
  runInNewContext(functionSource('saveModelSelection'),sandbox);
  await assert.rejects(sandbox.saveModelSelection({}));
  assert.equal(requests,0);
  assert.deepEqual(Array.from(sandbox.state.selectedModelIds),['a']);
  sandbox.draftSelection=['a','b'];
  sandbox.api.saveModelSelection=async () => ({selectedModelIds:['a','b']});
  await sandbox.saveModelSelection({});
  assert.deepEqual(Array.from(sandbox.state.selectedModelIds),['a','b']);
});

test('incomplete explicit routing choices cannot change other settings before being completed', async () => {
  for (const smartRouting of [
    {autoSelectRules:{code:{mode:'route',routeId:''}},failover:{mode:'off',routeIds:[]}},
    {autoSelectRules:{},failover:{mode:'ordered',routeIds:[]}},
  ]) {
    let requests=0;
    const sandbox=settingsSaveSandbox(async options => {requests+=1; return {desktopOptions:options};});
    sandbox.smartRoutingOptionsFromInputs=() => smartRouting;
    await sandbox.saveDesktopSettings({});
    assert.equal(requests,0);
    assert.equal(sandbox.desktopSettingsDraft.get('routerPort').value,'15800');
  }
});

test('routing validation names the task whose model is missing', () => {
  const sandbox=settingsSaveSandbox(async () => confirmedSettingsSnapshot());
  sandbox.els.smartCodeRoute={closest:() => ({querySelector:() => ({textContent:'代码任务'})})};
  const error=sandbox.incompleteRoutingChoice({autoSelectRules:{code:{mode:'route',routeId:''}},failover:{mode:'auto',routeIds:[]}});
  assert.equal(error.control,sandbox.els.smartCodeRoute);
  assert.match(error.message,/代码任务/);
});

test('invalid-field focus reveals its ancestor disclosures before scrolling', () => {
  const outer={tagName:'DETAILS',open:false,parentElement:null};
  const inner={tagName:'DETAILS',open:false,parentElement:outer};
  const calls=[];
  const field={parentElement:{tagName:'LABEL',parentElement:inner},scrollIntoView:options => {
    assert.equal(inner.open,true); assert.equal(outer.open,true); calls.push(['scroll',options.block]);
  },focus:options => calls.push(['focus',options.preventScroll])};
  const sandbox={};
  runInNewContext(functionSource('focusInvalidControl'),sandbox);
  sandbox.focusInvalidControl(field);
  sandbox.focusInvalidControl(null);
  assert.deepEqual(calls,[['scroll','center'],['focus',true]]);
});

test('routing validation identifies the actual unavailable backup slot instead of a valid first slot', () => {
  for(const badIndex of [1,2]) {
    const sandbox=settingsSaveSandbox(async () => confirmedSettingsSnapshot());
    sandbox.SMART_ROUTING_ROUTE_CONTROLS=['backup1','backup2','backup3'];
    for(const [index,id] of sandbox.SMART_ROUTING_ROUTE_CONTROLS.entries()) sandbox.els[id]={value:index===0?'route-a':index===badIndex?'retired-route':''};
    const error=sandbox.incompleteRoutingChoice({autoSelectRules:{},failover:{mode:'ordered',routeIds:['route-a','retired-route']}});
    assert.equal(error.control,sandbox.els[sandbox.SMART_ROUTING_ROUTE_CONTROLS[badIndex]]);
    assert.ok(error.message.includes(`备用位 ${badIndex+1}`));
    assert.doesNotMatch(error.message,/至少/);
  }
});

test('reference status identifies its saved-configuration scope and keeps repair tied to saved issues', () => {
  const sandbox={state:{modelReferenceStatus:{issues:[]}},els:{modelReferenceStatus:{innerHTML:''},repairModelReferences:{}},
    formatNumber:String,modelReferenceIssueItem:() => '<li>已保存的失效引用</li>',bindModelReferenceIssueActions() {}};
  runInNewContext(functionSource('renderModelReferenceStatus'),sandbox);
  for(const issues of [[],[{kind:'selection',value:'retired-model'}]]) {
    sandbox.state.modelReferenceStatus.issues=issues;
    sandbox.renderModelReferenceStatus();
    assert.match(sandbox.els.modelReferenceStatus.innerHTML,/<strong>[^<]*已保存配置[^<]*<\/strong>/);
    assert.equal(sandbox.els.repairModelReferences.disabled,issues.length===0);
  }
});

test('a basic setting explicitly undone during an unconfirmed save survives the later authoritative refresh', async () => {
  let fail;
  const sandbox=settingsSaveSandbox(() => new Promise((_resolve,reject) => {fail=reject;}));
  sandbox.desktopSettingsRevision=2;
  sandbox.routerPortValidationShown=false;
  sandbox.DESKTOP_SETTINGS_CONTROL_IDS=new Set(['routerPort']);
  sandbox.desktopSettingsSavedValues=() => ({routerPort:String(sandbox.state.desktopOptions.routerPort),bypassSystemProxy:sandbox.state.desktopOptions.bypassSystemProxy});
  sandbox.els.routerPort.id='routerPort';
  runInNewContext(['captureDesktopSettingsEdit','renderDesktopSettingsDraftStatus','desktopSettingsDraftValue'].map(functionSource).join('\n'),sandbox);
  const saving=sandbox.saveDesktopSettings({});
  sandbox.els.routerPort.value='15722';
  sandbox.captureDesktopSettingsEdit({target:sandbox.els.routerPort});
  fail(new Error('save result unavailable'));
  await assert.rejects(saving);
  sandbox.state=confirmedSettingsSnapshot();
  sandbox.renderDesktopSettingsDraftStatus();
  assert.equal(sandbox.desktopSettingsDraftValue('routerPort','15800'),'15722');
});

test('a model selection explicitly undone during an unconfirmed save survives the later authoritative refresh', async () => {
  let finish;
  const sandbox={state:{mode:'hybrid',selectedModelIds:['a']},draftSelection:['a','b'],modelSelectionDraftsToKeep:new WeakSet(),
    runAction:(_button,action) => action(),api:{saveModelSelection:() => new Promise(resolve => {finish=resolve;})},
    mergeStateWithRetainedDetailSlices:(_previous,next) => next,syncLoadedStateDetails() {},render() {},renderModelSelectionStatus() {},showToast() {}};
  runInNewContext(functionSource('saveModelSelection')+'\n'+functionSource('adoptStateSnapshot'),sandbox);
  const saving=sandbox.saveModelSelection({});
  sandbox.draftSelection=['a'];
  finish({stateUnavailable:true,selectedModelIds:['a','b']});
  await assert.rejects(saving,/无法确认/);
  sandbox.adoptStateSnapshot({mode:'hybrid',selectedModelIds:['a','b']});
  assert.deepEqual(Array.from(sandbox.draftSelection),['a']);
});

test('protected model draft intent survives local toggles and is released by an explicit reset or mode change', () => {
  const sandbox={state:{mode:'hybrid',selectedModelIds:['a']},draftSelection:['a'],modelSelectionDraftsToKeep:new WeakSet(),
    mergeStateWithRetainedDetailSlices:(_previous,next) => next,syncLoadedStateDetails() {},render() {}};
  runInNewContext(['updateModelSelectionDraft','toggleModel','adoptStateSnapshot'].map(functionSource).join('\n'),sandbox);
  sandbox.modelSelectionDraftsToKeep.add(sandbox.draftSelection);
  sandbox.toggleModel('b'); sandbox.toggleModel('b');
  sandbox.adoptStateSnapshot({mode:'hybrid',selectedModelIds:['a','b']});
  assert.deepEqual(Array.from(sandbox.draftSelection),['a']);
  sandbox.draftSelection=[...sandbox.state.selectedModelIds];
  sandbox.adoptStateSnapshot({mode:'hybrid',selectedModelIds:['b']});
  assert.deepEqual(Array.from(sandbox.draftSelection),['b']);
  sandbox.modelSelectionDraftsToKeep.add(sandbox.draftSelection);
  sandbox.adoptStateSnapshot({mode:'all_api',selectedModelIds:['api-only']});
  assert.deepEqual(Array.from(sandbox.draftSelection),['api-only']);
});

test('a settings save does not overwrite newer edits that return to an old saved value', async () => {
  let resolveSave;
  const requests = [];
  const sandbox = settingsSaveSandbox(options => {
    requests.push(options);
    return new Promise(resolve => { resolveSave = resolve; });
  });
  const saving = sandbox.saveDesktopSettings({});
  assert.equal(sandbox.desktopSettingsSaving, true);
  await sandbox.saveDesktopSettings({});
  assert.equal(requests.length, 1, 'The same pending settings save was submitted twice');
  assert.equal(requests[0].routerPort, 15800);
  assert.equal(requests[0].bypassSystemProxy, true);
  sandbox.els.routerPort.value = '15722';
  sandbox.els.bypassSystemProxy.checked = false;
  sandbox.desktopSettingsDraft.set('routerPort',{value:'15722',revision:3});
  sandbox.desktopSettingsDraft.set('bypassSystemProxy',{value:false,revision:4});
  resolveSave(confirmedSettingsSnapshot());
  await saving;
  assert.equal(sandbox.desktopSettingsSaving, false);
  assert.equal(sandbox.state.desktopOptions.routerPort, 15800);
  assert.equal(sandbox.desktopSettingsDraft.get('routerPort').value, '15722');
  assert.equal(sandbox.desktopSettingsDraft.get('bypassSystemProxy').value, false);
});

test('a settings save acknowledges only the submitted draft when no newer input exists', async () => {
  const sandbox = settingsSaveSandbox(async () => confirmedSettingsSnapshot());
  await sandbox.saveDesktopSettings({});
  assert.equal(sandbox.desktopSettingsDraft.size, 0);
  assert.equal(sandbox.desktopSettingsSaving, false);
  assert.equal(sandbox.state.desktopOptions.routerPort, 15800);
});

test('a rejected settings save keeps the draft and releases its pending state for retry', async () => {
  const sandbox = settingsSaveSandbox(async () => { throw new Error('save failed'); });
  await assert.rejects(sandbox.saveDesktopSettings({}), /save failed/);
  assert.equal(sandbox.desktopSettingsSaving, false);
  assert.equal(sandbox.desktopSettingsDraft.get('routerPort').value, '15800');
  assert.equal(sandbox.state.desktopOptions.routerPort, 15722);
});

test('an unconfirmed basic settings response does not consume edits or replace the last confirmed state', async () => {
  for (const response of [{desktopOptions:{routerPort:15722,bypassSystemProxy:false}}, {desktopOptions:{}},
    {stateUnavailable:true,desktopOptions:{routerPort:15800,bypassSystemProxy:true}}]) {
    const sandbox = settingsSaveSandbox(async () => response);
    await assert.rejects(sandbox.saveDesktopSettings({}));
    assert.equal(sandbox.desktopSettingsSaving,false);
    assert.equal(sandbox.desktopSettingsDraft.get('routerPort').value,'15800');
    assert.equal(sandbox.state.desktopOptions.routerPort,15722);
  }
});

test('a settings progress rendering failure cannot leave the form permanently pending', async () => {
  let requests = 0;
  let renders = 0;
  const sandbox = settingsSaveSandbox(async () => { requests += 1; return {}; });
  sandbox.renderDesktopSettingsDraftStatus = () => { if (renders++ === 0) throw new Error('progress render failed'); };
  await assert.rejects(sandbox.saveDesktopSettings({}), /progress render failed/);
  assert.equal(sandbox.desktopSettingsSaving, false);
  assert.equal(requests, 0);
  assert.equal(sandbox.desktopSettingsDraft.get('routerPort').value, '15800');
});

test('a settings snapshot adoption failure does not discard the submitted input', async () => {
  const sandbox = settingsSaveSandbox(async () => confirmedSettingsSnapshot());
  sandbox.adoptStateSnapshot = () => { throw new Error('snapshot rejected'); };
  await assert.rejects(sandbox.saveDesktopSettings({}), /snapshot rejected/);
  assert.equal(sandbox.desktopSettingsSaving, false);
  assert.equal(sandbox.desktopSettingsDraft.get('routerPort')?.value, '15800');
});

test('port validation accepts supported integers and blank default but rejects invalid or incomplete input', () => {
  const sandbox = {};
  runInNewContext(functionSource('routerPortValidationMessage'), sandbox);
  for (const value of ['', '1024', '15722', '65535', '1e4', '15722.0']) {
    assert.equal(sandbox.routerPortValidationMessage(value), '', value);
  }
  for (const value of ['0', '1023', '65536', '-1', '15722.5', 'Infinity', 'not-a-number', '1e']) {
    const message = sandbox.routerPortValidationMessage(value);
    assert.ok(message.includes('1024') && message.includes('65535'), value);
  }
  assert.notEqual(sandbox.routerPortValidationMessage('', true), '', 'An incomplete native number must not become the blank default');
});

test('invalid port validation stops saving without consuming the draft', async () => {
  let requests = 0;
  const sandbox = settingsSaveSandbox(async () => { requests += 1; return {}; });
  sandbox.renderRouterPortValidation = () => 'invalid port';
  await sandbox.saveDesktopSettings({});
  assert.equal(requests, 0);
  assert.equal(sandbox.desktopSettingsSaving, false);
  assert.equal(sandbox.desktopSettingsDraft.get('routerPort').value, '15800');
});

test('blank port keeps the existing explicit-save default of 15722', async () => {
  let submitted;
  const sandbox = settingsSaveSandbox(async options => { submitted = options; return confirmedSettingsSnapshot({routerPort:15722}); });
  sandbox.els.routerPort.value = '';
  await sandbox.saveDesktopSettings({});
  assert.equal(submitted.routerPort, 15722);
});

test('inline port validation clears after correction and does not rewrite the input', () => {
  const attributes = {};
  let focusCount = 0;
  const sandbox = {routerPortValidationShown:false,
    els:{routerPort:{value:'65536',validity:{badInput:false},setAttribute:(key,value) => { attributes[key]=value; },scrollIntoView() {},focus() {focusCount += 1;}},
      routerPortError:{textContent:'',hidden:true}},
  };
  runInNewContext(functionSource('routerPortValidationMessage') + '\n' + functionSource('renderRouterPortValidation'), sandbox);
  assert.notEqual(sandbox.renderRouterPortValidation({report:true,focus:true}), '');
  assert.equal(attributes['aria-invalid'], 'true');
  assert.equal(sandbox.els.routerPortError.hidden, false);
  assert.equal(sandbox.els.routerPort.value, '65536');
  assert.equal(focusCount, 1);
  sandbox.els.routerPort.value = '15800';
  assert.equal(sandbox.renderRouterPortValidation(), '');
  assert.equal(sandbox.els.routerPortError.hidden, true);
  assert.equal(attributes['aria-invalid'], 'false');
  assert.equal(focusCount, 1);
});

test('resource refresh keeps existing readable content while the new snapshot is loading', () => {
  const sandbox = {state:{codexResources:{agentFiles:[{name:'AGENTS.md'}]}},loadingDetailSections:new Set(['resources']),resourceRefreshFailed:false,
    els:{resourceSummary:{innerHTML:'existing counts'},resourceList:{innerHTML:'existing list'},resourceRefreshStatus:{textContent:''}},
  };
  runInNewContext(functionSource('renderResourceRefreshStatus') + '\n' + functionSource('renderDetailLoading'), sandbox);
  sandbox.renderDetailLoading('resources');
  assert.equal(sandbox.els.resourceSummary.innerHTML, 'existing counts');
  assert.equal(sandbox.els.resourceList.innerHTML, 'existing list');
  assert.ok(sandbox.els.resourceRefreshStatus.textContent.includes('刷新'));
  sandbox.state = {};
  sandbox.renderDetailLoading('resources');
  assert.equal(sandbox.els.resourceSummary.innerHTML, '');
  assert.ok(sandbox.els.resourceList.innerHTML.includes('正在读取'));
});

test('reading position uses each page scroller but leaves logs and software task scrolling alone', () => {
  const main = {scrollTop:120};
  const settings = {scrollTop:240};
  const sections = {resources:{querySelector:() => null},settings:{querySelector:() => settings},
    logs:{querySelector:() => main},softwareManager:{querySelector:() => main}};
  const sandbox = {currentSectionId:() => 'settings',document:{getElementById:id => sections[id],querySelector:() => main}};
  runInNewContext(functionSource('pageScrollContainer'), sandbox);
  assert.equal(sandbox.pageScrollContainer('resources'), main);
  assert.equal(sandbox.pageScrollContainer(), settings);
  assert.equal(sandbox.pageScrollContainer('logs'), null);
  assert.equal(sandbox.pageScrollContainer('softwareManager'), null);
  assert.equal(sandbox.pageScrollContainer('missing'), null);
});

test('unchanged resource status is not re-announced on unrelated renders', () => {
  let text = '';
  let announcements = 0;
  const status = {get textContent() {return text;},set textContent(value) {text=value; announcements+=1;}};
  const sandbox = {state:{codexResources:{snapshot:{state:'authoritative'}}},loadingDetailSections:new Set(),resourceRefreshFailed:false,
    els:{resourceRefreshStatus:status}};
  runInNewContext(functionSource('renderResourceRefreshStatus'), sandbox);
  sandbox.renderResourceRefreshStatus();
  sandbox.renderResourceRefreshStatus();
  assert.equal(announcements, 1);
  sandbox.loadingDetailSections.add('resources');
  sandbox.renderResourceRefreshStatus();
  assert.equal(announcements, 2);
  assert.match(text, /正在刷新/);
});

test('resource detail focus follows the same resource when a refresh changes its row index', () => {
  let focused = '';
  let buttons = [];
  const section = {classList:{contains:() => false},querySelectorAll:() => buttons};
  const body = {};
  const dialog = {open:false,contains:() => false};
  const old = {isConnected:true,closest:() => section,getAttribute:() => 'apps::app-old',getClientRects:() => [1],focus:() => {focused='old';}};
  const current = {isConnected:true,getAttribute:() => 'apps:1:app-old',getClientRects:() => [1],focus:() => {focused='same-resource';}};
  const other = {isConnected:true,getAttribute:() => 'apps::app-new',getClientRects:() => [1],focus:() => {focused='other-resource';}};
  const heading = {focus:() => {focused='heading';}};
  const sandbox = {detailDialogReturnTargets:new WeakMap(),
    resourceDetailItems:new Map([['apps::app-old',{key:'apps',item:{id:'app-old',name:'Existing app'}}]]),
    document:{body,activeElement:old,querySelector:selector => selector === '#pageTitle' ? heading : null}};
  runInNewContext(functionSource('resourceFocusIdentity') + '\n' + functionSource('rememberDetailDialogFocus') + '\n' + functionSource('restoreDetailDialogFocus'), sandbox);
  sandbox.rememberDetailDialogFocus(dialog, 'data-resource-detail');
  old.isConnected = false;
  sandbox.document.activeElement = body;
  buttons = [other,current];
  sandbox.resourceDetailItems.clear();
  sandbox.resourceDetailItems.set('apps::app-new',{key:'apps',item:{id:'app-new',name:'New app'}});
  sandbox.resourceDetailItems.set('apps:1:app-old',{key:'apps',item:{id:'app-old',name:'Existing app'}});
  sandbox.restoreDetailDialogFocus(dialog);
  assert.equal(focused, 'same-resource');
});

test('a later authoritative resource read clears failed refresh feedback but core-only and stale snapshots do not', () => {
  const oldSnapshot = {state:'authoritative',refreshedAt:'2026-09-10T03:00:00Z'};
  const sandbox = {state:{codexResources:{snapshot:oldSnapshot}},loadingDetailSections:new Set(),resourceRefreshFailed:true,
    resourceRefreshFailedAt:Date.parse(oldSnapshot.refreshedAt),els:{resourceRefreshStatus:{textContent:''}},formatTime:value => value};
  runInNewContext(functionSource('renderResourceRefreshStatus'), sandbox);
  sandbox.renderResourceRefreshStatus();
  assert.match(sandbox.els.resourceRefreshStatus.textContent, /无法刷新/);
  sandbox.state = {...sandbox.state,desktopOptions:{routerPort:15800}};
  sandbox.renderResourceRefreshStatus();
  assert.match(sandbox.els.resourceRefreshStatus.textContent, /无法刷新/);
  sandbox.state.codexResources = {snapshot:{...oldSnapshot,refreshedAt:'2026-09-10T02:00:00Z'}};
  sandbox.renderResourceRefreshStatus();
  assert.match(sandbox.els.resourceRefreshStatus.textContent, /无法刷新/);
  sandbox.state.codexResources = {snapshot:{state:'cached',refreshedAt:'2026-09-10T04:00:00Z'}};
  sandbox.renderResourceRefreshStatus();
  assert.match(sandbox.els.resourceRefreshStatus.textContent, /无法刷新/);
  sandbox.state.codexResources = {snapshot:{state:'authoritative',refreshedAt:'2026-09-10T04:00:00Z'}};
  sandbox.renderResourceRefreshStatus();
  assert.match(sandbox.els.resourceRefreshStatus.textContent, /已刷新/);
  assert.equal(sandbox.resourceRefreshFailed, false);
});

test('request detail focus stays in the full-fields view when the same request also has a compact button', () => {
  let focused = '';
  const body = {};
  const makeButton = name => ({isConnected:true,getAttribute:() => 'request-a',getClientRects:() => [1],focus:() => {focused=name;}});
  const compact = makeButton('compact');
  const full = makeButton('full-fields');
  const section = {classList:{contains:() => false},querySelectorAll:selector => selector.startsWith('.usage-full-details ') ? [full] : [compact,full]};
  const opener = {...makeButton('old'),closest:selector => selector === '.section-panel' ? section : selector === '.usage-full-details' ? {} : null};
  const dialog = {open:false,contains:() => false};
  const sandbox = {detailDialogReturnTargets:new WeakMap(),document:{body,activeElement:opener,querySelector:() => null}};
  runInNewContext(functionSource('rememberDetailDialogFocus') + '\n' + functionSource('restoreDetailDialogFocus'), sandbox);
  sandbox.rememberDetailDialogFocus(dialog, 'data-request-detail');
  opener.isConnected = false;
  sandbox.document.activeElement = body;
  sandbox.restoreDetailDialogFocus(dialog);
  assert.equal(focused, 'full-fields');
});
