const STORAGE_KEY = 'pinpoint_workspace_data';

const DEFAULT_STATE = {
  viewport: { x: 0, y: 0, zoom: 1.0 },
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
  ]
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
      connections: this.state.connections
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
          return {
            viewport: parsed.viewport || { x: 0, y: 0, zoom: 1.0 },
            cards: parsed.cards,
            connections: parsed.connections.filter(c => this.validateConnection(c, parsed.cards))
          };
        }
      }
    } catch (e) {
      // Fallback to default
    }
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  validateConnection(conn, cards) {
    if (!conn.fromPinId || !conn.toPinId || conn.fromPinId === conn.toPinId) return false;
    const c1 = this.findCardIdByPin(conn.fromPinId, cards);
    const c2 = this.findCardIdByPin(conn.toPinId, cards);
    return c1 && c2 && c1 !== c2;
  }

  findCardIdByPin(pinId, cards = this.state.cards) {
    if (!pinId) return null;
    if (pinId.startsWith('pin-head-left-')) return pinId.replace('pin-head-left-', '');
    if (pinId.startsWith('pin-head-right-')) return pinId.replace('pin-head-right-', '');
    if (pinId.startsWith('pin-head-')) return pinId.replace('pin-head-', '');
    const card = cards.find(c => c.contentHtml && c.contentHtml.includes(pinId));
    return card ? card.id : null;
  }

  canConnect(fromPinId, toPinId) {
    if (!fromPinId || !toPinId || fromPinId === toPinId) return false;
    const card1 = this.findCardIdByPin(fromPinId);
    const card2 = this.findCardIdByPin(toPinId);
    return card1 && card2 && card1 !== card2;
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
          cards: this.state.cards,
          connections: this.state.connections
        }));
      } catch (e) {}
    }, 400);
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
    this.state.connections = this.state.connections.filter(c => {
      const c1 = this.findCardIdByPin(c.fromPinId);
      const c2 = this.findCardIdByPin(c.toPinId);
      return !idSet.has(c1) && !idSet.has(c2);
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
      cards: this.state.cards,
      connections: this.state.connections
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
            cards: data.cards,
            connections: data.connections.filter(c => this.validateConnection(c, data.cards))
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
              cards: data.cards,
              connections: data.connections.filter(c => this.validateConnection(c, data.cards))
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
