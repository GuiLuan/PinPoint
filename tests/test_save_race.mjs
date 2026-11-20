import assert from 'node:assert/strict';
import { store } from '../frontend/js/state.js';
import { sync } from '../frontend/js/sync.js';
import { nodes } from '../frontend/js/nodes.js';

globalThis.window = { __sync: sync, location: { hash: '' } };
globalThis.document = { activeElement: null, querySelectorAll: () => [] };
const refreshCanvasTree = store.refreshCanvasTree;
const getCanvasHierarchy = store.getCanvasHierarchy;
nodes.flushActiveDOMEdits = () => {};
sync.connected = true;
sync.updateStatusDot = () => {};
sync.scheduleAutoSaveIfNeeded = () => {};
store.scheduleCacheWrite = () => {};
store.flushCacheToIDBNow = async () => {};
store.flushPendingCanvasIcons = async () => true;
store.getCanvasHierarchy = () => [{ id: 'root' }];
store.state.settings.save.mode = 'manual';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function runCase(phase) {
  store.dirtyCanvasIds.clear();
  store.pendingCanvasIcons.clear();
  store.pendingDeletedCanvasIds.clear();
  store.settingsDirty = false;
  store.state.cards = [{ id: 'card', title: 'before' }];
  store.markDirty('root');
  const started = deferred();
  const release = deferred();
  let savedTitle;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, 'PUT');
    savedTitle = JSON.parse(options.body).cards[0].title;
    if (phase === 'request') {
      started.resolve();
      await release.promise;
    }
    return { ok: true, json: async () => ({ revision: 1 }) };
  };
  store.refreshCanvasTree = async () => {
    if (phase === 'refresh') {
      started.resolve();
      await release.promise;
    }
  };
  const saving = sync.saveAllToBackend();
  if (phase !== 'none') {
    await started.promise;
    store.state.cards[0].title = 'after';
    store.markDirty('root');
    release.resolve();
  }
  assert.equal((await saving).ok, true);
  assert.equal(savedTitle, 'before');
  assert.equal(store.isCanvasDirty('root'), phase !== 'none');
  assert.equal(store.hasUnsavedChanges(), phase !== 'none');
}

async function testSettingsRequestsAreOrdered() {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const secondStarted = deferred();
  const releaseSecond = deferred();
  const sentValues = [];
  globalThis.fetch = async (url, { method, body }) => {
    sentValues.push({ url, method, interval: JSON.parse(body).save.intervalSec });
    if (sentValues.length === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    } else {
      secondStarted.resolve();
      await releaseSecond.promise;
    }
    return { ok: true };
  };

  store.setSaveSettings({ intervalSec: 5 });
  const firstSave = sync.pushSettingsNow();
  await firstStarted.promise;
  store.setSaveSettings({ intervalSec: 15 });
  const secondSave = sync.pushSettingsNow();
  assert.equal(sentValues.length, 1);
  releaseFirst.resolve();
  await secondStarted.promise;
  assert.equal(store.settingsDirty, true);
  releaseSecond.resolve();
  assert.deepEqual(await Promise.all([firstSave, secondSave]), [true, true]);
  assert.deepEqual(sentValues, [
    { url: '/api/v1/settings', method: 'PATCH', interval: 5 },
    { url: '/api/v1/settings', method: 'PATCH', interval: 15 }
  ]);
  assert.equal(store.settingsDirty, false);
}

async function testSettingsChangedWhileRefreshingTree() {
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  store.markDirty('root');
  store.refreshCanvasTree = async () => {
    refreshStarted.resolve();
    await releaseRefresh.promise;
  };
  const requests = [];
  globalThis.fetch = async (url, { method, body }) => {
    requests.push(method);
    if (method === 'PUT') {
      assert.equal(Object.hasOwn(JSON.parse(body), 'settings'), false);
    }
    return { ok: true, json: async () => ({ revision: 2 }) };
  };

  const saving = sync.saveAllToBackend();
  await refreshStarted.promise;
  store.setSaveSettings({ intervalSec: 20 });
  releaseRefresh.resolve();
  assert.equal((await saving).ok, true);
  assert.deepEqual(requests, ['PUT']);
  assert.equal(store.isCanvasDirty('root'), false);
  assert.equal(store.settingsDirty, true);
  assert.equal(store.hasUnsavedChanges(), true);

  assert.equal((await sync.saveAllToBackend()).ok, true);
  assert.deepEqual(requests, ['PUT', 'PATCH']);
  assert.equal(store.hasUnsavedChanges(), false);
}

async function testIconChangesDuringSave() {
  const firstPatchStarted = deferred();
  const releaseFirstPatch = deferred();
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const sentIcons = [];
  let serverIcon = null;
  let refreshes = 0;
  globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
    if (method === 'PUT') {
      assert.equal(Object.hasOwn(JSON.parse(body), 'icon'), false);
    } else if (method === 'PATCH') {
      const { icon } = JSON.parse(body);
      sentIcons.push(icon);
      if (icon === 'star') {
        firstPatchStarted.resolve();
        await releaseFirstPatch.promise;
      }
      serverIcon = icon;
    } else {
      assert.equal(url, '/api/v1/canvases');
      const icon = serverIcon;
      if (++refreshes === 1) {
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      return { ok: true, json: async () => ({ ok: true, data: [{ id: 'root', icon }] }) };
    }
    return { ok: true, json: async () => ({ revision: 3 }) };
  };

  store.markDirty('root');
  const firstIcon = store.setCanvasIcon('root', 'star');
  await firstPatchStarted.promise;
  const secondIcon = store.setCanvasIcon('root', 'flag');
  const saving = sync.saveAllToBackend();
  assert.deepEqual(sentIcons, ['star']);
  releaseFirstPatch.resolve();
  assert.deepEqual(await Promise.all([firstIcon, secondIcon]), [true, true]);
  await refreshStarted.promise;
  assert.equal(await store.setCanvasIcon('root', null), true);
  releaseRefresh.resolve();
  assert.equal((await saving).ok, true);
  assert.deepEqual(sentIcons, ['star', 'flag', null]);
  assert.equal(refreshes, 2);
  assert.equal(store.getCanvasIcon('root'), null);
  assert.equal(store.hasUnsavedChanges(), false);
}

async function testNewCanvasIconsSurviveFailedSaveAndReload() {
  store.state.cards = [];
  store.state.connections = [];
  const imported = await store.importAsSubcanvas({
    icon: 'book-open',
    cards: [{ id: 'portal', kind: 'subcanvas', subcanvasId: 'nested' }],
    connections: [],
    subcanvases: { nested: { icon: 'compass', cards: [], connections: [] } }
  }, 'test.pinpoint', { x: 0, y: 0 });
  const parentId = imported.subcanvasId;
  const nestedId = store.canvasesCache.get(parentId).cards[0].subcanvasId;
  assert.equal(await store.setCanvasIcon(parentId, 'bookmark'), true);
  const serverIcons = new Map([['root', null]]);
  let failNextPatch = true;
  globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
    if (url === '/api/v1/health') return { ok: true };
    if (method === 'GET') {
      const data = [...serverIcons].map(([id, icon]) => ({ id, icon }));
      return { ok: true, json: async () => ({ ok: true, data }) };
    }
    const id = url.split('/').at(-1).split('?')[0];
    const payload = JSON.parse(body);
    if (method === 'PUT') {
      assert.equal(Object.hasOwn(payload, 'icon'), false);
      if (!serverIcons.has(id)) serverIcons.set(id, null);
    } else {
      assert.equal(method, 'PATCH');
      assert.ok(serverIcons.has(id), 'A canvas must exist before its icon can be patched');
      if (failNextPatch) {
        failNextPatch = false;
        return { ok: false, status: 503 };
      }
      serverIcons.set(id, payload.icon);
    }
    return { ok: true, json: async () => ({ revision: 4 }) };
  };

  assert.equal((await sync.saveAllToBackend()).ok, false);
  assert.equal(store.getCanvasIcon(parentId), 'bookmark');
  assert.equal(store.getCanvasIcon(nestedId), 'compass');
  await store.flushCacheToIDBNow();
  store.canvasesCache.clear();
  store.pendingCanvasIcons.clear();
  store.dirtyCanvasIds.clear();
  assert.equal(await store.restoreFromIndexedDB(), true);
  assert.equal(store.getCanvasIcon(parentId), 'bookmark');
  assert.equal(store.getCanvasIcon(nestedId), 'compass');
  assert.equal((await sync.saveAllToBackend()).ok, true);
  assert.equal(serverIcons.get(parentId), 'bookmark');
  assert.equal(serverIcons.get(nestedId), 'compass');
  assert.equal(store.hasUnsavedChanges(), false);
}

async function testUndoKeepsPendingIconForUnopenedCanvas() {
  const childId = 'unopened-child';
  const nestedId = 'unopened-nested-child';
  const portal = { id: 'unopened-portal', kind: 'subcanvas', subcanvasId: childId };
  store.state.cards = [portal];
  store.undoStack = [store.snapshot()];
  store.redoStack = [];
  store.setCanvasTree([
    { id: 'root', icon: null },
    { id: childId, parentCanvasId: 'root', icon: 'star' },
    { id: nestedId, parentCanvasId: childId, icon: 'compass' }
  ]);
  sync.connected = false;
  await store.setCanvasIcon(childId, null);
  await store.setCanvasIcon(nestedId, 'flag');
  store.removeCard(portal.id);
  assert.equal(store.undo(), true);
  assert.ok(store.pendingCanvasIcons.has(childId));
  assert.equal(store.getCanvasIcon(childId), null);
  assert.equal(store.getCanvasIcon(nestedId), 'flag');
  assert.equal(store.pendingDeletedCanvasIds.has(nestedId), false);
  store.pendingCanvasIcons.clear();
  store.dirtyCanvasIds.clear();
  sync.connected = true;
}

async function testTreeRefreshesCannotRollBackIcons() {
  const firstStarted = deferred();
  const finishFirst = deferred();
  let requests = 0;
  globalThis.fetch = async () => {
    const isFirst = ++requests === 1;
    if (isFirst) {
      firstStarted.resolve();
      await finishFirst.promise;
    }
    return { ok: true, json: async () => ({ ok: true, data: [{ id: 'root', icon: isFirst ? 'star' : 'flag' }] }) };
  };
  const firstRefresh = store.refreshCanvasTree();
  await firstStarted.promise;
  await store.refreshCanvasTree();
  finishFirst.resolve();
  await firstRefresh;
  assert.equal(store.getCanvasIcon('root'), 'flag');
}

async function testNavigationCannotRollBackSavedIcon() {
  const childId = 'navigation-child';
  store.setCanvasTree([{ id: 'root', icon: null }, { id: childId, parentCanvasId: 'root', icon: 'star' }]);
  const getStarted = deferred();
  const finishGet = deferred();
  globalThis.fetch = async (url, { method = 'GET' } = {}) => {
    assert.equal(url, `/api/v1/canvases/${childId}`);
    if (method === 'PATCH') return { ok: true };
    getStarted.resolve();
    await finishGet.promise;
    return { ok: true, json: async () => ({ ok: true, data: { id: childId, parentCanvasId: 'root', icon: 'star' } }) };
  };
  const navigating = store.navigateToCanvas(childId);
  await getStarted.promise;
  assert.equal(await store.setCanvasIcon(childId, 'flag'), true);
  finishGet.resolve();
  assert.equal(await navigating, true);
  assert.equal(store.getCanvasIcon(childId), 'flag');
  assert.equal(store.canvasesCache.get(childId).icon, 'flag');
}

await runCase('request');
await runCase('refresh');
await runCase('none');
await testSettingsRequestsAreOrdered();
await testSettingsChangedWhileRefreshingTree();
delete store.flushPendingCanvasIcons;
delete store.flushCacheToIDBNow;
store.refreshCanvasTree = refreshCanvasTree;
store.getCanvasHierarchy = getCanvasHierarchy;
await testIconChangesDuringSave();
await testNewCanvasIconsSurviveFailedSaveAndReload();
await testUndoKeepsPendingIconForUnopenedCanvas();
await testTreeRefreshesCannotRollBackIcons();
await testNavigationCannotRollBackSavedIcon();
console.log('Save race regression cases passed');
