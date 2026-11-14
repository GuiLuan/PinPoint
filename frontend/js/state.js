import { computeFocusExitLayout } from './focusLayout.js';

const STORAGE_KEY = 'pinpoint_workspace_data';
const FILE_NAME_KEY = 'pinpoint_file_name';
const FILE_SNAPSHOT_KEY = 'pinpoint_file_snapshot';
const IDB_NAME = 'pinpoint_fs';
const IDB_STORE = 'handles';

function openIDB() {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function persistHandle(handle) {
  try {
    const db = await openIDB();
    if (!db) return;
    const tx = db.transaction(IDB_STORE, 'readwrite');
    if (handle) {
      tx.objectStore(IDB_STORE).put(handle, 'active_handle');
    } else {
      tx.objectStore(IDB_STORE).delete('active_handle');
    }
  } catch (e) {}
}

async function retrieveHandle() {
  try {
    const db = await openIDB();
    if (!db) return null;
    return await new Promise(resolve => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get('active_handle');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

export const DEFAULT_PALETTE = ['#30d158', '#0a84ff', '#bf5af2', '#ffd60a', '#ff9f0a'];
export const PRESET_POOL = [
  '#30d158', '#0a84ff', '#bf5af2', '#ffd60a', '#ff9f0a',
  '#ff453a', '#64d2ff', '#ac8e68', '#ff375f', '#5e5ce6'
];

const DEFAULT_STATE = {
  viewport: { x: 0, y: 0, zoom: 1.0 },
  settings: {
    alignMode: false,
    gridSnapMode: false,
    palette: [...DEFAULT_PALETTE],
    minimap: {
      enabled: true,
      position: 'bottom-right',
      size: 220
    }
  },
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

class StateManager {
  constructor() {
    this.state = this.loadInitialState();
    this.fileHandle = null;
    this.fileName = '';
    this.listeners = new Set();
    this.saveTimeout = null;
    this.undoStack = [this.snapshot()];
    this.redoStack = [];
    this.fileSavedSnapshot = null;
    this.focusSession = null;
  }

  get isFocusMode() {
    return !!this.focusSession;
  }

  snapshot() {
    return JSON.stringify({
      cards: this.state.cards,
      connections: this.state.connections,
      groups: this.state.groups || []
    });
  }

  hasUnsavedChanges() {
    if (this.isFocusMode) return true;
    if (!this.state.cards || this.state.cards.length === 0) return false;
    if (!this.fileSavedSnapshot) return true;
    return this.snapshot() !== this.fileSavedSnapshot;
  }

  commit() {
    const snap = this.snapshot();
    if (this.undoStack.length > 0 && this.undoStack[this.undoStack.length - 1] === snap) {
      return;
    }
    this.undoStack.push(snap);
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
    this.notify({ type: 'HISTORY_CHANGED' });
  }

  async restoreFileHandle() {
    try {
      const fileName = localStorage.getItem(FILE_NAME_KEY);
      if (!fileName) {
        this.fileHandle = null;
        this.fileName = '';
        this.fileSavedSnapshot = null;
        persistHandle(null);
        return;
      }
      const handle = await retrieveHandle();
      if (handle) {
        this.fileHandle = handle;
        this.fileName = handle.name || fileName;
      } else {
        this.fileName = fileName;
      }
      this.fileSavedSnapshot = localStorage.getItem(FILE_SNAPSHOT_KEY) || null;
      if (this.fileName) {
        this.notify({ type: 'HANDLE_RESTORED', fileName: this.fileName });
      }
    } catch (e) {}
  }

  canUndo() {
    return this.undoStack.length > 1;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (this.undoStack.length <= 1) return false;
    const current = this.undoStack.pop();
    this.redoStack.push(current);
    const prevSnap = this.undoStack[this.undoStack.length - 1];
    const data = JSON.parse(prevSnap);
    this.state.cards = JSON.parse(JSON.stringify(data.cards));
    this.state.connections = JSON.parse(JSON.stringify(data.connections));
    this.state.groups = JSON.parse(JSON.stringify(data.groups || []));
    this.scheduleAutoSave();
    this.notify({ type: 'STATE_RESTORED' });
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    const nextSnap = this.redoStack.pop();
    this.undoStack.push(nextSnap);
    const data = JSON.parse(nextSnap);
    this.state.cards = JSON.parse(JSON.stringify(data.cards));
    this.state.connections = JSON.parse(JSON.stringify(data.connections));
    this.state.groups = JSON.parse(JSON.stringify(data.groups || []));
    this.scheduleAutoSave();
    this.notify({ type: 'STATE_RESTORED' });
    return true;
  }

  hasLocalSavedState() {
    try {
      return !!localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return false;
    }
  }

  applyRemoteState(remoteState, sourceEvent = 'REMOTE_SYNCED') {
    if (this.isFocusMode) return false;
    if (!remoteState || !Array.isArray(remoteState.cards) || !Array.isArray(remoteState.connections)) {
      return false;
    }

    const cards = JSON.parse(JSON.stringify(remoteState.cards));
    const groups = JSON.parse(JSON.stringify(remoteState.groups || []));
    const connections = JSON.parse(JSON.stringify(remoteState.connections))
      .filter(c => this.validateConnection(c, cards, groups));

    if (remoteState.viewport) {
      this.state.viewport = {
        x: Number(remoteState.viewport.x ?? this.state.viewport.x ?? 0),
        y: Number(remoteState.viewport.y ?? this.state.viewport.y ?? 0),
        zoom: Number(remoteState.viewport.zoom ?? this.state.viewport.zoom ?? 1.0)
      };
    }

    if (remoteState.settings) {
      this.state.settings = {
        alignMode: remoteState.settings.alignMode ?? false,
        gridSnapMode: remoteState.settings.gridSnapMode ?? false,
        palette: Array.isArray(remoteState.settings.palette) && remoteState.settings.palette.length >= 2
          ? [...remoteState.settings.palette]
          : [...DEFAULT_PALETTE],
        minimap: {
          enabled: remoteState.settings.minimap?.enabled ?? true,
          position: remoteState.settings.minimap?.position || 'bottom-right',
          size: typeof remoteState.settings.minimap?.size === 'number' ? remoteState.settings.minimap.size : 220
        }
      };
    }

    const prevSnap = this.snapshot();
    this.state.cards = cards;
    this.state.connections = connections;
    this.state.groups = groups;
    const nextSnap = this.snapshot();

    if (sourceEvent === 'GRAPH_REPLACED' || sourceEvent === 'STATE_RESET') {
      this.undoStack = [nextSnap];
      this.redoStack = [];
    } else if (nextSnap !== prevSnap) {
      this.undoStack.push(nextSnap);
      if (this.undoStack.length > 60) this.undoStack.shift();
      this.redoStack = [];
    }

    this.notify({ type: 'REMOTE_SYNCED', sourceEvent });
    return true;
  }

  loadInitialState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.cards && parsed.connections) {
          const cards = parsed.cards;
          const groups = parsed.groups || [];
          return {
            viewport: parsed.viewport || { x: 0, y: 0, zoom: 1.0 },
            settings: {
              alignMode: parsed.settings?.alignMode ?? false,
              gridSnapMode: parsed.settings?.gridSnapMode ?? false,
              palette: Array.isArray(parsed.settings?.palette) && parsed.settings.palette.length >= 2
                ? parsed.settings.palette
                : [...DEFAULT_PALETTE],
              minimap: {
                enabled: parsed.settings?.minimap?.enabled ?? true,
                position: parsed.settings?.minimap?.position || 'bottom-right',
                size: typeof parsed.settings?.minimap?.size === 'number' ? parsed.settings.minimap.size : 220
              }
            },
            cards,
            connections: parsed.connections.filter(c => this.validateConnection(c, cards, groups)),
            groups
          };
        }
      }
    } catch (e) {
      // Fallback to default
    }
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
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
    this.scheduleAutoSave();
    this.listeners.forEach(fn => fn(event, this.state));
  }

  emitToast(message, variant = 'info') {
    this.listeners.forEach(fn => fn({ type: 'TOAST', message, variant }, this.state));
  }

  scheduleAutoSave() {
    if (this.isFocusMode) return;
    clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          viewport: this.state.viewport,
          settings: this.state.settings,
          cards: this.state.cards,
          connections: this.state.connections,
          groups: this.state.groups || []
        }));
      } catch (e) {}
    }, 400);
  }

  toggleAlignMode() {
    if (!this.state.settings) this.state.settings = { alignMode: false, gridSnapMode: false };
    this.state.settings.alignMode = !this.state.settings.alignMode;
    this.scheduleAutoSave();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
    return this.state.settings.alignMode;
  }

  toggleGridSnapMode() {
    if (!this.state.settings) this.state.settings = { alignMode: false, gridSnapMode: false, palette: [...DEFAULT_PALETTE], minimap: { enabled: true, position: 'bottom-right', size: 220 } };
    this.state.settings.gridSnapMode = !this.state.settings.gridSnapMode;
    this.scheduleAutoSave();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
    return this.state.settings.gridSnapMode;
  }

  getMinimapSettings() {
    if (!this.state.settings) {
      this.state.settings = { alignMode: false, gridSnapMode: false, palette: [...DEFAULT_PALETTE], minimap: { enabled: true, position: 'bottom-right', size: 220 } };
    }
    if (!this.state.settings.minimap) {
      this.state.settings.minimap = { enabled: true, position: 'bottom-right', size: 220 };
    }
    return this.state.settings.minimap;
  }

  toggleMinimap() {
    const mm = this.getMinimapSettings();
    mm.enabled = !mm.enabled;
    this.scheduleAutoSave();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
    return mm.enabled;
  }

  setMinimapSettings(patch) {
    const mm = this.getMinimapSettings();
    Object.assign(mm, patch);
    this.scheduleAutoSave();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
  }

  getPalette() {
    if (!this.state.settings) {
      this.state.settings = { alignMode: false, gridSnapMode: false, palette: [...DEFAULT_PALETTE] };
    }
    if (!Array.isArray(this.state.settings.palette) || this.state.settings.palette.length < 2) {
      this.state.settings.palette = [...DEFAULT_PALETTE];
    }
    return this.state.settings.palette;
  }

  setPalette(palette) {
    if (!this.state.settings) {
      this.state.settings = { alignMode: false, gridSnapMode: false, palette: [...DEFAULT_PALETTE] };
    }
    this.state.settings.palette = [...palette];
    this.scheduleAutoSave();
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
      const next = current.slice(0, targetCount);
      this.setPalette(next);
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

  addCard(card) {
    this.state.cards.push(card);
    this.commit();
    this.notify({ type: 'CARD_ADDED', card });
    return card;
  }

  removeCards(cardIds) {
    const idSet = new Set(cardIds);
    this.state.cards = this.state.cards.filter(c => !idSet.has(c.id));
    if (this.state.groups) {
      this.state.groups.forEach(g => {
        g.cardIds = g.cardIds.filter(id => !idSet.has(id));
      });
      // Remove groups with fewer than 2 cards
      const emptyGroups = this.state.groups.filter(g => g.cardIds.length < 2);
      emptyGroups.forEach(g => {
        const leftPinId = `pin-group-left-${g.id}`;
        const rightPinId = `pin-group-right-${g.id}`;
        this.state.connections = this.state.connections.filter(c =>
          c.fromPinId !== leftPinId && c.toPinId !== leftPinId &&
          c.fromPinId !== rightPinId && c.toPinId !== rightPinId
        );
      });
      this.state.groups = this.state.groups.filter(g => g.cardIds.length >= 2);
    }
    this.state.connections = this.state.connections.filter(c => {
      const c1 = this.findCardIdByPin(c.fromPinId);
      const c2 = this.findCardIdByPin(c.toPinId);
      return (!c1 || !idSet.has(c1)) && (!c2 || !idSet.has(c2));
    });
    this.commit();
    this.notify({ type: 'CARD_REMOVED', cardIds });
  }

  removeCard(cardId) {
    this.removeCards([cardId]);
  }

  updateCard(cardId, patch) {
    const card = this.state.cards.find(c => c.id === cardId);
    if (!card) return;
    Object.assign(card, patch);
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

  removeCardFromGroup(groupId, cardId) {
    const group = this.state.groups?.find(g => g.id === groupId);
    if (!group) return;
    group.cardIds = group.cardIds.filter(id => id !== cardId);
    if (group.cardIds.length < 2) {
      this.removeGroup(groupId);
    } else {
      this.commit();
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

    clearTimeout(this.saveTimeout);

    const fullCards = JSON.parse(JSON.stringify(this.state.cards));
    const fullConnections = JSON.parse(JSON.stringify(this.state.connections));
    const fullGroups = JSON.parse(JSON.stringify(this.state.groups || []));

    const focusCards = fullCards.filter(c => focusIdSet.has(c.id));
    const outsideCards = fullCards
      .filter(c => !focusIdSet.has(c.id))
      .map(c => {
        const rect = cardRectsMap?.get(c.id);
        return {
          ...c,
          _measuredWidth: rect ? rect.width : (c.width || 310),
          _measuredHeight: rect ? rect.height : 140
        };
      });

    const preFocusCardRects = focusCards.map(c => {
      const rect = cardRectsMap?.get(c.id);
      const w = rect ? rect.width : (c.width || 310);
      const h = rect ? rect.height : 140;
      return {
        left: c.x,
        top: c.y,
        right: c.x + w,
        bottom: c.y + h,
        width: w,
        height: h,
        cx: c.x + w / 2,
        cy: c.y + h / 2
      };
    });

    const insideGroups = [];
    const outsideGroups = [];
    const partialGroups = [];

    for (const g of fullGroups) {
      const members = Array.isArray(g.cardIds) ? g.cardIds : [];
      const inCount = members.filter(id => focusIdSet.has(id)).length;
      if (inCount === members.length && members.length >= 2) {
        insideGroups.push(g);
      } else if (inCount === 0 && members.length >= 2) {
        outsideGroups.push(g);
      } else if (members.length >= 2) {
        partialGroups.push(g);
      }
    }

    const insideEntityIds = new Set([
      ...focusIdSet,
      ...insideGroups.map(g => g.id)
    ]);

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
      fullPreFocusState: {
        cards: fullCards,
        connections: fullConnections,
        groups: fullGroups
      }
    };

    this.state.cards = JSON.parse(JSON.stringify(focusCards));
    this.state.groups = JSON.parse(JSON.stringify(insideGroups));
    this.state.connections = JSON.parse(JSON.stringify(internalConnections));

    this.undoStack = [this.snapshot()];
    this.redoStack = [];

    this.listeners.forEach(fn => fn({
      type: 'FOCUS_MODE_ENTERED',
      focusCount: focusCards.length
    }, this.state));
    return true;
  }

  confirmFocusMode(afterBox, focusCardRects) {
    if (!this.isFocusMode) return null;
    const session = this.focusSession;

    const editedCards = JSON.parse(JSON.stringify(this.state.cards));
    const editedGroups = JSON.parse(JSON.stringify(this.state.groups || []));
    const editedConnections = JSON.parse(JSON.stringify(this.state.connections));

    const outsideLayoutInput = session.outsideCards.map(c => ({
      id: c.id,
      x: c.x,
      y: c.y,
      width: c._measuredWidth || c.width || 310,
      height: c._measuredHeight || 140
    }));

    const { cardTargets } = computeFocusExitLayout({
      beforeBox: session.beforeBox,
      afterBox,
      preFocusCardRects: session.preFocusCardRects,
      focusCardRects: focusCardRects || [],
      outsideCards: outsideLayoutInput,
      outsideGroups: session.outsideGroups
    });

    const restoredOutsideCards = session.outsideCards.map(c => {
      const clean = JSON.parse(JSON.stringify(c));
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

    const restoredOutsideGroups = JSON.parse(JSON.stringify(session.outsideGroups));
    const restoredPartialGroups = JSON.parse(JSON.stringify(session.partialGroups))
      .map(g => ({
        ...g,
        cardIds: (g.cardIds || []).filter(id => survivingCardIds.has(id))
      }))
      .filter(g => g.cardIds.length >= 2);

    const mergedGroups = [...editedGroups, ...restoredOutsideGroups, ...restoredPartialGroups];

    const validExternalConnections = JSON.parse(JSON.stringify(session.externalConnections))
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

    const outsideCardIds = restoredOutsideCards.map(c => c.id);
    const externalConnIds = validExternalConnections.map(c => c.id);

    this.notify({
      type: 'FOCUS_MODE_EXITED',
      confirmed: true,
      cardTargets,
      outsideCardIds,
      externalConnIds
    });

    return {
      cardTargets,
      outsideCardIds,
      externalConnIds
    };
  }

  cancelFocusMode() {
    if (!this.isFocusMode) return false;
    const session = this.focusSession;
    const pre = session.fullPreFocusState;

    this.state.cards = JSON.parse(JSON.stringify(pre.cards));
    this.state.connections = JSON.parse(JSON.stringify(pre.connections));
    this.state.groups = JSON.parse(JSON.stringify(pre.groups));

    this.undoStack = [...(session.savedUndoStack || [this.snapshot()])];
    this.redoStack = [...(session.savedRedoStack || [])];
    this.focusSession = null;

    this.listeners.forEach(fn => fn({
      type: 'FOCUS_MODE_CANCELLED',
      seedCardIds: session.seedCardIds
    }, this.state));
    return true;
  }

  reset() {
    if (this.isFocusMode) {
      this.emitToast('当前处于专注模式，请先确认并退出专注模式后再重置画布', 'warning');
      return { blocked: true, reason: 'focus-mode' };
    }
    this.state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this.fileHandle = null;
    this.fileName = '';
    this.fileSavedSnapshot = null;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(FILE_NAME_KEY);
    localStorage.removeItem(FILE_SNAPSHOT_KEY);
    persistHandle(null);
    this.undoStack = [this.snapshot()];
    this.redoStack = [];
    this.notify({ type: 'STATE_RESET' });
  }

  async saveToFile() {
    if (this.isFocusMode) {
      this.emitToast('当前处于专注模式，请先确认并退出专注模式后再保存', 'warning');
      return { blocked: true, reason: 'focus-mode' };
    }
    const exportData = {
      version: 1,
      timestamp: Date.now(),
      viewport: this.state.viewport,
      settings: this.state.settings,
      cards: this.state.cards,
      connections: this.state.connections,
      groups: this.state.groups || []
    };
    const jsonStr = JSON.stringify(exportData, null, 2);

    if (window.showSaveFilePicker) {
      try {
        if (this.fileHandle && this.fileHandle.queryPermission) {
          let status = await this.fileHandle.queryPermission({ mode: 'readwrite' });
          if (status !== 'granted') {
            status = await this.fileHandle.requestPermission({ mode: 'readwrite' });
          }
          if (status !== 'granted') {
            this.fileHandle = null;
          }
        }
        if (!this.fileHandle) {
          this.fileHandle = await window.showSaveFilePicker({
            suggestedName: this.fileName || 'graph.pinpoint',
            types: [{
              description: 'PinPoint Graph',
              accept: { 'application/json': ['.pinpoint', '.json'] }
            }]
          });
          this.fileName = this.fileHandle.name;
        }
        const writable = await this.fileHandle.createWritable();
        await writable.write(jsonStr);
        await writable.close();
        persistHandle(this.fileHandle);
        localStorage.setItem(FILE_NAME_KEY, this.fileName);
        this.fileSavedSnapshot = this.snapshot();
        localStorage.setItem(FILE_SNAPSHOT_KEY, this.fileSavedSnapshot);
        this.notify({ type: 'FILE_SAVED', fileName: this.fileName });
        return { success: true, fileName: this.fileName };
      } catch (err) {
        if (err.name === 'AbortError') return { aborted: true };
        console.warn('Save with handle failed:', err);
        this.fileHandle = null;
        persistHandle(null);
      }
    }

    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fileName || 'graph.pinpoint';
    a.click();
    URL.revokeObjectURL(url);
    this.fileSavedSnapshot = this.snapshot();
    localStorage.setItem(FILE_NAME_KEY, a.download);
    localStorage.setItem(FILE_SNAPSHOT_KEY, this.fileSavedSnapshot);
    this.notify({ type: 'FILE_SAVED', fileName: a.download });
    return { success: true, fileName: a.download };
  }

  async openFromFile() {
    if (this.isFocusMode) {
      this.emitToast('当前处于专注模式，请先确认并退出专注模式后再打开文件', 'warning');
      return { blocked: true, reason: 'focus-mode' };
    }
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: 'PinPoint Graph',
            accept: { 'application/json': ['.pinpoint', '.json'] }
          }],
          multiple: false
        });
        const file = await handle.getFile();
        const content = await file.text();
        const data = JSON.parse(content);
        if (data.cards && data.connections) {
          this.fileHandle = handle;
          this.fileName = handle.name;
          persistHandle(this.fileHandle);
          localStorage.setItem(FILE_NAME_KEY, this.fileName);
          this.state = {
            viewport: data.viewport || { x: 0, y: 0, zoom: 1.0 },
            settings: {
              alignMode: data.settings?.alignMode ?? false,
              gridSnapMode: data.settings?.gridSnapMode ?? false,
              palette: Array.isArray(data.settings?.palette) && data.settings.palette.length >= 2
                ? data.settings.palette
                : [...DEFAULT_PALETTE],
              minimap: {
                enabled: data.settings?.minimap?.enabled ?? true,
                position: data.settings?.minimap?.position || 'bottom-right',
                size: typeof data.settings?.minimap?.size === 'number' ? data.settings.minimap.size : 220
              }
            },
            cards: data.cards,
            connections: data.connections.filter(c => this.validateConnection(c, data.cards, data.groups || [])),
            groups: data.groups || []
          };
          this.undoStack = [this.snapshot()];
          this.redoStack = [];
          this.fileSavedSnapshot = this.snapshot();
          localStorage.setItem(FILE_SNAPSHOT_KEY, this.fileSavedSnapshot);
          this.notify({ type: 'FILE_OPENED', fileName: this.fileName });
          return { success: true, fileName: this.fileName };
        }
      } catch (err) {
        if (err.name === 'AbortError') return { aborted: true };
      }
    }

    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pinpoint,.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve({ aborted: true });
        try {
          const content = await file.text();
          const data = JSON.parse(content);
          if (data.cards && data.connections) {
            this.fileHandle = null;
            this.fileName = file.name;
            persistHandle(null);
            localStorage.setItem(FILE_NAME_KEY, this.fileName);
            this.state = {
              viewport: data.viewport || { x: 0, y: 0, zoom: 1.0 },
              settings: {
                alignMode: data.settings?.alignMode ?? false,
                gridSnapMode: data.settings?.gridSnapMode ?? false,
                palette: Array.isArray(data.settings?.palette) && data.settings.palette.length >= 2
                  ? data.settings.palette
                  : [...DEFAULT_PALETTE],
                minimap: {
                  enabled: data.settings?.minimap?.enabled ?? true,
                  position: data.settings?.minimap?.position || 'bottom-right',
                  size: typeof data.settings?.minimap?.size === 'number' ? data.settings.minimap.size : 220
                }
              },
              cards: data.cards,
              connections: data.connections.filter(c => this.validateConnection(c, data.cards, data.groups || [])),
              groups: data.groups || []
            };
            this.undoStack = [this.snapshot()];
            this.redoStack = [];
            this.fileSavedSnapshot = this.snapshot();
            localStorage.setItem(FILE_SNAPSHOT_KEY, this.fileSavedSnapshot);
            this.notify({ type: 'FILE_OPENED', fileName: this.fileName });
            resolve({ success: true, fileName: file.name });
          }
        } catch (e) {
          resolve({ error: e });
        }
      };
      input.click();
    });
  }
}

export const store = new StateManager();
