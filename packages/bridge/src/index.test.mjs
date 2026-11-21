import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import ts from 'typescript';
import { randomInt } from 'node:crypto';

// Test-only browser listener: avoid Chromium's blocked ports without releasing a
// probed socket. Reallocate only unavailable binds, never browser/test actions.
async function listenForBrowser(server) {
  let lastBindError;
  for (let attempt = 0; attempt < 32; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = error => reject(error);
        server.once('error', onError);
        server.listen(randomInt(20_000, 65_536), '127.0.0.1', () => {
          server.off('error', onError);
          resolve();
        });
      });
      return;
    } catch (error) {
      lastBindError = error;
      if (error.code !== 'EADDRINUSE' && !(process.platform === 'win32' && error.code === 'EACCES')) throw error;
    }
  }
  throw new Error('Unable to bind a browser-compatible test listener after 32 candidates', { cause: lastBindError });
}

const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const shared = transpile(await readFile(new URL('../../shared/src/index.ts', import.meta.url), 'utf8')).replace(/^export /gm, '');
const placement = transpile(await readFile(new URL('./asset-placement.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const bridge = transpile(await readFile(new URL('./index.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const activation = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu', 'submit', 'keydown', 'keypress', 'keyup'];

test('capture isolation, real click selection, restoration and idle overlay without #root', async () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(req.url === '/child' ? '<body><button data-src="src/Button.tsx:1:1" data-cid="Button">Pick</button><form><input aria-label="input"></form><a href="#target">Link</a><p>plain text</p></body>' : '<iframe src="/child" style="width:600px;height:500px"></iframe>');
  });
  await listenForBrowser(server);
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => { window.results = []; window.addEventListener('message', event => { if (event.data.type === 'pick:result') window.results.push(event.data.payload); }); });
    const frame = page.frames().find(item => item.url().endsWith('/child'));
    await frame.evaluate(types => {
      window.counts = {};
      for (const type of [...types, 'pointermove', 'mousemove', 'wheel', 'scroll']) {
        document.addEventListener(type, event => { window.counts[type] = (window.counts[type] ?? 0) + 1; if (type === 'submit') event.preventDefault(); });
      }
      window.originalRaf = window.requestAnimationFrame.bind(window);
      window.framesScheduled = 0;
      window.requestAnimationFrame = fn => { window.framesScheduled++; return window.originalRaf(fn); };
      const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
      window.bridgeListeners = [];
      window.addEventListener = (type, fn, options) => { window.bridgeListeners.push({type, fn, options}); add(type, fn, options); };
      window.removeEventListener = (type, fn, options) => { window.bridgeListeners = window.bridgeListeners.filter(item => !(item.type === type && item.fn === fn && item.options === options)); remove(type, fn, options); };
    }, activation);
    await frame.addScriptTag({ content: `${shared}\n${placement}\n${bridge}\nconst beforeInstall = window.bridgeListeners.length; window.disposeBridge = installBridge(); window.bridgeOwned = window.bridgeListeners.slice(beforeInstall);` });
    const selectMode = async type => {
      await page.evaluate(type => document.querySelector('iframe').contentWindow.postMessage({type}, location.origin), type);
      // Same-origin ping ensures the prior message has been processed in the iframe event loop.
      await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    };
    await selectMode('pick:start');
    await frame.locator('button').click();
    await page.waitForFunction(() => window.results.length === 1);
    assert.equal((await page.evaluate(() => window.results[0])).src, 'src/Button.tsx:1:1');
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) assert.equal(await frame.evaluate(type => window.counts[type] ?? 0, type), 0, type);
    await frame.locator('input').focus();
    await frame.locator('input').press('Enter');
    await frame.locator('button').focus();
    await frame.locator('button').press('Space');
    await frame.locator('a').focus();
    await frame.locator('a').press('Enter');
    assert.equal(new URL(frame.url()).hash, '');
    assert.equal(await frame.evaluate(() => window.counts.submit ?? 0), 0);
    assert.equal(await frame.evaluate(() => window.counts.keydown ?? 0), 0);
    const blocked = await frame.evaluate(types => types.map(type => {
      const target = type === 'submit' ? document.querySelector('form') : document.querySelector('button');
      const event = type.startsWith('key') ? new KeyboardEvent(type, {key:'Enter', bubbles:true,cancelable:true}) : new Event(type,{bubbles:true,cancelable:true});
      target.dispatchEvent(event);
      return event.defaultPrevented;
    }), activation.filter(type => !['click', 'auxclick'].includes(type)));
    assert.ok(blocked.every(Boolean));
    const movement = await frame.evaluate(() => ['pointermove','mousemove','wheel','scroll'].map(type => {
      const event = new Event(type,{bubbles:true,cancelable:true});document.querySelector('button').dispatchEvent(event);return event.defaultPrevented;
    }));
    assert.ok(movement.every(value => !value));
    await frame.evaluate(() => new Promise(resolve => window.originalRaf(() => window.originalRaf(resolve))));
    const before = await frame.evaluate(() => window.framesScheduled);
    await frame.evaluate(() => new Promise(resolve => { let remaining=12; function next(){if(--remaining) window.originalRaf(next); else resolve();} window.originalRaf(next); }));
    assert.equal(await frame.evaluate(() => window.framesScheduled), before, 'overlay mutations must not schedule idle frames');
    await selectMode('pick:stop');
    assert.equal(await frame.locator('[data-highlight-src]').count(), 0);
    await frame.locator('button').click();
    assert.equal(await frame.evaluate(() => window.counts.click), 1);
    await frame.locator('input').press('Enter');
    assert.equal(await frame.evaluate(() => window.counts.submit), 1);
    await frame.locator('a').press('Enter');
    assert.equal(new URL(frame.url()).hash, '#target');
    const unblocked = await frame.evaluate(types => types.filter(type => type !== 'submit').map(type => {
      const event = type.startsWith('key') ? new KeyboardEvent(type,{key:'Enter',bubbles:true,cancelable:true}) : new Event(type,{bubbles:true,cancelable:true});
      document.querySelector('button').dispatchEvent(event); return !event.defaultPrevented;
    }), activation);
    assert.ok(unblocked.every(Boolean));
    await page.evaluate(()=>{window.placements=[];window.slots=[];window.addEventListener('message',event=>{if(event.source===document.querySelector('iframe').contentWindow&&event.origin===location.origin){if(event.data.type==='placement:target')window.placements.push(event.data.payload);if(event.data.type==='placement:slot')window.slots.push(event.data.payload);}});document.querySelector('iframe').contentWindow.postMessage({type:'placement:start',payload:{sessionId:'fixture-placement',assetId:'fixture-asset',baseVersion:'fixture-version'}},location.origin);});
    await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    await frame.locator('button').focus();await frame.locator('button').press('Enter');
    await page.waitForFunction(()=>window.placements.length===1&&window.slots.length>=1);
    assert.equal((await page.evaluate(()=>window.placements[0])).sessionId,'fixture-placement');
    assert.equal((await page.evaluate(()=>window.placements[0].target)).src,'src/Button.tsx:1:1');
    assert.equal(await frame.locator('[data-spatial-preview-slot="true"]').count(),1,'in-flow 3D preview slot should mount in webpage');
    const firstSlot=await page.evaluate(()=>window.slots.at(-1));
    assert.ok(Array.isArray(firstSlot.rect)&&firstSlot.rect[2]>100&&firstSlot.rect[3]>100,'slot rect should report real webpage stage bounds');
    await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'placement:preview-layout',payload:{sessionId:'fixture-placement',target:{kind:'insert',src:'src/Button.tsx:1:1',cid:'Button',ancestors:[],position:'before'},layout:{widthPercent:50,align:'start'}}},location.origin));
    await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    const resizedSlot=await page.evaluate(()=>window.slots.at(-1));
    assert.ok(resizedSlot.rect[2]<firstSlot.rect[2],'live layout resize should shrink in-page preview slot width');
    await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'placement:stop',payload:{sessionId:'fixture-placement'}},location.origin));
    await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    assert.equal(await frame.locator('[data-spatial-preview-slot="true"]').count(),0,'preview slot must be cleaned up on stop');
    assert.equal(await frame.locator('button').getAttribute('tabindex'),null,'temporary placement keyboard targets must be restored');
    await frame.evaluate(() => window.disposeBridge());
    assert.equal(await frame.locator('[data-bridge-overlay]').count(), 0);
    assert.equal(await frame.evaluate(() => window.bridgeListeners.filter(item => window.bridgeOwned.includes(item)).length), 0);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('pick:result is preceded by the click-time scroll progress', async () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(req.url === '/child'
      ? '<body style="margin:0"><div style="height:1500px"></div><button data-src="src/Button.tsx:1:1" data-cid="Button">Pick</button><div style="height:1500px"></div></body>'
      : '<iframe src="/child" style="width:600px;height:400px"></iframe>');
  });
  await listenForBrowser(server);
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => { window.messages = []; window.addEventListener('message', event => window.messages.push(event.data)); });
    const frame = page.frames().find(item => item.url().endsWith('/child'));
    await frame.addScriptTag({ content: `${shared}\n${placement}\n${bridge}\nwindow.disposeBridge = installBridge();` });
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ type: 'pick:start' }, location.origin));
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    // Scroll and click in the same task, before any scroll event can be dispatched.
    const expected = await frame.evaluate(() => {
      window.scrollTo(0, 1300);
      document.querySelector('button').click();
      return window.scrollY / (document.documentElement.scrollHeight - window.innerHeight);
    });
    await page.waitForFunction(() => window.messages.some(message => message.type === 'pick:result'));
    const messages = await page.evaluate(() => window.messages);
    const index = messages.findIndex(message => message.type === 'pick:result');
    assert.ok(index > 0, 'pick:result needs a preceding message');
    assert.equal(messages[index - 1].type, 'scroll:progress');
    assert.ok(Math.abs(messages[index - 1].payload.at - expected) < 1e-9, 'progress must be the click-time scroll position');
    assert.equal(messages[index - 1].payload.sync, false, 'a click is not a scroll: the other artboard must not follow it');
    // The real scroll still reports normally (without sync: false) once its event is dispatched.
    await page.waitForFunction(() => window.messages.some(message => message.type === 'scroll:progress' && message.payload.sync === undefined));
    // A programmatic scroll:to from the parent moves the child without echoing scroll:progress back.
    await page.evaluate(() => {
      window.messages.length = 0;
      document.querySelector('iframe').contentWindow.postMessage({ type: 'scroll:to', payload: { at: 0.25 } }, location.origin);
    });
    await frame.waitForFunction(() => Math.abs(window.scrollY - (document.documentElement.scrollHeight - window.innerHeight) * 0.25) <= 2);
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const echoed = await page.evaluate(() => window.messages.filter(message => message.type === 'scroll:progress'));
    assert.equal(echoed.length, 0, 'scroll:to must not echo scroll:progress back to the parent');
    await frame.evaluate(() => window.disposeBridge());
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
