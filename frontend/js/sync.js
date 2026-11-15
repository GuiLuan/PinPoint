import { store } from './state.js';
import { canvas } from './canvas.js';
import { nodes } from './nodes.js';
import { wires } from './wires.js';

const API_BASE = '/api/v1';

class SyncManager {
  constructor() {
    this.clientId = `web-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    this.eventSource = null;
    this.connected = false;
    this.isSaving = false;
    this.lastRevision = -1;
    this.isApplyingRemote = false;
    this.pendingEvent = null;
    this.autoSaveTimer = null;
    this.healthTimer = null;
    this.selectionTimer = null;
    this.statusDotEl = null;
    this._deferredAutoSave = false;
  }

  init() {
    this.statusDotEl = document.querySelector('.hud-title-dot');

    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
      this.connected = false;
      this.updateStatusDot();
      return;
    }

    store.subscribe((event) => {
      if (!event) return;

      if (event.type === 'DIRTY_CHANGED') {
        this.updateStatusDot();
        this.scheduleAutoSaveIfNeeded({ reset: true });
        return;
      }

      if (event.type === 'SETTINGS_CHANGED') {
        this.updateStatusDot();
        this.rescheduleAutoSave();
        // Persist settings changes promptly when online so save mode preference is remembered
        if (this.connected && !this.isApplyingRemote && !store.isFocusMode) {
          this.pushSettingsNow();
        }
        return;
      }

      if (event.type === 'CANVAS_SWITCHED') {
        this.updateStatusDot();
        return;
      }

      if (event.type === 'FOCUS_MODE_CANCELLED') {
        this.updateStatusDot();
        setTimeout(() => this.flushPendingIfIdle(), 20);
        return;
      }

      if (event.type === 'FOCUS_MODE_ENTERED' || event.type === 'FOCUS_MODE_EXITED') {
        this.updateStatusDot();
        if (event.type === 'FOCUS_MODE_EXITED') {
          this.pendingEvent = null;
          this.scheduleAutoSaveIfNeeded();
        }
        return;
      }
    });

    window.addEventListener('mouseup', () => {
      setTimeout(() => this.flushPendingIfIdle(), 25);
    }, true);
    window.addEventListener('blur', () => this.flushPendingIfIdle());
    window.addEventListener('focusout', () => {
      setTimeout(() => this.flushPendingIfIdle(), 25);
    }, true);

    this.connectSSE();
    this.startHealthMonitor();
  }

  updateStatusDot() {
    const saveSc = store.getShortcut?.('saveGraph');
    const scSuffix = saveSc ? ` (${saveSc})` : '';
    let statusClass = 'status-saved';
    let label = `已保存${scSuffix}`;

    if (!this.connected) {
      statusClass = 'status-offline';
      label = '服务已断开';
    } else if (store.hasUnsavedChanges()) {
      statusClass = 'status-unsaved';
      label = `有未保存的更改${scSuffix}`;
    }

    if (this.statusDotEl) {
      this.statusDotEl.classList.remove('status-saved', 'status-unsaved', 'status-offline', 'sync-connected', 'sync-reconnecting', 'sync-offline');
      this.statusDotEl.classList.add(statusClass);
      this.statusDotEl.dataset.normalTitle = label;
      if (!store.isFocusMode) {
        this.statusDotEl.title = label;
      }
    }

    window.__updateSaveUI?.({
      connected: this.connected,
      dirty: store.hasUnsavedChanges(),
      saving: this.isSaving,
      statusClass,
      label
    });
  }

  startHealthMonitor() {
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
        if (res.ok) {
          if (!this.connected) {
            this.connected = true;
            this.updateStatusDot();
            if (!this.eventSource || this.eventSource.readyState === EventSource.CLOSED) {
              this.connectSSE();
            }
          }
        } else {
          if (this.connected) {
            this.connected = false;
            this.updateStatusDot();
          }
        }
      } catch (e) {
        if (this.connected) {
          this.connected = false;
          this.updateStatusDot();
        }
      }
    }, 8000);
  }

  scheduleAutoSaveIfNeeded({ reset = false } = {}) {
    const sv = store.getSaveSettings();
    if (sv.mode !== 'auto' || !store.hasUnsavedChanges() || store.isFocusMode) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
      return;
    }

    if (reset && this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.autoSaveTimer) return;

    const delayMs = Math.max(1, Math.min(300, sv.intervalSec || 1)) * 1000;
    this.autoSaveTimer = setTimeout(async () => {
      this.autoSaveTimer = null;
      if (store.getSaveSettings().mode === 'auto' && store.hasUnsavedChanges() && !store.isFocusMode) {
        if (this.isUserBusyForSave()) {
          // Never interrupt active typing, inline renaming, or dragging; save once user finishes
          this._deferredAutoSave = true;
        } else {
          this._deferredAutoSave = false;
          await this.saveAllToBackend({ manual: false });
        }
      }
    }, delayMs);
  }

  rescheduleAutoSave() {
    this.scheduleAutoSaveIfNeeded({ reset: true });
  }

  isEditingActive() {
    const active = document.activeElement;
    if (active && active.closest && active.closest('input, textarea, select, [contenteditable="true"]')) {
      return true;
    }
    const openInputs = document.querySelectorAll('.header-title-input, .group-title-input, .canvas-tree-rename-input, .library-item-rename-input');
    for (const el of openInputs) {
      if (el.style.display !== 'none' && el.offsetParent !== null) {
        return true;
      }
    }
    return false;
  }

  isUserBusyForSave() {
    return Boolean(nodes.activeDrag || wires.activeDrag || canvas.dragAction || this.isEditingActive());
  }

  connectSSE() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    const es = new EventSource(`${API_BASE}/events`);
    this.eventSource = es;

    es.addEventListener('connected', async (msg) => {
      this.connected = true;
      try {
        const data = JSON.parse(msg.data);
        const rev = typeof data.revision === 'number' ? data.revision : 0;
        this.lastRevision = rev;

        if (Array.isArray(data.canvases)) {
          store.setCanvasTree(data.canvases);
        }

        if (Array.isArray(data.library)) {
          window.__library?.syncFromBackendBootstrap?.(data.library);
        }

        if (store.isFocusMode) {
          this.updateStatusDot();
          return;
        }

        if (data.settings && !store.settingsDirty) {
          this.isApplyingRemote = true;
          try {
            store.state.settings = store.normalizeSettings(data.settings);
            store.notify({ type: 'SETTINGS_CHANGED', settings: store.state.settings });
          } finally {
            this.isApplyingRemote = false;
          }
          // normalize/notify above might mark settingsDirty, clear if it came from server
          store.settingsDirty = false;
        }

        // Load active canvas from SQLite unless local cache has unsaved edits for it
        const activeId = store.activeCanvasId || 'root';
        if (!store.isCanvasDirty(activeId)) {
          let loadedPayload = activeId === 'root' ? data.state : null;
          if (!loadedPayload || activeId !== 'root') {
            try {
              const res = await fetch(`${API_BASE}/canvases/${encodeURIComponent(activeId)}`);
              if (res.ok) {
                const json = await res.json();
                if (json?.ok && json.data) loadedPayload = json.data;
              }
            } catch (e) {}
          }
          if (loadedPayload) {
            this.applyRemote(loadedPayload, 'CONNECTED');
            if (activeId === 'root' && data.selection) {
              this.applyRemoteSelection(data.selection);
            }
          }
        }
      } catch (e) {
        console.warn('[PinPoint Sync] Failed to parse connected payload:', e);
      }

      this.updateStatusDot();
      this.scheduleAutoSaveIfNeeded();
    });

    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data);
        if (!evt || typeof evt.revision !== 'number') return;
        if (evt.clientId && evt.clientId === this.clientId) {
          this.lastRevision = Math.max(this.lastRevision, evt.revision);
          return;
        }
        if (evt.revision <= this.lastRevision) return;
        this.lastRevision = evt.revision;

        if (evt.type === 'SELECTION_CHANGED') {
          const targetCid = evt.canvasId || evt.payload?.canvasId || 'root';
          if (!store.isFocusMode && targetCid === store.activeCanvasId) {
            this.applyRemoteSelection(evt.payload);
          }
          return;
        }

        if (evt.type === 'LIBRARY_CHANGED') {
          if (Array.isArray(evt.library)) {
            window.__library?.applyRemoteLibrary?.(evt.library);
          }
          return;
        }

        if (evt.type === 'CANVAS_CREATED' || evt.type === 'CANVAS_DELETED' || evt.type === 'CANVAS_UPDATED') {
          store.refreshCanvasTree();
        }

        const evtCanvasId = evt.canvasId || evt.state?.id || 'root';
        if (evtCanvasId !== store.activeCanvasId) {
          // If it's a child subcanvas on the active canvas, refresh active thumbnail
          const hasSubCard = store.state.cards.some(c => c.kind === 'subcanvas' && c.subcanvasId === evtCanvasId);
          if (hasSubCard && !store.isCanvasDirty(evtCanvasId)) {
            fetch(`${API_BASE}/canvases/${encodeURIComponent(evtCanvasId)}/thumbnail`)
              .then(r => r.ok ? r.json() : null)
              .then(json => {
                if (json?.ok && json.data) {
                  const card = store.state.cards.find(c => c.kind === 'subcanvas' && c.subcanvasId === evtCanvasId);
                  if (card) {
                    card.thumbnail = json.data;
                    if (!this.isUserBusyForSave()) {
                      nodes.render();
                      wires.render();
                    }
                  }
                }
              }).catch(() => {});
          }
          return;
        }

        // Do not overwrite locally modified unsaved work automatically
        if (store.isCanvasDirty(store.activeCanvasId)) {
          return;
        }

        if (store.isFocusMode || this.isUserBusyForEvent(evt.type)) {
          this.pendingEvent = evt;
          return;
        }
        this.applyRemote(evt.state, evt.type);
      } catch (e) {
        console.warn('[PinPoint Sync] Failed to handle SSE message:', e);
      }
    };

    es.onerror = () => {
      this.connected = false;
      this.updateStatusDot();
    };
  }

  isUserBusyForEvent(eventType) {
    if (eventType === 'VIEWPORT_CHANGED' || eventType === 'SETTINGS_CHANGED' || eventType === 'SELECTION_CHANGED') {
      return false;
    }
    if (nodes.activeDrag || wires.activeDrag || canvas.dragAction) {
      return true;
    }
    if (!document.hasFocus()) {
      return false;
    }
    return this.isEditingActive();
  }

  flushPendingIfIdle() {
    if (store.isFocusMode) return;
    if (this.pendingEvent && !this.isUserBusyForSave() && !this.isUserBusyForEvent(this.pendingEvent.type)) {
      const evt = this.pendingEvent;
      this.pendingEvent = null;
      this.applyRemote(evt.state, evt.type);
    }
    if (this._deferredAutoSave && !this.isUserBusyForSave()) {
      this._deferredAutoSave = false;
      if (store.getSaveSettings().mode === 'auto' && store.hasUnsavedChanges()) {
        this.scheduleAutoSaveIfNeeded({ reset: true });
      }
    }
  }

  applyRemote(remoteState, sourceEvent) {
    if (!remoteState) return;
    this.isApplyingRemote = true;
    try {
      store.applyRemoteCanvas(remoteState, sourceEvent);
    } finally {
      this.isApplyingRemote = false;
    }
  }

  applyRemoteSelection(sel) {
    if (!sel) return;
    this.isApplyingRemote = true;
    try {
      nodes.applyRemoteSelection(sel);
    } finally {
      this.isApplyingRemote = false;
    }
  }

  notifySelectionChanged() {
    if (this.isApplyingRemote || !this.connected || store.isFocusMode) return;
    clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      this.pushSelectionNow();
    }, 80);
  }

  notifyViewportChanged() {
    // Viewport panning/zooming stays cached in IndexedDB and syncs on save/auto-save
    store.scheduleCacheWrite();
  }

  async pushSettingsNow() {
    if (!this.connected || store.isFocusMode) return false;
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-PinPoint-Client': this.clientId
        },
        body: JSON.stringify(store.state.settings)
      });
      if (res.ok) {
        store.settingsDirty = false;
        this.updateStatusDot();
        return true;
      }
    } catch (e) {}
    return false;
  }

  _sortCanvasIdsTopDown(ids) {
    const depthOf = (cid, seen = new Set()) => {
      if (!cid || cid === 'root') return 0;
      if (seen.has(cid)) return 999;
      seen.add(cid);
      const entry = cid === store.activeCanvasId ? { parentCanvasId: store.parentCanvasId } : store.canvasesCache.get(cid);
      if (entry?.parentCanvasId) return 1 + depthOf(entry.parentCanvasId, seen);
      const row = (store.canvasTree || []).find(r => r.id === cid);
      if (row?.parentCanvasId) return 1 + depthOf(row.parentCanvasId, seen);
      return 1;
    };
    return [...ids].sort((a, b) => depthOf(a) - depthOf(b));
  }

  async saveAllToBackend({ manual = false } = {}) {
    if (store.isFocusMode) {
      if (manual) store.emitToast('请先退出专注模式后再保存', 'warning');
      return { ok: false, reason: 'focus-mode' };
    }
    if (!this.connected) {
      this.updateStatusDot();
      if (manual) store.emitToast('服务未连接，暂无法保存', 'warning');
      return { ok: false, reason: 'offline' };
    }
    if (this.isSaving) return { ok: false, reason: 'busy' };

    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = null;
    this.isSaving = true;
    this.updateStatusDot();

    try {
      nodes.flushActiveDOMEdits({ exitInputs: false });
      await store.flushCacheToIDBNow();

      // 1. Delete pending removed subcanvases that exist on the backend
      const serverCanvasIds = new Set((store.canvasTree || []).map(r => r.id));
      const deletedIds = [...store.pendingDeletedCanvasIds];
      for (const delId of deletedIds) {
        if (!serverCanvasIds.has(delId)) {
          store.pendingDeletedCanvasIds.delete(delId);
          continue;
        }
        try {
          const res = await fetch(`${API_BASE}/canvases/${encodeURIComponent(delId)}`, {
            method: 'DELETE',
            headers: { 'X-PinPoint-Client': this.clientId }
          });
          if (res.ok || res.status === 404) {
            store.pendingDeletedCanvasIds.delete(delId);
          }
        } catch (e) {
          throw e;
        }
      }

      // 2. Sync dirty canvases top-down (parent before child), skipping any unreachable orphans
      const reachableIds = new Set(store.getCanvasHierarchy().map(r => r.id));
      reachableIds.add('root');
      const dirtyIds = this._sortCanvasIdsTopDown(store.dirtyCanvasIds);
      const savedIds = [];

      for (const cid of dirtyIds) {
        if (!reachableIds.has(cid)) {
          store.canvasesCache.delete(cid);
          savedIds.push(cid);
          continue;
        }
        const entry = cid === store.activeCanvasId
          ? store._saveActiveToCacheMap(true)
          : store.canvasesCache.get(cid);
        if (!entry) {
          savedIds.push(cid);
          continue;
        }

        const cleanCards = (entry.cards || []).map(c => {
          if (c.kind === 'subcanvas') {
            const { thumbnail, ...rest } = c;
            return rest;
          }
          return c;
        });

        const payload = {
          id: cid,
          parentCanvasId: entry.parentCanvasId ?? null,
          title: entry.title || (cid === 'root' ? '主画布' : '子画布'),
          viewport: entry.viewport || { x: 0, y: 0, zoom: 1.0 },
          settings: store.state.settings,
          cards: cleanCards,
          connections: entry.connections || [],
          groups: entry.groups || []
        };

        const res = await fetch(`${API_BASE}/canvases/${encodeURIComponent(cid)}?mode=sync`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-PinPoint-Client': this.clientId
          },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          throw new Error(`Save canvas ${cid} failed with HTTP ${res.status}`);
        }
        const json = await res.json();
        if (typeof json?.revision === 'number') {
          this.lastRevision = Math.max(this.lastRevision, json.revision);
        }
        savedIds.push(cid);
      }

      // 3. Sync settings if dirty (and no canvases pushed it already)
      let clearedSettings = false;
      if (store.settingsDirty) {
        const okSettings = await this.pushSettingsNow();
        clearedSettings = okSettings;
      }

      store.clearDirtyFor(savedIds, clearedSettings || savedIds.length > 0);
      await store.refreshCanvasTree();

      if (manual) {
        store.emitToast('已保存', 'success');
      }
      this.updateStatusDot();
      return { ok: true, savedCount: savedIds.length };
    } catch (e) {
      console.warn('[PinPoint Sync] Save failed:', e);
      // Re-verify health in case server went down
      try {
        const h = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
        this.connected = h.ok;
      } catch (_) {
        this.connected = false;
      }
      this.updateStatusDot();
      if (manual) {
        store.emitToast(this.connected ? '保存失败，请重试' : '服务已断开，暂无法保存', 'warning');
      }
      return { ok: false, error: e };
    } finally {
      this.isSaving = false;
      this.updateStatusDot();
      if (store.hasUnsavedChanges()) {
        this.scheduleAutoSaveIfNeeded();
      }
    }
  }

  async pushSelectionNow() {
    if (!this.connected || store.isFocusMode) return;
    try {
      const sel = nodes.getSelectionState();
      await fetch(`${API_BASE}/selection?canvasId=${encodeURIComponent(store.activeCanvasId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-PinPoint-Client': this.clientId
        },
        body: JSON.stringify(sel)
      });
    } catch (e) {}
  }
}

export const sync = new SyncManager();
