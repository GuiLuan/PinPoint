import { computeFocusExitLayout } from './focusLayout.js';
import { idbCache } from './cache.js';
import { computeLocalThumbnail } from './subcanvas.js';
import { DEFAULT_SHORTCUTS, normalizeShortcutString } from './shortcuts.js';

const API_BASE = '/api/v1';

export const DEFAULT_PALETTE = ['#5ca479', '#5c91cf', '#967bc2', '#c7a24f', '#c77b5c'];
export const PRESET_POOL = [
  '#5ca479', '#5c91cf', '#967bc2', '#c7a24f', '#c77b5c',
  '#c96b6b', '#5fa8b8', '#9c8d77', '#b87495', '#767ac7'
];

export const DEFAULT_APPEARANCE_SETTINGS = {
  theme: 'dark',
  accentColor: '#4c8dff',
  canvasTexture: 'dots'
};

export const DEFAULT_SAVE_SETTINGS = {
  mode: 'auto',
  intervalSec: 1
};

export const DEFAULT_MEDIA_SETTINGS = {
  webpageLoadMode: 'smart'
};

export const DEFAULT_NAVIGATION_SETTINGS = {
  wheelMode: 'auto'
};

export const VALID_TOAST_POSITIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];

export const DEFAULT_TOAST_SETTINGS = {
  position: 'bottom-left',
  durationSec: 5
};

export const DEFAULT_SETTINGS = {
  alignMode: false,
  gridSnapMode: false,
  palette: [...DEFAULT_PALETTE],
  appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
  minimap: {
    enabled: true,
    position: 'bottom-right',
    size: 220
  },
  library: {
    position: 'left',
    layout: 'grid',
    width: 348
  },
  save: { ...DEFAULT_SAVE_SETTINGS },
  media: { ...DEFAULT_MEDIA_SETTINGS },
  navigation: { ...DEFAULT_NAVIGATION_SETTINGS },
  toast: { ...DEFAULT_TOAST_SETTINGS },
  shortcuts: { ...DEFAULT_SHORTCUTS }
};

const DEFAULT_ROOT_STATE = {
  id: 'root',
  parentCanvasId: null,
  title: '主画布',
  breadcrumbs: [{ id: 'root', title: '主画布' }],
  viewport: { x: 0, y: 0, zoom: 1.0 },
  settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  cards: [
    {
      id: 'card-1',
      title: '灵感源头',
      x: 140,
      y: 200,
      width: 340,
      contentHtml: '记录最初的想法。你可以划选任意<span class="text-capsule" data-pin-id="pin-1"><i class="capsule-pin"></i>核心词汇</span>，直接连线到其他节点。'
    },
    {
      id: 'card-2',
      title: '衍生延展',
      x: 640,
      y: 190,
      width: 320,
      contentHtml: '节点完全纯粹，只有<span class="text-capsule capsule-blue" data-pin-id="pin-2"><i class="capsule-pin"></i>标题与内容</span>。点击头部或胶囊圆孔即可跨卡片连接。'
    }
  ],
  connections: [
    { id: 'conn-1', fromPinId: 'pin-1', toPinId: 'pin-2', color: '#30d158' }
  ],
  groups: []
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

class StateManager {
  constructor() {
    this.activeCanvasId = 'root';
    this.activeCanvasTitle = '主画布';
    this.parentCanvasId = null;
    this.breadcrumbs = [{ id: 'root', title: '主画布' }];

    this.state = {
      viewport: { x: 0, y: 0, zoom: 1.0 },
      settings: clone(DEFAULT_SETTINGS),
      cards: clone(DEFAULT_ROOT_STATE.cards),
      connections: clone(DEFAULT_ROOT_STATE.connections),
      groups: []
    };

    this.canvasesCache = new Map();
    this.dirtyCanvasIds = new Set();
    this.pendingDeletedCanvasIds = new Set();
    this.deletedSubcanvasTrash = new Map();
    this.settingsDirty = false;
    this.canvasTree = [{
      id: 'root',
      parentCanvasId: null,
      title: '主画布',
      depth: 0,
      breadcrumbs: [{ id: 'root', title: '主画布' }],
      cardCount: 2,
      subcanvasCount: 0
    }];

    this.listeners = new Set();
    this.cacheTimeout = null;
    this.undoStack = [this.snapshot()];
    this.redoStack = [];
    this.focusSession = null;
    this._idSeq = 0;
  }

  get isFocusMode() {
    return !!this.focusSession;
  }

  _nextId(prefix) {
    this._idSeq += 1;
    return `${prefix}-${Date.now()}-${this._idSeq}-${Math.floor(Math.random() * 1000)}`;
  }

  normalizeSettings(raw) {
    const s = raw || {};
    const palette = Array.isArray(s.palette) && s.palette.length >= 2 && s.palette.length <= 10
      ? [...s.palette]
      : [...DEFAULT_PALETTE];
    const mm = s.minimap || {};
    const lib = s.library || {};
    const sv = s.save || {};
    const saveMode = sv.mode === 'manual' ? 'manual' : 'auto';
    const intervalSec = typeof sv.intervalSec === 'number' && !Number.isNaN(sv.intervalSec)
      ? Math.max(1, Math.min(300, Math.round(sv.intervalSec)))
      : 1;
    const md = s.media || {};
    const webpageLoadMode = ['smart', 'lazy', 'eager'].includes(md.webpageLoadMode)
      ? md.webpageLoadMode
      : 'smart';
    const nv = s.navigation || {};
    const wheelMode = ['auto', 'trackpad', 'mouse'].includes(nv.wheelMode)
      ? nv.wheelMode
      : 'auto';
    const ts = s.toast || {};
    const toastPos = VALID_TOAST_POSITIONS.includes(ts.position) ? ts.position : 'bottom-left';
    const toastDur = typeof ts.durationSec === 'number' && !Number.isNaN(ts.durationSec)
      ? Math.max(2, Math.min(30, Math.round(ts.durationSec)))
      : 5;
    const ap = s.appearance || {};
    const theme = ap.theme === 'light' ? 'light' : 'dark';
    const accentColor = (typeof ap.accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(ap.accentColor.trim()))
      ? ap.accentColor.trim().toLowerCase()
      : DEFAULT_APPEARANCE_SETTINGS.accentColor;
    const canvasTexture = ['solid', 'dots', 'grid'].includes(ap.canvasTexture)
      ? ap.canvasTexture
      : DEFAULT_APPEARANCE_SETTINGS.canvasTexture;
    const scRaw = s.shortcuts || {};
    const shortcuts = { ...DEFAULT_SHORTCUTS };
    for (const k of Object.keys(DEFAULT_SHORTCUTS)) {
      if (typeof scRaw[k] === 'string') {
        shortcuts[k] = scRaw[k].trim() === '' ? '' : (normalizeShortcutString(scRaw[k]) || DEFAULT_SHORTCUTS[k]);
      }
    }
    return {
      alignMode: !!s.alignMode,
      gridSnapMode: !!s.gridSnapMode,
      palette,
      appearance: {
        theme,
        accentColor,
        canvasTexture
      },
      minimap: {
        enabled: mm.enabled ?? true,
        position: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(mm.position) ? mm.position : 'bottom-right',
        size: typeof mm.size === 'number' ? Math.max(140, Math.min(320, Math.round(mm.size))) : 220
      },
      library: {
        position: lib.position === 'right' ? 'right' : 'left',
        layout: lib.layout === 'list' ? 'list' : 'grid',
        width: typeof lib.width === 'number' ? Math.max(260, Math.min(800, Math.round(lib.width))) : 348
      },
      save: {
        mode: saveMode,
        intervalSec
      },
      media: {
        webpageLoadMode
      },
      navigation: {
        wheelMode
      },
      toast: {
        position: toastPos,
        durationSec: toastDur
      },
      shortcuts
    };
  }

  snapshot() {
    return JSON.stringify({
      cards: this.state.cards.map(c => {
        if (c.kind === 'subcanvas') {
          const { thumbnail, ...rest } = c;
          return rest;
        }
        return c;
      }),
      connections: this.state.connections,
      groups: this.state.groups || []
    });
  }

  hasUnsavedChanges() {
    if (this.isFocusMode) return true;
    return this.dirtyCanvasIds.size > 0 || this.pendingDeletedCanvasIds.size > 0 || this.settingsDirty;
  }

  isCanvasDirty(canvasId) {
    return this.dirtyCanvasIds.has(canvasId);
  }

  markDirty(canvasId = this.activeCanvasId) {
    if (this.isFocusMode) return;
    if (canvasId) {
      this.dirtyCanvasIds.add(canvasId);
    }
    this.scheduleCacheWrite();
    this.listeners.forEach(fn => fn({ type: 'DIRTY_CHANGED', canvasId }, this.state));
  }

  markSettingsDirty() {
    if (this.isFocusMode) return;
    this.settingsDirty = true;
    this.scheduleCacheWrite();
    this.listeners.forEach(fn => fn({ type: 'DIRTY_CHANGED', settingsDirty: true }, this.state));
  }

  clearDirtyFor(canvasIds = [], clearedSettings = false) {
    canvasIds.forEach(id => {
      this.dirtyCanvasIds.delete(id);
      const cached = this.canvasesCache.get(id);
      if (cached) {
        cached.dirty = false;
        idbCache.putCanvas(cached);
      }
    });
    if (clearedSettings) {
      this.settingsDirty = false;
    }
    idbCache.setMeta('dirtyCanvasIds', [...this.dirtyCanvasIds]);
    idbCache.setMeta('settingsDirty', this.settingsDirty);
    idbCache.setMeta('pendingDeletedCanvasIds', [...this.pendingDeletedCanvasIds]);
    this.listeners.forEach(fn => fn({ type: 'DIRTY_CHANGED' }, this.state));
  }

  async restoreFromIndexedDB() {
    try {
      const [cachedCanvases, activeId, cachedSettings, dirtyIds, deletedIds, settingsDirtyFlag] = await Promise.all([
        idbCache.getAllCanvases(),
        idbCache.getMeta('activeCanvasId'),
        idbCache.getMeta('settings'),
        idbCache.getMeta('dirtyCanvasIds'),
        idbCache.getMeta('pendingDeletedCanvasIds'),
        idbCache.getMeta('settingsDirty')
      ]);

      if (Array.isArray(cachedCanvases)) {
        cachedCanvases.forEach(c => {
          if (c?.id) this.canvasesCache.set(c.id, c);
        });
      }
      if (Array.isArray(dirtyIds)) {
        dirtyIds.forEach(id => this.dirtyCanvasIds.add(id));
      }
      if (Array.isArray(deletedIds)) {
        deletedIds.forEach(id => this.pendingDeletedCanvasIds.add(id));
      }
      if (settingsDirtyFlag) {
        this.settingsDirty = true;
      }
      if (cachedSettings) {
        this.state.settings = this.normalizeSettings(cachedSettings);
      }

      const hashMatch = window.location.hash?.match(/canvas=([^&]+)/);
      const targetId = (hashMatch ? decodeURIComponent(hashMatch[1]) : null) || activeId || 'root';
      const targetCached = this.canvasesCache.get(targetId) || this.canvasesCache.get('root');
      if (targetCached) {
        this._loadCacheEntryIntoActive(targetCached);
        return true;
      }
    } catch (e) {
      console.warn('[PinPoint Cache] Failed to restore IndexedDB cache:', e);
    }
    return false;
  }

  _loadCacheEntryIntoActive(entry) {
    this.activeCanvasId = entry.id || 'root';
    this.activeCanvasTitle = entry.title || (this.activeCanvasId === 'root' ? '主画布' : '子画布');
    this.parentCanvasId = entry.parentCanvasId ?? null;
    this.breadcrumbs = Array.isArray(entry.breadcrumbs) && entry.breadcrumbs.length > 0
      ? clone(entry.breadcrumbs)
      : [{ id: this.activeCanvasId, title: this.activeCanvasTitle }];

    this.state.viewport = clone(entry.viewport || { x: 0, y: 0, zoom: 1.0 });
    this.state.cards = clone(entry.cards || []);
    this.state.connections = (clone(entry.connections || [])).filter(c => this.validateConnection(c, this.state.cards, entry.groups || []));
    this.state.groups = clone(entry.groups || []);
    this._refreshSubcanvasThumbnailsOnActive();

    this.undoStack = Array.isArray(entry.undoStack) && entry.undoStack.length > 0
      ? [...entry.undoStack]
      : [this.snapshot()];
    this.redoStack = Array.isArray(entry.redoStack) ? [...entry.redoStack] : [];
  }

  _saveActiveToCacheMap(isDirty = this.dirtyCanvasIds.has(this.activeCanvasId)) {
    const entry = {
      id: this.activeCanvasId,
      parentCanvasId: this.parentCanvasId,
      title: this.activeCanvasTitle,
      breadcrumbs: clone(this.breadcrumbs),
      viewport: clone(this.state.viewport),
      cards: clone(this.state.cards),
      connections: clone(this.state.connections),
      groups: clone(this.state.groups || []),
      undoStack: [...this.undoStack],
      redoStack: [...this.redoStack],
      dirty: !!isDirty,
      updatedAt: Date.now()
    };
    this.canvasesCache.set(this.activeCanvasId, entry);
    return entry;
  }

  scheduleCacheWrite() {
    if (this.isFocusMode) return;
    clearTimeout(this.cacheTimeout);
    this.cacheTimeout = setTimeout(() => {
      this.flushCacheToIDBNow();
    }, 220);
  }

  async flushCacheToIDBNow() {
    if (this.isFocusMode) return;
    const entry = this._saveActiveToCacheMap(this.dirtyCanvasIds.has(this.activeCanvasId));
    await Promise.all([
      idbCache.putCanvas(entry),
      idbCache.setMeta('activeCanvasId', this.activeCanvasId),
      idbCache.setMeta('settings', this.state.settings),
      idbCache.setMeta('dirtyCanvasIds', [...this.dirtyCanvasIds]),
      idbCache.setMeta('pendingDeletedCanvasIds', [...this.pendingDeletedCanvasIds]),
      idbCache.setMeta('settingsDirty', this.settingsDirty)
    ]);
  }

  scheduleAutoSave() {
    this.markDirty(this.activeCanvasId);
  }

  _refreshSubcanvasThumbnailsOnActive() {
    for (const card of this.state.cards) {
      if (card.kind === 'subcanvas' && card.subcanvasId) {
        const cachedSub = this.canvasesCache.get(card.subcanvasId);
        if (cachedSub && (cachedSub.dirty || this.dirtyCanvasIds.has(card.subcanvasId) || !card.thumbnail)) {
          card.thumbnail = computeLocalThumbnail(cachedSub);
        }
      }
    }
  }

  getThumbnailForSubcanvas(card) {
    if (!card || card.kind !== 'subcanvas') return null;
    const subId = card.subcanvasId;
    if (subId) {
      const cached = this.canvasesCache.get(subId);
      if (cached && (cached.dirty || this.dirtyCanvasIds.has(subId))) {
        return computeLocalThumbnail(cached);
      }
    }
    return card.thumbnail || computeLocalThumbnail({ id: subId, title: card.title, cards: [], groups: [], connections: [] });
  }

  commit() {
    const snap = this.snapshot();
    if (this.undoStack.length > 0 && this.undoStack[this.undoStack.length - 1] === snap) {
      return;
    }
    this.undoStack.push(snap);
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
    this.markDirty(this.activeCanvasId);
    this.notify({ type: 'HISTORY_CHANGED' });
  }

  canUndo() {
    return this.undoStack.length > 1;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (this.undoStack.length <= 1) return false;
    const prevSubIds = new Set(
      this.state.cards.filter(c => c.kind === 'subcanvas' && c.subcanvasId).map(c => c.subcanvasId)
    );
    const current = this.undoStack.pop();
    this.redoStack.push(current);
    const prevSnap = this.undoStack[this.undoStack.length - 1];
    const data = JSON.parse(prevSnap);
    this.state.cards = clone(data.cards);
    this.state.connections = clone(data.connections);
    this.state.groups = clone(data.groups || []);
    const nextSubIds = new Set(
      this.state.cards.filter(c => c.kind === 'subcanvas' && c.subcanvasId).map(c => c.subcanvasId)
    );
    let treeChanged = false;
    for (const sid of prevSubIds) {
      if (!nextSubIds.has(sid)) {
        this._markSubcanvasSubtreeDeleted(sid);
        treeChanged = true;
      }
    }
    for (const sid of nextSubIds) {
      if (!prevSubIds.has(sid)) {
        this._restoreSubcanvasSubtree(sid);
        treeChanged = true;
      }
    }
    this._refreshSubcanvasThumbnailsOnActive();
    this.markDirty(this.activeCanvasId);
    this.notify({ type: 'STATE_RESTORED' });
    if (treeChanged) {
      this.listeners.forEach(fn => fn({ type: 'CANVAS_TREE_UPDATED', tree: this.getCanvasHierarchy() }, this.state));
    }
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    const prevSubIds = new Set(
      this.state.cards.filter(c => c.kind === 'subcanvas' && c.subcanvasId).map(c => c.subcanvasId)
    );
    const nextSnap = this.redoStack.pop();
    this.undoStack.push(nextSnap);
    const data = JSON.parse(nextSnap);
    this.state.cards = clone(data.cards);
    this.state.connections = clone(data.connections);
    this.state.groups = clone(data.groups || []);
    const nextSubIds = new Set(
      this.state.cards.filter(c => c.kind === 'subcanvas' && c.subcanvasId).map(c => c.subcanvasId)
    );
    let treeChanged = false;
    for (const sid of prevSubIds) {
      if (!nextSubIds.has(sid)) {
        this._markSubcanvasSubtreeDeleted(sid);
        treeChanged = true;
      }
    }
    for (const sid of nextSubIds) {
      if (!prevSubIds.has(sid)) {
        this._restoreSubcanvasSubtree(sid);
        treeChanged = true;
      }
    }
    this._refreshSubcanvasThumbnailsOnActive();
    this.markDirty(this.activeCanvasId);
    this.notify({ type: 'STATE_RESTORED' });
    if (treeChanged) {
      this.listeners.forEach(fn => fn({ type: 'CANVAS_TREE_UPDATED', tree: this.getCanvasHierarchy() }, this.state));
    }
    return true;
  }

  applyRemoteCanvas(canvasPayload, sourceEvent = 'REMOTE_SYNCED') {
    if (this.isFocusMode || !canvasPayload) return false;
    const cid = canvasPayload.id || canvasPayload.canvasId || this.activeCanvasId;
    if (cid !== this.activeCanvasId) return false;
    if (!Array.isArray(canvasPayload.cards) || !Array.isArray(canvasPayload.connections)) return false;

    if (canvasPayload.title) this.activeCanvasTitle = canvasPayload.title;
    if (canvasPayload.parentCanvasId !== undefined) this.parentCanvasId = canvasPayload.parentCanvasId;
    if (Array.isArray(canvasPayload.breadcrumbs) && canvasPayload.breadcrumbs.length > 0) {
      this.breadcrumbs = clone(canvasPayload.breadcrumbs);
    }

    const cards = clone(canvasPayload.cards);
    const groups = clone(canvasPayload.groups || []);
    const connections = clone(canvasPayload.connections).filter(c => this.validateConnection(c, cards, groups));

    const prevVpJson = JSON.stringify(this.state.viewport);
    if (canvasPayload.viewport) {
      this.state.viewport = {
        x: Number(canvasPayload.viewport.x ?? this.state.viewport.x ?? 0),
        y: Number(canvasPayload.viewport.y ?? this.state.viewport.y ?? 0),
        zoom: Number(canvasPayload.viewport.zoom ?? this.state.viewport.zoom ?? 1.0)
      };
    }

    if (canvasPayload.settings && !this.settingsDirty) {
      this.state.settings = this.normalizeSettings(canvasPayload.settings);
    }

    const prevSnap = this.snapshot();
    this.state.cards = cards;
    this.state.connections = connections;
    this.state.groups = groups;
    this._refreshSubcanvasThumbnailsOnActive();
    const nextSnap = this.snapshot();
    const nextVpJson = JSON.stringify(this.state.viewport);

    if (sourceEvent === 'GRAPH_REPLACED' || sourceEvent === 'STATE_RESET' || sourceEvent === 'CONNECTED' || sourceEvent === 'CANVAS_LOADED') {
      this.undoStack = [nextSnap];
      this.redoStack = [];
    } else if (nextSnap !== prevSnap) {
      this.undoStack.push(nextSnap);
      if (this.undoStack.length > 60) this.undoStack.shift();
      this.redoStack = [];
    }

    const entry = this._saveActiveToCacheMap(false);
    idbCache.putCanvas(entry);
    if ((sourceEvent === 'CONNECTED' || sourceEvent === 'GRAPH_SYNCED') && nextSnap === prevSnap && prevVpJson === nextVpJson) {
      return true;
    }
    this.listeners.forEach(fn => fn({ type: 'REMOTE_SYNCED', sourceEvent }, this.state));
    return true;
  }

  applyRemoteState(remoteState, sourceEvent = 'REMOTE_SYNCED') {
    return this.applyRemoteCanvas({ id: this.activeCanvasId, ...remoteState }, sourceEvent);
  }

  setCanvasTree(treeRows) {
    if (Array.isArray(treeRows)) {
      this.canvasTree = clone(treeRows);
      this.listeners.forEach(fn => fn({ type: 'CANVAS_TREE_UPDATED', tree: this.canvasTree }, this.state));
    }
  }

  getCanvasHierarchy() {
    const map = new Map();
    for (const row of this.canvasTree || []) {
      if (!this.pendingDeletedCanvasIds.has(row.id)) {
        map.set(row.id, clone(row));
      }
    }

    // Merge local unsaved canvases from cache
    const ensureParentBreadcrumbs = (cid, visited = new Set()) => {
      if (visited.has(cid)) return [];
      visited.add(cid);
      const item = map.get(cid);
      if (!item) return [];
      if (!item.parentCanvasId) return [{ id: item.id, title: item.title }];
      const pCrumbs = ensureParentBreadcrumbs(item.parentCanvasId, visited);
      return [...pCrumbs, { id: item.id, title: item.title }];
    };

    for (const [cid, entry] of this.canvasesCache.entries()) {
      if (this.pendingDeletedCanvasIds.has(cid)) continue;
      const cards = cid === this.activeCanvasId ? this.state.cards : (entry.cards || []);
      const cardCount = cards.filter(c => c.kind !== 'subcanvas').length;
      const subcanvasCount = cards.filter(c => c.kind === 'subcanvas').length;
      const existing = map.get(cid) || {};
      map.set(cid, {
        ...existing,
        id: cid,
        parentCanvasId: entry.parentCanvasId !== undefined ? entry.parentCanvasId : (existing.parentCanvasId ?? null),
        title: (cid === this.activeCanvasId ? this.activeCanvasTitle : entry.title) || existing.title || (cid === 'root' ? '主画布' : '子画布'),
        cardCount,
        subcanvasCount,
        dirty: this.dirtyCanvasIds.has(cid)
      });
    }

    // Any parent canvas whose cards are loaded in memory defines its exact set of child subcanvasIds;
    // filter out stale/orphan canvases not referenced by any subcanvas card in a loaded parent.
    const loadedParentChildren = new Map();
    loadedParentChildren.set(
      this.activeCanvasId,
      new Set(this.state.cards.filter(c => c.kind === 'subcanvas' && c.subcanvasId).map(c => c.subcanvasId))
    );
    for (const [cid, entry] of this.canvasesCache.entries()) {
      if (cid === this.activeCanvasId) continue;
      loadedParentChildren.set(
        cid,
        new Set((entry.cards || []).filter(c => c.kind === 'subcanvas' && c.subcanvasId).map(c => c.subcanvasId))
      );
    }

    for (const [cid, node] of [...map.entries()]) {
      if (cid === 'root') continue;
      const pid = node.parentCanvasId;
      if (pid && loadedParentChildren.has(pid) && !loadedParentChildren.get(pid).has(cid)) {
        map.delete(cid);
      }
    }

    const result = [...map.values()].map(node => {
      const crumbs = ensureParentBreadcrumbs(node.id);
      return {
        ...node,
        breadcrumbs: crumbs,
        depth: Math.max(0, crumbs.length - 1),
        dirty: this.dirtyCanvasIds.has(node.id)
      };
    });

    // Tree DFS order from root so unreachable orphans never appear in hierarchy
    const childrenByParent = new Map();
    for (const node of result) {
      const p = node.parentCanvasId || '__root_parent__';
      if (!childrenByParent.has(p)) childrenByParent.set(p, []);
      childrenByParent.get(p).push(node);
    }
    const ordered = [];
    const walk = (pid) => {
      const kids = childrenByParent.get(pid) || [];
      for (const k of kids) {
        ordered.push(k);
        walk(k.id);
      }
    };
    walk('__root_parent__');
    return ordered;
  }

  async refreshCanvasTree() {
    try {
      const res = await fetch(`${API_BASE}/canvases`);
      if (res.ok) {
        const body = await res.json();
        if (body?.ok && Array.isArray(body.data)) {
          this.setCanvasTree(body.data);
          return body.data;
        }
      }
    } catch (e) {}
    return this.getCanvasHierarchy();
  }

  async renameCanvas(canvasId, newTitle) {
    if (!canvasId) return false;
    const cleanTitle = String(newTitle || '').trim() || (canvasId === 'root' ? '主画布' : '未命名子画布');

    // 1. Update canvasTree
    if (Array.isArray(this.canvasTree)) {
      const row = this.canvasTree.find(r => r.id === canvasId);
      if (row) row.title = cleanTitle;
    }

    // 2. Update active canvas title & breadcrumbs
    if (this.activeCanvasId === canvasId) {
      this.activeCanvasTitle = cleanTitle;
    }
    this.breadcrumbs = (this.breadcrumbs || []).map(b =>
      b.id === canvasId ? { ...b, title: cleanTitle } : b
    );

    // 3. Update active canvas subcanvas card if child is on current canvas
    const activeSubCard = this.state.cards.find(c => c.kind === 'subcanvas' && c.subcanvasId === canvasId);
    if (activeSubCard && activeSubCard.title !== cleanTitle) {
      activeSubCard.title = cleanTitle;
      this.markDirty(this.activeCanvasId);
      this.notify({ type: 'CARD_UPDATED', cardId: activeSubCard.id });
    }

    // 4. Update cached canvases (title, breadcrumbs, and parent card title)
    for (const entry of this.canvasesCache.values()) {
      let changed = false;
      if (entry.id === canvasId && entry.title !== cleanTitle) {
        entry.title = cleanTitle;
        changed = true;
      }
      if (Array.isArray(entry.breadcrumbs)) {
        const idx = entry.breadcrumbs.findIndex(b => b.id === canvasId);
        if (idx >= 0 && entry.breadcrumbs[idx].title !== cleanTitle) {
          entry.breadcrumbs = entry.breadcrumbs.map(b => b.id === canvasId ? { ...b, title: cleanTitle } : b);
          changed = true;
        }
      }
      if (Array.isArray(entry.cards)) {
        const card = entry.cards.find(c => c.kind === 'subcanvas' && c.subcanvasId === canvasId);
        if (card && card.title !== cleanTitle) {
          card.title = cleanTitle;
          changed = true;
        }
      }
      if (changed) {
        idbCache.putCanvas(entry);
      }
    }

    if (this.activeCanvasId === canvasId) {
      const activeEntry = this._saveActiveToCacheMap(this.dirtyCanvasIds.has(canvasId));
      idbCache.putCanvas(activeEntry);
    }

    // 5. Persist to backend when online, or mark dirty for later sync
    let persistedOnline = false;
    if (window.__sync?.connected) {
      try {
        const res = await fetch(`${API_BASE}/canvases/${encodeURIComponent(canvasId)}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-PinPoint-Client': window.__sync.clientId || ''
          },
          body: JSON.stringify({ title: cleanTitle })
        });
        if (res.ok) persistedOnline = true;
      } catch (e) {}
    }

    if (!persistedOnline) {
      this.markDirty(canvasId);
      this.scheduleAutoSave();
    }

    this.listeners.forEach(fn => fn({ type: 'CANVAS_TREE_UPDATED', tree: this.getCanvasHierarchy() }, this.state));
    return true;
  }

  async deleteCanvases(canvasIds) {
    if (this.isFocusMode) {
      this.emitToast('当前处于专注模式，请先退出专注模式后再删除画布', 'warning');
      return { blocked: true, reason: 'focus-mode' };
    }
    const rawList = Array.isArray(canvasIds) ? canvasIds : [canvasIds];
    const uniqueIds = [...new Set(rawList.filter(Boolean))];
    if (uniqueIds.length === 0) return { deletedCount: 0, deletedIds: [] };

    const deletableIds = uniqueIds.filter(id => id !== 'root');
    if (deletableIds.length === 0) {
      this.emitToast('主画布不能删除', 'warning');
      return { deletedCount: 0, deletedIds: [], rootSkipped: true };
    }

    const hierarchy = this.getCanvasHierarchy();
    const rowMap = new Map(hierarchy.map(r => [r.id, r]));
    const validTargets = deletableIds.filter(id => rowMap.has(id));
    if (validTargets.length === 0) return { deletedCount: 0, deletedIds: [] };

    const targetSet = new Set(validTargets);
    const hasSelectedAncestor = (cid) => {
      let pid = rowMap.get(cid)?.parentCanvasId;
      const seen = new Set([cid]);
      while (pid && !seen.has(pid)) {
        seen.add(pid);
        if (targetSet.has(pid)) return true;
        pid = rowMap.get(pid)?.parentCanvasId || null;
      }
      return false;
    };
    const topTargets = validTargets.filter(id => !hasSelectedAncestor(id));

    const allDeletedIds = new Set();
    for (const sid of topTargets) {
      allDeletedIds.add(sid);
      for (const did of this._collectDescendantCanvasIdsLocal(sid)) {
        allDeletedIds.add(did);
      }
    }

    // If the currently active canvas is inside a deleted subtree, switch to nearest surviving ancestor
    if (allDeletedIds.has(this.activeCanvasId)) {
      let safeParent = rowMap.get(this.activeCanvasId)?.parentCanvasId || 'root';
      const seen = new Set([this.activeCanvasId]);
      while (safeParent && allDeletedIds.has(safeParent) && !seen.has(safeParent)) {
        seen.add(safeParent);
        safeParent = rowMap.get(safeParent)?.parentCanvasId || 'root';
      }
      if (!safeParent || allDeletedIds.has(safeParent)) safeParent = 'root';
      await this.navigateToCanvas(safeParent);
    }

    const activeCardIdsToRemove = [];
    const nonActiveByParent = new Map();

    for (const sid of topTargets) {
      const pid = rowMap.get(sid)?.parentCanvasId;
      if (!pid) {
        this._markSubcanvasSubtreeDeleted(sid);
        continue;
      }
      if (pid === this.activeCanvasId) {
        const cardIds = this.state.cards
          .filter(c => c.kind === 'subcanvas' && c.subcanvasId === sid)
          .map(c => c.id);
        activeCardIdsToRemove.push(...cardIds);
      } else {
        if (!nonActiveByParent.has(pid)) nonActiveByParent.set(pid, []);
        nonActiveByParent.get(pid).push(sid);
      }
    }

    // Update any non-active parent canvases so their portal cards and connections stay consistent
    for (const [pid, childSids] of nonActiveByParent.entries()) {
      let parentEntry = this.canvasesCache.get(pid);
      if (!parentEntry) {
        try {
          const res = await fetch(`${API_BASE}/canvases/${encodeURIComponent(pid)}`);
          if (res.ok) {
            const json = await res.json();
            if (json?.ok && json.data) {
              parentEntry = {
                id: pid,
                parentCanvasId: json.data.parentCanvasId ?? null,
                title: json.data.title || (pid === 'root' ? '主画布' : '子画布'),
                breadcrumbs: json.data.breadcrumbs || [{ id: pid, title: json.data.title || '画布' }],
                viewport: json.data.viewport || { x: 0, y: 0, zoom: 1.0 },
                cards: json.data.cards || [],
                connections: json.data.connections || [],
                groups: json.data.groups || [],
                dirty: false,
                updatedAt: Date.now()
              };
            }
          }
        } catch (e) {}
      }

      if (parentEntry) {
        const childSidSet = new Set(childSids);
        const removedCardIds = new Set(
          (parentEntry.cards || [])
            .filter(c => c.kind === 'subcanvas' && childSidSet.has(c.subcanvasId))
            .map(c => c.id)
        );
        parentEntry.cards = (parentEntry.cards || []).filter(c => !removedCardIds.has(c.id));
        const removedGroupPinIds = new Set();
        if (Array.isArray(parentEntry.groups)) {
          parentEntry.groups.forEach(g => {
            g.cardIds = (g.cardIds || []).filter(id => !removedCardIds.has(id));
            if (g.cardIds.length < 2) {
              removedGroupPinIds.add(`pin-group-left-${g.id}`);
              removedGroupPinIds.add(`pin-group-right-${g.id}`);
            }
          });
          parentEntry.groups = parentEntry.groups.filter(g => g.cardIds.length >= 2);
        }
        const findOwnerInEntry = (pinId) => {
          if (!pinId) return null;
          if (pinId.startsWith('pin-head-')) {
            return pinId.replace(/^pin-head-(?:left-|right-)?/, '');
          }
          if (pinId.startsWith('pin-group-')) {
            return pinId.replace(/^pin-group-(?:left-|right-)?/, '');
          }
          for (const c of parentEntry.cards || []) {
            if (c.contentHtml && c.contentHtml.includes(pinId)) return c.id;
          }
          return null;
        };
        parentEntry.connections = (parentEntry.connections || []).filter(conn => {
          if (removedGroupPinIds.has(conn.fromPinId) || removedGroupPinIds.has(conn.toPinId)) return false;
          const o1 = findOwnerInEntry(conn.fromPinId);
          const o2 = findOwnerInEntry(conn.toPinId);
          return (!o1 || !removedCardIds.has(o1)) && (!o2 || !removedCardIds.has(o2));
        });
        parentEntry.dirty = true;
        parentEntry.updatedAt = Date.now();
        this.canvasesCache.set(pid, parentEntry);
        this.dirtyCanvasIds.add(pid);
        await idbCache.putCanvas(parentEntry);
      }

      for (const sid of childSids) {
        this._markSubcanvasSubtreeDeleted(sid);
      }
    }

    if (activeCardIdsToRemove.length > 0) {
      this.removeCards(activeCardIdsToRemove);
    }

    // Mark any remaining topTargets (e.g. if parent wasn't cached offline)
    for (const sid of topTargets) {
      if (!this.pendingDeletedCanvasIds.has(sid)) {
        this._markSubcanvasSubtreeDeleted(sid);
      }
    }

    if (activeCardIdsToRemove.length === 0) {
      this._saveActiveToCacheMap(this.dirtyCanvasIds.has(this.activeCanvasId));
      await this.flushCacheToIDBNow();
      this.listeners.forEach(fn => fn({ type: 'DIRTY_CHANGED', dirtyCanvasIds: [...this.dirtyCanvasIds] }, this.state));
      this.listeners.forEach(fn => fn({ type: 'CANVAS_TREE_UPDATED', tree: this.getCanvasHierarchy() }, this.state));
    }

    const skippedRootNote = uniqueIds.includes('root') ? '（已保留主画布）' : '';
    this.emitToast(`已删除 ${topTargets.length} 个子画布${skippedRootNote}`, 'success');
    return {
      deletedCount: topTargets.length,
      deletedIds: [...allDeletedIds],
      activeModified: activeCardIdsToRemove.length > 0
    };
  }

  async createSubcanvas({ x, y, title = '未命名子画布', headerColor = null, width = 300, height = 180, cardIds = null } = {}) {
    if (this.isFocusMode) {
      this.emitToast('请先退出专注模式后再新建子画布', 'warning');
      return null;
    }

    const subcanvasId = this._nextId('canvas');
    const cardId = this._nextId('card');
    const cleanTitle = (title || '').trim() || '未命名子画布';

    let movedCards = [];
    let movedGroups = [];
    let movedConns = [];
    if (Array.isArray(cardIds) && cardIds.length > 0) {
      const packSet = new Set(cardIds);
      movedCards = clone(this.state.cards.filter(c => packSet.has(c.id)));
      if (movedCards.length > 0) {
        const minX = Math.min(...movedCards.map(c => c.x));
        const minY = Math.min(...movedCards.map(c => c.y));
        movedCards.forEach(mc => {
          mc.x = Math.round(mc.x - minX + 140);
          mc.y = Math.round(mc.y - minY + 180);
          if (mc.kind === 'subcanvas' && mc.subcanvasId) {
            const subEntry = this.canvasesCache.get(mc.subcanvasId);
            if (subEntry) {
              subEntry.parentCanvasId = subcanvasId;
              idbCache.putCanvas(subEntry);
            }
          }
        });
        movedGroups = clone((this.state.groups || []).filter(g => g.cardIds?.length >= 2 && g.cardIds.every(id => packSet.has(id))));
        const owners = new Set([...packSet, ...movedGroups.map(g => g.id)]);
        movedConns = clone(this.state.connections.filter(cn => {
          const o1 = this.findCardIdByPin(cn.fromPinId);
          const o2 = this.findCardIdByPin(cn.toPinId);
          return o1 && o2 && owners.has(o1) && owners.has(o2);
        }));
        this.removeCards(cardIds);
      }
    }

    const childEntry = {
      id: subcanvasId,
      parentCanvasId: this.activeCanvasId,
      title: cleanTitle,
      breadcrumbs: [...this.breadcrumbs, { id: subcanvasId, title: cleanTitle }],
      viewport: { x: 0, y: 0, zoom: 1.0 },
      cards: movedCards,
      connections: movedConns,
      groups: movedGroups,
      dirty: true,
      updatedAt: Date.now()
    };
    this.canvasesCache.set(subcanvasId, childEntry);
    this.dirtyCanvasIds.add(subcanvasId);
    idbCache.putCanvas(childEntry);

    const card = {
      id: cardId,
      kind: 'subcanvas',
      subcanvasId,
      title: cleanTitle,
      x: Math.round(x ?? 140),
      y: Math.round(y ?? 200),
      width: Math.max(250, Math.round(width)),
      height: Math.max(120, Math.round(height)),
      contentHtml: '',
      thumbnail: computeLocalThumbnail(childEntry)
    };
    if (headerColor) card.headerColor = headerColor;

    this.state.cards.push(card);
    this.commit();
    this._saveActiveToCacheMap(true);
    this.notify({ type: 'CARD_ADDED', card });
    this.listeners.forEach(fn => fn({ type: 'CANVAS_TREE_UPDATED', tree: this.getCanvasHierarchy() }, this.state));
    return card;
  }

  async navigateToCanvas(targetCanvasId) {
    if (!targetCanvasId || targetCanvasId === this.activeCanvasId) return true;
    if (this.isFocusMode) {
      this.emitToast('当前处于专注模式，请先确认或取消专注模式后再切换画布', 'warning');
      return false;
    }

    // Save current active canvas to memory + IndexedDB
    const curEntry = this._saveActiveToCacheMap(this.dirtyCanvasIds.has(this.activeCanvasId));
    await idbCache.putCanvas(curEntry);

    let targetData = null;
    const cached = this.canvasesCache.get(targetCanvasId);

    if (cached && (cached.dirty || this.dirtyCanvasIds.has(targetCanvasId))) {
      targetData = cached;
    } else {
      try {
        const res = await fetch(`${API_BASE}/canvases/${encodeURIComponent(targetCanvasId)}`);
        if (res.ok) {
          const json = await res.json();
          if (json?.ok && json.data) {
            targetData = {
              id: json.data.id || targetCanvasId,
              parentCanvasId: json.data.parentCanvasId ?? null,
              title: json.data.title || '子画布',
              breadcrumbs: json.data.breadcrumbs || [{ id: targetCanvasId, title: json.data.title || '子画布' }],
              viewport: json.data.viewport || { x: 0, y: 0, zoom: 1.0 },
              cards: json.data.cards || [],
              connections: json.data.connections || [],
              groups: json.data.groups || [],
              dirty: false,
              updatedAt: Date.now()
            };
            this.canvasesCache.set(targetCanvasId, targetData);
            await idbCache.putCanvas(targetData);
          }
        }
      } catch (e) {}
    }

    if (!targetData && cached) {
      targetData = cached;
    }
    if (!targetData) {
      const idbFallback = await idbCache.getCanvas(targetCanvasId);
      if (idbFallback) targetData = idbFallback;
    }
    if (!targetData) {
      this.emitToast('无法加载目标子画布', 'warning');
      return false;
    }

    // Ensure parent subcanvas card title stays synced into breadcrumbs/title
    if (targetData.parentCanvasId) {
      const parentCached = this.canvasesCache.get(targetData.parentCanvasId);
      const parentCard = parentCached?.cards?.find(c => c.kind === 'subcanvas' && c.subcanvasId === targetCanvasId);
      if (parentCard && parentCard.title) {
        targetData.title = parentCard.title;
      }
      if (parentCached?.breadcrumbs) {
        targetData.breadcrumbs = [...parentCached.breadcrumbs, { id: targetCanvasId, title: targetData.title }];
      }
    }

    this._loadCacheEntryIntoActive(targetData);
    await idbCache.setMeta('activeCanvasId', this.activeCanvasId);
    try {
      window.location.hash = this.activeCanvasId === 'root' ? '' : `canvas=${encodeURIComponent(this.activeCanvasId)}`;
    } catch (e) {}

    this.listeners.forEach(fn => fn({ type: 'CANVAS_SWITCHED', canvasId: this.activeCanvasId }, this.state));
    return true;
  }

  _collectDescendantCanvasIdsLocal(canvasId) {
    const out = [];
    const queue = [canvasId];
    const seen = new Set([canvasId]);
    while (queue.length > 0) {
      const cur = queue.shift();
      const entry = cur === this.activeCanvasId
        ? { cards: this.state.cards }
        : this.canvasesCache.get(cur);
      if (entry?.cards) {
        for (const c of entry.cards) {
          if (c.kind === 'subcanvas' && c.subcanvasId && !seen.has(c.subcanvasId)) {
            seen.add(c.subcanvasId);
            out.push(c.subcanvasId);
            queue.push(c.subcanvasId);
          }
        }
      }
      for (const row of this.canvasTree || []) {
        if (row.parentCanvasId === cur && !seen.has(row.id)) {
          seen.add(row.id);
          out.push(row.id);
          queue.push(row.id);
        }
      }
    }
    return out;
  }

  putCachedCanvas(entry) {
    if (!entry || !entry.id) return;
    this.pendingDeletedCanvasIds.delete(entry.id);
    this.canvasesCache.set(entry.id, entry);
    if (entry.dirty) {
      this.dirtyCanvasIds.add(entry.id);
    }
    idbCache.putCanvas(entry);
  }

  notifyCanvasTreeUpdated() {
    this.listeners.forEach(fn => fn({ type: 'CANVAS_TREE_UPDATED', tree: this.getCanvasHierarchy() }, this.state));
  }

  _extractSubcanvasSnapshot(entry, fallbackId) {
    if (!entry) return null;
    return {
      id: entry.id || fallbackId,
      title: entry.title || '子画布',
      viewport: clone(entry.viewport || { x: 0, y: 0, zoom: 1.0 }),
      cards: clone(entry.cards || []).map(c => {
        if (c.kind === 'subcanvas') {
          const { thumbnail, ...rest } = c;
          return rest;
        }
        return c;
      }),
      connections: clone(entry.connections || []),
      groups: clone(entry.groups || [])
    };
  }

  collectCachedSubcanvasSubtreeSync(rootSubIds = []) {
    const out = {};
    const queue = [...rootSubIds].filter(Boolean);
    const seen = new Set();

    while (queue.length > 0) {
      const sid = queue.shift();
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);

      let entry = null;
      if (sid === this.activeCanvasId) {
        entry = {
          id: this.activeCanvasId,
          title: this.activeCanvasTitle,
          viewport: this.state.viewport,
          cards: this.state.cards,
          connections: this.state.connections,
          groups: this.state.groups || []
        };
      } else {
        entry = this.canvasesCache.get(sid) || this.deletedSubcanvasTrash.get(sid) || null;
      }

      if (!entry) continue;
      const snap = this._extractSubcanvasSnapshot(entry, sid);
      out[sid] = snap;
      for (const c of snap.cards || []) {
        if (c.kind === 'subcanvas' && c.subcanvasId && !seen.has(c.subcanvasId)) {
          queue.push(c.subcanvasId);
        }
      }
    }
    return out;
  }

  async collectSubcanvasSubtree(rootSubIds = []) {
    const out = {};
    const queue = [...rootSubIds].filter(Boolean);
    const seen = new Set();

    while (queue.length > 0) {
      const sid = queue.shift();
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);

      let entry = null;
      if (sid === this.activeCanvasId) {
        entry = {
          id: this.activeCanvasId,
          title: this.activeCanvasTitle,
          viewport: this.state.viewport,
          cards: this.state.cards,
          connections: this.state.connections,
          groups: this.state.groups || []
        };
      } else {
        entry = this.canvasesCache.get(sid) || null;
      }

      if (!entry) {
        try {
          const idbEntry = await idbCache.getCanvas(sid);
          if (idbEntry) {
            entry = idbEntry;
            if (!this.canvasesCache.has(sid) && !this.pendingDeletedCanvasIds.has(sid)) {
              this.canvasesCache.set(sid, idbEntry);
            }
          }
        } catch (e) {}
      }

      if (!entry && !this.pendingDeletedCanvasIds.has(sid)) {
        try {
          const res = await fetch(`${API_BASE}/canvases/${encodeURIComponent(sid)}/export?includeSubcanvases=true`);
          if (res.ok) {
            const json = await res.json();
            const data = json?.ok && json.data ? json.data : null;
            if (data) {
              entry = {
                id: sid,
                parentCanvasId: null,
                title: data.title || '子画布',
                viewport: data.viewport || { x: 0, y: 0, zoom: 1.0 },
                cards: data.cards || [],
                connections: data.connections || [],
                groups: data.groups || [],
                dirty: false,
                updatedAt: Date.now()
              };
              if (!this.canvasesCache.has(sid)) {
                this.canvasesCache.set(sid, entry);
              }
              const nestedMap = data.subcanvases || {};
              for (const [nestedId, nestedData] of Object.entries(nestedMap)) {
                if (!nestedId || !nestedData || seen.has(nestedId)) continue;
                const nestedSnap = this._extractSubcanvasSnapshot(nestedData, nestedId);
                out[nestedId] = nestedSnap;
                seen.add(nestedId);
                if (!this.canvasesCache.has(nestedId) && !this.pendingDeletedCanvasIds.has(nestedId)) {
                  this.canvasesCache.set(nestedId, {
                    id: nestedId,
                    parentCanvasId: nestedData.parentCanvasId ?? null,
                    title: nestedSnap.title,
                    viewport: clone(nestedSnap.viewport),
                    cards: clone(nestedSnap.cards),
                    connections: clone(nestedSnap.connections),
                    groups: clone(nestedSnap.groups),
                    dirty: false,
                    updatedAt: Date.now()
                  });
                }
                for (const sc of nestedSnap.cards || []) {
                  if (sc.kind === 'subcanvas' && sc.subcanvasId && !seen.has(sc.subcanvasId)) {
                    queue.push(sc.subcanvasId);
                  }
                }
              }
            }
          }
        } catch (e) {}
      }

      if (!entry) {
        entry = this.deletedSubcanvasTrash.get(sid) || null;
      }

      if (!entry) continue;
      const snap = this._extractSubcanvasSnapshot(entry, sid);
      out[sid] = snap;
      for (const c of snap.cards || []) {
        if (c.kind === 'subcanvas' && c.subcanvasId && !seen.has(c.subcanvasId)) {
          queue.push(c.subcanvasId);
        }
      }
    }

    return out;
  }

  _markSubcanvasSubtreeDeleted(subcanvasId) {
    if (!subcanvasId || subcanvasId === 'root') return;
    const allIds = [subcanvasId, ...this._collectDescendantCanvasIdsLocal(subcanvasId)];
    for (const id of allIds) {
      const cached = this.canvasesCache.get(id);
      if (cached) {
        this.deletedSubcanvasTrash.set(id, clone(cached));
      }
      this.pendingDeletedCanvasIds.add(id);
      this.dirtyCanvasIds.delete(id);
      this.canvasesCache.delete(id);
      idbCache.deleteCanvas(id);
    }
  }

  _restoreSubcanvasSubtree(subcanvasId) {
    if (!subcanvasId || subcanvasId === 'root') return;
    const queue = [subcanvasId];
    const seen = new Set();
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      this.pendingDeletedCanvasIds.delete(id);
      const trashed = this.deletedSubcanvasTrash.get(id);
      if (trashed) {
        trashed.dirty = true;
        this.canvasesCache.set(id, trashed);
        this.dirtyCanvasIds.add(id);
        idbCache.putCanvas(trashed);
        for (const c of trashed.cards || []) {
          if (c.kind === 'subcanvas' && c.subcanvasId && !seen.has(c.subcanvasId)) {
            queue.push(c.subcanvasId);
          }
        }
      }
    }
  }

  isPinValid(pinId, cards = this.state.cards, groups = this.state?.groups || []) {
    if (!pinId) return false;
    if (pinId.startsWith('pin-group-')) {
      const groupId = this.findCardIdByPin(pinId, cards, groups);
      return !!groupId && groups.some(g => g.id === groupId);
    }
    if (pinId.startsWith('pin-head-')) {
      const cardId = this.findCardIdByPin(pinId, cards, groups);
      return !!cardId && cards.some(c => c.id === cardId);
    }
    return cards.some(c =>
      c.contentHtml && (
        c.contentHtml.includes(`data-pin-id="${pinId}"`) ||
        c.contentHtml.includes(pinId)
      )
    );
  }

  validateConnection(conn, cards, groups = this.state.groups || []) {
    if (!conn.fromPinId || !conn.toPinId || conn.fromPinId === conn.toPinId) return false;
    if (!this.isPinValid(conn.fromPinId, cards, groups) || !this.isPinValid(conn.toPinId, cards, groups)) {
      return false;
    }
    const c1 = this.findCardIdByPin(conn.fromPinId, cards, groups);
    const c2 = this.findCardIdByPin(conn.toPinId, cards, groups);
    return c1 && c2 && c1 !== c2;
  }

  findCardIdByPin(pinId, cards = this.state.cards, groups = this.state?.groups || []) {
    if (!pinId) return null;
    if (pinId.startsWith('pin-group-left-')) return pinId.replace('pin-group-left-', '');
    if (pinId.startsWith('pin-group-right-')) return pinId.replace('pin-group-right-', '');
    if (pinId.startsWith('pin-group-')) return pinId.replace('pin-group-', '');
    if (pinId.startsWith('pin-head-left-')) return pinId.replace('pin-head-left-', '');
    if (pinId.startsWith('pin-head-right-')) return pinId.replace('pin-head-right-', '');
    if (pinId.startsWith('pin-head-')) return pinId.replace('pin-head-', '');
    const card = cards.find(c => c.contentHtml && c.contentHtml.includes(pinId));
    return card ? card.id : null;
  }

  canConnect(fromPinId, toPinId) {
    if (!fromPinId || !toPinId || fromPinId === toPinId) return false;
    const owner1 = this.findCardIdByPin(fromPinId);
    const owner2 = this.findCardIdByPin(toPinId);
    return owner1 && owner2 && owner1 !== owner2;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event) {
    this.scheduleCacheWrite();
    this.listeners.forEach(fn => fn(event, this.state));
  }

  emitToast(message, variant = 'info') {
    this.listeners.forEach(fn => fn({ type: 'TOAST', message, variant }, this.state));
  }

  getMediaSettings() {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    if (!this.state.settings.media) this.state.settings.media = { ...DEFAULT_MEDIA_SETTINGS };
    return this.state.settings.media;
  }

  setMediaSettings(patch) {
    const md = this.getMediaSettings();
    if (['smart', 'lazy', 'eager'].includes(patch.webpageLoadMode)) {
      md.webpageLoadMode = patch.webpageLoadMode;
    }
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
  }

  getNavigationSettings() {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    if (!this.state.settings.navigation) this.state.settings.navigation = { ...DEFAULT_NAVIGATION_SETTINGS };
    return this.state.settings.navigation;
  }

  setNavigationSettings(patch) {
    const nv = this.getNavigationSettings();
    if (['auto', 'trackpad', 'mouse'].includes(patch.wheelMode)) {
      nv.wheelMode = patch.wheelMode;
    }
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
  }

  getSaveSettings() {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    if (!this.state.settings.save) this.state.settings.save = { ...DEFAULT_SAVE_SETTINGS };
    return this.state.settings.save;
  }

  setSaveSettings(patch) {
    const sv = this.getSaveSettings();
    if (patch.mode === 'auto' || patch.mode === 'manual') {
      sv.mode = patch.mode;
    }
    if (typeof patch.intervalSec === 'number' && !Number.isNaN(patch.intervalSec)) {
      sv.intervalSec = Math.max(1, Math.min(300, Math.round(patch.intervalSec)));
    }
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
  }

  toggleAlignMode() {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    this.state.settings.alignMode = !this.state.settings.alignMode;
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
    return this.state.settings.alignMode;
  }

  toggleGridSnapMode() {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    this.state.settings.gridSnapMode = !this.state.settings.gridSnapMode;
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
    return this.state.settings.gridSnapMode;
  }

  getAppearanceSettings() {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    if (!this.state.settings.appearance) {
      this.state.settings.appearance = { ...DEFAULT_APPEARANCE_SETTINGS };
    }
    return this.state.settings.appearance;
  }

  setAppearanceSettings(patch) {
    const ap = this.getAppearanceSettings();
    if (patch.theme === 'dark' || patch.theme === 'light') {
      ap.theme = patch.theme;
    }
    if (typeof patch.accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.accentColor.trim())) {
      ap.accentColor = patch.accentColor.trim().toLowerCase();
    }
    if (['solid', 'dots', 'grid'].includes(patch.canvasTexture)) {
      ap.canvasTexture = patch.canvasTexture;
    }
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
  }

  getShortcuts() {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    if (!this.state.settings.shortcuts) {
      this.state.settings.shortcuts = { ...DEFAULT_SHORTCUTS };
    }
    for (const k of Object.keys(DEFAULT_SHORTCUTS)) {
      if (typeof this.state.settings.shortcuts[k] !== 'string') {
        this.state.settings.shortcuts[k] = DEFAULT_SHORTCUTS[k];
      }
    }
    return this.state.settings.shortcuts;
  }

  getShortcut(actionKey) {
    const map = this.getShortcuts();
    return typeof map[actionKey] === 'string' ? map[actionKey] : (DEFAULT_SHORTCUTS[actionKey] || '');
  }

  setShortcut(actionKey, binding) {
    if (!(actionKey in DEFAULT_SHORTCUTS)) return false;
    const sc = this.getShortcuts();
    const clean = binding === '' ? '' : normalizeShortcutString(binding);
    if (binding !== '' && !clean) return false;
    sc[actionKey] = clean;
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
    return true;
  }

  setShortcuts(patch) {
    if (!patch || typeof patch !== 'object') return;
    const sc = this.getShortcuts();
    for (const [k, v] of Object.entries(patch)) {
      if (k in DEFAULT_SHORTCUTS && typeof v === 'string') {
        sc[k] = v === '' ? '' : (normalizeShortcutString(v) || sc[k]);
      }
    }
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
  }

  resetShortcuts() {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    this.state.settings.shortcuts = { ...DEFAULT_SHORTCUTS };
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
  }

  getMinimapSettings() {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    if (!this.state.settings.minimap) {
      this.state.settings.minimap = { enabled: true, position: 'bottom-right', size: 220 };
    }
    return this.state.settings.minimap;
  }

  toggleMinimap() {
    const mm = this.getMinimapSettings();
    mm.enabled = !mm.enabled;
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
    return mm.enabled;
  }

  setMinimapSettings(patch) {
    const mm = this.getMinimapSettings();
    Object.assign(mm, patch);
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
  }

  getLibrarySettings() {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    if (!this.state.settings.library) {
      this.state.settings.library = { position: 'left', layout: 'grid', width: 348 };
    }
    if (typeof this.state.settings.library.width !== 'number') {
      this.state.settings.library.width = 348;
    }
    return this.state.settings.library;
  }

  setLibrarySettings(patch) {
    const lib = this.getLibrarySettings();
    if (patch.position === 'left' || patch.position === 'right') lib.position = patch.position;
    if (patch.layout === 'grid' || patch.layout === 'list') lib.layout = patch.layout;
    if (typeof patch.width === 'number' && !Number.isNaN(patch.width)) {
      lib.width = Math.max(260, Math.min(800, Math.round(patch.width)));
    }
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
  }

  getToastSettings() {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    if (!this.state.settings.toast) {
      this.state.settings.toast = { ...DEFAULT_TOAST_SETTINGS };
    }
    return this.state.settings.toast;
  }

  setToastSettings(patch) {
    const ts = this.getToastSettings();
    if (VALID_TOAST_POSITIONS.includes(patch.position)) {
      ts.position = patch.position;
    }
    if (typeof patch.durationSec === 'number' && !Number.isNaN(patch.durationSec)) {
      ts.durationSec = Math.max(2, Math.min(30, Math.round(patch.durationSec)));
    }
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
  }

  getPalette() {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    if (!Array.isArray(this.state.settings.palette) || this.state.settings.palette.length < 2) {
      this.state.settings.palette = [...DEFAULT_PALETTE];
    }
    return this.state.settings.palette;
  }

  setPalette(palette) {
    if (!this.state.settings) this.state.settings = clone(DEFAULT_SETTINGS);
    this.state.settings.palette = [...palette];
    this.markSettingsDirty();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
  }

  updatePaletteColor(index, color) {
    const palette = [...this.getPalette()];
    if (index >= 0 && index < palette.length) {
      palette[index] = color;
      this.setPalette(palette);
    }
  }

  setPaletteSlotCount(count) {
    const targetCount = Math.max(2, Math.min(10, count));
    const current = [...this.getPalette()];
    if (targetCount === current.length) return;

    if (targetCount < current.length) {
      this.setPalette(current.slice(0, targetCount));
    } else {
      const next = [...current];
      while (next.length < targetCount) {
        const unused = PRESET_POOL.find(c => !next.some(x => x.toLowerCase() === c.toLowerCase()));
        next.push(unused || `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`);
      }
      this.setPalette(next);
    }
  }

  addPaletteSlot() {
    const current = this.getPalette();
    if (current.length >= 10) return false;
    this.setPaletteSlotCount(current.length + 1);
    return true;
  }

  removePaletteSlot(index) {
    const current = [...this.getPalette()];
    if (current.length <= 2) return false;
    if (index >= 0 && index < current.length) {
      current.splice(index, 1);
      this.setPalette(current);
      return true;
    }
    return false;
  }

  resetPalette() {
    this.setPalette([...DEFAULT_PALETTE]);
  }

  addCard(card, skipCommit = false) {
    this.state.cards.push(card);
    if (!skipCommit) this.commit();
    else this.markDirty(this.activeCanvasId);
    this.notify({ type: 'CARD_ADDED', card });
    return card;
  }

  removeCards(cardIds) {
    const idSet = new Set(cardIds);
    const removedSubIds = this.state.cards
      .filter(c => idSet.has(c.id) && c.kind === 'subcanvas' && c.subcanvasId)
      .map(c => c.subcanvasId);

    this.state.cards = this.state.cards.filter(c => !idSet.has(c.id));
    if (this.state.groups) {
      this.state.groups.forEach(g => {
        g.cardIds = g.cardIds.filter(id => !idSet.has(id));
      });
      const legacyEmptyGroups = this.state.groups.filter(g => {
        const hasBounds = typeof g.x === 'number' && typeof g.y === 'number' && typeof g.width === 'number' && typeof g.height === 'number';
        return !hasBounds && g.cardIds.length < 2;
      });
      legacyEmptyGroups.forEach(g => {
        const leftPinId = `pin-group-left-${g.id}`;
        const rightPinId = `pin-group-right-${g.id}`;
        this.state.connections = this.state.connections.filter(c =>
          c.fromPinId !== leftPinId && c.toPinId !== leftPinId &&
          c.fromPinId !== rightPinId && c.toPinId !== rightPinId
        );
      });
      this.state.groups = this.state.groups.filter(g => {
        const hasBounds = typeof g.x === 'number' && typeof g.y === 'number' && typeof g.width === 'number' && typeof g.height === 'number';
        return hasBounds || g.cardIds.length >= 2;
      });
    }
    this.state.connections = this.state.connections.filter(c => {
      const c1 = this.findCardIdByPin(c.fromPinId);
      const c2 = this.findCardIdByPin(c.toPinId);
      return (!c1 || !idSet.has(c1)) && (!c2 || !idSet.has(c2));
    });

    removedSubIds.forEach(sid => this._markSubcanvasSubtreeDeleted(sid));

    this.commit();
    this.notify({ type: 'CARD_REMOVED', cardIds });
    if (removedSubIds.length > 0) {
      this.listeners.forEach(fn => fn({ type: 'CANVAS_TREE_UPDATED', tree: this.getCanvasHierarchy() }, this.state));
    }
  }

  removeCard(cardId) {
    this.removeCards([cardId]);
  }

  updateCard(cardId, patch) {
    const card = this.state.cards.find(c => c.id === cardId);
    if (!card) return;
    Object.assign(card, patch);
    if (card.kind === 'subcanvas' && card.subcanvasId && patch.title !== undefined) {
      const subEntry = this.canvasesCache.get(card.subcanvasId);
      if (subEntry) {
        subEntry.title = card.title;
        idbCache.putCanvas(subEntry);
      }
      this.listeners.forEach(fn => fn({ type: 'CANVAS_TREE_UPDATED', tree: this.getCanvasHierarchy() }, this.state));
    }
    this.markDirty(this.activeCanvasId);
    this.notify({ type: 'CARD_UPDATED', cardId });
  }

  addGroup(group) {
    if (!this.state.groups) this.state.groups = [];
    this.state.groups.push(group);
    this.commit();
    this.notify({ type: 'GROUP_ADDED', group });
    return group;
  }

  removeGroup(groupId) {
    if (!this.state.groups) return;
    this.state.groups = this.state.groups.filter(g => g.id !== groupId);
    const leftPinId = `pin-group-left-${groupId}`;
    const rightPinId = `pin-group-right-${groupId}`;
    this.state.connections = this.state.connections.filter(c =>
      c.fromPinId !== leftPinId && c.toPinId !== leftPinId &&
      c.fromPinId !== rightPinId && c.toPinId !== rightPinId
    );
    this.commit();
    this.notify({ type: 'GROUP_REMOVED', groupId });
  }

  updateGroup(groupId, patch) {
    const group = this.state.groups?.find(g => g.id === groupId);
    if (!group) return;
    Object.assign(group, patch);
    this.markDirty(this.activeCanvasId);
    this.notify({ type: 'GROUP_UPDATED', groupId });
  }

  addCardToGroup(groupId, cardId) {
    const group = this.state.groups?.find(g => g.id === groupId);
    if (!group) return;
    if (!group.cardIds.includes(cardId)) {
      group.cardIds.push(cardId);
      this.commit();
      this.notify({ type: 'GROUP_UPDATED', groupId });
    }
  }

  removeCardFromGroup(groupId, cardId, skipCommit = false) {
    const group = this.state.groups?.find(g => g.id === groupId);
    if (!group) return;
    const prevLen = group.cardIds.length;
    group.cardIds = group.cardIds.filter(id => id !== cardId);
    if (group.cardIds.length !== prevLen) {
      if (!skipCommit) this.commit();
      else this.markDirty(this.activeCanvasId);
      this.notify({ type: 'GROUP_UPDATED', groupId });
    }
  }

  addConnection(fromPinId, toPinId, color) {
    if (!this.canConnect(fromPinId, toPinId)) return null;
    const exists = this.state.connections.some(c =>
      (c.fromPinId === fromPinId && c.toPinId === toPinId) ||
      (c.fromPinId === toPinId && c.toPinId === fromPinId)
    );
    if (exists) return null;

    const conn = {
      id: `conn-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      fromPinId,
      toPinId,
      color: color || '#98989d'
    };
    this.state.connections.push(conn);
    this.commit();
    this.notify({ type: 'CONNECTION_ADDED', conn });
    return conn;
  }

  removeConnection(connId) {
    this.state.connections = this.state.connections.filter(c => c.id !== connId);
    this.commit();
    this.notify({ type: 'CONNECTION_REMOVED', connId });
  }

  reconnect(connId, newToPinId) {
    const conn = this.state.connections.find(c => c.id === connId);
    if (!conn) return false;
    if (!this.canConnect(conn.fromPinId, newToPinId)) return false;
    conn.toPinId = newToPinId;
    this.commit();
    this.notify({ type: 'CONNECTION_RECONNECTED', conn });
    return true;
  }

  enterFocusMode(selectedCardIds, beforeBox, cardRectsMap) {
    if (this.isFocusMode) return false;
    const focusIdSet = new Set(
      [...(selectedCardIds || [])].filter(id => this.state.cards.some(c => c.id === id))
    );
    if (focusIdSet.size === 0) return false;

    clearTimeout(this.cacheTimeout);

    const fullCards = clone(this.state.cards);
    const fullConnections = clone(this.state.connections);
    const fullGroups = clone(this.state.groups || []);

    const focusCards = fullCards.filter(c => focusIdSet.has(c.id));
    const outsideCards = fullCards
      .filter(c => !focusIdSet.has(c.id))
      .map(c => {
        const rect = cardRectsMap?.get(c.id);
        return {
          ...c,
          _measuredWidth: rect ? rect.width : (c.width || 310),
          _measuredHeight: rect ? rect.height : (c.height || 140)
        };
      });

    const preFocusCardRects = focusCards.map(c => {
      const rect = cardRectsMap?.get(c.id);
      const w = rect ? rect.width : (c.width || 310);
      const h = rect ? rect.height : (c.height || 140);
      return {
        left: c.x, top: c.y, right: c.x + w, bottom: c.y + h,
        width: w, height: h, cx: c.x + w / 2, cy: c.y + h / 2
      };
    });

    const insideGroups = [];
    const outsideGroups = [];
    const partialGroups = [];

    for (const g of fullGroups) {
      const members = Array.isArray(g.cardIds) ? g.cardIds : [];
      const hasBounds = typeof g.x === 'number' && !Number.isNaN(g.x) &&
                        typeof g.y === 'number' && !Number.isNaN(g.y) &&
                        typeof g.width === 'number' && !Number.isNaN(g.width) &&
                        typeof g.height === 'number' && !Number.isNaN(g.height);
      if (!hasBounds && members.length < 2) continue;

      const inCount = members.filter(id => focusIdSet.has(id)).length;
      if (members.length === 0) {
        outsideGroups.push(g);
      } else if (inCount === members.length) {
        insideGroups.push(g);
      } else if (inCount === 0) {
        outsideGroups.push(g);
      } else {
        partialGroups.push(g);
      }
    }

    const insideEntityIds = new Set([...focusIdSet, ...insideGroups.map(g => g.id)]);
    const internalConnections = [];
    const externalConnections = [];

    for (const conn of fullConnections) {
      const o1 = this.findCardIdByPin(conn.fromPinId, fullCards, fullGroups);
      const o2 = this.findCardIdByPin(conn.toPinId, fullCards, fullGroups);
      if (o1 && o2 && insideEntityIds.has(o1) && insideEntityIds.has(o2)) {
        internalConnections.push(conn);
      } else {
        externalConnections.push(conn);
      }
    }

    this.focusSession = {
      seedCardIds: [...focusIdSet],
      beforeBox: beforeBox ? { ...beforeBox } : null,
      preFocusCardRects,
      outsideCards,
      outsideGroups,
      partialGroups,
      externalConnections,
      savedUndoStack: [...this.undoStack],
      savedRedoStack: [...this.redoStack],
      fullPreFocusState: { cards: fullCards, connections: fullConnections, groups: fullGroups }
    };

    this.state.cards = clone(focusCards);
    this.state.groups = clone(insideGroups);
    this.state.connections = clone(internalConnections);

    this.undoStack = [this.snapshot()];
    this.redoStack = [];

    this.listeners.forEach(fn => fn({ type: 'FOCUS_MODE_ENTERED', focusCount: focusCards.length }, this.state));
    return true;
  }

  confirmFocusMode(afterBox, focusCardRects) {
    if (!this.isFocusMode) return null;
    const session = this.focusSession;

    const editedCards = clone(this.state.cards);
    const editedGroups = clone(this.state.groups || []);
    const editedConnections = clone(this.state.connections);

    const outsideLayoutInput = session.outsideCards.map(c => ({
      id: c.id,
      x: c.x,
      y: c.y,
      width: c._measuredWidth || c.width || 310,
      height: c._measuredHeight || c.height || 140
    }));

    const { cardTargets, groupTargets } = computeFocusExitLayout({
      beforeBox: session.beforeBox,
      afterBox,
      preFocusCardRects: session.preFocusCardRects,
      focusCardRects: focusCardRects || [],
      outsideCards: outsideLayoutInput,
      outsideGroups: session.outsideGroups
    });

    const restoredOutsideCards = session.outsideCards.map(c => {
      const clean = clone(c);
      delete clean._measuredWidth;
      delete clean._measuredHeight;
      const target = cardTargets.get(clean.id);
      if (target) {
        clean.x = target.x;
        clean.y = target.y;
      }
      return clean;
    });

    const mergedCards = [...editedCards, ...restoredOutsideCards];
    const survivingCardIds = new Set(mergedCards.map(c => c.id));

    const restoredOutsideGroups = clone(session.outsideGroups).map(g => {
      const gt = groupTargets?.get(g.id);
      if (gt) {
        g.x = gt.x;
        g.y = gt.y;
      }
      return g;
    });

    // Build final rect lookup for partial group refitting
    const focusRectById = new Map();
    (focusCardRects || []).forEach((r, idx) => {
      const fc = editedCards[idx];
      if (fc && r) focusRectById.set(fc.id, r);
    });
    const outsideSizeById = new Map(outsideLayoutInput.map(c => [c.id, { width: c.width, height: c.height }]));
    const getFinalCardRect = (c) => {
      if (!c) return null;
      const fr = focusRectById.get(c.id);
      if (fr) return { x: c.x, y: c.y, width: fr.width || c.width || 310, height: fr.height || c.height || 140 };
      const os = outsideSizeById.get(c.id);
      if (os) return { x: c.x, y: c.y, width: os.width, height: os.height };
      return { x: c.x, y: c.y, width: c.width || 310, height: c.height || 140 };
    };
    const mergedCardMap = new Map(mergedCards.map(c => [c.id, c]));

    const restoredPartialGroups = clone(session.partialGroups)
      .map(g => {
        const nextCardIds = (g.cardIds || []).filter(id => survivingCardIds.has(id));
        const hasBounds = typeof g.x === 'number' && !Number.isNaN(g.x) &&
                          typeof g.y === 'number' && !Number.isNaN(g.y) &&
                          typeof g.width === 'number' && !Number.isNaN(g.width) &&
                          typeof g.height === 'number' && !Number.isNaN(g.height);
        const nextGroup = { ...g, cardIds: nextCardIds };
        if (hasBounds && nextCardIds.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const cid of nextCardIds) {
            const rect = getFinalCardRect(mergedCardMap.get(cid));
            if (!rect) continue;
            if (rect.x < minX) minX = rect.x;
            if (rect.y < minY) minY = rect.y;
            if (rect.x + rect.width > maxX) maxX = rect.x + rect.width;
            if (rect.y + rect.height > maxY) maxY = rect.y + rect.height;
          }
          if (Number.isFinite(minX)) {
            const origX = g.x;
            const origY = g.y;
            const origW = g.width;
            const origH = g.height;
            const PADDING_X = 24;
            const PADDING_TOP = 62;
            const PADDING_BOTTOM = 24;
            const newX = Math.round(minX - PADDING_X);
            const newY = Math.round(minY - PADDING_TOP);
            const newW = Math.round(Math.max(288, (maxX - minX) + PADDING_X * 2));
            const newH = Math.round(Math.max(100, (maxY - minY) + PADDING_TOP + PADDING_BOTTOM));
            nextGroup.x = newX;
            nextGroup.y = newY;
            nextGroup.width = newW;
            nextGroup.height = newH;
            groupTargets?.set(g.id, {
              x: newX,
              y: newY,
              width: newW,
              height: newH,
              origX,
              origY,
              origWidth: origW,
              origHeight: origH,
              dx: newX - origX,
              dy: newY - origY
            });
          }
        }
        return nextGroup;
      })
      .filter(g => {
        const hasBounds = typeof g.x === 'number' && !Number.isNaN(g.x) &&
                          typeof g.y === 'number' && !Number.isNaN(g.y) &&
                          typeof g.width === 'number' && !Number.isNaN(g.width) &&
                          typeof g.height === 'number' && !Number.isNaN(g.height);
        return hasBounds || g.cardIds.length >= 2;
      });

    const mergedGroups = [...editedGroups, ...restoredOutsideGroups, ...restoredPartialGroups];
    const validExternalConnections = clone(session.externalConnections)
      .filter(conn => this.validateConnection(conn, mergedCards, mergedGroups));

    const seenConnIds = new Set(editedConnections.map(c => c.id));
    const seenPairs = new Set(editedConnections.map(c => [c.fromPinId, c.toPinId].sort().join('::')));
    const mergedConnections = [...editedConnections];

    for (const conn of validExternalConnections) {
      const pairKey = [conn.fromPinId, conn.toPinId].sort().join('::');
      if (!seenConnIds.has(conn.id) && !seenPairs.has(pairKey)) {
        seenConnIds.add(conn.id);
        seenPairs.add(pairKey);
        mergedConnections.push(conn);
      }
    }

    this.state.cards = mergedCards;
    this.state.groups = mergedGroups;
    this.state.connections = mergedConnections;

    const savedUndo = session.savedUndoStack || [];
    this.focusSession = null;

    this.undoStack = [...savedUndo];
    const finalSnap = this.snapshot();
    if (this.undoStack.length === 0 || this.undoStack[this.undoStack.length - 1] !== finalSnap) {
      this.undoStack.push(finalSnap);
      if (this.undoStack.length > 60) this.undoStack.shift();
    }
    this.redoStack = [];
    this.markDirty(this.activeCanvasId);

    const outsideCardIds = restoredOutsideCards.map(c => c.id);
    const externalConnIds = validExternalConnections.map(c => c.id);
    const outsideGroupIds = restoredOutsideGroups.map(g => g.id);

    this.notify({
      type: 'FOCUS_MODE_EXITED',
      confirmed: true,
      cardTargets,
      groupTargets,
      outsideCardIds,
      outsideGroupIds,
      externalConnIds
    });

    return { cardTargets, groupTargets, outsideCardIds, outsideGroupIds, externalConnIds };
  }

  cancelFocusMode() {
    if (!this.isFocusMode) return false;
    const session = this.focusSession;
    const pre = session.fullPreFocusState;

    this.state.cards = clone(pre.cards);
    this.state.connections = clone(pre.connections);
    this.state.groups = clone(pre.groups);

    this.undoStack = [...(session.savedUndoStack || [this.snapshot()])];
    this.redoStack = [...(session.savedRedoStack || [])];
    this.focusSession = null;

    this.listeners.forEach(fn => fn({ type: 'FOCUS_MODE_CANCELLED', seedCardIds: session.seedCardIds }, this.state));
    return true;
  }

  reset() {
    if (this.isFocusMode) {
      this.emitToast('当前处于专注模式，请先确认并退出专注模式后再重置画布', 'warning');
      return { blocked: true, reason: 'focus-mode' };
    }

    // Mark descendant subcanvases for deletion
    const descIds = this._collectDescendantCanvasIdsLocal(this.activeCanvasId);
    descIds.forEach(did => this._markSubcanvasSubtreeDeleted(did));

    if (this.activeCanvasId === 'root') {
      this.state.viewport = clone(DEFAULT_ROOT_STATE.viewport);
      this.state.cards = clone(DEFAULT_ROOT_STATE.cards);
      this.state.connections = clone(DEFAULT_ROOT_STATE.connections);
      this.state.groups = [];
    } else {
      this.state.viewport = { x: 0, y: 0, zoom: 1.0 };
      this.state.cards = [];
      this.state.connections = [];
      this.state.groups = [];
    }
    this.undoStack = [this.snapshot()];
    this.redoStack = [];
    this.markDirty(this.activeCanvasId);
    this.notify({ type: 'STATE_RESET' });
  }

  async _buildExportData(canvasId = this.activeCanvasId) {
    let baseExport = null;
    try {
      const res = await fetch(`${API_BASE}/canvases/${encodeURIComponent(canvasId)}/export?includeSubcanvases=true`);
      if (res.ok) {
        const json = await res.json();
        if (json?.ok && json.data) baseExport = json.data;
      }
    } catch (e) {}

    // Overlay any local dirty cache entries so export matches live state even before saving
    const getLiveEntry = (cid) => {
      if (cid === this.activeCanvasId) {
        return {
          id: this.activeCanvasId,
          parentCanvasId: this.parentCanvasId,
          title: this.activeCanvasTitle,
          viewport: clone(this.state.viewport),
          cards: clone(this.state.cards).map(c => {
            if (c.kind === 'subcanvas') {
              const { thumbnail, ...rest } = c;
              return rest;
            }
            return c;
          }),
          connections: clone(this.state.connections),
          groups: clone(this.state.groups || [])
        };
      }
      const cached = this.canvasesCache.get(cid);
      if (cached) {
        return {
          id: cached.id,
          parentCanvasId: cached.parentCanvasId ?? null,
          title: cached.title || '子画布',
          viewport: clone(cached.viewport || { x: 0, y: 0, zoom: 1.0 }),
          cards: clone(cached.cards || []).map(c => {
            if (c.kind === 'subcanvas') {
              const { thumbnail, ...rest } = c;
              return rest;
            }
            return c;
          }),
          connections: clone(cached.connections || []),
          groups: clone(cached.groups || [])
        };
      }
      return null;
    };

    const rootData = getLiveEntry(canvasId) || baseExport;
    if (!rootData) return null;

    const exportData = {
      version: 1,
      timestamp: Date.now(),
      canvasId: rootData.id || canvasId,
      title: rootData.title || (canvasId === 'root' ? '主画布' : '子画布'),
      viewport: rootData.viewport || { x: 0, y: 0, zoom: 1.0 },
      settings: clone(this.state.settings),
      cards: rootData.cards || [],
      connections: rootData.connections || [],
      groups: rootData.groups || []
    };

    const subcanvases = { ...(baseExport?.subcanvases || {}) };
    const queue = [];
    for (const c of exportData.cards) {
      if (c.kind === 'subcanvas' && c.subcanvasId) queue.push(c.subcanvasId);
    }
    const seen = new Set([canvasId]);
    while (queue.length > 0) {
      const sid = queue.shift();
      if (seen.has(sid) || this.pendingDeletedCanvasIds.has(sid)) continue;
      seen.add(sid);
      const liveSub = getLiveEntry(sid) || subcanvases[sid];
      if (liveSub) {
        subcanvases[sid] = liveSub;
        for (const sc of liveSub.cards || []) {
          if (sc.kind === 'subcanvas' && sc.subcanvasId && !seen.has(sc.subcanvasId)) {
            queue.push(sc.subcanvasId);
          }
        }
      }
    }

    // Remove deleted subcanvases from export map
    for (const key of Object.keys(subcanvases)) {
      if (!seen.has(key) || this.pendingDeletedCanvasIds.has(key)) {
        delete subcanvases[key];
      }
    }

    if (Object.keys(subcanvases).length > 0) {
      exportData.subcanvases = subcanvases;
    }

    return exportData;
  }

  collectLocalReferencedAssetIds() {
    const found = new Set();
    const re = /\/api\/v1\/assets\/(asset-[a-zA-Z0-9_-]+)/g;
    const scanText = (str) => {
      if (typeof str !== 'string' || !str.includes('asset-')) return;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(str)) !== null) found.add(m[1]);
    };
    const scanCards = (cards) => {
      for (const c of cards || []) {
        if (c?.media?.assetId) found.add(c.media.assetId);
        if (c?.media?.src) scanText(c.media.src);
        if (c?.contentHtml) scanText(c.contentHtml);
      }
    };
    scanCards(this.state.cards);
    for (const entry of this.canvasesCache.values()) {
      scanCards(entry?.cards);
      for (const snap of [...(entry?.undoStack || []), ...(entry?.redoStack || [])]) {
        scanText(snap);
      }
    }
    for (const snap of [...this.undoStack, ...this.redoStack]) {
      scanText(snap);
    }
    return [...found];
  }

  async exportCanvasToFile(canvasId = this.activeCanvasId) {
    if (this.isFocusMode) {
      this.emitToast('当前处于专注模式，请先确认并退出专注模式后再导出', 'warning');
      return { blocked: true, reason: 'focus-mode' };
    }

    if (window.__sync?.connected && this.hasUnsavedChanges()) {
      try {
        await window.__sync.saveAllToBackend?.({ manual: false });
      } catch (e) {}
    }

    const exportData = await this._buildExportData(canvasId);
    if (!exportData) {
      this.emitToast('无法读取画布数据', 'warning');
      return { error: new Error('Canvas not found') };
    }

    const safeBaseName = (exportData.title || 'graph').replace(/[\\/:*?"<>|]/g, '_');

    // Check if canvas references local backend assets
    const hasLocalAssets = JSON.stringify(exportData).includes('/api/v1/assets/') || JSON.stringify(exportData).includes('"assetId"');
    if (hasLocalAssets && window.__sync?.connected) {
      try {
        const res = await fetch(`${API_BASE}/canvases/${encodeURIComponent(canvasId)}/export?includeSubcanvases=true&includeAssets=true`);
        if (res.ok) {
          const json = await res.json();
          const bData = json?.ok && json.data ? json.data : null;
          if (bData?.assetsOmitted) {
            const sizeMb = ((bData.assetsSizeBytes || 0) / (1024 * 1024)).toFixed(1);
            const useZip = confirm(`当前画布包含约 ${sizeMb} MB 本地媒体资源（超过 50MB 单文件内嵌上限）。\n\n点击「确定」导出包含完整资源的 .pinpoint.zip 包；\n点击「取消」仅导出纯结构 .pinpoint 文件。`);
            if (useZip) {
              const zipUrl = `${API_BASE}/canvases/${encodeURIComponent(canvasId)}/export-bundle?format=zip&includeSubcanvases=true`;
              const zipRes = await fetch(zipUrl);
              if (zipRes.ok) {
                const zipBlob = await zipRes.blob();
                const zipName = `${safeBaseName}.pinpoint.zip`;
                const dlUrl = URL.createObjectURL(zipBlob);
                const a = document.createElement('a');
                a.href = dlUrl;
                a.download = zipName;
                a.click();
                URL.revokeObjectURL(dlUrl);
                this.emitToast(`已导出资源包「${zipName}」`, 'success');
                return { success: true, fileName: zipName };
              }
            }
          } else if (bData?.assets) {
            exportData.assets = bData.assets;
          }
        }
      } catch (e) {}
    }

    const suggestedName = `${safeBaseName}.pinpoint`;
    const jsonStr = JSON.stringify(exportData, null, 2);

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{
            description: 'PinPoint Graph',
            accept: { 'application/json': ['.pinpoint', '.json'] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(jsonStr);
        await writable.close();
        this.emitToast(`已导出「${handle.name}」`, 'success');
        return { success: true, fileName: handle.name };
      } catch (err) {
        if (err.name === 'AbortError') return { aborted: true };
      }
    }

    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.click();
    URL.revokeObjectURL(url);
    this.emitToast(`已导出「${suggestedName}」`, 'success');
    return { success: true, fileName: suggestedName };
  }

  async importAsSubcanvas(data, fileName = '导入的子画布.pinpoint', { x, y } = {}) {
    if (this.isFocusMode) {
      this.emitToast('当前处于专注模式，请先确认并退出专注模式后再导入文件', 'warning');
      return { blocked: true, reason: 'focus-mode' };
    }
    if (!data || !Array.isArray(data.cards) || !Array.isArray(data.connections)) {
      this.emitToast('无效的 .pinpoint 文件格式', 'warning');
      return { error: new Error('Invalid format') };
    }

    if (data.assets && typeof data.assets === 'object' && window.__sync?.connected) {
      try {
        await fetch(`${API_BASE}/assets/import-inline`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assets: data.assets })
        });
      } catch (e) {}
    }

    const newSubcanvasId = this._nextId('canvas');
    const cardId = this._nextId('card');
    const baseName = String(fileName || '').replace(/\.(pinpoint|json)$/i, '').trim();
    const rawTitle = typeof data.title === 'string' ? data.title.trim() : '';
    const cleanTitle = (rawTitle && rawTitle !== '主画布') ? rawTitle : (baseName || rawTitle || '导入的子画布');

    // Build collision-free remapping for any nested subcanvases in the imported bundle
    const subIdMap = new Map();
    if (data.canvasId && typeof data.canvasId === 'string') {
      subIdMap.set(data.canvasId, newSubcanvasId);
    }
    const registerSubId = (oldSid) => {
      if (!oldSid || typeof oldSid !== 'string') return;
      if (!subIdMap.has(oldSid)) {
        subIdMap.set(oldSid, this._nextId('canvas'));
      }
    };

    const rawSubs = (data.subcanvases && typeof data.subcanvases === 'object') ? data.subcanvases : {};
    for (const sid of Object.keys(rawSubs)) {
      registerSubId(sid);
    }
    for (const c of data.cards) {
      if (c?.kind === 'subcanvas' && c.subcanvasId) registerSubId(c.subcanvasId);
    }
    for (const sub of Object.values(rawSubs)) {
      if (sub && Array.isArray(sub.cards)) {
        for (const c of sub.cards) {
          if (c?.kind === 'subcanvas' && c.subcanvasId) registerSubId(c.subcanvasId);
        }
      }
    }

    const normalizeImportedGraph = (rawGraph) => {
      const cards = clone(rawGraph.cards || []).map(c => {
        const next = { ...c };
        if (next.kind === 'subcanvas' && next.subcanvasId) {
          next.subcanvasId = subIdMap.get(next.subcanvasId) || next.subcanvasId;
        }
        return next;
      });
      const groups = clone(rawGraph.groups || []);
      const connections = clone(rawGraph.connections || []).filter(c => this.validateConnection(c, cards, groups));
      const vp = rawGraph.viewport || {};
      return {
        viewport: {
          x: Number.isFinite(Number(vp.x)) ? Number(vp.x) : 0,
          y: Number.isFinite(Number(vp.y)) ? Number(vp.y) : 0,
          zoom: Number.isFinite(Number(vp.zoom)) && Number(vp.zoom) > 0 ? Number(vp.zoom) : 1.0
        },
        cards,
        groups,
        connections
      };
    };

    const rootNorm = normalizeImportedGraph(data);
    const childEntry = {
      id: newSubcanvasId,
      parentCanvasId: this.activeCanvasId,
      title: cleanTitle,
      breadcrumbs: [...this.breadcrumbs, { id: newSubcanvasId, title: cleanTitle }],
      viewport: rootNorm.viewport,
      cards: rootNorm.cards,
      connections: rootNorm.connections,
      groups: rootNorm.groups,
      dirty: true,
      updatedAt: Date.now()
    };

    const importedEntries = new Map();
    importedEntries.set(newSubcanvasId, childEntry);

    for (const [oldSid, rawSub] of Object.entries(rawSubs)) {
      if (!rawSub || !Array.isArray(rawSub.cards)) continue;
      const mappedSid = subIdMap.get(oldSid);
      if (!mappedSid || mappedSid === newSubcanvasId) continue;
      const normSub = normalizeImportedGraph(rawSub);
      const mappedParent = (rawSub.parentCanvasId && subIdMap.get(rawSub.parentCanvasId)) || newSubcanvasId;
      importedEntries.set(mappedSid, {
        id: mappedSid,
        parentCanvasId: mappedParent === mappedSid ? newSubcanvasId : mappedParent,
        title: (typeof rawSub.title === 'string' && rawSub.title.trim()) ? rawSub.title.trim() : '子画布',
        viewport: normSub.viewport,
        cards: normSub.cards,
        connections: normSub.connections,
        groups: normSub.groups,
        dirty: true,
        updatedAt: Date.now()
      });
    }

    // BFS from newSubcanvasId to keep parentCanvasId & breadcrumbs consistent for all nested subcanvases
    const queue = [newSubcanvasId];
    const visited = new Set([newSubcanvasId]);
    while (queue.length > 0) {
      const curId = queue.shift();
      const curEntry = importedEntries.get(curId);
      if (!curEntry) continue;
      for (const c of curEntry.cards) {
        if (c.kind === 'subcanvas' && c.subcanvasId && !visited.has(c.subcanvasId)) {
          visited.add(c.subcanvasId);
          const subEntry = importedEntries.get(c.subcanvasId);
          if (subEntry) {
            subEntry.parentCanvasId = curId;
            subEntry.breadcrumbs = [...(curEntry.breadcrumbs || []), { id: subEntry.id, title: subEntry.title }];
            queue.push(c.subcanvasId);
          }
        }
      }
    }

    // Compute thumbnails bottom-up (post-order by reverse BFS order)
    const order = [...visited];
    for (let i = order.length - 1; i >= 0; i--) {
      const entry = importedEntries.get(order[i]);
      if (!entry) continue;
      for (const c of entry.cards) {
        if (c.kind === 'subcanvas' && c.subcanvasId) {
          const subEntry = importedEntries.get(c.subcanvasId);
          if (subEntry) {
            c.thumbnail = computeLocalThumbnail(subEntry);
          }
        }
      }
    }

    for (const [sid, entry] of importedEntries.entries()) {
      this.canvasesCache.set(sid, entry);
      this.dirtyCanvasIds.add(sid);
      await idbCache.putCanvas(entry);
    }

    // Place the new subcanvas portal near viewport center (nudge if colliding)
    const vp = this.state.viewport || { x: 0, y: 0, zoom: 1.0 };
    const zoom = vp.zoom > 0 ? vp.zoom : 1.0;
    let posX = x ?? ((-vp.x + window.innerWidth / 2) / zoom - 150);
    let posY = y ?? ((-vp.y + window.innerHeight / 2) / zoom - 90);
    posX = Math.round(posX);
    posY = Math.round(posY);
    while (this.state.cards.some(c => Math.abs((c.x || 0) - posX) < 24 && Math.abs((c.y || 0) - posY) < 24)) {
      posX += 32;
      posY += 32;
    }
    if (this.state.settings?.gridSnapMode) {
      const GRID_SIZE = 24;
      posX = Math.round(posX / GRID_SIZE) * GRID_SIZE;
      posY = Math.round(posY / GRID_SIZE) * GRID_SIZE;
    }

    const card = {
      id: cardId,
      kind: 'subcanvas',
      subcanvasId: newSubcanvasId,
      title: cleanTitle,
      x: posX,
      y: posY,
      width: 300,
      height: 180,
      contentHtml: '',
      thumbnail: computeLocalThumbnail(childEntry)
    };

    this.state.cards.push(card);
    this.commit();
    this._saveActiveToCacheMap(true);
    this.notify({ type: 'CARD_ADDED', card });
    this.notify({ type: 'FILE_OPENED', fileName, card });
    this.listeners.forEach(fn => fn({ type: 'CANVAS_TREE_UPDATED', tree: this.getCanvasHierarchy() }, this.state));
    this.emitToast(`已将「${cleanTitle}」作为子画布导入`, 'success');
    return { success: true, fileName, card, subcanvasId: newSubcanvasId };
  }

  async openFromFile({ x, y } = {}) {
    if (this.isFocusMode) {
      this.emitToast('当前处于专注模式，请先确认并退出专注模式后再导入文件', 'warning');
      return { blocked: true, reason: 'focus-mode' };
    }

    const parseAndImport = async (file) => {
      if (!file) return { aborted: true };
      if (file.name.toLowerCase().endsWith('.zip')) {
        if (window.__media?.importZipAsSubcanvas) {
          return await window.__media.importZipAsSubcanvas(file, { x, y });
        }
      }
      try {
        const content = await file.text();
        return await this.importAsSubcanvas(JSON.parse(content), file.name, { x, y });
      } catch (e) {
        this.emitToast('无效的 .pinpoint 文件格式', 'warning');
        return { error: e };
      }
    };

    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: 'PinPoint Graph / Bundle',
            accept: {
              'application/json': ['.pinpoint', '.json'],
              'application/zip': ['.zip']
            }
          }],
          multiple: false
        });
        const file = await handle.getFile();
        return await parseAndImport(file);
      } catch (err) {
        if (err.name === 'AbortError') return { aborted: true };
      }
    }

    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pinpoint,.pinpoint.zip,.zip,.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve({ aborted: true });
        resolve(await parseAndImport(file));
      };
      input.click();
    });
  }
}

export const store = new StateManager();
