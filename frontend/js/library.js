import { store } from './state.js';
import { canvas } from './canvas.js';
import { nodes, hexToRgba } from './nodes.js';
import { wires } from './wires.js';
import { sync } from './sync.js';

const LIBRARY_STORAGE_KEY = 'pinpoint_library_data';
const API_BASE = '/api/v1';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripTags(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  return (div.textContent || div.innerText || '').trim();
}

function extractCapsuleColors(contentHtml) {
  if (!contentHtml) return [];
  const div = document.createElement('div');
  div.innerHTML = contentHtml;
  const colors = [];
  div.querySelectorAll('.text-capsule').forEach(el => {
    const pinColor = el.style?.getPropertyValue?.('--capsule-pin')?.trim();
    if (pinColor && pinColor !== '#98989d') {
      colors.push(pinColor);
    } else if (el.classList.contains('capsule-blue')) {
      colors.push('#0a84ff');
    } else if (el.classList.contains('capsule-purple')) {
      colors.push('#bf5af2');
    } else if (el.classList.contains('capsule-yellow')) {
      colors.push('#ffd60a');
    } else if (el.classList.contains('capsule-orange')) {
      colors.push('#ff9f0a');
    } else if (el.classList.contains('capsule-red')) {
      colors.push('#ff453a');
    } else {
      colors.push('#30d158');
    }
  });
  return colors;
}

class LibraryManager {
  constructor() {
    this.drawerEl = null;
    this.listEl = null;
    this.searchInputEl = null;
    this.countBadgeEl = null;
    this.saveCtaBtnEl = null;
    this.layoutToggleBtnEl = null;
    this.composerEl = null;
    this.composerNameInputEl = null;
    this.composerPreviewEl = null;
    this.toggleBtnEl = null;
    this.dropOverlayEl = null;
    this.resizeHandleEl = null;

    this.items = this.loadLocalLibrary();
    this.searchQuery = '';
    this.pendingCapture = null;
    this.editingItemId = null;
    this.draggingItemId = null;
    this.isResizing = false;
    this.insertCascade = 0;
  }

  clampWidth(width) {
    const maxAllowed = Math.max(260, Math.min(800, (window.innerWidth || 1280) - 40));
    const numeric = typeof width === 'number' && !Number.isNaN(width) ? width : 348;
    return Math.max(260, Math.min(maxAllowed, Math.round(numeric)));
  }

  init(drawerEl, toggleBtnEl) {
    this.drawerEl = drawerEl;
    this.toggleBtnEl = toggleBtnEl;
    if (!this.drawerEl) return;

    this.listEl = this.drawerEl.querySelector('#library-items-list');
    this.searchInputEl = this.drawerEl.querySelector('#library-search-input');
    this.countBadgeEl = this.drawerEl.querySelector('#library-count-badge');
    this.saveCtaBtnEl = this.drawerEl.querySelector('#btn-library-save-selection');
    this.layoutToggleBtnEl = this.drawerEl.querySelector('#btn-library-layout-toggle');
    this.composerEl = this.drawerEl.querySelector('#library-save-composer');
    this.composerNameInputEl = this.drawerEl.querySelector('#library-save-name-input');
    this.composerPreviewEl = this.drawerEl.querySelector('#library-save-preview');
    this.dropOverlayEl = document.getElementById('library-canvas-drop-hint');
    this.resizeHandleEl = this.drawerEl.querySelector('#library-resize-handle');

    this.bindEvents();
    this.applySettings();
    this.updateSelectionState();
    this.renderList();
  }

  applySettings() {
    if (!this.drawerEl) return;
    const { position, layout, width } = store.getLibrarySettings();

    this.drawerEl.classList.remove('pos-left', 'pos-right');
    this.drawerEl.classList.add(`pos-${position}`);

    if (!this.isResizing) {
      this.drawerEl.style.width = `${this.clampWidth(width)}px`;
    }

    if (this.listEl) {
      const prevLayout = this.listEl.classList.contains('layout-list') ? 'list' : 'grid';
      this.listEl.classList.remove('layout-grid', 'layout-list');
      this.listEl.classList.add(`layout-${layout}`);
      if (prevLayout !== layout) {
        this.renderList();
      }
    }

    if (this.layoutToggleBtnEl) {
      this.layoutToggleBtnEl.classList.toggle('is-list', layout === 'list');
      this.layoutToggleBtnEl.setAttribute(
        'data-tooltip',
        layout === 'grid' ? '切换单列视图' : '切换网格视图'
      );
    }
  }

  isOnline() {
    return window.location.protocol === 'http:' || window.location.protocol === 'https:';
  }

  loadLocalLibrary() {
    try {
      const raw = localStorage.getItem(LIBRARY_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {}
    return [];
  }

  saveLocalLibrary() {
    try {
      localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(this.items));
    } catch (e) {}
  }

  async syncFromBackendBootstrap(remoteItems) {
    if (!Array.isArray(remoteItems)) return;
    const pendingLocal = this.items.filter(it => it && it.localPending);
    if (pendingLocal.length > 0 && this.isOnline()) {
      for (const localItem of [...pendingLocal].reverse()) {
        try {
          const res = await fetch(`${API_BASE}/library`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-PinPoint-Client': sync.clientId
            },
            body: JSON.stringify({
              name: localItem.name,
              description: localItem.description || '',
              cards: localItem.cards,
              groups: localItem.groups || [],
              connections: localItem.connections || []
            })
          });
          if (res.ok) {
            const body = await res.json();
            if (body?.data) remoteItems = [body.data, ...remoteItems];
          }
        } catch (e) {}
      }
    }
    this.items = remoteItems;
    this.saveLocalLibrary();
    this.renderList();
  }

  applyRemoteLibrary(remoteItems) {
    if (!Array.isArray(remoteItems)) return;
    this.items = remoteItems;
    this.saveLocalLibrary();
    this.renderList();
  }

  isOpen() {
    return !!this.drawerEl?.classList.contains('is-open');
  }

  open() {
    if (!this.drawerEl) return;
    this.drawerEl.classList.add('is-open');
    this.toggleBtnEl?.classList.add('is-active');
    this.updateSelectionState();
    this.renderList();
  }

  close() {
    if (!this.drawerEl) return;
    this.cancelSaveForm();
    this.editingItemId = null;
    this.drawerEl.classList.remove('is-open');
    this.toggleBtnEl?.classList.remove('is-active');
  }

  toggle() {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  handleEscape() {
    if (!this.isOpen()) return false;
    if (this.pendingCapture) {
      this.cancelSaveForm();
      return true;
    }
    if (this.editingItemId) {
      this.editingItemId = null;
      this.renderList();
      return true;
    }
    this.close();
    return true;
  }

  updateSelectionState() {
    if (!this.saveCtaBtnEl) return;
    const count = nodes.selectedCardIds.size;
    if (count > 0) {
      this.saveCtaBtnEl.disabled = false;
      this.saveCtaBtnEl.classList.add('is-ready');
      this.saveCtaBtnEl.setAttribute('data-tooltip', `将选中的 ${count} 个节点保存到库 (Shift+L)`);
    } else {
      this.saveCtaBtnEl.disabled = true;
      this.saveCtaBtnEl.classList.remove('is-ready');
      this.saveCtaBtnEl.setAttribute('data-tooltip', '选中画布节点后保存到库 (Shift+L)');
    }
  }

  captureSelection() {
    nodes.flushActiveDOMEdits();
    const selectedSet = new Set(nodes.selectedCardIds);
    if (selectedSet.size === 0) return null;

    const selectedCards = store.state.cards
      .filter(c => selectedSet.has(c.id))
      .map(c => JSON.parse(JSON.stringify(c)));
    if (selectedCards.length === 0) return null;

    const selectedGroups = (store.state.groups || [])
      .filter(g => Array.isArray(g.cardIds) && g.cardIds.length >= 2 && g.cardIds.every(id => selectedSet.has(id)))
      .map(g => JSON.parse(JSON.stringify(g)));

    const groupIdSet = new Set(selectedGroups.map(g => g.id));
    const relevantOwners = new Set([...selectedSet, ...groupIdSet]);

    const internalConnections = store.state.connections
      .filter(conn => {
        const o1 = store.findCardIdByPin(conn.fromPinId);
        const o2 = store.findCardIdByPin(conn.toPinId);
        return o1 && o2 && relevantOwners.has(o1) && relevantOwners.has(o2);
      })
      .map(conn => JSON.parse(JSON.stringify(conn)));

    const minX = Math.min(...selectedCards.map(c => Number(c.x) || 0));
    const minY = Math.min(...selectedCards.map(c => Number(c.y) || 0));
    selectedCards.forEach(c => {
      c.x = Math.round((Number(c.x) || 0) - minX);
      c.y = Math.round((Number(c.y) || 0) - minY);
    });

    let suggestedName = '';
    if (selectedCards.length === 1) {
      suggestedName = selectedCards[0].title || '未命名节点';
    } else if (selectedGroups.length === 1 && selectedGroups[0].cardIds.length === selectedCards.length) {
      suggestedName = selectedGroups[0].title || `${selectedCards[0].title} 等 ${selectedCards.length} 个节点`;
    } else {
      suggestedName = `${selectedCards[0].title || '未命名节点'} 等 ${selectedCards.length} 个节点`;
    }

    return {
      suggestedName,
      cards: selectedCards,
      groups: selectedGroups,
      connections: internalConnections
    };
  }

  openSaveForm() {
    const capture = this.captureSelection();
    if (!capture) {
      this.open();
      store.emitToast('请先在画布上选中至少 1 个节点后再保存到库', 'warning');
      return;
    }

    this.pendingCapture = capture;
    this.open();

    if (this.composerEl) {
      this.composerEl.style.display = 'flex';
    }
    if (this.composerNameInputEl) {
      this.composerNameInputEl.value = capture.suggestedName;
    }
    if (this.composerPreviewEl) {
      this.composerPreviewEl.innerHTML = this.buildPreviewSvg(capture);
    }

    requestAnimationFrame(() => {
      this.composerNameInputEl?.focus();
      this.composerNameInputEl?.select();
    });
  }

  cancelSaveForm() {
    this.pendingCapture = null;
    if (this.composerEl) {
      this.composerEl.style.display = 'none';
    }
  }

  async confirmSaveForm() {
    if (!this.pendingCapture) return;
    const name = (this.composerNameInputEl?.value || '').trim() || this.pendingCapture.suggestedName;
    const capture = this.pendingCapture;
    this.cancelSaveForm();
    await this.createLibraryItem({
      name,
      description: '',
      cards: capture.cards,
      groups: capture.groups,
      connections: capture.connections
    });
  }

  async createLibraryItem(payload) {
    const now = Date.now();
    const localFallbackItem = {
      id: `lib-${now}-${Math.floor(Math.random() * 100000)}`,
      name: payload.name,
      description: payload.description || '',
      createdAt: now,
      updatedAt: now,
      cards: JSON.parse(JSON.stringify(payload.cards)),
      groups: JSON.parse(JSON.stringify(payload.groups || [])),
      connections: JSON.parse(JSON.stringify(payload.connections || []))
    };

    if (this.isOnline()) {
      try {
        const res = await fetch(`${API_BASE}/library`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-PinPoint-Client': sync.clientId
          },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          const json = await res.json();
          if (json?.ok && json.data) {
            this.items = [json.data, ...this.items.filter(it => it.id !== json.data.id)];
            this.saveLocalLibrary();
            this.renderList();
            store.emitToast(`已保存到库：「${json.data.name}」`, 'success');
            return json.data;
          }
        }
      } catch (e) {}
    }

    localFallbackItem.localPending = true;
    this.items = [localFallbackItem, ...this.items];
    this.saveLocalLibrary();
    this.renderList();
    store.emitToast(`已保存到本地库：「${localFallbackItem.name}」`, 'success');
    return localFallbackItem;
  }

  async renameLibraryItem(itemId, newName) {
    const trimmed = (newName || '').trim();
    if (!trimmed) {
      this.editingItemId = null;
      this.renderList();
      return;
    }

    const item = this.items.find(it => it.id === itemId);
    if (!item) return;

    item.name = trimmed;
    item.updatedAt = Date.now();
    this.editingItemId = null;
    this.saveLocalLibrary();
    this.renderList();

    if (this.isOnline() && !item.localPending) {
      try {
        const res = await fetch(`${API_BASE}/library/${encodeURIComponent(itemId)}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-PinPoint-Client': sync.clientId
          },
          body: JSON.stringify({ name: trimmed })
        });
        if (res.ok) {
          const json = await res.json();
          if (json?.ok && json.data) {
            const idx = this.items.findIndex(it => it.id === itemId);
            if (idx >= 0) this.items[idx] = json.data;
            this.saveLocalLibrary();
            this.renderList();
          }
        }
      } catch (e) {}
    }
    store.emitToast(`已重命名为「${trimmed}」`, 'info');
  }

  async deleteLibraryItem(itemId) {
    const item = this.items.find(it => it.id === itemId);
    if (!item) return;
    if (!confirm(`确定要从库中删除「${item.name}」吗？`)) return;

    const wasLocalPending = !!item.localPending;
    this.items = this.items.filter(it => it.id !== itemId);
    this.saveLocalLibrary();
    this.renderList();

    if (this.isOnline() && !wasLocalPending) {
      try {
        await fetch(`${API_BASE}/library/${encodeURIComponent(itemId)}`, {
          method: 'DELETE',
          headers: {
            'X-PinPoint-Client': sync.clientId
          }
        });
      } catch (e) {}
    }
    store.emitToast(`已从库中移除「${item.name}」`, 'info');
  }

  instantiateItem(itemId, boardPos = null) {
    const item = this.items.find(it => it.id === itemId);
    if (!item || !Array.isArray(item.cards) || item.cards.length === 0) return false;

    const { newCards, newGroups, newConnections } = nodes.cloneCardsAndGroups(
      item.cards,
      item.groups || [],
      item.connections || []
    );

    if (newCards.length === 0) return false;

    const minX = Math.min(...newCards.map(c => Number(c.x) || 0));
    const minY = Math.min(...newCards.map(c => Number(c.y) || 0));
    const maxX = Math.max(...newCards.map(c => (Number(c.x) || 0) + (Number(c.width) || 310)));
    const maxY = Math.max(...newCards.map(c => (Number(c.y) || 0) + 140));
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;

    let targetOriginX;
    let targetOriginY;

    if (boardPos && typeof boardPos.x === 'number' && typeof boardPos.y === 'number') {
      targetOriginX = boardPos.x - bboxW / 2;
      targetOriginY = boardPos.y - Math.min(48, bboxH / 2);
    } else {
      const vp = store.state.viewport;
      const centerX = (-vp.x + window.innerWidth / 2) / vp.zoom;
      const centerY = (-vp.y + window.innerHeight / 2) / vp.zoom;
      const cascade = (this.insertCascade % 5) * 28;
      this.insertCascade += 1;
      targetOriginX = centerX - bboxW / 2 + cascade;
      targetOriginY = centerY - bboxH / 2 + cascade;
    }

    const dx = targetOriginX - minX;
    const dy = targetOriginY - minY;
    const gridSnap = !!store.state.settings?.gridSnapMode;

    newCards.forEach(c => {
      let nx = Math.round((Number(c.x) || 0) + dx);
      let ny = Math.round((Number(c.y) || 0) + dy);
      if (gridSnap) {
        nx = Math.round(nx / 24) * 24;
        ny = Math.round(ny / 24) * 24;
      }
      c.x = nx;
      c.y = ny;
      store.state.cards.push(c);
    });

    if (newGroups.length > 0) {
      if (!store.state.groups) store.state.groups = [];
      newGroups.forEach(g => store.state.groups.push(g));
    }

    newConnections.forEach(conn => {
      store.state.connections.push(conn);
    });

    nodes.hideAllMenus();
    nodes.selectedCardIds = new Set(newCards.map(c => c.id));
    store.commit();
    nodes.render();
    nodes.renderGroups();
    wires.render();
    nodes.updateAlignmentBar();
    store.scheduleAutoSave();
    nodes.onSelectionChange?.();

    store.emitToast(`已从库插入「${item.name}」（${newCards.length} 个节点）`, 'success');
    return true;
  }

  buildPreviewSvg(item) {
    const cards = item.cards || [];
    const groups = item.groups || [];
    const connections = item.connections || [];
    if (cards.length === 0) return '';

    const W = 264;
    const H = 84;
    const PAD = 10;
    const EST_CARD_H = 124;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const cardRects = new Map();
    cards.forEach(c => {
      const x = Number(c.x) || 0;
      const y = Number(c.y) || 0;
      const w = Number(c.width) || 310;
      const h = EST_CARD_H;
      cardRects.set(c.id, { x, y, w, h, color: c.headerColor || '#98989d' });
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    });

    const spanW = Math.max(1, maxX - minX);
    const spanH = Math.max(1, maxY - minY);
    const scale = Math.min((W - PAD * 2) / spanW, (H - PAD * 2) / spanH, 0.45);
    const drawnW = spanW * scale;
    const drawnH = spanH * scale;
    const offX = (W - drawnW) / 2 - minX * scale;
    const offY = (H - drawnH) / 2 - minY * scale;

    const mapX = (x) => (x * scale + offX).toFixed(1);
    const mapY = (y) => (y * scale + offY).toFixed(1);

    const resolvePinCenter = (pinId) => {
      if (!pinId) return null;
      if (pinId.startsWith('pin-group-')) {
        const prefix = pinId.startsWith('pin-group-left-')
          ? 'pin-group-left-'
          : pinId.startsWith('pin-group-right-')
            ? 'pin-group-right-'
            : 'pin-group-';
        const gid = pinId.slice(prefix.length);
        const grp = groups.find(g => g.id === gid);
        if (!grp) return null;
        const members = grp.cardIds.map(id => cardRects.get(id)).filter(Boolean);
        if (members.length === 0) return null;
        const gx1 = Math.min(...members.map(m => m.x)) - 20;
        const gy1 = Math.min(...members.map(m => m.y)) - 36;
        const gx2 = Math.max(...members.map(m => m.x + m.w)) + 20;
        const isRight = pinId.startsWith('pin-group-right-');
        return { x: isRight ? gx2 : gx1, y: gy1 + 14 };
      }
      for (const prefix of ['pin-head-left-', 'pin-head-right-', 'pin-head-']) {
        if (pinId.startsWith(prefix)) {
          const cid = pinId.slice(prefix.length);
          const rect = cardRects.get(cid);
          if (!rect) return null;
          const isRight = prefix === 'pin-head-right-';
          return { x: isRight ? rect.x + rect.w : rect.x, y: rect.y + 18 };
        }
      }
      for (const c of cards) {
        if (c.contentHtml && c.contentHtml.includes(pinId)) {
          const rect = cardRects.get(c.id);
          if (rect) {
            return { x: rect.x + rect.w * 0.5, y: rect.y + rect.h * 0.62 };
          }
        }
      }
      return null;
    };

    const groupMarkup = groups.map(g => {
      const members = (g.cardIds || []).map(id => cardRects.get(id)).filter(Boolean);
      if (members.length < 2) return '';
      const gx = Math.min(...members.map(m => m.x)) - 18;
      const gy = Math.min(...members.map(m => m.y)) - 32;
      const gw = Math.max(...members.map(m => m.x + m.w)) - gx + 18;
      const gh = Math.max(...members.map(m => m.y + m.h)) - gy + 18;
      const col = escapeHtml(g.headerColor || '#0a84ff');
      return `<rect x="${mapX(gx)}" y="${mapY(gy)}" width="${(gw * scale).toFixed(1)}" height="${(gh * scale).toFixed(1)}" rx="5" fill="${escapeHtml(hexToRgba(g.headerColor || '#0a84ff', 0.09))}" stroke="${col}" stroke-opacity="0.55" stroke-width="1" stroke-dasharray="3 2" />`;
    }).join('');

    const wireMarkup = connections.map(conn => {
      const p1 = resolvePinCenter(conn.fromPinId);
      const p2 = resolvePinCenter(conn.toPinId);
      if (!p1 || !p2) return '';
      const x1 = Number(mapX(p1.x));
      const y1 = Number(mapY(p1.y));
      const x2 = Number(mapX(p2.x));
      const y2 = Number(mapY(p2.y));
      const dx = Math.max(12, Math.abs(x2 - x1) * 0.45);
      const cx1 = x1 + (x2 >= x1 ? dx : -dx);
      const cx2 = x2 - (x2 >= x1 ? dx : -dx);
      const col = escapeHtml(conn.color || '#98989d');
      return `<path d="M ${x1} ${y1} C ${cx1.toFixed(1)} ${y1}, ${cx2.toFixed(1)} ${y2}, ${x2} ${y2}" fill="none" stroke="${col}" stroke-width="1.6" stroke-opacity="0.85" />`;
    }).join('');

    const cardMarkup = cards.map(c => {
      const rect = cardRects.get(c.id);
      const x = Number(mapX(rect.x));
      const y = Number(mapY(rect.y));
      const w = Math.max(14, rect.w * scale);
      const h = Math.max(12, rect.h * scale);
      const hdrH = Math.max(3.5, Math.min(7, h * 0.28));
      const col = c.headerColor || '#98989d';
      const capColors = extractCapsuleColors(c.contentHtml).slice(0, 3);
      const dots = capColors.map((cc, idx) => {
        const dx = x + 4 + idx * 5.5;
        const dy = y + h * 0.62;
        if (dx + 3 > x + w - 3) return '';
        return `<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="2" fill="${escapeHtml(cc)}" />`;
      }).join('');
      return `
        <g>
          <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3.5" fill="rgba(34,34,38,0.95)" stroke="rgba(255,255,255,0.18)" stroke-width="0.9" />
          <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${hdrH.toFixed(1)}" rx="2.5" fill="${escapeHtml(col)}" fill-opacity="0.88" />
          <line x1="${(x + 3.5).toFixed(1)}" y1="${(y + hdrH + 4).toFixed(1)}" x2="${Math.max(x + 6, x + w - 4).toFixed(1)}" y2="${(y + hdrH + 4).toFixed(1)}" stroke="rgba(255,255,255,0.18)" stroke-width="1.2" stroke-linecap="round" />
          ${dots}
        </g>
      `;
    }).join('');

    return `<svg class="library-preview-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${groupMarkup}${wireMarkup}${cardMarkup}</svg>`;
  }

  getFilteredItems() {
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter(item => {
      const parts = [item.name || '', item.description || ''];
      (item.cards || []).forEach(c => {
        parts.push(c.title || '');
        parts.push(stripTags(c.contentHtml || ''));
      });
      return parts.join('\n').toLowerCase().includes(q);
    });
  }

  renderList() {
    if (!this.listEl) return;
    if (this.countBadgeEl) {
      this.countBadgeEl.textContent = String(this.items.length);
    }

    const { layout } = store.getLibrarySettings();
    this.listEl.classList.remove('layout-grid', 'layout-list');
    this.listEl.classList.add(`layout-${layout}`);

    const filtered = this.getFilteredItems();
    if (filtered.length === 0) {
      const emptyMsg = this.items.length === 0
        ? '库中还没有保存任何节点组合。<br>选中画布上的节点后，点击左上角「＋」按钮或按 Shift+L 即可保存。'
        : `没有匹配「${escapeHtml(this.searchQuery)}」的库项目。`;
      this.listEl.innerHTML = `
        <div class="library-empty-state">
          <svg viewBox="0 0 24 24" width="28" height="28" stroke="currentColor" stroke-width="1.5" fill="none">
            <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
            <path d="M2 17l10 5 10-5"></path>
            <path d="M2 12l10 5 10-5"></path>
          </svg>
          <p>${emptyMsg}</p>
        </div>
      `;
      return;
    }

    this.listEl.innerHTML = '';
    filtered.forEach(item => {
      const cardCount = item.cards?.length || 0;
      const connCount = item.connections?.length || 0;
      const groupCount = item.groups?.length || 0;

      const metaParts = [`${cardCount} 节点`];
      if (connCount > 0) metaParts.push(`${connCount} 连线`);
      if (groupCount > 0) metaParts.push(`${groupCount} 组`);

      const tileEl = document.createElement('div');
      tileEl.className = 'library-item-tile';
      tileEl.dataset.itemId = item.id;
      tileEl.setAttribute('draggable', 'true');

      const tooltipLines = [item.name, metaParts.join(' · ')];
      if (item.description) tooltipLines.push(item.description);
      tooltipLines.push('拖拽或双击缩略图插入，点击名称重命名');
      tileEl.title = tooltipLines.join('\n');

      const isEditing = this.editingItemId === item.id;
      const nameHtml = isEditing
        ? `<input type="text" class="library-item-rename-input" value="${escapeHtml(item.name)}" />`
        : `<span class="library-item-name" title="点击重命名">${escapeHtml(item.name)}</span>`;

      const listMetaHtml = layout === 'list'
        ? `<span class="library-item-submeta">${metaParts.join(' · ')}</span>${item.description ? `<span class="library-item-desc" title="${escapeHtml(item.description)}">${escapeHtml(item.description)}</span>` : ''}`
        : '';

      tileEl.innerHTML = `
        <div class="library-tile-visual">
          ${this.buildPreviewSvg(item)}
          <div class="library-tile-actions">
            <button type="button" class="library-tile-action-btn btn-lib-insert" title="插入到画布">
              <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
            <button type="button" class="library-tile-action-btn danger btn-lib-delete" title="从库中删除">
              <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        </div>
        <div class="library-tile-caption">
          ${nameHtml}
          ${listMetaHtml}
        </div>
      `;

      // Drag from library onto canvas
      tileEl.addEventListener('dragstart', (e) => {
        if (isEditing || e.target?.closest?.('.library-tile-caption, button, input')) {
          e.preventDefault();
          return;
        }
        this.draggingItemId = item.id;
        tileEl.classList.add('is-dragging');
        try {
          e.dataTransfer.setData('application/x-pinpoint-library', item.id);
          e.dataTransfer.setData('text/plain', item.id);
          e.dataTransfer.effectAllowed = 'copy';
        } catch (err) {}
      });

      tileEl.addEventListener('dragend', () => {
        this.draggingItemId = null;
        tileEl.classList.remove('is-dragging');
        this.dropOverlayEl?.classList.remove('is-visible');
      });

      tileEl.addEventListener('dblclick', (e) => {
        if (e.target.closest('button, input, .library-tile-caption')) return;
        this.instantiateItem(item.id);
      });

      tileEl.querySelector('.btn-lib-insert')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.instantiateItem(item.id);
      });

      tileEl.querySelector('.btn-lib-delete')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteLibraryItem(item.id);
      });

      const nameSpan = tileEl.querySelector('.library-item-name');
      nameSpan?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.editingItemId = item.id;
        this.renderList();
        const input = this.listEl.querySelector(`[data-item-id="${CSS.escape(item.id)}"] .library-item-rename-input`);
        if (input) {
          input.focus();
          input.select();
        }
      });

      if (isEditing) {
        const input = tileEl.querySelector('.library-item-rename-input');
        let finished = false;
        const finishRename = (save) => {
          if (finished) return;
          finished = true;
          if (save) {
            this.renameLibraryItem(item.id, input.value);
          } else {
            this.editingItemId = null;
            this.renderList();
          }
        };
        input?.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            finishRename(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finishRename(false);
          }
        });
        input?.addEventListener('blur', () => finishRename(true));
        input?.addEventListener('mousedown', (e) => e.stopPropagation());
      }

      this.listEl.appendChild(tileEl);
    });
  }

  bindEvents() {
    this.drawerEl.addEventListener('mousedown', (e) => e.stopPropagation());
    this.drawerEl.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    this.drawerEl.querySelector('#btn-close-library')?.addEventListener('click', () => {
      this.close();
    });

    this.layoutToggleBtnEl?.addEventListener('click', () => {
      const current = store.getLibrarySettings().layout;
      const next = current === 'grid' ? 'list' : 'grid';
      store.setLibrarySettings({ layout: next });
    });

    this.saveCtaBtnEl?.addEventListener('click', () => {
      this.openSaveForm();
    });

    this.composerNameInputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.confirmSaveForm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancelSaveForm();
      }
    });

    this.searchInputEl?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value || '';
      this.renderList();
    });

    if (this.resizeHandleEl) {
      this.resizeHandleEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startWidth = this.drawerEl.getBoundingClientRect().width;
        const isRight = this.drawerEl.classList.contains('pos-right');

        this.isResizing = true;
        this.drawerEl.classList.add('is-resizing');
        document.body.style.cursor = 'ew-resize';

        const onMouseMove = (ev) => {
          const delta = isRight ? (startX - ev.clientX) : (ev.clientX - startX);
          const nextWidth = this.clampWidth(startWidth + delta);
          this.drawerEl.style.width = `${nextWidth}px`;
        };

        const onMouseUp = () => {
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
          this.isResizing = false;
          this.drawerEl.classList.remove('is-resizing');
          document.body.style.cursor = '';

          const finalWidth = this.clampWidth(this.drawerEl.getBoundingClientRect().width);
          this.drawerEl.style.width = `${finalWidth}px`;
          store.setLibrarySettings({ width: finalWidth });
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });

      this.resizeHandleEl.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const resetWidth = this.clampWidth(348);
        this.drawerEl.style.width = `${resetWidth}px`;
        store.setLibrarySettings({ width: resetWidth });
      });
    }

    // Canvas drop support for dragging library items directly onto canvas
    const viewportEl = document.getElementById('viewport');
    if (viewportEl) {
      viewportEl.addEventListener('dragover', (e) => {
        const hasType = this.draggingItemId || e.dataTransfer?.types?.includes('application/x-pinpoint-library');
        if (!hasType) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        this.dropOverlayEl?.classList.add('is-visible');
      });

      viewportEl.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && viewportEl.contains(e.relatedTarget)) return;
        this.dropOverlayEl?.classList.remove('is-visible');
      });

      viewportEl.addEventListener('drop', (e) => {
        const itemId = e.dataTransfer?.getData('application/x-pinpoint-library') || this.draggingItemId;
        this.dropOverlayEl?.classList.remove('is-visible');
        this.draggingItemId = null;
        if (!itemId) return;
        e.preventDefault();
        const boardPos = canvas.screenToBoard(e.clientX, e.clientY);
        this.instantiateItem(itemId, boardPos);
      });
    }
  }
}

export const library = new LibraryManager();
