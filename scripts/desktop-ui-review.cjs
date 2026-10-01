// Real Electron renderer review on the existing isolated smoke fixture.
// Never start the user's Router or load the user's Codex profile.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.env.CODEXBRIDGE_DESKTOP_SMOKE !== '1' || !path.isAbsolute(process.env.CODEXBRIDGE_DESKTOP_SMOKE_HOME || '')) {
  throw new Error('UI review requires an isolated smoke profile');
}
const originalQuit = app.quit.bind(app);
let reviewing = false;
const failures = [];
const checks = [];
let resourceStateReadOverride = null;
let budgetSaveOverride = null;
let basicSettingsSaveOverride = null;
let modelSelectionSaveOverride = null;
let modeSelectOverride = null;
let clipboardWriteOverride = null;
const outputDir = process.env.CODEXBRIDGE_UI_REVIEW_OUTPUT;
const settle = () => new Promise(resolve => setTimeout(resolve, 160));

async function review() {
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  const read = (source) => wc.executeJavaScript(source);
  const waitUntil = async (expression, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await read(expression)) return; await settle(); }
    throw new Error('Timed out waiting for ' + expression);
  };
  const click = async (selector) => {
    const point = await read(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({block:'nearest'});
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    const nativePoint = {x:Math.round(point.x*wc.getZoomFactor()),y:Math.round(point.y*wc.getZoomFactor())};
    wc.sendInputEvent({type:'mouseDown', button:'left', clickCount:1, ...nativePoint});
    wc.sendInputEvent({type:'mouseUp', button:'left', clickCount:1, ...nativePoint});
    await settle();
  };
  const check = async (name, task) => {
    try { await task(); checks.push(name); console.log('UI PASS: ' + name); }
    catch (error) { failures.push({name, message:error.message}); console.error('UI FAIL: ' + name + ': ' + error.message); }
    // Persistent notices belong to this scenario, not to the next independent test.
    finally { await read('hideToast()'); }
  };
  const screenshot = async (name) => {
    if (!outputDir) return;
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    fs.mkdirSync(outputDir, {recursive:true});
    fs.writeFileSync(path.join(outputDir, name + '.png'), (await wc.capturePage()).toPNG());
  };
  const show = async (section) => {
    await click(`[data-section="${section}"]`);
    await read('document.fonts.ready.then(() => true)');
    await settle();
  };
  async function checkSoftwareTaskState() {
    await check('installer: delayed snapshots and prior task messages cannot unlock the active task', async () => {
      const before = await read('JSON.stringify(softwareManagerState)');
      try {
        await read(`globalThis.uiRaceSnapshot=softwareManagerState.snapshot;
          updateSoftwareManager({type:'task-result',result:{taskId:'ui-race-a',kind:'install',status:'succeeded',components:[{componentId:'chatgpt',status:'succeeded'}],skills:[]}});
          updateSoftwareManager({type:'task-starting',taskId:'ui-starting-b',submissionId:'ui-request-b',kind:'install',componentId:'chatgpt'});
          updateSoftwareManager({type:'snapshot',snapshot:{...uiRaceSnapshot,task:null}});
          updateSoftwareManager({type:'task-event',event:{type:'finished',taskId:'ui-race-a',result:{taskId:'ui-race-a',status:'succeeded'}}});`);
        assert.equal(await read('softwareManagerState.snapshot.task.taskId'), 'ui-starting-b');
        assert.equal(await read("document.querySelector('[data-software-start]:not(:disabled)')"), null);
        assert.equal(await read("document.querySelectorAll('[data-software-component]:not(:disabled)').length"), 0);
        await read(`updateSoftwareManager({type:'task-event',event:{type:'progress',taskId:'ui-race-b',phase:'download',componentId:'chatgpt',percent:55,cancellable:true,message:'current task'}});
          updateSoftwareManager({type:'task-event',event:{type:'progress',taskId:'ui-race-a',phase:'commit',critical:true,message:'old task'}});
          updateSoftwareManager({type:'task-event',event:{type:'snapshot',snapshot:{...uiRaceSnapshot,task:null}}});`);
        assert.equal(await read('softwareManagerState.snapshot.task.taskId'), 'ui-race-b');
        assert.equal(await read('softwareManagerState.snapshot.task.percent'), 55);
        assert.equal(await read("document.querySelector('[data-software-cancel]').disabled"), false);
        await screenshot('installer-task-state-races');
        await read(`globalThis.uiRaceResult={taskId:'ui-race-b',kind:'install',status:'succeeded',components:[{componentId:'chatgpt',status:'succeeded'}],skills:[]};
          updateSoftwareManager({type:'task-event',event:{type:'finished',taskId:'ui-race-b',result:uiRaceResult}});`);
        assert.equal(await read('softwareManagerState.snapshot.task.phase'), 'finishing');
        assert.equal(await read("document.querySelector('[data-software-start]:not(:disabled)')"), null);
        assert.equal(await read("document.querySelector('[data-software-cancel]').disabled"), true);
        await read("updateSoftwareManager({type:'task-result',submissionId:'ui-request-b',result:uiRaceResult}); updateSoftwareManager({type:'task-event',event:{type:'progress',taskId:'ui-race-b',phase:'download'}})");
        assert.equal(await read('softwareManagerState.snapshot.task'), null);
        assert.equal(await read('softwareManagerState.lastResult.taskId'), 'ui-race-b');
        assert.ok(await read("document.querySelector('.software-result-summary').textContent.includes('安装成功')"));
        await read(`updateSoftwareManager({type:'snapshot',snapshot:{...uiRaceSnapshot,task:{taskId:'ui-observed-task',kind:'install',phase:'download'}}});
          updateSoftwareManager({type:'snapshot',expectedTaskRevision:softwareManagerState.taskRevision,snapshot:{...uiRaceSnapshot,task:null}});
          updateSoftwareManager({type:'task-event',event:{type:'progress',taskId:'ui-observed-task',phase:'download'}});`);
        assert.equal(await read('softwareManagerState.snapshot.task'), null, 'A fresh read must recover a missed completion without resurrecting its old progress');
        await read("updateSoftwareManager({type:'task-event',event:{type:'finished',taskId:'ui-observed-task',result:{taskId:'ui-observed-task',kind:'install',status:'failed',components:[{componentId:'chatgpt',status:'failed',message:'download_stalled'}],skills:[]}}})");
        assert.equal(await read('softwareManagerState.lastResult.status'), 'failed', 'A recovered task must still receive its first late result');
        assert.ok(await read("document.querySelector('.software-result-summary').textContent.includes('安装失败')"));
      } finally { await read('delete globalThis.uiRaceSnapshot; delete globalThis.uiRaceResult; softwareManagerState=' + before + '; renderSoftwareManager()'); }
    });
  }
  async function checkCodexOnlyTabs(sizes = [win.getSize()]) {
    await show('softwareManager');
    await waitUntil('softwareManagerLoaded && !softwareManagerLoading');
    for (const size of sizes) {
      win.setSize(...size);
      await settle();
      for (const tab of ['install','update','uninstall','rollback']) {
        await check(`${size[0]} ${tab}: only Codex remains, selections and confirmation are usable`, async () => {
          const before = await read('JSON.stringify(softwareManagerState)');
          try {
            await read("softwareManagerState={...softwareManagerState,activeTab:'install',selectedComponentIds:[],selectedSkillIds:['documents'],selectedPluginIds:['cowart'],skillsExpanded:true,confirmationPending:false,lastResult:null,snapshot:{...softwareManagerState.snapshot,tabs:['install','update','uninstall','rollback'],readOnly:false,task:null,components:[{id:'chatgpt',name:'ChatGPT',version:'2.0.0',installedVersion:'1.0.0',updateState:'update-available',selectable:true},{id:'git',installedVersion:'1.0.0'},{id:'v2rayn',installedVersion:'1.0.0'}],rollback:[{id:'chatgpt',name:'ChatGPT',version:'2.0.0',previousVersion:'1.0.0'},{id:'git',version:'2.0.0',previousVersion:'1.0.0'},{id:'v2rayn',version:'2.0.0',previousVersion:'1.0.0'}],skills:[{id:'documents'}],curatedPlugins:[{id:'cowart',name:'Cowart',installed:true}]}}; renderSoftwareManager()");
            await click('[data-software-tab="' + tab + '"]');
            assert.equal(await read("document.querySelectorAll('#softwareManagerRoot .software-component-card').length"), 1);
            assert.equal(await read("document.querySelectorAll('#softwareManagerRoot [data-software-skill], #softwareManagerRoot [data-software-plugin], #softwareManagerRoot [data-software-toggle-skills]').length"), 0);
            assert.equal(await read("document.querySelector('#softwareManagerRoot .software-component-head strong').textContent"), 'Codex');
            if (await read("document.querySelector('[data-software-component=\"chatgpt\"]').checked")) await click('[data-software-component="chatgpt"]');
            assert.equal(await read("document.querySelector('[data-software-start]').disabled"), true);
            await click('[data-software-component="chatgpt"]');
            assert.equal(await read("document.querySelector('[data-software-start]').disabled"), false);
            assert.equal(await read('JSON.stringify(softwareManagerState.selectedComponentIds)'), '["chatgpt"]');
            assert.equal(await read('JSON.stringify(softwareManagerState.selectedSkillIds)'), '[]');
            assert.equal(await read('JSON.stringify(softwareManagerState.selectedPluginIds)'), '[]');
            await click('[data-software-start]');
            const confirmation = await read("document.querySelector('.software-confirmation').textContent");
            assert.ok(confirmation.includes('已选择 1 项') && confirmation.includes('Codex'), confirmation);
            assert.ok(!/Cowart|V2RayN|\bGit\b|Skills/.test(confirmation), confirmation);
            assert.equal(await read('softwareManagerState.snapshot.task'), null, 'Confirmation must not start an installation');
            if (tab === 'uninstall') assert.ok(confirmation.includes('聊天历史与项目文件保留'));
            await screenshot(`codex-only-${size[0]}-${tab}-confirmation`);
            await click('[data-software-confirm-cancel]');
            assert.equal(await read('softwareManagerState.confirmationPending'), false);
            assert.equal(await read('softwareManagerState.snapshot.task'), null);
            await screenshot(`codex-only-${size[0]}-${tab}`);
          } finally { await read('softwareManagerState=' + before + '; renderSoftwareManager()'); }
        });
      }
      for (const rollback of [[], [{id:'git',version:'2.0.0',previousVersion:'1.0.0'},{id:'v2rayn',version:'2.0.0',previousVersion:'1.0.0'}]]) {
        await check(`${size[0]} rollback: ${rollback.length ? 'retired-only' : 'empty'} records expose no action`, async () => {
          const before = await read('JSON.stringify(softwareManagerState)');
          try {
            await read(`updateSoftwareManager({type:'snapshot',snapshot:{...softwareManagerState.snapshot,tabs:['install','update','uninstall','rollback'],task:null,rollback:${JSON.stringify(rollback)}}})`);
            assert.equal(await read("document.querySelector('#softwareManagerRoot [data-software-tab=\"rollback\"]')"), null);
            assert.equal(await read("document.querySelectorAll('#softwareManagerRoot [data-software-component=\"git\"], #softwareManagerRoot [data-software-component=\"v2rayn\"]').length"), 0);
          } finally { await read('softwareManagerState=' + before + '; renderSoftwareManager()'); }
        });
      }
    }
  }
  if (process.env.CODEXBRIDGE_UI_REVIEW_CODEX_ONLY === '1') {
    await checkCodexOnlyTabs([[980,640],[1180,760],[1440,900]]);
    await checkSoftwareTaskState();
    if (outputDir) {
      fs.mkdirSync(outputDir,{recursive:true});
      fs.writeFileSync(path.join(outputDir,'result.json'),JSON.stringify({checks,failures},null,2));
    }
    if (failures.length) throw new Error(failures.length + ' Codex-only checks failed');
    console.log('DESKTOP_CODEX_ONLY_PASS ' + checks.length);
    return;
  }
  if (process.env.CODEXBRIDGE_UI_REVIEW_TASK_STATE_ONLY === '1') {
    win.setSize(980,640);
    await show('softwareManager');
    await waitUntil('softwareManagerLoaded && !softwareManagerLoading');
    await checkSoftwareTaskState();
    if (outputDir) {
      fs.mkdirSync(outputDir,{recursive:true});
      fs.writeFileSync(path.join(outputDir,'result.json'),JSON.stringify({checks,failures},null,2));
    }
    if (failures.length) throw new Error(failures.length + ' software task-state checks failed');
    console.log('DESKTOP_SOFTWARE_STATE_PASS ' + checks.length);
    return;
  }
  await settle();
  const quick = process.env.CODEXBRIDGE_UI_REVIEW_QUICK === '1';
  if (process.env.CODEXBRIDGE_UI_REVIEW_TOAST_ONLY !== '1' && process.env.CODEXBRIDGE_UI_REVIEW_QUOTA_ONLY !== '1') {
  for (const size of quick ? [[980,640]] : [[1180,760], [980,640], [1440,900]]) {
    win.setSize(...size);
    await settle();
    for (const section of quick ? ['models','resources','settings','sessions','logs','doubleQuota'] : ['dashboard','preflight','models','capabilities','stats','resources','settings','softwareManager','sessions','logs','doubleQuota','vvip']) {
      await show(section);
      // The layout matrix intentionally inspects the top of each page; navigation history is tested separately.
      if (await read("document.querySelector('#backToPageTop') && !document.querySelector('#backToPageTop').hidden")) await click('#backToPageTop');
      const dimensions = await read(`(() => {
        const main = document.querySelector('.main');
        const section = document.querySelector('#${section}');
        const title = document.querySelector('#pageTitle');
        const activeNav = document.querySelector('.nav-item.active');
        return {width:innerWidth, height:innerHeight, mainWidth:main.clientWidth, mainScrollWidth:main.scrollWidth,
          sectionVisible:section.getBoundingClientRect().height > 0,
          title:title?.textContent?.trim(), nav:activeNav?.textContent?.trim(), navSection:activeNav?.dataset.section,
          activePage:activeNav?.getAttribute('aria-current')};
      })()`);
      await check(`${size[0]} ${section}: viewport and current-page heading`, () => {
        assert.equal(dimensions.sectionVisible, true);
        assert.equal(dimensions.navSection, section, 'Navigation did not reach the requested page');
        assert.ok(dimensions.mainScrollWidth <= dimensions.mainWidth + 1, 'Page has horizontal overflow');
        assert.equal(dimensions.title, dimensions.nav, 'Heading should identify the active page');
        assert.equal(dimensions.activePage, 'page');
      });
      if (section === 'settings') {
        await check(`${size[0]} settings: controls retain their meaning in named groups`, async () => {
          const groups = await read(`(() => {
            const ids = ['routerPort','bypassSystemProxy','localRateLimitEnabled','duplicateRequestProtection','interceptCodexAuxiliaryTasks','codexAuxiliaryModelId','autoSelectModel','autoFailover'];
            return ids.map(id => ({id, count:document.querySelectorAll('#' + id).length,
              group:document.getElementById(id)?.closest('fieldset')?.querySelector('legend')?.textContent.trim()}));
          })()`);
          assert.deepEqual(groups.map(item => item.count), [1,1,1,1,1,1,1,1]);
          assert.deepEqual(groups.map(item => item.group), ['连接','连接','请求与辅助任务','请求与辅助任务','请求与辅助任务','请求与辅助任务','自动路由','自动路由']);
        });
        await check(`${size[0]} settings: section shortcuts preserve drafts and keep their headings visible`, async () => {
          const originalPort = await read('els.routerPort.value');
          const saved = await read('JSON.stringify(state.desktopOptions)');
          await click('#routerPort');
          wc.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});
          wc.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});
          await settle();
          await wc.insertText('15799');
          try {
            for (const id of ['settingsBackups','settingsProfiles','settingsGeneral']) {
              if (id === 'settingsProfiles' && size[0] === 980) {
                await read(`document.querySelector('[data-settings-jump="${id}"]').focus()`);
                wc.sendInputEvent({type:'keyDown',keyCode:'Enter'});
                wc.sendInputEvent({type:'char',keyCode:'Enter'});
                wc.sendInputEvent({type:'keyUp',keyCode:'Enter'});
                await settle();
              } else {
                await click(`[data-settings-jump="${id}"]`);
              }
              const location = await read(`(() => {
                const heading=document.querySelector('#${id} h2').getBoundingClientRect();
                const nav=document.querySelector('.settings-jump-nav').getBoundingClientRect();
                const footer=document.querySelector('.settings-actions').getBoundingClientRect();
                return {headingTop:heading.top,headingBottom:heading.bottom,navBottom:nav.bottom,footerTop:footer.top,focus:document.activeElement.closest('article')?.id};
              })()`);
              assert.equal(location.focus, id);
              assert.ok(location.headingTop >= location.navBottom && location.headingBottom < location.footerTop, JSON.stringify(location));
              assert.equal(await read('els.routerPort.value'), '15799');
              assert.equal(await read('JSON.stringify(state.desktopOptions)'), saved);
              if (id === 'settingsProfiles' && size[0] === 1180) await screenshot('settings-section-shortcuts');
            }
          } finally { await read(`els.routerPort.value=${JSON.stringify(originalPort)}; els.routerPort.dispatchEvent(new Event('input',{bubbles:true}))`); }
        });
        await check(`${size[0]} settings: invalid port stays editable with a visible explanation and no save`, async () => {
          const original = await read('els.routerPort.value');
          const saved = await read('JSON.stringify(state.desktopOptions)');
          try {
            await read("els.routerPort.value='65536'; els.routerPort.dispatchEvent(new Event('input',{bubbles:true}))");
            await click('[data-settings-jump="settingsProfiles"]');
            await click('#saveDesktopOptions');
            await waitUntil("!els.saveDesktopOptions.classList.contains('loading')");
            assert.equal(await read('els.routerPort.value'), '65536');
            assert.equal(await read('document.activeElement.id'), 'routerPort');
            assert.equal(await read("els.routerPort.getAttribute('aria-invalid')"), 'true');
            const explanation = await read(`(() => {
              const error=document.querySelector('#routerPortError'); const rect=error.getBoundingClientRect();
              return {text:error.textContent,visible:!error.hidden,top:rect.top,bottom:rect.bottom,
                navBottom:document.querySelector('.settings-jump-nav').getBoundingClientRect().bottom,
                footerTop:document.querySelector('.settings-actions').getBoundingClientRect().top};
            })()`);
            assert.ok(explanation.visible && explanation.text.includes('1024') && explanation.text.includes('65535'));
            assert.ok(explanation.top >= explanation.navBottom && explanation.bottom < explanation.footerTop, JSON.stringify(explanation));
            assert.equal(await read('JSON.stringify(state.desktopOptions)'), saved);
            if (size[0] === 980) await screenshot('settings-port-error');
            await read("els.routerPort.value='15800'; els.routerPort.dispatchEvent(new Event('input',{bubbles:true}))");
            assert.equal(await read('els.routerPortError.hidden'), true);
            assert.equal(await read("els.routerPort.getAttribute('aria-invalid')"), 'false');
            await click('#discardDesktopSettings');
            assert.equal(await read('els.routerPort.value'), original);
          } finally {
            await read(`desktopSettingsDraft.clear(); els.routerPort.value=${JSON.stringify(original)}; els.routerPort.dispatchEvent(new Event('input',{bubbles:true})); render()`);
          }
        });
      }
      if (section === 'logs') {
        await check(`${size[0]} logs: the viewer fits the window without a second vertical scrollbar`, async () => {
          const layout = await read(`(() => {
            const output = document.querySelector('#logOutput').getBoundingClientRect();
            const main = document.querySelector('.main');
            return {bottom:output.bottom,height:output.height,viewport:innerHeight,overflow:main.scrollHeight-main.clientHeight};
          })()`);
          assert.ok(layout.bottom <= layout.viewport - 10, JSON.stringify(layout));
          assert.ok(layout.height >= 200, JSON.stringify(layout));
          assert.ok(layout.overflow <= 1, JSON.stringify(layout));
        });
      }
      if (section === 'sessions') {
        await check(`${size[0]} sessions: search and clear share a compact row`, async () => {
          const aligned = await read(`(() => {
            const search = document.querySelector('#sessionSearch').getBoundingClientRect();
            const clear = document.querySelector('#clearSessionSearch').getBoundingClientRect();
            return Math.abs(search.top + search.height/2 - clear.top - clear.height/2) < 2;
          })()`);
          assert.equal(aligned, true);
        });
      }
      if (section === 'capabilities') {
        await check(`${size[0]} capabilities: model diagnostics start on the first screen`, async () => {
          const top = await read("document.querySelector('#capabilityDiagnostics').getBoundingClientRect().top");
          assert.ok(top < dimensions.height - 90, 'Summary tiles displaced the model diagnostics');
          const summaryHeight = await read("document.querySelector('#capabilitySummary').getBoundingClientRect().height");
          assert.ok(summaryHeight <= Math.min(240, dimensions.height / 3), 'Capability summary occupies too much of the viewport');
        });
      }
      if (['settings','softwareManager'].includes(section)) {
        await check(`${size[0]} ${section}: footer does not cover visible form controls`, async () => {
          const covered = await read(`(() => {
            const section = document.querySelector('#${section}');
            const footer = section.querySelector('.settings-actions, .software-action-bar');
            if (!footer) throw new Error('Missing action footer');
            const bar = footer.getBoundingClientRect();
            return [...section.querySelectorAll('input, select, button')].filter(node => {
              if (footer.contains(node) || !node.getClientRects().length) return false;
              const rect = node.getBoundingClientRect();
              let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
              for (let parent = node.parentElement; parent; parent = parent.parentElement) {
                if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) {
                  const bounds = parent.getBoundingClientRect(); top = Math.max(top,bounds.top); bottom = Math.min(bottom,bounds.bottom);
                }
              }
              return bottom > top && Math.min(bottom,bar.bottom) - Math.max(top,bar.top) > 1
                && Math.min(rect.right,bar.right) > Math.max(rect.left,bar.left);
            }).map(node => node.id || node.textContent.trim() || node.type);
          })()`);
          assert.deepEqual(covered, []);
        });
      }
      if (section === 'models') {
        await check(`${size[0]} models: selection opens by default and every provider is above the model pool`, async () => {
          const layout = await read(`(() => {
            const preview=document.querySelector('#providerPreview');
            const pool=document.querySelector('#modelPool').getBoundingClientRect();
            return {open:document.querySelector('#modelSelectedDetails').open,
              previewBottom:preview.getBoundingClientRect().bottom,poolTop:pool.top,
              overflow:preview.scrollHeight-preview.clientHeight};
          })()`);
          assert.equal(layout.open, true);
          assert.ok(layout.previewBottom <= layout.poolTop + 1, JSON.stringify(layout));
          assert.ok(layout.overflow <= 1, 'Providers must not be hidden in their own scroll rail');
        });
        await check(`${size[0]} models: choices remain reachable below the full supplier list`, async () => {
          const visible = await read(`(() => {
            const card=document.querySelector('#modelPool .model-card');
            card.scrollIntoView({block:'center'});
            const rect=card.getBoundingClientRect();
            return rect.bottom>document.querySelector('.topbar').getBoundingClientRect().bottom
              && rect.top<document.querySelector('.model-selection-actions').getBoundingClientRect().top;
          })()`);
          assert.equal(visible, true);
        });
        await check(`${size[0]} models: readable secondary labels`, async () => {
          const sizes = await read("[...document.querySelectorAll('#selectedModels small, #providerPreview small, #modelPool .model-meta')].map(node => parseFloat(getComputedStyle(node).fontSize))");
          assert.ok(sizes.length > 0 && sizes.every(size => size >= 12), 'Secondary model text is below 12px');
        });
        await check(`${size[0]} models: chosen cards expose their pressed state`, async () => {
          const cards = await read("[...document.querySelectorAll('#modelPool .model-card')].map(node => ({selected:node.classList.contains('selected'),pressed:node.getAttribute('aria-pressed')}))");
          assert.ok(cards.length > 0);
          for (const card of cards) assert.equal(card.pressed, String(card.selected));
        });
      }
      if (section === 'doubleQuota') {
        await check(`${size[0]} service page: version details do not become a tall single column`, async () => {
          const result = await read(`(() => {
            const items = [...document.querySelectorAll('.double-quota-metrics > div')];
            return items.map(element => element.getBoundingClientRect().top);
          })()`);
          assert.ok(result.length >= 2);
          assert.equal(result[0], result[1]);
        });
      }
      if (section === 'stats') {
        await check(`${size[0]} stats: trend before collapsed budget editor`, async () => {
          const layout = await read(`(() => {
            const graph = document.querySelector('#usageChart').getBoundingClientRect();
            const editor = document.querySelector('#usageBudgetDetails');
            const metrics = [...document.querySelectorAll('.stat-summary .metric')].map(x => x.getBoundingClientRect());
            return {graphTop:graph.top, height:innerHeight, editorExists:!!editor, editorOpen:editor?.open,
              first:metrics[0]?.top, second:metrics[1]?.top};
          })()`);
          assert.equal(layout.editorExists, true);
          assert.equal(layout.editorOpen, false);
          assert.ok(layout.graphTop < layout.height - 90, 'Trend is below the initial viewport');
          assert.equal(layout.first, layout.second, 'Metrics collapsed into a single long column');
        });
        await check(`${size[0]} statistics: empty data does not render two horizontally scrolling tables`, async () => {
          assert.equal(await read("document.querySelectorAll('#usageTable .usage-table-block').length"), 0);
          assert.equal(await read("document.querySelectorAll('#stats .empty-state').length"), 1);
        });
      }
      if (section === 'resources') {
        await check(`${size[0]} resources: list or empty state visible without scrolling`, async () => {
          const top = await read("document.querySelector('#resourceList').getBoundingClientRect().top");
          assert.ok(top < dimensions.height - 70, 'Diagnostic explanations displaced resource content');
        });
        await check(`${size[0]} resources: empty categories do not displace existing resources`, async () => {
          assert.equal(await read("[...document.querySelectorAll('#resourceList > .resource-block')].filter(node => node.querySelector('header span')?.textContent === '0').length"), 0);
          assert.ok(await read("document.querySelector('#resourceList').textContent.includes('规则文件')"));
        });
      }
      if (section === 'softwareManager') {
        await click('[data-software-tab="install"]');
        await check(`${size[0]} installer: page width is stable across task result and confirmation text`, async () => {
          const before=await read('JSON.stringify(softwareManagerState)');
          try {
            const widths=[];
            for(const [status,confirmation] of [['succeeded',false],['skipped',false],['succeeded',true]]) {
              await read(`softwareManagerState={...softwareManagerState,confirmationPending:${confirmation},lastResult:{kind:'uninstall',taskId:'ui-width',status:'succeeded',components:[{componentId:'chatgpt',status:${JSON.stringify(status)},message:'component_uninstalled'}],skills:[]}};renderSoftwareManager()`);
              widths.push(await read("document.querySelector('#softwareManager').getBoundingClientRect().width"));
            }
            assert.ok(Math.max(...widths)-Math.min(...widths)<1,'Installer shrank according to its contents: '+JSON.stringify(widths));
            const fill=await read(`(() => {const page=document.querySelector('#softwareManager').getBoundingClientRect();const main=document.querySelector('.main');const style=getComputedStyle(main);return Math.abs(page.width-(main.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)))<2;})()`);
            assert.equal(fill,true,'Installer must fill the available page width');
          } finally {await read(`softwareManagerState=JSON.parse(${JSON.stringify(before)});renderSoftwareManager()`);}
        });
        await check(`${size[0]} installer: single full-width Codex entry and visible start action`, async () => {
          const result = await read(`(() => {
            const cards = [...document.querySelectorAll('.software-component-card')];
            const action = document.querySelector('[data-software-start]');
            const box = action.getBoundingClientRect();
            return {count:cards.length, fullWidth:Math.abs(cards[0].getBoundingClientRect().width-document.querySelector(".software-manager-grid").getBoundingClientRect().width)<2,
              disabled:action.disabled, visible:box.top >= 0 && box.bottom <= innerHeight,
              wrap:getComputedStyle(action).whiteSpace,
              unavailable:cards.flatMap(card => [...card.querySelectorAll('input')]).filter(input => input.disabled).length};
          })()`);
          assert.equal(result.count, 1);
          assert.equal(result.fullWidth, true);
          assert.equal(result.disabled, false);
          assert.equal(result.visible, true);
          assert.equal(result.wrap, 'nowrap');
          assert.equal(result.unavailable, 0);
          assert.equal(await read("document.querySelector('.software-install-root-value').title"), await read("document.querySelector('.software-install-root-value').textContent"));
        });
      }
      await screenshot(`${size[0]}-${section}`);
      if (section === 'softwareManager') {
        await check(`${size[0]} installer: running task actions stay visible and honor cancellation guards`, async () => {
          await read('globalThis.uiReviewSoftwareBaseline = softwareManagerState');
          try {
            for (const scenario of [
              {phase:'download',percent:37,cancellable:true,critical:false},
              {phase:'commit',percent:null,cancellable:true,critical:true},
              {phase:'extract',percent:null,cancellable:false,critical:false},
            ]) {
              const scrollBefore = await read("document.querySelector('.software-scroll-area').scrollTop");
              await read(`softwareManagerState = {...uiReviewSoftwareBaseline,
                snapshot:{...uiReviewSoftwareBaseline.snapshot,task:{taskId:'ui-staged-install',kind:'install',...${JSON.stringify(scenario)}},logs:['正在准备安装文件','正在下载安装包']}};
                renderSoftwareManager();`);
              await settle();
              const controls = await read(`(() => {
                const footer = document.querySelector('.software-footer');
                const cancel = footer?.querySelector('[data-software-cancel]');
                const report = footer?.querySelector('[data-software-copy-report]');
                const visible = element => { const r = element?.getBoundingClientRect(); return !!r && r.width > 0 && r.top >= 0 && r.bottom <= innerHeight; };
                return {cancelVisible:visible(cancel), reportVisible:visible(report), disabled:cancel?.disabled,
                  enabledStart:!!document.querySelector('[data-software-start]:not(:disabled)'),
                  top:document.querySelector('.software-task-panel')?.getBoundingClientRect().top};
              })()`);
              assert.equal(controls.cancelVisible, true);
              assert.equal(controls.reportVisible, true);
              assert.equal(controls.disabled, !scenario.cancellable || scenario.critical);
              assert.equal(controls.enabledStart, false);
              assert.ok(controls.top < dimensions.height - 160);
              if (scenario.phase === 'download') {
                await screenshot(`${size[0]}-install-running`);
                await click('.software-task-log > summary');
                await read("document.querySelector('.software-scroll-area').scrollTop = 80");
              } else {
                assert.equal(await read("document.querySelector('.software-scroll-area').scrollTop"), scrollBefore, 'Progress updates reset manual scrolling');
                assert.equal(await read("document.querySelector('.software-task-log').open"), true, 'Progress updates closed the task log');
              }
            }
            await read(`softwareManagerState = {...uiReviewSoftwareBaseline,
              snapshot:{...uiReviewSoftwareBaseline.snapshot,task:null,logs:['已完成任务']},
              lastResult:{taskId:'ui-staged-install',kind:'install',status:'partial',components:[
                {componentId:'chatgpt',status:'succeeded',message:'component_committed'},
                {componentId:'git',status:'failed',message:'access_denied'}],skills:[]}};
              renderSoftwareManager();`);
            assert.equal(await read("document.querySelector('.software-scroll-area').scrollTop"), 0);
            assert.ok(await read("document.querySelector('.software-result-summary').textContent.includes('1 项成功') && document.querySelector('.software-result-summary').textContent.includes('1 项失败')"));
            assert.equal(await read("document.querySelectorAll('.software-result-row').length"), 2);
            await screenshot(`${size[0]}-install-result`);
          } finally { await read('softwareManagerState = uiReviewSoftwareBaseline; renderSoftwareManager()'); }
        });
      }
    }
  }
  await checkCodexOnlyTabs();
  for (const section of ['resources']) {
    await check(`${section}: native undo restores a search edit and updates its results`, async () => {
      await show(section);
      const resourceBefore=await read('resourceFilterText');
      const selector='#resourceSearch';
      try {
        await read("resourceFilterText=''; els.resourceSearch.value=''; renderResources()");
        const rows='#resourceList .resource-item';
        const originalRows=await read(`document.querySelectorAll(${JSON.stringify(rows)}).length`);
        assert.ok(originalRows>0,'The fixture must include searchable rows');
        await click(selector); await wc.insertText('native-undo-query'); await settle();
        assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`),'native-undo-query');
        assert.equal(await read(`document.querySelectorAll(${JSON.stringify(rows)}).length`),0);
        wc.undo(); await settle();
        assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`),'','Undo did not restore the search text');
        assert.equal(await read('resourceFilterText'),'','Undo did not update filtering');
        assert.equal(await read(`document.querySelectorAll(${JSON.stringify(rows)}).length`),originalRows,'Undo did not restore the result list');
      } finally {
        await read(`resourceFilterText=${JSON.stringify(resourceBefore)}; els.resourceSearch.value=resourceFilterText; renderResources()`);
      }
    });
  }
  await show('softwareManager');
  await check('Codex checkbox keeps keyboard focus across local state changes without weakening task guards', async () => {
    const before=await read('JSON.stringify(softwareManagerState)');
    try {
      await read("softwareManagerState={...softwareManagerState,activeTab:'install',confirmationPending:false,snapshot:{...softwareManagerState.snapshot,task:null,readOnly:false}}; renderSoftwareManager()");
      await click('[data-software-component="chatgpt"]');
      await read("updateSoftwareManager({type:'confirm-close'})");
      assert.equal(await read("document.activeElement===document.querySelector('[data-software-component=\"chatgpt\"]')"),true);
      await read("document.querySelector('#pageTitle').focus(); updateSoftwareManager({type:'confirm-close'})");
      assert.equal(await read('document.activeElement.id'),'pageTitle','State updates must not steal focus');
      await read("updateSoftwareManager({type:'task-starting',taskId:'ui-codex-state-only',kind:'install'})");
      assert.equal(await read("document.querySelector('[data-software-start]:not(:disabled)')"),null);
      assert.equal(await read("document.querySelector('[data-software-cancel]').disabled"),true);
      assert.equal(await read("document.querySelectorAll('[data-software-component]:not(:disabled)').length"),0);
    } finally { await read('softwareManagerState='+before+'; renderSoftwareManager()'); }
  });
  await checkSoftwareTaskState();
  await show('stats');
  await check('budget disclosure retains draft input through open-close-open', async () => {
    await click('#usageBudgetDetails > summary');
    assert.equal(await read("document.querySelector('#usageBudgetDetails').open"), true);
    await click('#usageDailyTokenLimit');
    wc.sendInputEvent({type:'keyDown', keyCode:'A', modifiers:['control']});
    wc.sendInputEvent({type:'keyUp', keyCode:'A', modifiers:['control']});
    await wc.insertText('123000');
    await click('#usageBudgetDetails > summary');
    await click('#usageBudgetDetails > summary');
    assert.equal(await read("document.querySelector('#usageDailyTokenLimit').value"), '123000');
  });
  await check('budget edits survive focus changes, page navigation and a background state refresh without saving', async () => {
    const original = await read('JSON.stringify(state.desktopOptions)');
    try {
      await read(`els.usageBudgetScope.value='global'; els.usageBudgetScope.dispatchEvent(new Event('change',{bubbles:true}));
        els.usageDailyCallLimit.value='123'; els.usageDailyCallLimit.dispatchEvent(new Event('input',{bubbles:true}));
        els.usageCacheWriteCostPerMillion.value='0'; els.usageCacheWriteCostPerMillion.dispatchEvent(new Event('input',{bubbles:true}));`);
      await show('settings');
      await read('refresh({lite:true})');
      await show('stats');
      assert.equal(await read('els.usageDailyCallLimit.value'), '123');
      assert.equal(await read('els.usageCacheWriteCostPerMillion.value'), '0');
      assert.equal(await read('JSON.stringify(state.desktopOptions)'), original);
      await read("document.querySelector('#saveUsageBudgets').scrollIntoView({block:'center'})");
      await screenshot('budget-unsaved-draft');
    } finally {
      await read(`if(typeof usageBudgetDrafts !== 'undefined') usageBudgetDrafts.clear();
        els.usageBudgetScope.value='global'; state.desktopOptions=${original}; renderUsageBudgetInputs({keepTarget:false})`);
    }
  });
  await check('switching budget scope keeps each object draft separate and does not save it', async () => {
    const original = await read('JSON.stringify(state.desktopOptions)');
    try {
      await read(`els.usageDailyCallLimit.value='123'; els.usageDailyCallLimit.dispatchEvent(new Event('input',{bubbles:true}));
        els.usageBudgetScope.value='route'; els.usageBudgetScope.dispatchEvent(new Event('change',{bubbles:true}));
        els.usageDailyCallLimit.value='7'; els.usageDailyCallLimit.dispatchEvent(new Event('input',{bubbles:true}));
        els.usageBudgetScope.value='global'; els.usageBudgetScope.dispatchEvent(new Event('change',{bubbles:true}));`);
      assert.equal(await read('els.usageDailyCallLimit.value'), '123');
      await read("els.usageBudgetScope.value='route'; els.usageBudgetScope.dispatchEvent(new Event('change',{bubbles:true}))");
      assert.equal(await read('els.usageDailyCallLimit.value'), '7');
      assert.equal(await read('JSON.stringify(state.desktopOptions)'), original);
    } finally {
      await read(`if(typeof usageBudgetDrafts !== 'undefined') usageBudgetDrafts.clear();
        els.usageBudgetScope.value='global'; state.desktopOptions=${original}; renderUsageBudgetInputs({keepTarget:false})`);
    }
  });
  await check('saving one budget keeps edits made during the request and drafts for other objects', async () => {
    const snapshot = JSON.parse(await read('JSON.stringify(state)'));
    let finishSave;
    let submitted;
    budgetSaveOverride = (_event, options) => {
      submitted = options;
      return new Promise(resolve => { finishSave = () => resolve({...snapshot,desktopOptions:{...snapshot.desktopOptions,...options}}); });
    };
    try {
      await read(`els.usageDailyCallLimit.value='123'; els.usageDailyCallLimit.dispatchEvent(new Event('input',{bubbles:true}));`);
      await click('#saveUsageBudgets');
      assert.equal(submitted.usageBudgets.global.dailyCallLimit, 123);
      await read(`els.usageDailyCallLimit.value='456'; els.usageDailyCallLimit.dispatchEvent(new Event('input',{bubbles:true}));
        els.usageBudgetScope.value='route'; els.usageBudgetScope.dispatchEvent(new Event('change',{bubbles:true}));
        els.usageDailyCallLimit.value='7'; els.usageDailyCallLimit.dispatchEvent(new Event('input',{bubbles:true}));`);
      finishSave();
      await waitUntil("!els.saveUsageBudgets.classList.contains('loading')");
      assert.equal(await read('els.usageDailyCallLimit.value'), '7');
      await read("els.usageBudgetScope.value='global'; els.usageBudgetScope.dispatchEvent(new Event('change',{bubbles:true}))");
      assert.equal(await read('els.usageDailyCallLimit.value'), '456');
      assert.equal(await read('state.desktopOptions.usageBudgets.global.dailyCallLimit'), 123);
    } finally {
      finishSave?.(); budgetSaveOverride = null;
      await waitUntil("!els.saveUsageBudgets.classList.contains('loading')");
      await read(`if(typeof usageBudgetDrafts !== 'undefined') usageBudgetDrafts.clear();
        els.usageBudgetScope.value='global'; adoptStateSnapshot(${JSON.stringify(snapshot)}); renderUsageBudgetInputs({keepTarget:false})`);
    }
  });
  await check('invalid budget numbers cannot silently remove an existing limit', async () => {
    const snapshot = JSON.parse(await read('JSON.stringify(state)'));
    let saves = 0;
    budgetSaveOverride = async () => { saves += 1; return snapshot; };
    try {
      await read("els.usageDailyCallLimit.value='-1'; els.usageDailyCallLimit.dispatchEvent(new Event('input',{bubbles:true}))");
      await click('#saveUsageBudgets');
      await waitUntil("!els.saveUsageBudgets.classList.contains('loading')");
      assert.equal(saves, 0);
      assert.equal(await read('els.usageDailyCallLimit.value'), '-1');
      assert.equal(await read('document.activeElement.id'), 'usageDailyCallLimit');
    } finally {
      budgetSaveOverride = null;
      await read(`if(typeof usageBudgetDrafts !== 'undefined') usageBudgetDrafts.clear();
        els.usageDailyCallLimit.blur(); els.usageDailyCallLimit.value=''; renderUsageBudgetInputs({keepTarget:false})`);
    }
  });
  await check('discarding the current budget in read-only mode preserves drafts for other scopes', async () => {
    const original = await read('JSON.stringify(state.desktopOptions)');
    const unavailable = await read('state.stateUnavailable');
    try {
      await read(`els.usageDailyCallLimit.value='123'; els.usageDailyCallLimit.dispatchEvent(new Event('input',{bubbles:true}));
        els.usageBudgetScope.value='route'; els.usageBudgetScope.dispatchEvent(new Event('change',{bubbles:true}));
        els.usageDailyCallLimit.value='7'; els.usageDailyCallLimit.dispatchEvent(new Event('input',{bubbles:true}));
        els.usageBudgetScope.value='global'; els.usageBudgetScope.dispatchEvent(new Event('change',{bubbles:true}));
        state.stateUnavailable=true; applyStateUnavailableWriteGuard(document,true);`);
      assert.equal(await read('els.discardUsageBudget.disabled'),false);
      await click('#discardUsageBudget');
      assert.equal(await read('els.usageDailyCallLimit.value'),'');
      assert.equal(await read('document.activeElement.id'),'usageBudgetScope');
      assert.equal(await read('els.usageBudgetScope.disabled'),false);
      assert.equal(await read('els.saveUsageBudgets.disabled'),true);
      await read("els.usageBudgetScope.value='route'; els.usageBudgetScope.dispatchEvent(new Event('change',{bubbles:true}))");
      assert.equal(await read('els.usageDailyCallLimit.value'),'7');
      assert.equal(await read('JSON.stringify(state.desktopOptions)'),original);
    } finally {
      await read(`state.stateUnavailable=${Boolean(unavailable)}; applyStateUnavailableWriteGuard(document,${Boolean(unavailable)});
        usageBudgetDrafts.clear(); els.usageBudgetScope.value='global'; renderUsageBudgetInputs({keepTarget:false,resetInputs:true})`);
    }
  });
  await check('a failed budget save retains input through refresh and a retry saves only that object', async () => {
    const snapshot = JSON.parse(await read('JSON.stringify(state)'));
    let fail = true;
    let submitted;
    budgetSaveOverride = async (_event,options) => {
      submitted = options;
      if(fail) throw new Error('UI fixture: budget save failed');
      return {...snapshot,desktopOptions:{...snapshot.desktopOptions,...options}};
    };
    try {
      await read("els.usageDailyCallLimit.value='27'; els.usageDailyCallLimit.dispatchEvent(new Event('input',{bubbles:true}))");
      await click('#saveUsageBudgets');
      await waitUntil("!els.saveUsageBudgets.classList.contains('loading')");
      await read('refresh({lite:true})');
      assert.equal(await read('els.usageDailyCallLimit.value'),'27');
      assert.equal(await read('els.discardUsageBudget.disabled'),false);
      fail = false;
      await click('[data-toast-close]');
      await click('#saveUsageBudgets');
      await waitUntil("!els.saveUsageBudgets.classList.contains('loading')");
      assert.equal(submitted.usageBudgets.global.dailyCallLimit,27);
      assert.equal(await read('els.discardUsageBudget.disabled'),true);
    } finally {
      budgetSaveOverride=null;
      await read(`usageBudgetDrafts.clear(); adoptStateSnapshot(${JSON.stringify(snapshot)}); renderUsageBudgetInputs({resetInputs:true})`);
    }
  });
  await check('an incomplete native budget number survives refresh and cannot be saved as the blank default', async () => {
    const originalSize=win.getSize();
    try {
      for(const budgetSize of [[980,640],[1180,760],[1440,900]]) {
        win.setSize(...budgetSize); await settle();
        const snapshot = JSON.parse(await read('JSON.stringify(state)'));
        let saves = 0;
        budgetSaveOverride = async () => { saves+=1; return snapshot; };
        try {
          await click('#usageDailyCallLimit');
          wc.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});
          wc.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});
          await settle(); await wc.insertText('1e'); await settle();
          assert.equal(await read('els.usageDailyCallLimit.validity.badInput'),true);
          await show('settings'); await read('refresh({lite:true})'); await show('stats');
          assert.equal(await read('els.usageDailyCallLimit.validity.badInput'),true);
          await click('#saveUsageBudgets');
          await waitUntil("!els.saveUsageBudgets.classList.contains('loading')");
          assert.equal(saves,0);
          assert.equal(await read('els.usageBudgetError.hidden'),false);
          assert.equal(await read("els.toast.classList.contains('hidden')"),true,'Field validation must remain inline');
          await read("els.discardUsageBudget.scrollIntoView({block:'nearest'})");
          assert.equal(await read("(() => {const b=els.discardUsageBudget,r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return b===hit||b.contains(hit)})()"),true,'Discard action is obscured');
          await screenshot('budget-invalid-'+budgetSize[0]);
          await click('#discardUsageBudget');
          assert.equal(await read('els.usageDailyCallLimit.validity.badInput'),false);
          assert.equal(await read('els.usageBudgetError.hidden'),true);
        } finally {
          budgetSaveOverride=null;
          await read('usageBudgetDrafts.clear(); renderUsageBudgetInputs({resetInputs:true})');
        }
      }
    } finally { win.setSize(...originalSize); await settle(); }
  });
  await check('a removed budget target stays identified and cannot write to its replacement', async () => {
    const models = await read('JSON.stringify(state.models)');
    let saves=0;
    budgetSaveOverride=async () => {saves+=1; return JSON.parse(await read('JSON.stringify(state)'));};
    try {
      await read("els.usageBudgetScope.value='route'; els.usageBudgetScope.dispatchEvent(new Event('change',{bubbles:true}))");
      const target = await read('els.usageBudgetTarget.value');
      await read("els.usageDailyCallLimit.value='7'; els.usageDailyCallLimit.dispatchEvent(new Event('input',{bubbles:true})); state.models=[{id:'ui-other-budget-model',provider:'gpt'}]; renderUsageBudgetInputs()");
      assert.equal(await read('els.usageBudgetTarget.value'),target);
      await click('#saveUsageBudgets');
      await waitUntil("!els.saveUsageBudgets.classList.contains('loading')");
      assert.equal(saves,0);
      assert.equal(await read('els.usageDailyCallLimit.value'),'7');
    } finally {
      budgetSaveOverride=null;
      await read(`usageBudgetDrafts.clear(); state.models=${models}; els.usageBudgetScope.value='global'; renderUsageBudgetInputs({keepTarget:false,resetInputs:true})`);
    }
  });
  await check('sidebar utility menu reveals existing commands and closes with Escape', async () => {
    await click('#sidebarUtilityToggle');
    assert.equal(await read("document.querySelector('#sidebarUtilityMenu').matches(':popover-open')"), true);
    assert.ok(await read("document.querySelector('#openGitHub').getBoundingClientRect().height > 0"));
    wc.sendInputEvent({type:'keyDown', keyCode:'Escape'});
    wc.sendInputEvent({type:'keyUp', keyCode:'Escape'});
    await settle();
    assert.equal(await read("document.querySelector('#sidebarUtilityMenu').matches(':popover-open')"), false);
  });
  await check('choosing a sidebar utility command dismisses the menu', async () => {
    for (const id of ['openGitHub','openUpdateFolder']) {
      await click('#sidebarUtilityToggle');
      // Keep the real native button/default action, but do not open an external app in this test.
      await read(`document.addEventListener('click', event => {
        if (event.target.closest('#${id}')) event.stopImmediatePropagation();
      }, {capture:true, once:true})`);
      await click('#' + id);
      assert.equal(await read("document.querySelector('#sidebarUtilityMenu').matches(':popover-open')"), false, id);
    }
  });
  await show('models');
  await check('model ordering works with buttons and keyboard without applying the draft', async () => {
    const saved = await read('JSON.stringify(state.selectedModelIds)');
    const initial = JSON.parse(await read('JSON.stringify(draftSelection)'));
    if (!(await read("document.querySelector('#modelSelectedDetails').open"))) await click('#modelSelectedDetails > summary');
    assert.equal(await read("document.querySelector('[data-move-selected-slot=\"0\"][data-move-direction=\"up\"]').disabled"), true);
    await click('[data-move-selected-slot="0"][data-move-direction="down"]');
    assert.equal(await read('JSON.stringify(draftSelection)'), JSON.stringify([initial[1],initial[0],...initial.slice(2)]));
    await read("globalThis.orderKeyEvents = []; for (const kind of ['keydown','keypress','keyup']) document.addEventListener(kind, event => orderKeyEvents.push({kind,key:event.key,code:event.code}), {once:true})");
    wc.sendInputEvent({type:'keyDown',keyCode:'Enter'});
    wc.sendInputEvent({type:'char',keyCode:'Enter'});
    wc.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await settle();
    const keyDiagnostics = await read("JSON.stringify({active:document.activeElement?.outerHTML,focused:document.hasFocus(),events:orderKeyEvents})");
    assert.ok(await read("orderKeyEvents.some(event => event.kind === 'keypress')"), 'Keyboard simulation must include the character event');
    assert.equal(await read('JSON.stringify(draftSelection)'), JSON.stringify([initial[1],initial[2],initial[0],...initial.slice(3)]), keyDiagnostics);
    assert.equal(await read('JSON.stringify(state.selectedModelIds)'), saved);
    assert.ok(await read("document.querySelector('#modelSelectionStatus').textContent.includes('未保存')"));
    await screenshot('model-order-controls');
    await click('#discardModelSelection');
    await click('#modelSelectedDetails > summary');
  });
  await check('clearing the model draft exposes an empty status and discard restores the list', async () => {
    const saved = await read('JSON.stringify(state.selectedModelIds)');
    const count = await read('draftSelection.length');
    if (!(await read("document.querySelector('#modelSelectedDetails').open"))) await click('#modelSelectedDetails > summary');
    try {
      for (let index = 0; index < count; index++) await click('[data-remove-selected-slot="0"]');
      assert.equal(await read('draftSelection.length'), 0);
      assert.equal(await read("document.querySelector('#selectedModels').getAttribute('role')"), 'status');
      assert.equal(await read("document.querySelectorAll('#selectedModels [role=\"listitem\"]').length"), 0);
      assert.ok(await read("document.querySelector('#selectedModels').textContent.includes('至少选择一个模型')"));
      assert.equal(await read('JSON.stringify(state.selectedModelIds)'), saved);
    } finally {
      await click('#discardModelSelection');
      await click('#modelSelectedDetails > summary');
    }
    assert.equal(await read('JSON.stringify(draftSelection)'), saved);
    assert.equal(await read("document.querySelector('#selectedModels').getAttribute('role')"), 'list');
    assert.equal(await read("document.querySelectorAll('#selectedModels [role=\"listitem\"]').length"), count);
  });
  await check('model draft status, discard, and search do not persist unintended selection', async () => {
    const before = await read("JSON.stringify(state.selectedModelIds)");
    await click('#modelPool .model-card:not(.selected)');
    assert.ok(await read("document.querySelector('#modelSelectionStatus')?.textContent.includes('未保存')"));
    await show('stats'); await show('models');
    assert.ok(await read("document.querySelector('#modelSelectionStatus')?.textContent.includes('未保存')"));
    assert.equal(await read("JSON.stringify(state.selectedModelIds)"), before);
    const draft = await read('JSON.stringify(draftSelection)');
    await show('stats');
    if (!(await read("document.querySelector('#usageBudgetDetails').open"))) await click('#usageBudgetDetails > summary');
    await click('#saveUsageBudgets');
    await waitUntil("!document.querySelector('#saveUsageBudgets').classList.contains('loading')");
    await show('settings');
    await click('#saveDesktopOptions');
    await waitUntil("!document.querySelector('#saveDesktopOptions').classList.contains('loading')");
    await show('models');
    assert.equal(await read('JSON.stringify(draftSelection)'), draft, 'Saving another page discarded the model draft');
    assert.ok(await read("document.querySelector('#modelSelectionStatus').textContent.includes('未保存')"));
    await screenshot('models-unsaved');
    const notificationClear = await read(`(() => {
      const notice = document.querySelector('#toast');
      if (!notice.getClientRects().length) return true;
      return notice.getBoundingClientRect().bottom <= document.querySelector('.model-selection-actions').getBoundingClientRect().top;
    })()`);
    assert.equal(notificationClear, true, 'Success notification covers the model action footer');
    await click('#discardModelSelection');
    assert.equal(await read("JSON.stringify(draftSelection)"), before);
    await click('#modelSelectedDetails > summary');
    assert.ok(await read("document.querySelector('#selectedModels .slot-card').getBoundingClientRect().height > 0"));
    await click('#modelSelectedDetails > summary');
    await click('#modelSearch');
    await wc.insertText('terra');
    await settle();
    assert.ok(await read("[...document.querySelectorAll('#modelPool .model-card')].every(node => /terra/i.test(node.textContent)) && document.querySelectorAll('#modelPool .model-card').length > 0"));
    assert.equal(await read("JSON.stringify(draftSelection)"), before);
    await click('#clearModelSearch');
    assert.equal(await read("document.querySelector('#modelSearch').value"), '');
    assert.ok(await read("document.querySelector('#modelSelectionStatus')?.textContent.includes('已保存')"));
  });
  await check('provider selection and editor return retain the model catalog', async () => {
    await click('[data-provider-preview="deepseek"]');
    assert.ok(await read("document.querySelector('#modelPool').textContent.includes('DeepSeek')"));
    await click('[data-provider-edit="deepseek"]');
    assert.ok(await read("document.querySelector('.provider-editor-panel').getBoundingClientRect().height > 0"));
    await screenshot('provider-editor');
    const back = await read(`(() => {
      const control = document.querySelector('.provider-editor-panel [data-back-model-catalog]');
      const rect = control.getBoundingClientRect();
      return {top:rect.top, bottom:rect.bottom, headerBottom:document.querySelector('.topbar').getBoundingClientRect().bottom};
    })()`);
    assert.ok(back.top >= back.headerBottom, 'Sticky header obscures provider return control: ' + JSON.stringify(back));
    await click('[data-back-model-catalog]');
    assert.ok(await read("document.querySelector('#modelPool .model-card').getBoundingClientRect().height > 0"));
  });
  await check('searching a standard provider works after returning from the custom-model editor', async () => {
    await click('[data-open-custom-editor]');
    await click('.custom-editor-panel [data-back-model-catalog]');
    await click('#modelSearch');
    await wc.insertText('deepseek');
    await settle();
    assert.ok(await read("document.querySelectorAll('#modelPool .model-card').length > 0 && document.querySelector('#modelPool').textContent.includes('DeepSeek')"));
    await click('#clearModelSearch');
  });
  await show('resources');
  await check('resource reset clears search, status and hidden source even while writes are unavailable', async () => {
    await waitUntil("loadedDetailSections.has('resources')");
    const originalResources = await read('JSON.stringify(state.codexResources)');
    const originalCount = await read("document.querySelectorAll('#resourceList .resource-item').length");
    assert.ok(originalCount > 0);
    assert.equal(await read('els.clearResourceFilters?.disabled'), true);
    await click('#resourceSearch');
    await wc.insertText('预览不存在的资源 <test>');
    await read("els.resourceStatusFilter.value='issues'; els.resourceStatusFilter.dispatchEvent(new Event('change',{bubbles:true})); els.resourceSourceFilter.value='cached'; els.resourceSourceFilter.dispatchEvent(new Event('change',{bubbles:true}))");
    await settle();
    assert.equal(await read("document.querySelector('.resource-advanced-controls').open"), false);
    assert.ok(await read("els.resourceFilterStatus.textContent.includes('本地缓存') && els.resourceFilterStatus.textContent.includes('只看提醒/失败')"));
    assert.equal(await read('els.resourceFilterStatus.children.length'), 0);
    await screenshot('resources-active-filters');
    await read('globalThis.previousResourceAvailability=state.stateUnavailable; state.stateUnavailable=true; applyStateUnavailableWriteGuard(document,true)');
    try {
      assert.equal(await read('els.clearResourceFilters.disabled'), false);
      await click('#clearResourceFilters');
      assert.equal(await read('resourceFilterText'), '');
      assert.equal(await read('resourceStatusFilter'), 'all');
      assert.equal(await read('resourceSourceFilter'), 'all');
      assert.equal(await read('els.resourceSourceFilter.value'), 'all');
      assert.equal(await read('els.resourceFilterStatus.hidden'), true);
      assert.equal(await read('els.clearResourceFilters.disabled'), true);
      assert.equal(await read('document.activeElement.id'), 'resourceSearch');
      assert.equal(await read("document.querySelectorAll('#resourceList .resource-item').length"), originalCount);
      assert.equal(await read('JSON.stringify(state.codexResources)'), originalResources);
    } finally { await read('state.stateUnavailable=previousResourceAvailability; applyStateUnavailableWriteGuard(document,false)'); }
  });
  await check('compact usage rows retain full data and request details', async () => {
    await show('stats');
    const entry = {route:'ui-review-model',upstreamModel:'ui-upstream-model',api:'responses',requestId:'ui-review-request',
      calls:3,totalTokens:42,promptTokens:30,completionTokens:12,cacheReadTokens:5,cacheCreationTokens:7,
      durationMs:1234,status:'succeeded',statusCode:200,lastAt:'2026-09-09T10:00:00Z',finishedAt:'2026-09-09T10:00:00Z'};
    const renderFixture = `renderUsageTableStable(${JSON.stringify([entry])}, ${JSON.stringify([entry])})`;
    await read(renderFixture);
    assert.equal(await read("document.querySelector('#usageFullDetails').open"), false);
    assert.ok(await read("[...document.querySelectorAll('.usage-compact-table')].every(table => table.scrollWidth <= table.clientWidth + 1)"));
    const visibleTokens = await read("[...document.querySelectorAll('.usage-compact-table')].map(table => ({headers:[...table.querySelectorAll('th')].map(x=>x.textContent),values:[...table.querySelectorAll('tbody tr:first-child .usage-token-cell')].map(x=>x.childNodes[0].textContent),cache:table.querySelector('tbody tr:first-child .usage-token-cell:last-of-type')?.textContent}))");
    for (const table of visibleTokens) {
      assert.deepEqual(table.headers.slice(2,6), ['总 Token','输入 Token','输出 Token','缓存 Token']);
      assert.deepEqual(table.values, ['42','30','12','12']);
    }
    assert.ok(await read("[...document.querySelectorAll('.usage-compact-table tbody tr:first-child')].every(row => row.textContent.includes('读 5') && row.textContent.includes('写 7'))"));
    const statsSize=win.getSize();
    try {
      for (const size of [[1440,900],[980,640]]) {
        win.setSize(...size); await settle();
        assert.ok(await read("[...document.querySelectorAll('.usage-compact-scroll')].every(el => el.clientWidth > 0 && el.getBoundingClientRect().right <= innerWidth && el.scrollWidth >= el.clientWidth)"));
        assert.ok(await read("document.querySelector('.main').scrollWidth <= document.querySelector('.main').clientWidth + 1"));
        assert.ok(await read("[...document.querySelectorAll('.usage-compact-table .usage-token-cell')].every(el => el.scrollWidth <= el.clientWidth + 1)"));
        await read("document.querySelector('.usage-compact-table').scrollIntoView({block:'center'})");
        await settle();
        await screenshot('stats-tokens-'+size[0]);
      }
    } finally { win.setSize(...statsSize); await settle(); }
    await screenshot('stats-controlled-data');
    await click('.usage-compact-table [data-request-detail]');
    assert.ok(await read("document.querySelector('#requestDetailBody').textContent.includes('ui-upstream-model')"));
    await click('#closeRequestDetail');
    await click('#usageFullDetails > summary');
    assert.ok(await read("document.querySelector('#usageFullDetails').textContent.includes('ui-upstream-model') && document.querySelector('#usageFullDetails').textContent.includes('写 7')"));
    await read(renderFixture);
    assert.equal(await read("document.querySelector('#usageFullDetails').open"), true);
    await show('resources');
  });
  await show('sessions');
  await waitUntil("loadedDetailSections.has('sessions')");
  await check('session search shows matching counts without changing the source or export scope', async () => {
    await read(`globalThis.previousSessionView = {tree:state.codexSessionTree,sessions:state.codexSessions};
      globalThis.reviewSessions = [
        {id:'ui-session-a',title:'安装界面优化',model:'gpt-6-astra',modelProvider:'GPT',updatedAt:'2026-09-09T10:00:00Z'},
        {id:'ui-session-b',title:'路由日志排查',model:'deepseek-v4-flash',modelProvider:'DeepSeek',updatedAt:'2026-09-09T09:00:00Z'},
        {id:'ui-session-c',title:'帮助说明',model:'gpt-5.6-terra',modelProvider:'GPT',updatedAt:'2026-09-09T08:00:00Z'}
      ];
      state.codexSessions = reviewSessions;
      state.codexSessionTree = {projects:[{key:'ui-project',name:'界面项目',path:'F:/ui-preview/project',active:true,sessions:reviewSessions.slice(0,2)}],looseSessions:reviewSessions.slice(2),sessions:reviewSessions};
      globalThis.originalSessionTree = JSON.stringify(state.codexSessionTree);
      renderSessions();`);
    try {
      assert.equal(await read("document.querySelector('#sessionSearchCount')?.textContent"), '1 个项目 · 3 个会话');
      assert.equal(await read("document.querySelector('.session-diagnostics').open"), false);
      assert.ok(await read("document.querySelector('.session-folder').getBoundingClientRect().top < innerHeight - 120"));
      await screenshot('sessions-controlled-data');
      await click('#sessionSearch');
      await wc.insertText('DeepSeek'); await settle();
      assert.equal(await read("document.querySelector('#sessionSearchCount').textContent"), '1 个项目 · 1 个会话');
      assert.equal(await read("document.querySelector('[data-export-filtered-sessions]').disabled"), false);
      await click('.session-diagnostics > summary');
      assert.ok(await read("document.querySelector('.session-diagnostics').textContent.includes('原始线程总数')"));
      await click('#clearSessionSearch');
      assert.equal(await read("document.activeElement.id"), 'sessionSearch');
      assert.equal(await read("document.querySelector('.session-diagnostics').open"), true);
      await wc.insertText('no-matching-session-ui-review'); await settle();
      assert.equal(await read("document.querySelector('#sessionSearchCount').textContent"), '0 个项目 · 0 个会话');
      assert.equal(await read("document.querySelector('[data-export-filtered-sessions]').disabled"), true);
      assert.equal(await read("document.querySelector('[data-export-all-sessions]').disabled"), false);
      await click('#clearSessionSearch');
      assert.equal(await read("document.querySelector('#sessionSearchCount').textContent"), '1 个项目 · 3 个会话');
      assert.equal(await read("document.querySelector('#clearSessionSearch').disabled"), true);
      assert.equal(await read('JSON.stringify(state.codexSessionTree) === originalSessionTree'), true);
    } finally {
      await read("state.codexSessionTree = previousSessionView.tree; state.codexSessions = previousSessionView.sessions; sessionSearchText = ''; els.sessionSearch.value = ''; renderSessions()");
    }
  });
  await show('logs');
  await check('reading old logs pauses scrolling, survives navigation and can resume explicitly', async () => {
    const previous = await read('JSON.stringify(state.logs)');
    try {
      await read("logFollowLatest = true; state.logs = Array.from({length:160},(_,i) => '[10:00:00] Test log ' + i); renderLogs(state.logs)");
      await settle();
      await read("globalThis.logWheelTrace = {before:els.logOutput.scrollTop}; globalThis.logWheelListener = event => Object.assign(logWheelTrace,{deltaY:event.deltaY,target:event.target.id}); document.addEventListener('wheel',logWheelListener,{capture:true,once:true})");
      const point = await read("(() => { const r=els.logOutput.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()");
      // Electron native wheel deltas have the opposite sign to DOM WheelEvent.deltaY.
      wc.sendInputEvent({type:'mouseWheel',...point,deltaX:0,deltaY:360,canScroll:true});
      // Synchronize on observable scroll/follow behavior; wheel tracing is diagnostic only.
      await waitUntil('els.logOutput.scrollTop < logWheelTrace.before && !logFollowLatest');
      const wheelTrace = await read("JSON.stringify({...logWheelTrace,top:els.logOutput.scrollTop,height:els.logOutput.scrollHeight,visible:els.logOutput.clientHeight})");
      assert.ok(await read('els.logOutput.scrollTop < logWheelTrace.before'), 'Expected the log view to scroll upward: ' + wheelTrace);
      assert.equal(await read('logFollowLatest'), false, wheelTrace);
      const pausedTop = await read('els.logOutput.scrollTop');
      assert.ok(pausedTop > 0);
      assert.equal(await read('els.resumeLogFollow.hidden'), false);
      await read("state.logs.push('[10:00:01] New line <not markup>'); renderLogs(state.logs)");
      await settle();
      assert.ok(Math.abs(await read('els.logOutput.scrollTop') - pausedTop) <= 1);
      assert.equal(await read('els.logOutput.children.length'), 0);
      await screenshot('logs-reading-history');
      await show('stats');
      await read("state.logs.push('[10:00:02] New line while away'); renderLogs(state.logs)");
      await show('logs');
      assert.ok(Math.abs(await read('els.logOutput.scrollTop') - pausedTop) <= 1);
      await click('#resumeLogFollow');
      assert.ok(await read('els.logOutput.scrollHeight - els.logOutput.clientHeight - els.logOutput.scrollTop <= 1'));
      assert.equal(await read('document.activeElement.id'), 'logOutput');
      assert.equal(await read('els.resumeLogFollow.hidden'), true);
      await read('globalThis.logTextNode = els.logOutput.firstChild; renderLogs(state.logs)');
      assert.equal(await read('els.logOutput.firstChild === logTextNode'), true);
    } finally {
      await read(`document.removeEventListener('wheel',globalThis.logWheelListener,true); state.logs = ${previous}; logFollowLatest = true; renderLogs(state.logs)`);
    }
  });
  await show('settings');
  await check('settings drafts survive a real refresh and navigation without saving and can be discarded', async () => {
    const saved = await read('JSON.stringify(state.desktopOptions)');
    const before = await read("JSON.stringify(Object.fromEntries([...document.querySelectorAll('#settingsGeneral input[id],#settingsGeneral select[id]')].map(node => [node.id,node.type==='checkbox'?node.checked:node.value])))");
    await read(`els.routerPort.value='15789'; els.routerPort.dispatchEvent(new Event('input',{bubbles:true}));
      els.bypassSystemProxy.checked=!els.bypassSystemProxy.checked; els.bypassSystemProxy.dispatchEvent(new Event('change',{bubbles:true}));
      els.smartCodeMode.value='route'; els.smartCodeMode.dispatchEvent(new Event('change',{bubbles:true}));
      els.smartCodeRoute.value=els.smartCodeRoute.options[els.smartCodeRoute.options.length-1].value; els.smartCodeRoute.dispatchEvent(new Event('change',{bubbles:true}));
      els.codexAuxiliaryModelId.value=els.codexAuxiliaryModelId.options[els.codexAuxiliaryModelId.options.length-1].value; els.codexAuxiliaryModelId.dispatchEvent(new Event('change',{bubbles:true}));
      globalThis.expectedSettingsDraft={port:els.routerPort.value,proxy:els.bypassSystemProxy.checked,mode:els.smartCodeMode.value,route:els.smartCodeRoute.value,aux:els.codexAuxiliaryModelId.value};`);
    try {
      await show('stats');
      await read('refresh({lite:true})');
      await show('settings');
      assert.equal(await read('els.routerPort.value'), '15789');
      assert.equal(await read('els.bypassSystemProxy.checked === expectedSettingsDraft.proxy'), true);
      assert.equal(await read('els.smartCodeMode.value'), 'route');
      assert.equal(await read('els.smartCodeRoute.value === expectedSettingsDraft.route'), true);
      assert.equal(await read('els.codexAuxiliaryModelId.value === expectedSettingsDraft.aux'), true);
      assert.ok(await read("els.desktopSettingsDraftStatus.textContent.includes('未保存')"));
      assert.equal(await read('JSON.stringify(state.desktopOptions)'), saved);
      await screenshot('settings-unsaved-draft');
      await click('#discardDesktopSettings');
      const after = await read("JSON.stringify(Object.fromEntries([...document.querySelectorAll('#settingsGeneral input[id],#settingsGeneral select[id]')].map(node => [node.id,node.type==='checkbox'?node.checked:node.value])))");
      assert.equal(after, before);
      assert.equal(await read('els.discardDesktopSettings.disabled'), true);
      await read("globalThis.originalSettingsOptions=state.desktopOptions; state={...state,desktopOptions:{...state.desktopOptions,routerPort:15801}}; render()");
      assert.equal(await read('els.routerPort.value'), '15801', 'A clean form did not follow the new saved value');
      await read('state={...state,desktopOptions:originalSettingsOptions}; render()');
    } finally {
      await read(`if(typeof desktopSettingsDraft !== 'undefined') desktopSettingsDraft.clear();
        state={...state,desktopOptions:${saved}}; render();`);
    }
  });
  await check('an incomplete native number survives refresh as invalid instead of saving the default', async () => {
    await show('settings');
    const saved = await read('JSON.stringify(state.desktopOptions)');
    const original = await read('els.routerPort.value');
    try {
      await click('#routerPort');
      wc.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});
      wc.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});
      await settle();
      await wc.insertText('1e'); await settle();
      assert.equal(await read('els.routerPort.validity.badInput'), true);
      await click('[data-settings-jump="settingsProfiles"]');
      await read('refresh({lite:true})');
      assert.equal(await read('els.routerPort.validity.badInput'), true);
      await click('#saveDesktopOptions');
      await waitUntil("!els.saveDesktopOptions.classList.contains('loading')");
      assert.equal(await read('els.routerPortError.hidden'), false);
      assert.equal(await read('JSON.stringify(state.desktopOptions)'), saved);
      await click('#discardDesktopSettings');
      assert.equal(await read('els.routerPort.validity.badInput'), false);
      assert.equal(await read('els.routerPortError.hidden'), true);
      assert.equal(await read('els.routerPort.value'), original);
    } finally {
      await read(`desktopSettingsDraft.clear(); els.routerPort.value=${JSON.stringify(original)}; els.routerPort.dispatchEvent(new Event('input',{bubbles:true})); render()`);
    }
  });
  await check('sidebar navigation retains independent reading positions and top reset is read-only', async () => {
    win.setSize(980,640); await settle();
    await show('resources');
    await waitUntil("!loadingDetailSections.has('resources')");
    if (!(await read("document.querySelector('#resourceList .resource-diagnostics').open"))) await click('#resourceList .resource-diagnostics > summary');
    const saved = await read('JSON.stringify(state.desktopOptions)');
    await read("document.querySelector('.main').scrollTop=180"); await settle();
    const resourcesTop = await read("document.querySelector('.main').scrollTop");
    assert.ok(resourcesTop > 64, 'The resource fixture must have actual scrollable content');
    await show('settings');
    await read("document.querySelector('#settings > .action-page-scroll').scrollTop=280"); await settle();
    const settingsTop = await read("document.querySelector('#settings > .action-page-scroll').scrollTop");
    assert.ok(settingsTop > 64);
    await show('resources');
    await waitUntil("!loadingDetailSections.has('resources')");
    assert.ok(Math.abs(await read("document.querySelector('.main').scrollTop") - resourcesTop) <= 2);
    assert.equal(await read("document.querySelector('#resourceList .resource-diagnostics').open"), true);
    await show('settings');
    assert.ok(Math.abs(await read("document.querySelector('#settings > .action-page-scroll').scrollTop") - settingsTop) <= 2);
    assert.equal(await read('els.backToPageTop.hidden'), false);
    await screenshot('reading-position-restored');
    await read('globalThis.previousReadingAvailability=state.stateUnavailable; state.stateUnavailable=true; applyStateUnavailableWriteGuard(document,true)');
    try {
      assert.equal(await read('els.backToPageTop.disabled'), false);
      await click('#backToPageTop');
      assert.equal(await read("document.querySelector('#settings > .action-page-scroll').scrollTop"), 0);
      assert.equal(await read('document.activeElement.id'), 'pageTitle');
      assert.equal(await read('els.backToPageTop.hidden'), true);
    } finally { await read('state.stateUnavailable=previousReadingAvailability; applyStateUnavailableWriteGuard(document,false)'); }
    await show('resources');
    await show('settings');
    assert.equal(await read("document.querySelector('#settings > .action-page-scroll').scrollTop"), 0);
    await read("activateSection('resources')"); await settle();
    assert.equal(await read("document.querySelector('.main').scrollTop"), 0, 'Explicit programmatic navigation should retain its original top positioning');
    assert.equal(await read('JSON.stringify(state.desktopOptions)'), saved);
    for (const section of ['logs','softwareManager']) {
      await show(section);
      assert.equal(await read('els.backToPageTop.hidden'), true);
    }
  });
  const pressDialogKey = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({type:'keyDown',keyCode,modifiers});
    if (keyCode === 'Enter') wc.sendInputEvent({type:'char',keyCode,modifiers});
    wc.sendInputEvent({type:'keyUp',keyCode,modifiers});
    await settle();
  };
  for (const size of quick ? [[980,640]] : [[980,640],[1180,760],[1440,900]]) {
    win.setSize(...size); await settle();
    for (const kind of ['request','resource']) {
      const dialogId = kind === 'request' ? 'requestDetailDialog' : 'resourceDetailDialog';
      const closeId = kind === 'request' ? 'closeRequestDetail' : 'closeResourceDetail';
      const bodyId = kind === 'request' ? 'requestDetailBody' : 'resourceDetailBody';
      await show(kind === 'request' ? 'stats' : 'resources');
      await check(`${size[0]} ${kind} details: long content scrolls independently and focus returns to the launcher`, async () => {
        const longText = Array.from({length:80},(_,index) => `第 ${index + 1} 行诊断内容 <test>，用于检查完整显示和正文滚动。`).join('\n');
        const opener = kind === 'request' ? '.usage-compact-table [data-request-detail]' : '#resourceList [data-resource-detail]';
        if (kind === 'request') {
          const entry = {requestId:'ui-dialog-request',route:'界面测试模型',upstreamModel:'ui-upstream-model',status:'failed',api:'responses',error:longText,totalTokens:42,durationMs:1234};
          await read(`renderUsageTableStable([],${JSON.stringify([entry])})`);
        }
        await read(`globalThis.dialogLauncher=document.querySelector(${JSON.stringify(opener)})`);
        await click(opener);
        try {
          if (kind === 'resource') await read(`showResourceDetail({key:'skills',label:'资源详情测试',item:{id:'ui-dialog-resource',name:'测试技能',description:${JSON.stringify(longText)},diagnostic:{status:'warn',label:'测试提示',detail:${JSON.stringify(longText)}}}})`);
          assert.equal(await read('document.activeElement.id'), closeId);
          await read("document.querySelector('[data-section=\"settings\"]').focus()");
          assert.equal(await read(`document.querySelector('#${dialogId}').contains(document.activeElement)`), true, 'Focus escaped to background controls');
          await pressDialogKey('Tab');
          assert.equal(await read(`document.querySelector('#${dialogId}').contains(document.activeElement) || document.activeElement === document.body`), true);
          const layout = await read(`(() => {
            const body=document.querySelector('#${bodyId}'); body.scrollTop=body.scrollHeight;
            const close=document.querySelector('#${closeId}').getBoundingClientRect();
            return {overflow:body.scrollHeight>body.clientHeight,closeTop:close.top,closeBottom:close.bottom,height:innerHeight,
              hit:document.elementFromPoint(close.x+close.width/2,close.y+close.height/2)?.closest('button')?.id,
              horizontal:body.scrollWidth-body.clientWidth,markup:body.querySelector('test')!==null,complete:body.textContent.includes('第 80 行')};
          })()`);
          assert.equal(layout.overflow, true);
          assert.equal(layout.hit, closeId);
          assert.ok(layout.closeTop >= 0 && layout.closeBottom < layout.height && layout.horizontal <= 1, JSON.stringify(layout));
          assert.equal(layout.markup, false);
          assert.equal(layout.complete, true);
          if (size[0] === 980) await screenshot(kind + '-details-long');
          await pressDialogKey('Escape');
          assert.equal(await read(`document.querySelector('#${dialogId}').classList.contains('hidden')`), true);
          assert.equal(await read('document.activeElement === dialogLauncher'), true);
        } finally { await read(kind === 'request' ? 'hideRequestDetail()' : 'hideResourceDetail()'); }
      });
    }
    await check(`${size[0]} confirmations: cancellation stays visible for long messages and Enter defaults to cancel`, async () => {
      await read("els.resourceSearch.focus(); globalThis.confirmResult='pending'; void showConfirmDialog({title:'测试确认 <test> ' + 'T'.repeat(90),message:'这是隔离测试，不会执行实际操作。'.repeat(100)}).then(value => {confirmResult=value})");
      try {
        assert.equal(await read("document.activeElement.matches('[data-confirm-cancel]')"), true);
        const layout = await read(`(() => {
          const cancel=document.querySelector('[data-confirm-cancel]').getBoundingClientRect();
          const heading=document.querySelector('.runtime-confirm-dialog h2');
          return {top:cancel.top,bottom:cancel.bottom,height:innerHeight,titleOverflow:heading.scrollWidth-heading.clientWidth,hit:document.elementFromPoint(cancel.x+cancel.width/2,cancel.y+cancel.height/2)?.closest('button')?.hasAttribute('data-confirm-cancel')};
        })()`);
        assert.ok(layout.top >= 0 && layout.bottom <= layout.height, JSON.stringify(layout));
        assert.equal(layout.hit, true);
        assert.ok(layout.titleOverflow <= 1, JSON.stringify(layout));
        if (size[0] === 980) await screenshot('confirmation-long');
        await pressDialogKey('Enter');
        assert.equal(await read('confirmResult'), false);
        assert.equal(await read('document.activeElement.id'), 'resourceSearch');
      } finally { if (await read("!!document.querySelector('[data-confirm-cancel]')")) await click('[data-confirm-cancel]'); }
    });
  }
  await check('cancelling a real action restores its re-enabled launcher without updating resources', async () => {
    await show('resources');
    const original = await read('JSON.stringify(state.codexResources)');
    if (!(await read("document.querySelector('.resource-advanced-controls').open"))) await click('.resource-advanced-controls > summary');
    await click('#refreshPluginMarketplaces');
    try {
      assert.equal(await read('els.refreshPluginMarketplaces.disabled'), true);
      await pressDialogKey('Escape');
      await waitUntil("!els.refreshPluginMarketplaces.disabled && !document.querySelector('.runtime-confirm-backdrop')");
      assert.equal(await read('document.activeElement.id'), 'refreshPluginMarketplaces');
      assert.equal(await read('JSON.stringify(state.codexResources)'), original);
    } finally {
      if (await read("!!document.querySelector('[data-confirm-cancel]')")) await click('[data-confirm-cancel]');
      if (await read("document.querySelector('.resource-advanced-controls').open")) await click('.resource-advanced-controls > summary');
    }
  });
  await check('confirmation Escape affects only the top modal and explicit confirmation still returns true', async () => {
    await read("els.resourceSearch.focus(); showRequestDetail({requestId:'ui-stacked',route:'只读测试',totalTokens:1}); globalThis.confirmResult='pending'; void showConfirmDialog({title:'嵌套确认',message:'取消只关闭当前确认框。'}).then(value => {confirmResult=value})");
    try {
      await pressDialogKey('Escape');
      assert.equal(await read('confirmResult'), false);
      assert.equal(await read("els.requestDetailDialog.classList.contains('hidden')"), false);
      assert.equal(await read('document.activeElement.id'), 'closeRequestDetail');
      await read("globalThis.confirmResult='pending'; void showConfirmDialog({title:'确认结果测试',message:'这里只检查返回结果，不执行操作。'}).then(value => {confirmResult=value})");
      await click('[data-confirm-ok]');
      assert.equal(await read('confirmResult'), true);
    } finally {
      if (await read("!!document.querySelector('[data-confirm-cancel]')")) await click('[data-confirm-cancel]');
      await read('hideRequestDetail()');
    }
  });
  for (const outcome of ['cached', 'rejected', 'authoritative']) {
    await check(`resource refresh ${outcome}: feedback reflects the actual read result`, async () => {
      await show('resources');
      await waitUntil("!loadingDetailSections.has('resources')");
      const snapshot = JSON.parse(await read('JSON.stringify(state)'));
      const previousList = await read('els.resourceList.textContent');
      const previousOptions = await read('JSON.stringify(state.desktopOptions)');
      const reply = structuredClone(snapshot);
      reply.codexResources.snapshot = {...reply.codexResources.snapshot,state:outcome,refreshedAt:'2026-09-10T05:00:00Z'};
      if (reply.codexResources.pluginPage) reply.codexResources.pluginPage.snapshot = {...reply.codexResources.pluginPage.snapshot,...reply.codexResources.snapshot};
      let finishRead;
      let readCount = 0;
      resourceStateReadOverride = () => {
        readCount += 1;
        return new Promise((resolve,reject) => { finishRead = () => outcome === 'rejected' ? reject(new Error('UI fixture: resource read failed')) : resolve(reply); });
      };
      await read("hideToast(); els.toast.querySelector('[data-toast-message]').textContent=''");
      try {
        await click('#refreshResources');
        assert.equal(readCount, 1);
        finishRead();
        await waitUntil("!els.refreshResources.disabled && !loadingDetailSections.has('resources')");
        const status = await read('els.resourceRefreshStatus.textContent');
        const toast = await read('els.toast.textContent');
        if (outcome === 'authoritative') {
          assert.match(status, /已刷新/);
          assert.match(toast, /已刷新/);
        } else {
          assert.match(status, /无法刷新|未能刷新|刷新失败/);
          assert.doesNotMatch(toast, /已刷新/);
          assert.equal(await read('els.resourceList.textContent'), previousList);
          await screenshot(`resource-refresh-${outcome}`);
        }
        assert.equal(await read('JSON.stringify(state.desktopOptions)'), previousOptions);
      } finally {
        finishRead?.();
        resourceStateReadOverride = null;
        await waitUntil("!els.refreshResources.classList.contains('loading')");
        await read(`adoptStateSnapshot(${JSON.stringify(snapshot)}); render()`);
      }
    });
  }
  await check('resource pending feedback survives a filter redraw without replacing the list', async () => {
    await show('resources');
    await waitUntil("!loadingDetailSections.has('resources')");
    const snapshot = JSON.parse(await read('JSON.stringify(state)'));
    let finishRead;
    let readCount = 0;
    resourceStateReadOverride = () => { readCount += 1; return new Promise(resolve => { finishRead = () => resolve(snapshot); }); };
    try {
      const previousList = await read('els.resourceList.textContent');
      await click('#refreshResources');
      await read('renderResources()');
      assert.match(await read('els.resourceRefreshStatus.textContent'), /正在刷新/);
      assert.equal(await read('els.refreshResources.disabled'), true);
      assert.equal(await read('els.resourceList.textContent'), previousList);
      await read("els.refreshResources.click(); void ensureDetailedStateForSection('resources')");
      assert.equal(readCount, 1, 'Pending resource reads must not be submitted twice');
    } finally {
      finishRead?.();
      resourceStateReadOverride = null;
      await waitUntil("!els.refreshResources.classList.contains('loading') && !loadingDetailSections.has('resources')");
    }
  });
  for (const kind of ['request','resource']) {
    await check(`${kind} detail restores keyboard focus after its opener was redrawn`, async () => {
      await show(kind === 'request' ? 'stats' : 'resources');
      if (kind === 'resource') await waitUntil("!loadingDetailSections.has('resources')");
      const opener = kind === 'request' ? '.usage-compact-table [data-request-detail]' : '#resourceList [data-resource-detail]';
      const request = {requestId:'ui-focus-retained',route:'界面测试模型',status:'success',api:'responses',totalTokens:42,durationMs:1234};
      const previousFilter = await read('resourceFilterText');
      if (kind === 'request') await read(`renderUsageTableStable([],${JSON.stringify([request])})`);
      await click(opener);
      try {
        await read(kind === 'request' ? `renderUsageTableStable([],${JSON.stringify([request])})` : 'renderResources()');
        await pressDialogKey('Escape');
        assert.equal(await read(`document.activeElement.matches(${JSON.stringify(opener)})`), true);
        await click(opener);
        await read(kind === 'request' ? 'renderUsageTableStable([],[])' : "resourceFilterText='ui-no-resource-focus-match'; renderResources()");
        await pressDialogKey('Escape');
        assert.equal(await read('document.activeElement.id'), 'pageTitle', 'A removed item should return focus to the safe page heading');
      } finally {
        await read(kind === 'request' ? 'hideRequestDetail(); renderUsage()' : `hideResourceDetail(); resourceFilterText=${JSON.stringify(previousFilter)}; renderResources()`);
      }
    });
  }
  await check('request details opened from full fields return to that view after a redraw', async () => {
    await show('stats');
    const request = {requestId:'ui-full-fields-focus',route:'界面测试模型',status:'success',api:'responses',totalTokens:42,durationMs:1234};
    const renderRows = () => read(`renderUsageTableStable([],${JSON.stringify([request])})`);
    try {
      await renderRows();
      await read("document.querySelector('#usageFullDetails').open=true");
      await click('#usageFullDetails [data-request-detail]');
      await renderRows();
      await pressDialogKey('Escape');
      assert.equal(await read("document.activeElement.matches('#usageFullDetails [data-request-detail]')"), true);
    } finally { await read('hideRequestDetail(); renderUsage()'); }
  });
  await check('resource detail returns to the same item after another resource is inserted before it', async () => {
    await show('resources');
    await waitUntil("!loadingDetailSections.has('resources')");
    const existing = {id:'ui-stable-focus',name:'原有应用'};
    const inserted = {id:'ui-new-app',name:'新增应用'};
    const renderRows = async rows => read(`resourceDetailItems.clear(); els.resourceList.innerHTML=resourceBlock('测试应用',${JSON.stringify(rows)},resourceShortLabel,'apps'); bindResourceActionButtons()`);
    try {
      await renderRows([existing]);
      await click('#resourceList [data-resource-detail]');
      await renderRows([inserted,existing]);
      await pressDialogKey('Escape');
      assert.equal(await read("resourceDetailItems.get(document.activeElement.getAttribute('data-resource-detail'))?.item.id"), 'ui-stable-focus');
    } finally { await read('hideResourceDetail(); renderResources()'); }
  });
  for (const outcome of ['stale','unavailable','valid']) {
    await check(`basic settings ${outcome} receipt: edits clear only after confirmed saving`, async () => {
      await show('settings');
      const snapshot = JSON.parse(await read('JSON.stringify(state)'));
      const port = Number(snapshot.desktopOptions.routerPort) === 15817 ? 15818 : 15817;
      basicSettingsSaveOverride = async (_event,options) => ({...snapshot,
        ...(outcome === 'unavailable' ? {stateUnavailable:true} : {}),
        desktopOptions:outcome === 'stale' ? snapshot.desktopOptions : {...snapshot.desktopOptions,...options}});
      try {
        await read(`els.routerPort.value=${JSON.stringify(String(port))}; els.routerPort.dispatchEvent(new Event('input',{bubbles:true}));
          els.bypassSystemProxy.checked=!els.bypassSystemProxy.checked; els.bypassSystemProxy.dispatchEvent(new Event('change',{bubbles:true}));`);
        await click('#saveDesktopOptions');
        await waitUntil("!els.saveDesktopOptions.classList.contains('loading')");
        assert.equal(await read('els.routerPort.value'),String(port));
        if (outcome === 'valid') {
          assert.equal(await read('state.desktopOptions.routerPort'),port);
          assert.equal(await read('desktopSettingsDraft.size'),0);
        } else {
          assert.equal(await read('JSON.stringify(state.desktopOptions)'),JSON.stringify(snapshot.desktopOptions));
          assert.equal(await read('state.stateUnavailable'),snapshot.stateUnavailable);
          assert.ok(await read('desktopSettingsDraft.size > 0'));
          assert.match(await read('els.toast.textContent'),/无法确认/);
          if(outcome === 'unavailable') await screenshot('unconfirmed-settings-retained');
        }
      } finally {
        basicSettingsSaveOverride=null;
        await read(`desktopSettingsDraft.clear(); adoptStateSnapshot(${JSON.stringify(snapshot)}); render()`);
      }
    });
    await check(`model selection ${outcome} receipt: chosen order is not discarded by an unconfirmed reply`, async () => {
      await show('models');
      const snapshot=JSON.parse(await read('JSON.stringify(state)'));
      const selection=[...snapshot.selectedModelIds].reverse();
      assert.ok(selection.length>1,'The fixture needs multiple model choices');
      modelSelectionSaveOverride=async (_event,ids) => ({...snapshot,
        ...(outcome === 'unavailable' ? {stateUnavailable:true} : {}),selectedModelIds:outcome === 'stale' ? snapshot.selectedModelIds : ids});
      try {
        await read(`draftSelection=${JSON.stringify(selection)}; modelPageView='catalog'; render()`);
        await click('#saveModelSelectionPanel');
        await waitUntil("!document.querySelector('#saveModelSelectionPanel').classList.contains('loading')");
        assert.equal(await read('JSON.stringify(draftSelection)'),JSON.stringify(selection));
        assert.equal(await read('JSON.stringify(state.selectedModelIds)'),JSON.stringify(outcome === 'valid' ? selection : snapshot.selectedModelIds));
        assert.equal(await read('state.stateUnavailable'),snapshot.stateUnavailable);
        if(outcome !== 'valid') assert.match(await read('els.toast.textContent'),/无法确认/);
      } finally {
        modelSelectionSaveOverride=null;
        await read(`adoptStateSnapshot(${JSON.stringify(snapshot)}); draftSelection=[...state.selectedModelIds]; render()`);
      }
    });
  }
  for (const kind of ['settings','budget','models']) {
    await check(`${kind}: an undo during an unconfirmed save survives later state and can be discarded`, async () => {
      await show(kind === 'budget' ? 'stats' : kind);
      const snapshot=JSON.parse(await read('JSON.stringify(state)'));
      let payload, finish;
      const intercept=(_event,value) => {payload=value; return new Promise(resolve => {finish=() => resolve({...snapshot,stateUnavailable:true});});};
      const input=kind === 'settings' ? 'routerPort' : 'usageDailyCallLimit';
      const save=kind === 'settings' ? '#saveDesktopOptions' : kind === 'budget' ? '#saveUsageBudgets' : '#saveModelSelectionPanel';
      const original=kind === 'models' ? snapshot.selectedModelIds : await read(`els.${input}.value`);
      if(kind === 'settings') basicSettingsSaveOverride=intercept;
      else if(kind === 'budget') budgetSaveOverride=intercept;
      else modelSelectionSaveOverride=intercept;
      try {
        if(kind === 'models') await read(`draftSelection=${JSON.stringify([...original].reverse())}; modelPageView='catalog'; render()`);
        else await read(`els.${input}.value=${JSON.stringify(kind === 'settings' ? '15819' : '37')}; els.${input}.dispatchEvent(new Event('input',{bubbles:true}))`);
        await click(save);
        assert.ok(payload);
        if(kind === 'models') await read(`draftSelection=${JSON.stringify(original)}; render()`);
        else await read(`els.${input}.value=${JSON.stringify(original)}; els.${input}.dispatchEvent(new Event('input',{bubbles:true}))`);
        finish();
        await waitUntil(`!document.querySelector(${JSON.stringify(save)}).classList.contains('loading')`);
        const committed={...snapshot,stateConfigRevision:'ui-committed-'+kind,
          ...(kind === 'models' ? {selectedModelIds:payload} : {desktopOptions:{...snapshot.desktopOptions,...payload}})};
        await read(`adoptStateSnapshot(${JSON.stringify(committed)}); render()`);
        if(kind === 'models') assert.equal(await read('JSON.stringify(draftSelection)'),JSON.stringify(original));
        else assert.equal(await read(`els.${input}.value`),original);
        const discard=kind === 'settings' ? '#discardDesktopSettings' : kind === 'budget' ? '#discardUsageBudget' : '#discardModelSelection';
        assert.equal(await read(`document.querySelector(${JSON.stringify(discard)}).disabled`),false);
        await click(discard);
        if(kind === 'models') assert.equal(await read('JSON.stringify(draftSelection)'),JSON.stringify(payload));
        else assert.equal(await read(`els.${input}.value`),kind === 'settings' ? '15819' : '37');
      } finally {
        finish?.(); basicSettingsSaveOverride=null; budgetSaveOverride=null; modelSelectionSaveOverride=null;
        await read(`desktopSettingsDraft.clear(); usageBudgetDrafts.clear(); adoptStateSnapshot(${JSON.stringify(snapshot)}); draftSelection=[...state.selectedModelIds]; render()`);
      }
    });
  }
  for (const kind of ['empty-models','empty-rule','empty-failover']) {
    await check(`${kind}: an incomplete selection is explained before any settings are written`, async () => {
      await show(kind === 'empty-models' ? 'models' : 'settings');
      const snapshot=JSON.parse(await read('JSON.stringify(state)'));
      let writes=0;
      basicSettingsSaveOverride=async () => {writes+=1; return snapshot;};
      modelSelectionSaveOverride=async () => {writes+=1; return snapshot;};
      const save=kind === 'empty-models' ? '#saveModelSelectionPanel' : '#saveDesktopOptions';
      try {
        if(kind === 'empty-models') await read("draftSelection=[]; modelPageView='catalog'; render()");
        else if(kind === 'empty-rule') await read("els.smartCodeMode.value='route'; els.smartCodeMode.dispatchEvent(new Event('change',{bubbles:true})); els.smartCodeRoute.value=''; els.smartCodeRoute.dispatchEvent(new Event('change',{bubbles:true}))");
        else await read("els.smartFailoverMode.value='ordered'; els.smartFailoverMode.dispatchEvent(new Event('change',{bubbles:true})); for(const id of SMART_ROUTING_ROUTE_CONTROLS){els[id].value=''; els[id].dispatchEvent(new Event('change',{bubbles:true}));}");
        await click(save);
        await waitUntil(`!document.querySelector(${JSON.stringify(save)}).classList.contains('loading')`);
        assert.equal(writes,0);
        assert.match(await read('els.toast.textContent'),/选择|备用/);
        assert.equal(await read('JSON.stringify(state.desktopOptions)'),JSON.stringify(snapshot.desktopOptions));
      } finally {
        basicSettingsSaveOverride=null; modelSelectionSaveOverride=null;
        await read(`desktopSettingsDraft.clear(); adoptStateSnapshot(${JSON.stringify(snapshot)}); draftSelection=[...state.selectedModelIds]; render()`);
      }
    });
  }
  for (const kind of ['rule','backup2','backup3']) {
    await check(`${kind}: validation opens the folded section and targets the field that needs correction`, async () => {
      await show('settings');
      const snapshot=JSON.parse(await read('JSON.stringify(state)'));
      const previouslyOpen=await read("document.querySelector('.routing-disclosure').open");
      const expected=kind==='rule'?'smartLongContextRoute':kind==='backup2'?'smartFailoverRoute2':'smartFailoverRoute3';
      let writes=0;
      basicSettingsSaveOverride=async () => {writes+=1; return snapshot;};
      try {
        if(kind==='rule') await read("els.smartLongContextMode.value='route'; els.smartLongContextMode.dispatchEvent(new Event('change',{bubbles:true})); els.smartLongContextRoute.value=''; els.smartLongContextRoute.dispatchEvent(new Event('change',{bubbles:true}))");
        else await read(`els.smartFailoverMode.value='ordered'; els.smartFailoverMode.dispatchEvent(new Event('change',{bubbles:true}));
          for(const [index,id] of SMART_ROUTING_ROUTE_CONTROLS.entries()) {
            const value=id===${JSON.stringify(expected)}?'ui-retired-route':index===0?state.models[0].id:'';
            populateSmartRoutingRouteSelect(els[id],value); els[id].value=value; els[id].dispatchEvent(new Event('change',{bubbles:true}));
          }`);
        await read("document.querySelector('.routing-disclosure').open=false");
        const otherDisclosures=await read("JSON.stringify([...document.querySelectorAll('details:not(.routing-disclosure)')].map(node => node.open))");
        await click('#saveDesktopOptions');
        await waitUntil("!els.saveDesktopOptions.classList.contains('loading')");
        assert.equal(writes,0);
        assert.equal(await read("document.querySelector('.routing-disclosure').open"),true);
        assert.equal(await read('document.activeElement.id'),expected);
        assert.equal(await read("JSON.stringify([...document.querySelectorAll('details:not(.routing-disclosure)')].map(node => node.open))"),otherDisclosures);
        const field=await read(`(() => {const rect=els.${expected}.getBoundingClientRect(); return {top:rect.top,bottom:rect.bottom,height:innerHeight,hit:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('select')?.id};})()`);
        assert.ok(field.top>=0 && field.bottom<=field.height,JSON.stringify(field));
        assert.equal(field.hit,expected);
        const message=await read('els.toast.textContent');
        assert.ok(message.includes(kind==='rule'?'长上下文':`备用位 ${kind==='backup2'?2:3}`));
        assert.match(await read('els.modelReferenceStatus.textContent'),/已保存配置/);
        assert.equal(await read('JSON.stringify(state.desktopOptions)'),JSON.stringify(snapshot.desktopOptions));
        if(kind==='backup2') await screenshot('routing-error-target');
      } finally {
        basicSettingsSaveOverride=null;
        await read(`desktopSettingsDraft.clear(); adoptStateSnapshot(${JSON.stringify(snapshot)}); render(); document.querySelector('.routing-disclosure').open=${previouslyOpen}`);
      }
    });
  }
  for (const kind of ['settings','budget','models']) {
    await check(`${kind}: keyboard save stays single-flight across state broadcasts and permits retry`, async () => {
      await show(kind==='budget'?'stats':kind);
      if(kind==='budget') await read("document.querySelector('#usageBudgetDetails').open=true");
      const snapshot=JSON.parse(await read('JSON.stringify(state)'));
      const save=kind==='settings'?'#saveDesktopOptions':kind==='budget'?'#saveUsageBudgets':'#saveModelSelectionPanel';
      const discard=kind==='settings'?'#discardDesktopSettings':kind==='budget'?'#discardUsageBudget':'#discardModelSelection';
      const input=kind==='settings'?'routerPort':'usageDailyCallLimit';
      const wanted=kind==='models'?[...snapshot.selectedModelIds].reverse():kind==='settings'?'15827':'29';
      const requests=[];
      const pending=[];
      const intercept=(_event,payload) => {
        requests.push(payload);
        return new Promise((resolve,reject) => pending.push({resolve,reject,payload}));
      };
      const waitForRequest=async count => {
        const deadline=Date.now()+20000;
        while(requests.length<count && Date.now()<deadline) await settle();
        assert.equal(requests.length,count);
      };
      const focusSave=() => read(`document.querySelector(${JSON.stringify(save)}).focus()`);
      if(kind==='settings') basicSettingsSaveOverride=intercept;
      else if(kind==='budget') budgetSaveOverride=intercept;
      else modelSelectionSaveOverride=intercept;
      try {
        if(kind==='models') await read(`draftSelection=${JSON.stringify(wanted)}; modelPageView='catalog'; render()`);
        else await read(`els.${input}.value=${JSON.stringify(wanted)}; els.${input}.dispatchEvent(new Event('input',{bubbles:true}))`);
        await focusSave();
        assert.equal(await read('document.activeElement.id'),save.slice(1));
        await pressDialogKey('Enter');
        await waitForRequest(1);
        assert.equal(await read(`document.querySelector(${JSON.stringify(save)}).disabled`),true);
        // Use the real preload subscription rather than calling the renderer reducer directly.
        wc.send('state:update',{...snapshot,stateUnavailable:true});
        await waitUntil('state.stateUnavailable === true');
        wc.send('state:update',{...snapshot,stateUnavailable:false});
        await waitUntil('state.stateUnavailable === false');
        assert.equal(await read(`document.querySelector(${JSON.stringify(save)}).disabled`),true,'A state broadcast re-enabled a pending save');
        await click(save);
        await pressDialogKey('Enter');
        assert.equal(requests.length,1,'Repeated activation submitted a second save');
        if(kind==='models') assert.deepEqual(requests[0],wanted);
        else if(kind==='settings') assert.equal(requests[0].routerPort,15827);
        else assert.equal(requests[0].usageBudgets.global.dailyCallLimit,29);
        pending[0].reject(new Error('UI fixture: retryable keyboard save failure'));
        await waitUntil(`!document.querySelector(${JSON.stringify(save)}).classList.contains('loading')`);
        await read('render()');
        assert.equal(await read(`document.querySelector(${JSON.stringify(save)}).disabled`),false);
        assert.equal(await read(`document.querySelector(${JSON.stringify(discard)}).disabled`),false,'A failed save lost its editable draft after rendering');
        if(kind==='models') assert.equal(await read('JSON.stringify(draftSelection)'),JSON.stringify(wanted));
        else assert.equal(await read(`els.${input}.value`),wanted);
        await focusSave(); await pressDialogKey('Enter'); await waitForRequest(2);
        const payload=pending[1].payload;
        pending[1].resolve({...snapshot,stateUnavailable:false,...(kind==='models'
          ? {selectedModelIds:payload} : {desktopOptions:{...snapshot.desktopOptions,...payload}})});
        await waitUntil(`!document.querySelector(${JSON.stringify(save)}).classList.contains('loading')`);
        assert.equal(requests.length,2);
        assert.equal(await read(`document.querySelector(${JSON.stringify(save)}).disabled`),false);
        assert.equal(await read(`document.querySelector(${JSON.stringify(discard)}).disabled`),true,'A confirmed save left a stale unsaved draft');
        if(kind==='models') assert.equal(await read('JSON.stringify(state.selectedModelIds)'),JSON.stringify(wanted));
        else if(kind==='settings') assert.equal(await read('state.desktopOptions.routerPort'),15827);
        else assert.equal(await read('state.desktopOptions.usageBudgets.global.dailyCallLimit'),29);
      } finally {
        for(const entry of pending) entry.reject(new Error('UI fixture cleanup'));
        basicSettingsSaveOverride=null; budgetSaveOverride=null; modelSelectionSaveOverride=null;
        await waitUntil(`!document.querySelector(${JSON.stringify(save)}).classList.contains('loading')`);
        await read(`desktopSettingsDraft.clear(); usageBudgetDrafts.clear(); adoptStateSnapshot(${JSON.stringify(snapshot)}); draftSelection=[...state.selectedModelIds]; render()`);
      }
    });
  }
  await check('real isolated IPC saves retain selected order and a complete explicit routing choice', async () => {
    // These two writes are confined to the disposable smoke profile; no Router is started.
    await show('models');
    const selection=JSON.parse(await read('JSON.stringify(state.selectedModelIds)')).reverse();
    await read(`draftSelection=${JSON.stringify(selection)}; modelPageView='catalog'; render()`);
    await click('#saveModelSelectionPanel');
    await waitUntil("!document.querySelector('#saveModelSelectionPanel').classList.contains('loading')");
    assert.equal(await read('JSON.stringify(state.selectedModelIds)'),JSON.stringify(selection));
    assert.match(await read('els.toast.textContent'),/已保存/);
    await show('settings');
    const route=await read('state.models[0].id');
    await read(`els.routerPort.value='15821'; els.routerPort.dispatchEvent(new Event('input',{bubbles:true}));
      els.smartCodeMode.value='route'; els.smartCodeMode.dispatchEvent(new Event('change',{bubbles:true}));
      els.smartCodeRoute.value=${JSON.stringify(route)}; els.smartCodeRoute.dispatchEvent(new Event('change',{bubbles:true}));
      els.smartFailoverMode.value='ordered'; els.smartFailoverMode.dispatchEvent(new Event('change',{bubbles:true}));
      for (const [index,id] of SMART_ROUTING_ROUTE_CONTROLS.entries()) {els[id].value=index<2?${JSON.stringify(route)}:''; els[id].dispatchEvent(new Event('change',{bubbles:true}));}`);
    await click('#saveDesktopOptions');
    await waitUntil("!els.saveDesktopOptions.classList.contains('loading')");
    const saved=JSON.parse(await read('window.codexBridge.getState({lite:true}).then(value => JSON.stringify(value.desktopOptions))'));
    assert.equal(saved.routerPort,15821);
    assert.equal(saved.smartRouting.autoSelectRules.code.mode,'route');
    assert.equal(saved.smartRouting.autoSelectRules.code.routeId,route);
    assert.equal(saved.smartRouting.failover.mode,'ordered');
    assert.deepEqual(saved.smartRouting.failover.routeIds,[route]);
    assert.equal(await read('desktopSettingsDraft.size'),0);
    assert.match(await read('els.toast.textContent'),/已保存/);
  });
  }
  win.setSize(980,640); await settle();
  for (const section of ['settings','resources']) {
    await check(`${section}: long error paths stay readable inside the toast without covering actions`, async () => {
      await show(section);
      const message='无法读取安装文件：F:\\Apps\\CodexBridge\\'+'LongPackageName'.repeat(12)+'\\manifest.json';
      await read(`showToast(${JSON.stringify(message)},'error')`);
      try {
        const layout=await read(`(() => {
          const toast=els.toast, bounds=toast.getBoundingClientRect(), style=getComputedStyle(toast);
          const footer=document.querySelector('#settings > .action-page-footer');
          const action=footer && !document.querySelector('#settings').classList.contains('hidden') ? footer.getBoundingClientRect() : null;
          return {left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom,width:innerWidth,height:innerHeight,
            toastWidth:bounds.width,toastHeight:bounds.height,visible:style.visibility==='visible' && Number(style.opacity)>0,
            overflow:toast.scrollWidth-toast.clientWidth,text:toast.querySelector('[data-toast-message]').textContent,actionTop:action?.top,
            saveHit:action ? document.elementFromPoint(els.saveDesktopOptions.getBoundingClientRect().x+els.saveDesktopOptions.offsetWidth/2,
              els.saveDesktopOptions.getBoundingClientRect().y+els.saveDesktopOptions.offsetHeight/2)?.closest('button')?.id : null};
        })()`);
        await screenshot(section+'-long-error');
        assert.ok(layout.visible && layout.toastWidth>0 && layout.toastHeight>0,'The error toast must be visible: '+JSON.stringify(layout));
        assert.equal(layout.text,message,'The error path must remain available in full');
        assert.ok(layout.overflow<=1,'Error text overflows the toast: '+JSON.stringify(layout));
        assert.ok(layout.left>=0 && layout.right<=layout.width && layout.top>=0 && layout.bottom<=layout.height,JSON.stringify(layout));
        if(section==='settings') {
          assert.ok(layout.bottom<=layout.actionTop,JSON.stringify(layout));
          assert.equal(layout.saveHit,'saveDesktopOptions');
        }
      } finally { await read("clearTimeout(showToast.timer); els.toast.classList.add('hidden')"); }
    });
  }
  await check('toast has only Close and retains selectable text and keyboard dismissal', async () => {
    await show('resources');
    await click('#resourceSearch');
    const message='设置已保存';
    await read(`showToast(${JSON.stringify(message)},'success')`);
    assert.deepEqual(await read("[...els.toast.querySelectorAll('button')].map(button=>button.textContent.trim())"),['关闭']);
    assert.equal(await read("els.toast.querySelector('[data-toast-copy]')"),null);
    assert.equal(await read("getComputedStyle(els.toast.querySelector('[data-toast-message]')).userSelect"),'text');
    await screenshot('toast-close-only');
    await read("els.toast.querySelector('[data-toast-close]').focus()");
    wc.sendInputEvent({type:'keyDown',keyCode:'Enter'});
    wc.sendInputEvent({type:'char',keyCode:'Enter'});
    wc.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await settle();
    assert.equal(await read("els.toast.classList.contains('hidden')"),true);
    assert.equal(await read('document.activeElement.id'),'resourceSearch');
  });
  await check('toast closes after five seconds without requiring a click', async () => {
    await show('resources');
    await click('#resourceSearch');
    await read("showToast('模型选择已保存，并已更新 Router 配置。','success')");
    await read("els.toast.querySelector('[data-toast-close]').focus()");
    assert.equal(await read("els.toast.classList.contains('hidden')"),false);
    await waitUntil("els.toast.classList.contains('hidden')",7000);
    assert.equal(await read('document.activeElement.id'),'resourceSearch');
  });
  await check('unavailable-state errors keep Close usable without enabling configuration writes', async () => {
    await show('resources');
    const unavailable=await read('state.stateUnavailable');
    try {
      await read("state.stateUnavailable=true; showToast('状态暂不可用，请刷新重试。','error'); applyStateUnavailableWriteGuard(document,true)");
      await settle();
      assert.equal(await read("els.toast.querySelector('[data-toast-copy]')"),null);
      assert.equal(await read("els.toast.querySelector('[data-toast-close]').disabled"),false);
      await click('[data-toast-close]');
      assert.equal(await read("els.toast.classList.contains('hidden')"),true);
      assert.equal(await read('els.saveDesktopOptions.disabled'),true);
    } finally {
      await read(`state.stateUnavailable=${Boolean(unavailable)}; applyStateUnavailableWriteGuard(document,${Boolean(unavailable)})`);
    }
  });
  for (const zoom of [1.25,1.5,2]) {
    await check(`toast: ${zoom*100}% zoom retains readable text and reachable actions`, async () => {
      win.setSize(1440,900); wc.setZoomFactor(zoom); await settle();
      try {
        await show('settings');
        await read("showToast('无法读取文件：'+ '测试目录/LongFileName/'.repeat(100),'error')");
        const layout=await read(`(() => {
          const box=els.toast.getBoundingClientRect(), body=els.toast.querySelector('[data-toast-message]');
          const actions=[...els.toast.querySelectorAll('button')].map(button=>{
            const r=button.getBoundingClientRect();
            return {width:r.width,height:r.height,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===button};
          });
          return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:innerWidth,height:innerHeight,
            bodyOverflow:body.scrollWidth-body.clientWidth,scrollable:body.scrollHeight>body.clientHeight,actions};
        })()`);
        assert.ok(layout.left>=0 && layout.top>=0 && layout.right<=layout.width && layout.bottom<=layout.height,JSON.stringify(layout));
        assert.ok(layout.bodyOverflow<=1 && layout.scrollable,JSON.stringify(layout));
        assert.ok(layout.actions.every(action=>action.hit && action.width>=30 && action.height>=30),JSON.stringify(layout));
        await screenshot('toast-zoom-'+zoom*100);
        await click('[data-toast-close]');
        assert.equal(await read("els.toast.classList.contains('hidden')"),true);
      } finally { wc.setZoomFactor(1); await read('hideToast()'); }
    });
  }
  for (const section of ['resources']) {
    await check(`${section}: CJK composition survives a background refresh and commits the search`, async () => {
      win.setSize(1180,760); await settle(); await show(section);
      const resourceBefore=await read('resourceFilterText');
      const selector='#resourceSearch';
      try {
        await read("resourceFilterText=''; els.resourceSearch.value=''; renderResources()");
        await click(selector);
        wc.debugger.attach('1.3');
        await wc.debugger.sendCommand('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
        await read(`window.__compositionInput=document.querySelector(${JSON.stringify(selector)}); renderResources()`);
        assert.equal(await read(`document.querySelector(${JSON.stringify(selector)})===window.__compositionInput`),true,'The composing input was replaced');
        assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`),'中文');
        await wc.debugger.sendCommand('Input.insertText',{text:'中文检索'});
        await settle();
        assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`),'中文检索');
        assert.equal(await read('resourceFilterText'),'中文检索');
        assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),true);
      } finally {
        if(wc.debugger.isAttached()) wc.debugger.detach();
        await read(`delete window.__compositionInput; resourceFilterText=${JSON.stringify(resourceBefore)}; els.resourceSearch.value=resourceFilterText; renderResources()`);
      }
    });
  }
  await check('mode recovery retains edits during IPC and blocks saving incompatible draft models', async () => {
    await show('models');await show('dashboard');
    const subscription=await read("state.modelPresets.find(model=>model.authMode==='codex_openai')?.presetId");
    assert.ok(subscription);
    await read(`window.codexBridge.saveModelSelection(${JSON.stringify([subscription,'deepseek-v4-pro'])}).then(value=>{adoptStateSnapshot(value);draftSelection=[...state.selectedModelIds];render()})`);
    const before=JSON.parse(await read('JSON.stringify(state)'));
    const next={...before,mode:'all_api',selectedModelIds:['deepseek-v4-pro']};
    let finish,saveCalls=0;
    modeSelectOverride=()=>new Promise((resolve,reject)=>{finish={resolve,reject};});
    modelSelectionSaveOverride=async(_event,ids,options)=>{
      saveCalls++;assert.equal(options?.exactSelection,true);assert.equal(options?.expectedMode,'all_api');
      return {...next,selectedModelIds:ids};
    };
    try {
      await click('.mode-card[data-mode=all_api]');await waitUntil("document.querySelector('.runtime-confirm-backdrop')?.open");
      await click('[data-confirm-ok]');await waitUntil('pendingModeSwitch!==null');
      await show('models');await read("activeProviderId='deepseek';modelPageView='catalog';render()");
      await click('[data-model-id="deepseek-v4-flash"]');
      const edited=JSON.parse(await read('JSON.stringify(draftSelection)'));
      assert.deepEqual(edited,[subscription,'deepseek-v4-pro','deepseek-v4-flash']);
      await click('#saveModelSelectionPanel');
      await waitUntil("!document.querySelector('#saveModelSelectionPanel').classList.contains('loading')");
      assert.equal(saveCalls,0,'Saving during a pending mode change must not reach IPC');
      assert.match(await read('els.toast.textContent'),/尚未确认/);await read('hideToast()');
      await read(`adoptStateSnapshot(${JSON.stringify(next)});render()`);
      assert.deepEqual(JSON.parse(await read('JSON.stringify(draftSelection)')),edited,'Mode broadcast discarded the edit');
      finish.resolve({state:next,transaction:{revision:'ui-fixture'}});
      await waitUntil('pendingModeSwitch===null');
      assert.deepEqual(JSON.parse(await read('JSON.stringify(draftSelection)')),edited,'RPC completion discarded the edit');
      await read('hideToast()');await click('#saveModelSelectionPanel');
      await waitUntil("!document.querySelector('#saveModelSelectionPanel').classList.contains('loading')");
      assert.equal(saveCalls,0,'An incompatible subscription draft reached the save IPC');
      assert.match(await read('els.toast.textContent'),/不可用/);
      await read(`hideToast();toggleModel(${JSON.stringify(subscription)})`);
      await click('#saveModelSelectionPanel');
      await waitUntil("!document.querySelector('#saveModelSelectionPanel').classList.contains('loading')");
      assert.equal(saveCalls,1);
      assert.deepEqual(JSON.parse(await read('JSON.stringify(state.selectedModelIds)')),['deepseek-v4-pro','deepseek-v4-flash']);
      assert.equal(await read('modeSwitchDraftsToKeep.has(draftSelection)'),false);
      await screenshot('mode-inflight-draft-saved');
    } finally {
      finish?.reject(new Error('UI fixture cleanup'));await waitUntil('pendingModeSwitch===null');
      modeSelectOverride=null;modelSelectionSaveOverride=null;
      await read(`state=${JSON.stringify(before)};draftSelection=[...state.selectedModelIds];render()`);
    }
  });
  await check('manual API mode requires confirmation then retains API selection through the real mode IPC', async () => {
    await show('dashboard');
    const desired=['deepseek-v4-flash','deepseek-v4-pro'];
    const subscription=await read("state.modelPresets.find(model=>model.authMode==='codex_openai')?.presetId");
    assert.ok(subscription,'The fixture must contain an official subscription model');
    const selection=[subscription,...desired];
    await read(`window.codexBridge.saveModelSelection(${JSON.stringify(selection)}).then(value=>{adoptStateSnapshot(value);draftSelection=[...state.selectedModelIds];render()})`);
    const before=await read('JSON.stringify(state.selectedModelIds)');
    assert.equal(await read('state.mode'),'hybrid');
    await click('.mode-card[data-mode=all_api]');
    await waitUntil("document.querySelector('.runtime-confirm-backdrop')?.open");
    assert.ok(await read("document.querySelector('.runtime-confirm-message').textContent.includes('余额')"));
    assert.ok(await read("document.activeElement.matches('[data-confirm-cancel]')"));
    await click('[data-confirm-cancel]');
    await waitUntil("!document.querySelector('.mode-card[data-mode=all_api]').disabled");
    assert.equal(await read('state.mode'),'hybrid');
    assert.equal(await read('JSON.stringify(state.selectedModelIds)'),before);
    await click('.mode-card[data-mode=all_api]');
    await waitUntil("document.querySelector('.runtime-confirm-backdrop')?.open");
    await screenshot('quota-recovery-confirmation');
    await click('[data-confirm-ok]');
    await waitUntil("state.mode==='all_api' && !document.querySelector('.mode-card[data-mode=all_api]').classList.contains('loading')");
    assert.deepEqual(JSON.parse(await read('JSON.stringify(state.selectedModelIds)')),desired);
    assert.deepEqual(JSON.parse(await read('JSON.stringify(draftSelection)')),desired);
    assert.match(await read('els.toast.textContent'),/重启/);
    assert.equal(await read("document.querySelector('#apiQuotaRecovery')===null"),true);
    const configFile=path.join(process.env.CODEXBRIDGE_DESKTOP_SMOKE_HOME,'.codex','config.toml');
    const configText=fs.readFileSync(configFile,'utf8');
    assert.match(configText,/model_provider\s*=\s*"codexbridge"/);
    assert.match(configText,/requires_openai_auth\s*=\s*false/);
    assert.match(configText,/model\s*=\s*"cb-deepseek-v4-flash"/);
    assert.equal(await read('state.routerRunning'),false,'Recovery must not launch a Router');
    await screenshot('quota-recovery-completed');
  });
  await check('returning to subscription preserves API choices instead of restoring the default list', async () => {
    await show('dashboard');
    const before=await read('JSON.stringify(state.selectedModelIds)');
    assert.equal(await read('state.mode'),'all_api');
    await click('[data-mode="hybrid"]');await waitUntil("document.querySelector('.runtime-confirm-backdrop')?.open");
    await click('[data-confirm-cancel]');
    await waitUntil("!document.querySelector('[data-mode=hybrid]').classList.contains('loading')");
    assert.equal(await read('state.mode'),'all_api');
    await click('[data-mode="hybrid"]');await waitUntil("document.querySelector('.runtime-confirm-backdrop')?.open");
    await screenshot('mode-return-confirmation');await click('[data-confirm-ok]');
    await waitUntil("state.mode==='hybrid' && pendingModeSwitch===null");
    assert.equal(await read('JSON.stringify(state.selectedModelIds)'),before);
    assert.equal(await read('JSON.stringify(draftSelection)'),before);
    assert.match(fs.readFileSync(path.join(process.env.CODEXBRIDGE_DESKTOP_SMOKE_HOME,'.codex','config.toml'),'utf8'),/model_provider\s*=\s*"openai"/);
    assert.equal(await read('state.routerRunning'),false);
    await screenshot('mode-return-completed');
  });
  await check('primary text, sidebar labels, action and placeholder contrast are readable', async () => {
    const pairs = await read(`(() => {
      const color = (selector, property, pseudo) => getComputedStyle(document.querySelector(selector), pseudo).getPropertyValue(property);
      return [
        ['body', color('body','color'), color('body','background-color')],
        ['page help', color('.topbar p','color'), color('.topbar','background-color')],
        ['navigation group', color('.nav-group-label','color'), color('.sidebar','background-color')],
        ['selected navigation', color('.nav-item.active','color'), color('.nav-item.active','background-color')],
        ['primary action', color('#saveModelSelectionPanel','color'), color('#saveModelSelectionPanel','background-color')],
        ['port validation error', color('#routerPortError','color'), color('#settingsGeneral','background-color')],
        ['placeholder', color('#resourceSearch','color','::placeholder'), color('#resourceSearch','background-color')]
      ];
    })()`);
    const luminance = value => value.match(/[\d.]+/g).slice(0,3).map(Number).map(x => {
      const channel = x / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126,.7152,.0722][index], 0);
    for (const [label, foreground, background] of pairs) {
      const values = [luminance(foreground), luminance(background)].sort((a,b) => b-a);
      const ratio = (values[0] + .05) / (values[1] + .05);
      assert.ok(ratio >= 4.5, `${label}: ${ratio.toFixed(2)}:1`);
    }
  });
  await check('reduced-motion preference suppresses control transitions', async () => {
    wc.debugger.attach('1.3');
    try {
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      const duration = await read("getComputedStyle(document.querySelector('.nav-item')).transitionDuration");
      assert.ok(duration.split(',').every(value => parseFloat(value) <= .001));
    } finally { wc.debugger.detach(); }
  });
  if (outputDir) fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({checks, failures}, null, 2));
  if (failures.length) throw new Error(`${failures.length} UI review checks failed`);
  console.log(`DESKTOP_UI_REVIEW_PASS ${checks.length}`);
}

app.quit = function () {
  if (reviewing) return originalQuit();
  reviewing = true;
  review().then(originalQuit, error => { console.error(error); app.exit(1); });
};
// Inject read-only IPC outcomes only in this disposable renderer test process.
const registerIpcHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerIpcHandler(channel, channel === 'state:get'
  ? (event, options) => resourceStateReadOverride && options?.forceResourceRefresh
    ? resourceStateReadOverride(event, options) : handler(event, options)
  : channel === 'options:save'
    ? (event, options) => budgetSaveOverride && options?.usageBudgets
      ? budgetSaveOverride(event, options) : basicSettingsSaveOverride && !options?.usageBudgets
        ? basicSettingsSaveOverride(event, options) : handler(event, options)
  : channel === 'models:saveSelection'
    ? (event, ids, options) => modelSelectionSaveOverride ? modelSelectionSaveOverride(event, ids, options) : handler(event, ids, options)
  : channel === 'mode:select'
    ? (event, mode, options) => modeSelectOverride ? modeSelectOverride(event, mode, options) : handler(event, mode, options)
  : channel === 'clipboard:write'
    ? (event, text) => clipboardWriteOverride ? clipboardWriteOverride(event, text) : handler(event, text)
  : handler);
require('../desktop/main.cjs');
ipcMain.handle = registerIpcHandler;
