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
    this.lastRevision = -1;
    this.isApplyingRemote = false;
    this.pendingEvent = null;
    this.syncTimer = null;
    this.viewportTimer = null;
    this.selectionTimer = null;
    this.statusDotEl = null;
  }

  init() {
    this.statusDotEl = document.querySelector('.hud-title-dot');

    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
      this.setStatus('offline');
      return;
    }

    // Subscribe to local store mutations -> push to backend
    store.subscribe((event) => {
      if (this.isApplyingRemote || !this.connected || store.isFocusMode) return;
      if (event?.type === 'FOCUS_MODE_CANCELLED') {
        setTimeout(() => this.flushPendingIfIdle(), 20);
        return;
      }
      if (!event || event.type === 'REMOTE_SYNCED' || event.type === 'HANDLE_RESTORED' || event.type === 'FILE_SAVED' || event.type === 'TOAST' || event.type === 'FOCUS_MODE_ENTERED') {
        return;
      }

      if (event.type === 'SETTINGS_CHANGED') {
        this.scheduleGraphSync(80);
        return;
      }

      if (event.type === 'FOCUS_MODE_EXITED') {
        this.pendingEvent = null;
        this.scheduleGraphSync(90);
        return;
      }

      if (
        event.type === 'HISTORY_CHANGED' ||
        event.type === 'STATE_RESTORED' ||
        event.type === 'STATE_RESET' ||
        event.type === 'FILE_OPENED' ||
        event.type === 'CONNECTION_ADDED' ||
        event.type === 'CONNECTION_REMOVED' ||
        event.type === 'CONNECTION_RECONNECTED' ||
        event.type?.startsWith('CARD_') ||
        event.type?.startsWith('GROUP_')
      ) {
        this.scheduleGraphSync(90);
      }
    });

    // Flush deferred remote updates once user finishes dragging, editing, or leaves window
    window.addEventListener('mouseup', () => this.flushPendingIfIdle(), true);
    window.addEventListener('blur', () => this.flushPendingIfIdle());
    window.addEventListener('focusout', () => {
      setTimeout(() => this.flushPendingIfIdle(), 20);
    }, true);

    this.connectSSE();
  }

  setStatus(mode) {
    if (!this.statusDotEl) return;
    this.statusDotEl.classList.remove('sync-connected', 'sync-reconnecting', 'sync-offline');
    this.statusDotEl.classList.add(`sync-${mode}`);
    let normalTitle = '离线模式（仅本地存储）';
    if (mode === 'connected') {
      normalTitle = '实时同步已连接 (/api/v1/events)';
    } else if (mode === 'reconnecting') {
      normalTitle = '实时同步重连中...';
    }
    this.statusDotEl.dataset.normalTitle = normalTitle;
    if (!store.isFocusMode) {
      this.statusDotEl.title = normalTitle;
    }
  }

  connectSSE() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    const es = new EventSource(`${API_BASE}/events`);
    this.eventSource = es;

    es.addEventListener('connected', (msg) => {
      this.connected = true;
      this.setStatus('connected');
      try {
        const data = JSON.parse(msg.data);
        const rev = typeof data.revision === 'number' ? data.revision : 0;
        const hasWorkspaceFile = !!data.hasWorkspaceFile;

        if (store.isFocusMode) {
          this.lastRevision = rev;
          return;
        }

        if (rev > 0 || hasWorkspaceFile) {
          this.lastRevision = rev;
          this.applyRemote(data.state, 'CONNECTED');
          if (data.selection) {
            this.applyRemoteSelection(data.selection);
          }
        } else if (store.hasLocalSavedState()) {
          // Backend is pristine; seed backend from browser localStorage
          this.lastRevision = rev;
          this.pushGraphNow().then(() => {
            const sel = nodes.getSelectionState();
            if (sel.cardIds.length > 0 || sel.capsulePinId) {
              this.pushSelectionNow();
            }
          });
        } else {
          this.lastRevision = rev;
        }
      } catch (e) {
        console.warn('[PinPoint Sync] Failed to parse connected payload:', e);
      }
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
          if (!store.isFocusMode) {
            this.applyRemoteSelection(evt.payload);
          }
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
      this.setStatus('reconnecting');
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
    const active = document.activeElement;
    if (active && active.closest && active.closest('.note-body, .header-title-input, .group-title-input')) {
      return true;
    }
    return false;
  }

  flushPendingIfIdle() {
    if (!this.pendingEvent || store.isFocusMode) return;
    if (this.isUserBusyForEvent(this.pendingEvent.type)) return;
    const evt = this.pendingEvent;
    this.pendingEvent = null;
    this.applyRemote(evt.state, evt.type);
  }

  applyRemote(remoteState, sourceEvent) {
    if (!remoteState) return;
    this.isApplyingRemote = true;
    try {
      store.applyRemoteState(remoteState, sourceEvent);
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
    }, 60);
  }

  notifyViewportChanged() {
    if (this.isApplyingRemote || !this.connected || store.isFocusMode) return;
    clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => {
      this.pushViewportNow();
    }, 220);
  }

  scheduleGraphSync(delay = 90) {
    if (store.isFocusMode) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.pushGraphNow();
    }, delay);
  }

  async pushGraphNow() {
    if (!this.connected || store.isFocusMode) return;
    try {
      const payload = {
        viewport: store.state.viewport,
        settings: store.state.settings,
        cards: store.state.cards,
        connections: store.state.connections,
        groups: store.state.groups || []
      };
      const res = await fetch(`${API_BASE}/graph?mode=sync`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-PinPoint-Client': this.clientId
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        console.warn('[PinPoint Sync] Graph sync rejected:', res.status);
      }
    } catch (e) {
      // Network offline or server restarting; SSE will recover
    }
  }

  async pushViewportNow() {
    if (!this.connected || store.isFocusMode) return;
    try {
      await fetch(`${API_BASE}/viewport`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-PinPoint-Client': this.clientId
        },
        body: JSON.stringify(store.state.viewport)
      });
    } catch (e) {}
  }

  async pushSelectionNow() {
    if (!this.connected || store.isFocusMode) return;
    try {
      if (this.syncTimer) {
        clearTimeout(this.syncTimer);
        this.syncTimer = null;
        await this.pushGraphNow();
      }
      const sel = nodes.getSelectionState();
      await fetch(`${API_BASE}/selection`, {
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
