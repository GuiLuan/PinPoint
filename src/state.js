const STORAGE_KEY = 'pinpoint_workspace_data';

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
    palette: [...DEFAULT_PALETTE]
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
  }

  snapshot() {
    return JSON.stringify({
      cards: this.state.cards,
      connections: this.state.connections,
      groups: this.state.groups || []
    });
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
                : [...DEFAULT_PALETTE]
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

  validateConnection(conn, cards, groups = this.state.groups || []) {
    if (!conn.fromPinId || !conn.toPinId || conn.fromPinId === conn.toPinId) return false;
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

  scheduleAutoSave() {
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
    if (!this.state.settings) this.state.settings = { alignMode: false, gridSnapMode: false, palette: [...DEFAULT_PALETTE] };
    this.state.settings.gridSnapMode = !this.state.settings.gridSnapMode;
    this.scheduleAutoSave();
    this.notify({ type: 'SETTINGS_CHANGED', settings: this.state.settings });
    return this.state.settings.gridSnapMode;
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

  reset() {
    this.state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this.fileHandle = null;
    this.fileName = '';
    localStorage.removeItem(STORAGE_KEY);
    this.undoStack = [this.snapshot()];
    this.redoStack = [];
    this.notify({ type: 'STATE_RESET' });
  }

  async saveToFile() {
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
        this.notify({ type: 'FILE_SAVED', fileName: this.fileName });
        return { success: true, fileName: this.fileName };
      } catch (err) {
        if (err.name === 'AbortError') return { aborted: true };
      }
    }

    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fileName || 'graph.pinpoint';
    a.click();
    URL.revokeObjectURL(url);
    this.notify({ type: 'FILE_SAVED', fileName: a.download });
    return { success: true, fileName: a.download };
  }

  async openFromFile() {
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
          this.state = {
            viewport: data.viewport || { x: 0, y: 0, zoom: 1.0 },
            settings: {
              alignMode: data.settings?.alignMode ?? false,
              gridSnapMode: data.settings?.gridSnapMode ?? false,
              palette: Array.isArray(data.settings?.palette) && data.settings.palette.length >= 2
                ? data.settings.palette
                : [...DEFAULT_PALETTE]
            },
            cards: data.cards,
            connections: data.connections.filter(c => this.validateConnection(c, data.cards, data.groups || [])),
            groups: data.groups || []
          };
          this.undoStack = [this.snapshot()];
          this.redoStack = [];
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
            this.state = {
              viewport: data.viewport || { x: 0, y: 0, zoom: 1.0 },
              settings: {
                alignMode: data.settings?.alignMode ?? false,
                gridSnapMode: data.settings?.gridSnapMode ?? false,
                palette: Array.isArray(data.settings?.palette) && data.settings.palette.length >= 2
                  ? data.settings.palette
                  : [...DEFAULT_PALETTE]
              },
              cards: data.cards,
              connections: data.connections.filter(c => this.validateConnection(c, data.cards, data.groups || [])),
              groups: data.groups || []
            };
            this.undoStack = [this.snapshot()];
            this.redoStack = [];
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
