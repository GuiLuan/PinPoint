import { store } from './state.js';
import { canvas } from './canvas.js';
import { wires } from './wires.js';

export function hexToRgba(hex, alpha = 1) {
  if (!hex) return `rgba(48, 209, 88, ${alpha})`;
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  const num = parseInt(c, 16);
  if (isNaN(num)) return hex;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

class NodeManager {
  constructor() {
    this.containerEl = null;
    this.groupsContainerEl = null;
    this.selectionPopoverEl = null;
    this.capsuleActionBarEl = null;
    this.canvasContextMenuEl = null;
    this.marqueeBoxEl = null;
    this.alignmentBarEl = null;
    this.viewportEl = null;
    this.currentRange = null;
    this.targetCapsule = null;
    this.selectedCapsule = null;
    this.targetHeaderCard = null;
    this.targetGroup = null;
    this.selectedColor = '#30d158';
    this.selectedCardIds = new Set();
    this.activeMarquee = null;
    this.activeDrag = null;
    this.clipboard = null;
    this.pasteCount = 0;
    this.mouseBoardPos = { x: 0, y: 0 };
  }

  init(containerEl, selectionPopoverEl, marqueeBoxEl, alignmentBarEl, viewportEl, capsuleActionBarEl, canvasContextMenuEl) {
    this.containerEl = containerEl;
    this.groupsContainerEl = document.getElementById('groups-container');
    this.selectionPopoverEl = selectionPopoverEl;
    this.capsuleActionBarEl = capsuleActionBarEl || document.getElementById('capsule-action-bar');
    this.canvasContextMenuEl = canvasContextMenuEl || document.getElementById('canvas-context-menu');
    this.marqueeBoxEl = marqueeBoxEl;
    this.alignmentBarEl = alignmentBarEl;
    this.viewportEl = viewportEl;

    window.addEventListener('mousemove', (e) => {
      const { x, y, zoom } = store.state.viewport;
      this.mouseBoardPos = {
        x: (e.clientX - x) / zoom,
        y: (e.clientY - y) / zoom
      };
    });

    this.renderPopoverPalette();
    this.bindCapsuleActionEvents();
    this.bindCanvasContextMenuEvents();
    this.bindCanvasShortcuts();
    this.bindSelectionEvents();
    this.bindAlignmentEvents();
    this.bindMarqueeEvents();
    this.bindGlobalGestures();
  }

  spawnNode(pos, title = '未命名节点', skipCommit = false) {
    let x = Math.round(pos.x - 20);
    let y = Math.round(pos.y - 20);
    if (store.state.settings?.gridSnapMode) {
      const GRID_SIZE = 24;
      x = Math.round(x / GRID_SIZE) * GRID_SIZE;
      y = Math.round(y / GRID_SIZE) * GRID_SIZE;
    }
    const card = {
      id: `card-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      title: title || '未命名节点',
      x,
      y,
      width: 310,
      contentHtml: ''
    };
    store.addCard(card, skipCommit);
    this.render();
    return card;
  }

  editCardTitle(cardId) {
    const cardEl = document.getElementById(`card-dom-${cardId}`);
    if (!cardEl) return;
    if (typeof cardEl._startTitleEdit === 'function') {
      cardEl._startTitleEdit();
    } else {
      const titleSpan = cardEl.querySelector('.header-title');
      titleSpan?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }
  }

  render() {
    this.containerEl.innerHTML = '';

    store.state.cards.forEach(card => {
      const cardEl = document.createElement('div');
      cardEl.className = 'note-card' + (this.selectedCardIds.has(card.id) ? ' selected' : '');
      cardEl.id = `card-dom-${card.id}`;
      cardEl.style.left = `${card.x}px`;
      cardEl.style.top = `${card.y}px`;
      cardEl.style.width = `${card.width || 310}px`;

      const leftPinId = `pin-head-left-${card.id}`;
      const rightPinId = `pin-head-right-${card.id}`;
      const legacyPinId = `pin-head-${card.id}`;

      const leftConn = store.state.connections.find(c => c.toPinId === leftPinId || c.fromPinId === leftPinId || c.toPinId === legacyPinId);
      const rightConn = store.state.connections.find(c => c.toPinId === rightPinId || c.fromPinId === rightPinId);

      const leftConnected = !!leftConn;
      const rightConnected = !!rightConn;

      const leftColor = card.headerColor || leftConn?.color || '#98989d';
      const rightColor = card.headerColor || rightConn?.color || '#98989d';

      let headerStyle = '';
      if (card.headerColor) {
        cardEl.style.setProperty('--card-theme-border', hexToRgba(card.headerColor, 0.75));
        cardEl.style.setProperty('--card-theme-glow', hexToRgba(card.headerColor, 0.45));
        const bg1 = hexToRgba(card.headerColor, 0.24);
        const bg2 = hexToRgba(card.headerColor, 0.10);
        const borderOutline = hexToRgba(card.headerColor, 0.70);
        const borderDivider = hexToRgba(card.headerColor, 0.35);
        headerStyle = `style="background: linear-gradient(180deg, ${bg1} 0%, ${bg2} 100%); border-color: ${borderOutline}; border-top-color: ${card.headerColor}; border-bottom-color: ${borderDivider};"`;
      } else {
        cardEl.style.removeProperty('--card-theme-border');
        cardEl.style.removeProperty('--card-theme-glow');
      }

      cardEl.innerHTML = `
        <div class="note-header" ${headerStyle}>
          <div class="header-port-slot header-port-slot-left" title="连接端口 (左)">
            <i class="header-pin header-pin-left ${leftConnected ? 'pin-connected' : ''}" 
               data-header-pin-id="${leftPinId}" 
               style="background-color: ${leftColor}; color: ${leftColor};"></i>
          </div>

          <div class="header-content">
            <span class="header-title" title="双击重命名">${card.title || '未命名节点'}</span>
            <input class="header-title-input" value="${card.title || ''}" placeholder="未命名节点" style="display: none;" />
          </div>

          <div class="header-port-slot header-port-slot-right" title="连接端口 (右)">
            <i class="header-pin header-pin-right ${rightConnected ? 'pin-connected' : ''}" 
               data-header-pin-id="${rightPinId}" 
               style="background-color: ${rightColor}; color: ${rightColor};"></i>
          </div>
        </div>
        <div class="note-body" contenteditable="true" spellcheck="false">${card.contentHtml || ''}</div>
        <div class="card-resize-handle card-resize-handle-left" data-side="left" title="按住左右拖拽调节宽度 (左侧)"></div>
        <div class="card-resize-handle card-resize-handle-right" data-side="right" title="按住左右拖拽调节宽度 (右侧)"></div>
      `;

      // Title editing (double click to edit, enter/blur/escape to commit)
      const titleSpan = cardEl.querySelector('.header-title');
      const titleInput = cardEl.querySelector('.header-title-input');

      let prevTitle = card.title || '';
      const startTitleEdit = () => {
        prevTitle = card.title || '';
        titleSpan.style.display = 'none';
        titleInput.style.display = 'block';
        titleInput.value = card.title || '';
        titleInput.focus();
        titleInput.select();
      };
      cardEl._startTitleEdit = startTitleEdit;

      const finishTitleEdit = () => {
        if (titleInput.style.display === 'none') return;
        const newTitle = titleInput.value.trim() || '未命名节点';
        const changed = newTitle !== prevTitle;
        card.title = newTitle;
        prevTitle = newTitle;
        titleSpan.textContent = newTitle;
        titleInput.style.display = 'none';
        titleSpan.style.display = '';
        if (changed) store.commit();
        store.scheduleAutoSave();
      };

      titleSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startTitleEdit();
      });

      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finishTitleEdit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          titleInput.value = card.title || '';
          finishTitleEdit();
        }
      });

      titleInput.addEventListener('blur', () => {
        finishTitleEdit();
      });

      titleInput.addEventListener('mousedown', (e) => {
        e.stopPropagation();
      });

      cardEl.addEventListener('mousedown', (e) => {
        if (e.shiftKey && !e.target.closest('.header-pin, .header-port-slot, .capsule-pin')) {
          e.preventDefault();
          this.selectCard(card.id, true);
        }
      });

      // Drag node by header or open color popover via right click
      const headerEl = cardEl.querySelector('.note-header');

      headerEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot, .capsule-pin')) return;
        e.preventDefault();
        e.stopPropagation();
        this.openPopoverForHeader(card, headerEl);
      });

      headerEl.addEventListener('mousedown', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot') || e.target === titleInput) return;
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        wires.clearFocus();
        wires.dismissDropMenu(true);
        this.clearCapsuleSelection();
        window.getSelection()?.removeAllRanges();
        this.hideSelectionPopover();

        if (e.shiftKey) {
          this.selectCard(card.id, true);
        } else if (!this.selectedCardIds.has(card.id)) {
          this.selectCard(card.id, false);
        }

        this.activeDrag = {
          type: 'MOVE_CARDS',
          leadCardId: card.id,
          startX: e.clientX,
          startY: e.clientY,
          isAlt: e.altKey,
          cloned: false,
          initialPositions: new Map(
            [...this.selectedCardIds].map(id => {
              const c = store.state.cards.find(x => x.id === id);
              return [id, { x: c.x, y: c.y, width: c.width || 310 }];
            })
          )
        };
        this.selectedCardIds.forEach(id => {
          document.getElementById(`card-dom-${id}`)?.classList.add('active');
        });
      });

      headerEl.addEventListener('dblclick', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot') || e.target === titleInput) return;
        startTitleEdit();
      });

      // Card resizing (both left and right handles)
      cardEl.querySelectorAll('.card-resize-handle').forEach(resizeHandle => {
        resizeHandle.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          wires.clearFocus();
          wires.dismissDropMenu(true);
          this.clearCapsuleSelection();
          window.getSelection()?.removeAllRanges();
          this.hideSelectionPopover();

          const side = resizeHandle.getAttribute('data-side') || 'right';
          this.activeDrag = {
            type: 'RESIZE_CARD',
            side,
            cardId: card.id,
            startX: e.clientX,
            initX: card.x,
            initWidth: cardEl.offsetWidth
          };
          resizeHandle.classList.add('active');
        });
      });

      // Header pins connection (left and right)
      const headPinLeftEl = cardEl.querySelector('.header-pin-left');
      const headPinRightEl = cardEl.querySelector('.header-pin-right');
      this.bindPinEvents(headPinLeftEl, leftPinId);
      this.bindPinEvents(headPinRightEl, rightPinId);

      // Body input & keyboard events
      const bodyEl = cardEl.querySelector('.note-body');
      let bodyTypingTimeout = null;

      bodyEl.addEventListener('input', () => {
        card.contentHtml = bodyEl.innerHTML;
        wires.render();
        store.scheduleAutoSave();

        clearTimeout(bodyTypingTimeout);
        bodyTypingTimeout = setTimeout(() => {
          store.commit();
        }, 700);
      });

      bodyEl.addEventListener('blur', () => {
        clearTimeout(bodyTypingTimeout);
        store.commit();
      });

      bodyEl.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
          e.preventDefault();
          document.execCommand('redo');
          card.contentHtml = bodyEl.innerHTML;
          wires.render();
          store.scheduleAutoSave();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
          setTimeout(() => {
            card.contentHtml = bodyEl.innerHTML;
            wires.render();
            store.scheduleAutoSave();
          }, 0);
        }
      });

      this.containerEl.appendChild(cardEl);
    });

    this.bindCapsuleEvents();
    this.renderGroups();
  }

  bindPinEvents(pinEl, pinId) {
    if (!pinEl) return;
    const slotEl = pinEl.closest('.header-port-slot');
    const triggerEl = slotEl || pinEl;

    triggerEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      wires.clearFocus();
      window.getSelection()?.removeAllRanges();

      const startPos = wires.getPinBoardPos(pinId);
      if (!startPos) return;

      const capsule = pinEl.closest('.text-capsule');
      const cardEl = pinEl.closest('.note-card');
      const cardId = cardEl?.id.replace('card-dom-', '');
      const card = cardId ? store.state.cards.find(c => c.id === cardId) : null;

      let color = '#98989d';
      if (capsule) {
        color = window.getComputedStyle(capsule).getPropertyValue('--capsule-pin').trim() || '#30d158';
      } else if (card?.headerColor) {
        color = card.headerColor;
      }

      wires.startConnect(pinId, startPos, color, e.clientX, e.clientY);
      pinEl.classList.add('pin-active');
    });

    triggerEl.addEventListener('mouseenter', () => {
      if (wires.activeDrag) {
        if (store.canConnect(wires.activeDrag.fromPinId, pinId)) {
          pinEl.classList.add(pinEl.classList.contains('pin-connected') ? 'pin-active' : 'pin-ghost');
        }
      }
    });

    triggerEl.addEventListener('mouseleave', () => {
      if (wires.activeDrag) {
        pinEl.classList.remove('pin-active');
        pinEl.classList.remove('pin-ghost');
      }
    });
  }

  bindCapsuleEvents() {
    document.querySelectorAll('.text-capsule').forEach(capsule => {
      const pinId = capsule.getAttribute('data-pin-id');
      const pinEl = capsule.querySelector('.capsule-pin');

      this.bindPinEvents(pinEl, pinId);

      capsule.addEventListener('mouseenter', () => {
        if (wires.activeDrag) return;
        wires.triggerPinFocus(pinId);
      });

      capsule.addEventListener('mouseleave', () => {
        if (wires.activeDrag) return;
        wires.clearFocus();
      });

      // Right click capsule: open color customization popover (same mental model as header)
      capsule.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        wires.clearFocus();
        this.clearCapsuleSelection();
        this.openPopoverForCapsule(capsule);
      });

      // Prevent mousedown on capsule from triggering text selection on the atomic node
      capsule.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.capsule-pin')) return;
        e.preventDefault();
      });

      // Click capsule body to select it and reveal delete button
      capsule.addEventListener('click', (e) => {
        if (e.target.closest('.capsule-pin')) return;
        e.stopPropagation();
        this.selectCapsule(capsule);
      });
    });
  }

  bindCapsuleActionEvents() {
    if (!this.capsuleActionBarEl) return;
    this.capsuleActionBarEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    const btnDelete = this.capsuleActionBarEl.querySelector('#btn-delete-capsule');
    btnDelete?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.selectedCapsule) {
        this.deleteCapsule(this.selectedCapsule);
      }
    });
  }

  selectCapsule(capsule) {
    if (!capsule) return;
    this.hideSelectionPopover();
    this.clearCapsuleSelection();

    this.selectedCapsule = capsule;
    capsule.classList.add('capsule-selected');
    this.updateCapsuleActionPosition();
  }

  clearCapsuleSelection() {
    if (this.selectedCapsule) {
      this.selectedCapsule.classList.remove('capsule-selected');
      this.selectedCapsule = null;
    }
    if (this.capsuleActionBarEl) {
      this.capsuleActionBarEl.style.display = 'none';
    }
  }

  updateCapsuleActionPosition() {
    if (!this.selectedCapsule || !this.capsuleActionBarEl) return;
    const rects = this.selectedCapsule.getClientRects();
    const rect = rects.length > 0 ? rects[0] : this.selectedCapsule.getBoundingClientRect();
    if ((rect.width === 0 && rect.height === 0) || rect.bottom < 0 || rect.top > window.innerHeight) {
      this.capsuleActionBarEl.style.display = 'none';
      return;
    }
    this.capsuleActionBarEl.style.display = 'flex';
    this.capsuleActionBarEl.style.left = `${rect.left + rect.width / 2}px`;
    this.capsuleActionBarEl.style.top = `${rect.top}px`;
  }

  deleteCapsule(capsule) {
    if (!capsule) return;
    wires.clearFocus();
    const pinId = capsule.getAttribute('data-pin-id');
    if (pinId) {
      const connsToRemove = store.state.connections.filter(c => c.fromPinId === pinId || c.toPinId === pinId);
      connsToRemove.forEach(c => store.removeConnection(c.id));
    }

    const text = capsule.innerText.trim();
    const textNode = document.createTextNode(text);
    const cardEl = capsule.closest('.note-card');
    const cardId = cardEl?.id.replace('card-dom-', '');

    capsule.parentNode?.replaceChild(textNode, capsule);

    if (cardId) {
      const card = store.state.cards.find(c => c.id === cardId);
      if (card && cardEl) {
        card.contentHtml = cardEl.querySelector('.note-body').innerHTML;
      }
    }

    this.clearCapsuleSelection();
    store.commit();
    this.render();
    wires.render();
    store.scheduleAutoSave();
  }

  bindCanvasContextMenuEvents() {
    if (!this.canvasContextMenuEl) return;
    this.canvasContextMenuEl.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    const btnAlign = this.canvasContextMenuEl.querySelector('#menu-toggle-align');
    btnAlign?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      store.toggleAlignMode();
      this.updateContextMenuToggles();
    });

    const btnGrid = this.canvasContextMenuEl.querySelector('#menu-toggle-gridsnap');
    btnGrid?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      store.toggleGridSnapMode();
      this.updateContextMenuToggles();
    });
  }

  bindCanvasShortcuts() {
    if (!this.viewportEl) return;

    // Double click on empty canvas to quickly spawn node at cursor
    this.viewportEl.addEventListener('dblclick', (e) => {
      const isBg = (e.target === this.viewportEl ||
                    e.target === document.getElementById('board') ||
                    e.target.id === 'wire-svg') &&
                   !e.target.closest('.note-card, .wire-group, .hud-bar, .alignment-bar, #selection-popover, #capsule-action-bar, #wire-drop-menu, #canvas-context-menu');
      if (!isBg || e.button !== 0) return;

      this.hideAllMenus();
      const boardPos = canvas.screenToBoard(e.clientX, e.clientY);
      const newNode = this.spawnNode(boardPos);
      wires.render();

      setTimeout(() => {
        const cardEl = document.getElementById(`card-dom-${newNode.id}`);
        if (cardEl) {
          const titleSpan = cardEl.querySelector('.header-title');
          titleSpan?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        }
      }, 30);
    });

    // Right click on empty canvas to open context menu
    this.viewportEl.addEventListener('contextmenu', (e) => {
      const isBg = (e.target === this.viewportEl ||
                    e.target === document.getElementById('board') ||
                    e.target.id === 'wire-svg') &&
                   !e.target.closest('.note-card, .wire-group, .hud-bar, .alignment-bar, #selection-popover, #capsule-action-bar, #wire-drop-menu');
      if (!isBg) return;

      e.preventDefault();
      e.stopPropagation();
      this.showCanvasContextMenu(e.clientX, e.clientY);
    });
  }

  showCanvasContextMenu(screenX, screenY) {
    if (!this.canvasContextMenuEl) return;
    this.hideAllMenus();
    this.updateContextMenuToggles();

    const menu = this.canvasContextMenuEl;
    menu.style.display = 'flex';

    const menuWidth = 185;
    const menuHeight = 110;
    let left = screenX + 2;
    let top = screenY + 2;

    if (left + menuWidth > window.innerWidth - 10) {
      left = screenX - menuWidth - 2;
    }
    if (top + menuHeight > window.innerHeight - 10) {
      top = screenY - menuHeight - 2;
    }
    if (left < 10) left = 10;
    if (top < 10) top = 10;

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  hideCanvasContextMenu() {
    if (this.canvasContextMenuEl) {
      this.canvasContextMenuEl.style.display = 'none';
    }
  }

  updateContextMenuToggles() {
    const alignActive = !!store.state.settings?.alignMode;
    const gridActive = !!store.state.settings?.gridSnapMode;
    const alignPill = document.getElementById('toggle-align-pill');
    const gridPill = document.getElementById('toggle-gridsnap-pill');
    if (alignPill) alignPill.classList.toggle('is-active', alignActive);
    if (gridPill) gridPill.classList.toggle('is-active', gridActive);
  }

  hideAllMenus() {
    this.clearCapsuleSelection();
    this.hideSelectionPopover();
    this.hideCanvasContextMenu();
    wires.dismissDropMenu(true);
  }

  selectAllCards() {
    this.hideAllMenus();
    this.selectedCardIds = new Set(store.state.cards.map(c => c.id));
    this.updateSelectionVisuals();
    this.updateAlignmentBar();
  }

  renderPopoverPalette() {
    if (!this.selectionPopoverEl) return;
    const colorsRow = this.selectionPopoverEl.querySelector('.popover-colors-row');
    if (!colorsRow) return;

    const palette = store.getPalette();
    colorsRow.innerHTML = '';

    // "无颜色 / 默认" button
    const noneBtn = document.createElement('button');
    noneBtn.className = 'popover-color-btn popover-none-btn' + (this.selectedColor === null ? ' selected' : '');
    noneBtn.setAttribute('data-color', 'none');
    noneBtn.title = '无颜色 / 默认';
    noneBtn.innerHTML = `
      <svg viewBox="0 0 20 20" class="none-color-icon">
        <circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.6" fill="none"></circle>
        <line x1="4.5" y1="4.5" x2="15.5" y2="15.5" stroke="currentColor" stroke-width="1.6"></line>
      </svg>
    `;
    noneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setSelectedColor(null);
    });
    colorsRow.appendChild(noneBtn);

    const dividerLeft = document.createElement('div');
    dividerLeft.className = 'popover-divider';
    colorsRow.appendChild(dividerLeft);

    palette.forEach((color, idx) => {
      const btn = document.createElement('button');
      btn.className = 'popover-color-btn';
      btn.setAttribute('data-color', color);
      btn.style.setProperty('--btn-color', color);
      btn.title = `配色 ${idx + 1} (${color})`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setSelectedColor(color);
      });
      colorsRow.appendChild(btn);
    });

    const divider = document.createElement('div');
    divider.className = 'popover-divider';
    colorsRow.appendChild(divider);

    const label = document.createElement('label');
    label.className = 'popover-palette-btn';
    label.title = '自定义调色盘';
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'popover-color-picker';
    input.value = this.selectedColor || palette[0] || '#30d158';

    const handleCustomColor = (e) => {
      const col = e.target.value;
      if (col) this.setSelectedColor(col);
    };
    input.addEventListener('input', handleCustomColor);
    input.addEventListener('change', handleCustomColor);

    label.appendChild(input);
    colorsRow.appendChild(label);

    this.setSelectedColor(this.selectedColor);
  }

  setSelectedColor(color) {
    this.selectedColor = (color === 'none' || color === '' || color === undefined) ? null : color;
    let matchedPreset = false;

    const noneBtn = this.selectionPopoverEl.querySelector('.popover-none-btn');
    if (noneBtn) {
      noneBtn.classList.toggle('selected', this.selectedColor === null);
    }

    this.selectionPopoverEl.querySelectorAll('.popover-color-btn:not(.popover-none-btn)').forEach(btn => {
      const btnColor = btn.getAttribute('data-color');
      const isMatch = this.selectedColor && btnColor?.toLowerCase() === this.selectedColor?.toLowerCase();
      btn.classList.toggle('selected', isMatch);
      if (isMatch) matchedPreset = true;
    });

    const paletteBtn = this.selectionPopoverEl.querySelector('.popover-palette-btn');
    if (paletteBtn) {
      paletteBtn.classList.toggle('selected', this.selectedColor !== null && !matchedPreset);
      const colorPicker = paletteBtn.querySelector('.popover-color-picker');
      if (colorPicker && this.selectedColor && this.selectedColor.startsWith('#')) colorPicker.value = this.selectedColor;
    }

    const dot = this.selectionPopoverEl.querySelector('.apply-color-dot');
    if (dot) {
      if (this.selectedColor) {
        dot.style.backgroundColor = this.selectedColor;
        dot.style.borderColor = 'transparent';
        dot.innerHTML = '';
      } else {
        dot.style.backgroundColor = 'transparent';
        dot.style.borderColor = 'rgba(255, 255, 255, 0.4)';
        dot.innerHTML = `<svg viewBox="0 0 12 12" style="width:100%;height:100%;color:#ff453a;display:block;"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.8"></line></svg>`;
      }
    }
  }

  openPopoverForCapsule(capsule) {
    this.clearCapsuleSelection();
    window.getSelection()?.removeAllRanges();
    this.currentRange = null;
    this.targetHeaderCard = null;
    this.targetGroup = null;
    this.targetCapsule = capsule;

    this.renderPopoverPalette();
    const pinColor = capsule.style.getPropertyValue('--capsule-pin').trim();
    const currentColor = (pinColor && pinColor !== '#98989d') ? pinColor : null;

    this.setSelectedColor(currentColor);
    this.updatePopoverPosition();
  }

  openPopoverForHeader(card, headerEl) {
    this.clearCapsuleSelection();
    window.getSelection()?.removeAllRanges();
    this.currentRange = null;
    this.targetCapsule = null;
    this.targetGroup = null;
    this.targetHeaderCard = { card, headerEl };

    this.renderPopoverPalette();
    const currentColor = card.headerColor || null;
    this.setSelectedColor(currentColor);
    this.updatePopoverPosition();
  }

  updatePopoverPosition() {
    if (!this.selectionPopoverEl) return;

    let rect = null;
    if (this.targetHeaderCard) {
      rect = this.targetHeaderCard.headerEl.getBoundingClientRect();
    } else if (this.targetGroup) {
      rect = this.targetGroup.headerEl.getBoundingClientRect();
    } else if (this.targetCapsule) {
      const rects = this.targetCapsule.getClientRects();
      rect = rects.length > 0 ? rects[0] : this.targetCapsule.getBoundingClientRect();
    } else if (this.currentRange) {
      const rects = this.currentRange.getClientRects();
      rect = rects.length > 0 ? rects[0] : this.currentRange.getBoundingClientRect();
    }

    if (!rect || (rect.width === 0 && rect.height === 0)) {
      this.hideSelectionPopover();
      return;
    }

    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
      this.selectionPopoverEl.style.display = 'none';
      return;
    }

    this.selectionPopoverEl.style.display = 'flex';
    this.selectionPopoverEl.style.left = `${rect.left + rect.width / 2}px`;
    this.selectionPopoverEl.style.top = `${rect.top}px`;
  }

  hideSelectionPopover() {
    if (this.selectionPopoverEl) {
      this.selectionPopoverEl.style.display = 'none';
    }
    this.currentRange = null;
    this.targetCapsule = null;
    this.targetHeaderCard = null;
    this.targetGroup = null;
  }

  bindSelectionEvents() {
    document.addEventListener('selectionchange', () => {
      if (document.body.classList.contains('is-wire-dragging') || this.activeDrag) {
        this.hideSelectionPopover();
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        if (!this.targetCapsule && !this.targetHeaderCard && !this.targetGroup) this.hideSelectionPopover();
        return;
      }

      const text = selection.toString().trim();
      if (!text) {
        if (!this.targetCapsule && !this.targetHeaderCard && !this.targetGroup) this.hideSelectionPopover();
        return;
      }

      const anchor = selection.anchorNode;
      const bodyEl = anchor?.nodeType === 3 ? anchor.parentElement.closest('.note-body') : anchor?.closest('.note-body');
      if (!bodyEl) {
        if (!this.targetCapsule && !this.targetHeaderCard && !this.targetGroup) this.hideSelectionPopover();
        return;
      }

      this.targetCapsule = null;
      this.targetHeaderCard = null;
      this.targetGroup = null;
      this.currentRange = selection.getRangeAt(0).cloneRange();
      this.renderPopoverPalette();
      this.setSelectedColor(this.selectedColor || store.getPalette()[0] || '#30d158');
      this.updatePopoverPosition();
    });

    this.selectionPopoverEl.addEventListener('mousedown', (e) => {
      if (!e.target.classList.contains('popover-color-picker')) {
        e.preventDefault();
      }
    });

    const applyBtn = this.selectionPopoverEl.querySelector('#popover-apply-btn');
    if (applyBtn) {
      applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.applyColor();
      });
    }

    document.addEventListener('mousedown', (e) => {
      if (this.canvasContextMenuEl && this.canvasContextMenuEl.contains(e.target)) return;
      this.hideCanvasContextMenu();

      if (this.capsuleActionBarEl && this.capsuleActionBarEl.contains(e.target)) return;
      if (!e.target.closest('.text-capsule')) {
        this.clearCapsuleSelection();
      }

      if (this.selectionPopoverEl && this.selectionPopoverEl.contains(e.target)) return;
      if (e.target.closest('.text-capsule, .note-header, .group-header')) return;
      this.hideSelectionPopover();
    });

    window.addEventListener('keydown', (e) => {
      if (this.selectionPopoverEl && this.selectionPopoverEl.style.display === 'flex') {
        if (e.key === 'Escape') {
          this.hideSelectionPopover();
        } else if (e.key === 'Enter' && !e.target?.closest?.('input, [contenteditable="true"]')) {
          e.preventDefault();
          this.applyColor();
        }
      }
    });
  }

  applyColor() {
    if (this.targetHeaderCard) {
      this.applyHeaderColor(this.targetHeaderCard.card, this.selectedColor);
    } else if (this.targetGroup) {
      this.applyGroupColor(this.targetGroup.group, this.selectedColor);
    } else if (this.targetCapsule) {
      this.recolorCapsule(this.targetCapsule, this.selectedColor);
    } else if (this.currentRange) {
      this.createCapsuleFromSelection(this.selectedColor);
    }
    this.hideSelectionPopover();
  }

  applyHeaderColor(card, newColor) {
    card.headerColor = newColor;

    const leftPinId = `pin-head-left-${card.id}`;
    const rightPinId = `pin-head-right-${card.id}`;
    const legacyPinId = `pin-head-${card.id}`;
    const headPins = new Set([leftPinId, rightPinId, legacyPinId]);

    store.state.connections.forEach(conn => {
      if (headPins.has(conn.fromPinId)) {
        if (newColor) {
          conn.color = newColor;
        } else {
          const otherId = store.findCardIdByPin(conn.toPinId);
          const otherCard = store.state.cards.find(c => c.id === otherId);
          conn.color = otherCard?.headerColor || '#98989d';
        }
      } else if (headPins.has(conn.toPinId)) {
        // If arriving from an uncolored header node, update connection color
        const otherCardId = store.findCardIdByPin(conn.fromPinId);
        const otherCard = store.state.cards.find(c => c.id === otherCardId);
        const isFromCapsule = conn.fromPinId.startsWith('pin-') && !conn.fromPinId.startsWith('pin-head-');
        if (!isFromCapsule) {
          conn.color = otherCard?.headerColor || newColor || '#98989d';
        }
      }
    });

    store.commit();
    this.render();
    wires.render();
    store.scheduleAutoSave();
  }

  recolorCapsule(capsule, newColor) {
    const pinId = capsule.getAttribute('data-pin-id');
    const color = newColor || '#98989d';
    const bg = newColor ? hexToRgba(newColor, 0.14) : 'rgba(255, 255, 255, 0.08)';
    const border = newColor ? hexToRgba(newColor, 0.38) : 'rgba(255, 255, 255, 0.2)';

    capsule.style.setProperty('--capsule-pin', color);
    capsule.style.backgroundColor = bg;
    capsule.style.borderColor = border;

    // Update both outgoing and incoming connections connected to this capsule
    if (pinId) {
      store.state.connections.forEach(conn => {
        if (conn.fromPinId === pinId || conn.toPinId === pinId) {
          conn.color = color;
        }
      });
    }

    const cardEl = capsule.closest('.note-card');
    const cardId = cardEl?.id.replace('card-dom-', '');
    if (cardId) {
      const card = store.state.cards.find(c => c.id === cardId);
      if (card) {
        card.contentHtml = cardEl.querySelector('.note-body').innerHTML;
      }
    }

    store.commit();
    this.render();
    wires.render();
    store.scheduleAutoSave();
  }

  createCapsuleFromSelection(color = '#30d158') {
    if (!this.currentRange) return;

    const selectedText = this.currentRange.toString().trim();
    if (!selectedText) return;

    const pinId = `pin-${Date.now()}`;
    const bg = hexToRgba(color, 0.14);
    const border = hexToRgba(color, 0.38);

    const capsule = document.createElement('span');
    capsule.className = 'text-capsule';
    capsule.setAttribute('data-pin-id', pinId);
    capsule.setAttribute('contenteditable', 'false');
    capsule.style.setProperty('--capsule-pin', color);
    capsule.style.backgroundColor = bg;
    capsule.style.borderColor = border;
    capsule.innerHTML = `<i class="capsule-pin"></i>${selectedText}`;

    this.currentRange.deleteContents();
    this.currentRange.insertNode(capsule);

    window.getSelection()?.removeAllRanges();
    this.hideSelectionPopover();

    const cardEl = capsule.closest('.note-card');
    const cardId = cardEl?.id.replace('card-dom-', '');
    if (cardId) {
      const card = store.state.cards.find(c => c.id === cardId);
      if (card) {
        card.contentHtml = cardEl.querySelector('.note-body').innerHTML;
      }
    }

    this.bindCapsuleEvents();
    store.commit();
    wires.render();
    store.scheduleAutoSave();
  }

  selectCard(cardId, isShift = false) {
    if (isShift) {
      if (this.selectedCardIds.has(cardId)) {
        this.selectedCardIds.delete(cardId);
      } else {
        this.selectedCardIds.add(cardId);
      }
    } else {
      this.selectedCardIds.clear();
      this.selectedCardIds.add(cardId);
    }
    this.updateSelectionVisuals();
    this.updateAlignmentBar();
  }

  clearSelection() {
    this.selectedCardIds.clear();
    this.updateSelectionVisuals();
    this.updateAlignmentBar();
  }

  filterSelectionAfterRestore() {
    this.selectedCardIds = new Set(
      [...this.selectedCardIds].filter(id => store.state.cards.some(c => c.id === id))
    );
  }

  updateSelectionVisuals() {
    document.querySelectorAll('.note-card').forEach(cardEl => {
      const cardId = cardEl.id.replace('card-dom-', '');
      cardEl.classList.toggle('selected', this.selectedCardIds.has(cardId));
    });
  }

  updateAlignmentBar() {
    if (!this.alignmentBarEl) return;
    const count = this.selectedCardIds.size;
    if (count >= 2) {
      this.alignmentBarEl.style.display = 'flex';
      const distributeH = this.alignmentBarEl.querySelector('#btn-distribute-h');
      const distributeV = this.alignmentBarEl.querySelector('#btn-distribute-v');
      const btnCreateGroup = this.alignmentBarEl.querySelector('#btn-create-group');
      if (distributeH) {
        distributeH.style.opacity = count >= 3 ? '1' : '0.35';
        distributeH.style.pointerEvents = count >= 3 ? 'auto' : 'none';
      }
      if (distributeV) {
        distributeV.style.opacity = count >= 3 ? '1' : '0.35';
        distributeV.style.pointerEvents = count >= 3 ? 'auto' : 'none';
      }
      if (btnCreateGroup) {
        btnCreateGroup.style.display = 'flex';
      }
    } else {
      this.alignmentBarEl.style.display = 'none';
    }
  }

  deleteSelectedCards() {
    if (this.selectedCardIds.size === 0) return;
    const toDelete = [...this.selectedCardIds];
    store.removeCards(toDelete);
    this.clearSelection();
    this.render();
    wires.render();
    store.scheduleAutoSave();
  }

  cloneCardsAndGroups(cardsToClone, groupsToClone = [], connectionsToClone = null) {
    const cardIdMap = new Map();
    const groupIdMap = new Map();
    const pinIdMap = new Map();
    const newCards = [];
    const newGroups = [];

    // 1. Generate new IDs and map header pins for cards
    cardsToClone.forEach(c => {
      const newCardId = `card-${Date.now()}-${Math.floor(Math.random() * 100000)}-${Math.floor(Math.random() * 1000)}`;
      cardIdMap.set(c.id, newCardId);
      pinIdMap.set(`pin-head-left-${c.id}`, `pin-head-left-${newCardId}`);
      pinIdMap.set(`pin-head-right-${c.id}`, `pin-head-right-${newCardId}`);
      pinIdMap.set(`pin-head-${c.id}`, `pin-head-left-${newCardId}`);
    });

    // 2. Generate new IDs and map pins for groups
    groupsToClone.forEach(g => {
      const newGroupId = `group-${Date.now()}-${Math.floor(Math.random() * 100000)}-${Math.floor(Math.random() * 1000)}`;
      groupIdMap.set(g.id, newGroupId);
      pinIdMap.set(`pin-group-left-${g.id}`, `pin-group-left-${newGroupId}`);
      pinIdMap.set(`pin-group-right-${g.id}`, `pin-group-right-${newGroupId}`);
      pinIdMap.set(`pin-group-${g.id}`, `pin-group-left-${newGroupId}`);

      const clonedGroup = JSON.parse(JSON.stringify(g));
      clonedGroup.id = newGroupId;
      clonedGroup.cardIds = (g.cardIds || []).map(oldId => cardIdMap.get(oldId)).filter(Boolean);
      newGroups.push(clonedGroup);
    });

    // 3. Clone cards and remap capsule pins in contentHtml
    cardsToClone.forEach(c => {
      const newCardId = cardIdMap.get(c.id);
      const cloned = JSON.parse(JSON.stringify(c));
      cloned.id = newCardId;

      if (cloned.contentHtml) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = cloned.contentHtml;
        tempDiv.querySelectorAll('.text-capsule').forEach(capsule => {
          const oldPinId = capsule.getAttribute('data-pin-id');
          const newPinId = `pin-${Date.now()}-${Math.floor(Math.random() * 100000)}-${Math.floor(Math.random() * 1000)}`;
          capsule.setAttribute('data-pin-id', newPinId);
          if (oldPinId) pinIdMap.set(oldPinId, newPinId);
        });
        cloned.contentHtml = tempDiv.innerHTML;
      }
      newCards.push(cloned);
    });

    // 4. Remap connections
    const sourceCardIds = new Set(cardsToClone.map(c => c.id));
    const sourceGroupIds = new Set(groupsToClone.map(g => g.id));
    const relevantSourceIds = new Set([...sourceCardIds, ...sourceGroupIds]);

    const candidateConnections = (connectionsToClone !== null)
      ? connectionsToClone
      : store.state.connections.filter(conn => {
          const o1 = store.findCardIdByPin(conn.fromPinId);
          const o2 = store.findCardIdByPin(conn.toPinId);
          return o1 && o2 && relevantSourceIds.has(o1) && relevantSourceIds.has(o2);
        });

    const newConnections = [];
    candidateConnections.forEach(conn => {
      const remappedFrom = pinIdMap.get(conn.fromPinId);
      const remappedTo = pinIdMap.get(conn.toPinId);
      if (remappedFrom && remappedTo) {
        newConnections.push({
          id: `conn-${Date.now()}-${Math.floor(Math.random() * 100000)}-${Math.floor(Math.random() * 1000)}`,
          fromPinId: remappedFrom,
          toPinId: remappedTo,
          color: conn.color
        });
      }
    });

    return { newCards, newGroups, newConnections, cardIdMap, groupIdMap, pinIdMap };
  }

  cloneCards(cardsToClone) {
    return this.cloneCardsAndGroups(cardsToClone);
  }

  copySelectedCards() {
    if (this.selectedCardIds.size === 0) return false;

    // Sync contentHtml from DOM for any card with active edits
    this.selectedCardIds.forEach(id => {
      const card = store.state.cards.find(c => c.id === id);
      const cardEl = document.getElementById(`card-dom-${id}`);
      const body = cardEl?.querySelector('.note-body');
      if (card && body) {
        card.contentHtml = body.innerHTML;
      }
    });

    const cardsToCopy = store.state.cards.filter(c => this.selectedCardIds.has(c.id));
    if (cardsToCopy.length === 0) return false;

    // Identify any groups whose member cards are all selected
    const groupsToCopy = (store.state.groups || []).filter(g =>
      g.cardIds && g.cardIds.length > 0 && g.cardIds.every(id => this.selectedCardIds.has(id))
    );
    const groupIdsToCopy = new Set(groupsToCopy.map(g => g.id));

    const relevantEntityIds = new Set([...this.selectedCardIds, ...groupIdsToCopy]);
    const internalConnections = store.state.connections.filter(conn => {
      const owner1 = store.findCardIdByPin(conn.fromPinId);
      const owner2 = store.findCardIdByPin(conn.toPinId);
      return owner1 && owner2 && relevantEntityIds.has(owner1) && relevantEntityIds.has(owner2);
    }).map(c => JSON.parse(JSON.stringify(c)));

    this.clipboard = {
      cards: JSON.parse(JSON.stringify(cardsToCopy)),
      groups: JSON.parse(JSON.stringify(groupsToCopy)),
      internalConnections
    };
    this.pasteCount = 0;
    return true;
  }

  cutSelectedCards() {
    if (this.selectedCardIds.size === 0) return false;
    this.copySelectedCards();
    this.deleteSelectedCards();
    return true;
  }

  pasteCards() {
    if (!this.clipboard || !this.clipboard.cards || this.clipboard.cards.length === 0) return false;
    this.pasteCount++;
    const offset = 32 * this.pasteCount;

    const { newCards, newGroups, newConnections } = this.cloneCardsAndGroups(
      this.clipboard.cards,
      this.clipboard.groups || [],
      this.clipboard.internalConnections || []
    );

    newCards.forEach(c => {
      c.x = Math.round(c.x + offset);
      c.y = Math.round(c.y + offset);
      if (store.state.settings?.gridSnapMode) {
        const GRID_SIZE = 24;
        c.x = Math.round(c.x / GRID_SIZE) * GRID_SIZE;
        c.y = Math.round(c.y / GRID_SIZE) * GRID_SIZE;
      }
      store.state.cards.push(c);
    });

    if (newGroups && newGroups.length > 0) {
      if (!store.state.groups) store.state.groups = [];
      newGroups.forEach(g => store.state.groups.push(g));
    }

    newConnections.forEach(conn => {
      store.state.connections.push(conn);
    });

    this.selectedCardIds = new Set(newCards.map(c => c.id));
    store.commit();
    this.render();
    this.renderGroups();
    wires.render();
    store.scheduleAutoSave();
    this.updateAlignmentBar();
    return true;
  }

  calcGroupBounds(group) {
    if (!group || !Array.isArray(group.cardIds) || group.cardIds.length === 0) return null;
    const memberCards = store.state.cards.filter(c => group.cardIds.includes(c.id));
    if (memberCards.length === 0) return null;

    const PADDING_X = 24;
    const PADDING_TOP = 52;
    const PADDING_BOTTOM = 24;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    memberCards.forEach(c => {
      const el = document.getElementById(`card-dom-${c.id}`);
      const w = el?.offsetWidth || c.width || 310;
      const h = el?.offsetHeight || 140;
      if (c.x < minX) minX = c.x;
      if (c.x + w > maxX) maxX = c.x + w;
      if (c.y < minY) minY = c.y;
      if (c.y + h > maxY) maxY = c.y + h;
    });

    const x = minX - PADDING_X;
    const y = minY - PADDING_TOP;
    const width = Math.max(340, (maxX - minX) + PADDING_X * 2);
    const height = (maxY - minY) + PADDING_TOP + PADDING_BOTTOM;

    return { x, y, width, height };
  }

  renderGroups() {
    if (!this.groupsContainerEl) {
      this.groupsContainerEl = document.getElementById('groups-container');
      if (!this.groupsContainerEl) return;
    }
    this.groupsContainerEl.innerHTML = '';

    const groups = store.state.groups || [];
    groups.forEach(group => {
      const bounds = this.calcGroupBounds(group);
      if (!bounds) return;

      const groupEl = document.createElement('div');
      groupEl.className = 'node-group';
      groupEl.id = `group-dom-${group.id}`;
      groupEl.style.left = `${bounds.x}px`;
      groupEl.style.top = `${bounds.y}px`;
      groupEl.style.width = `${bounds.width}px`;
      groupEl.style.height = `${bounds.height}px`;

      const leftPinId = `pin-group-left-${group.id}`;
      const rightPinId = `pin-group-right-${group.id}`;
      const leftConn = store.state.connections.find(c => c.toPinId === leftPinId || c.fromPinId === leftPinId);
      const rightConn = store.state.connections.find(c => c.toPinId === rightPinId || c.fromPinId === rightPinId);

      const leftConnected = !!leftConn;
      const rightConnected = !!rightConn;
      const leftColor = group.headerColor || leftConn?.color || '#98989d';
      const rightColor = group.headerColor || rightConn?.color || '#98989d';

      if (group.headerColor) {
        groupEl.style.borderColor = hexToRgba(group.headerColor, 0.45);
        groupEl.style.backgroundColor = hexToRgba(group.headerColor, 0.035);
        groupEl.style.setProperty('--group-theme', group.headerColor);
      } else {
        groupEl.style.removeProperty('--group-theme');
      }

      const memberCount = group.cardIds.filter(id => store.state.cards.some(c => c.id === id)).length;

      groupEl.innerHTML = `
        <div class="group-header">
          <div class="header-port-slot header-port-slot-left" title="组连接端口 (左)">
            <i class="header-pin header-pin-left ${leftConnected ? 'pin-connected' : ''}" 
               data-header-pin-id="${leftPinId}" 
               style="background-color: ${leftColor}; color: ${leftColor};"></i>
          </div>

          <div class="group-title-container">
            <svg class="group-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect></svg>
            <span class="group-title" title="双击重命名组">${group.title || '节点组'}</span>
            <input class="group-title-input" value="${group.title || ''}" placeholder="节点组" style="display: none;" />
            <span class="group-card-count">${memberCount} 个节点</span>
          </div>

          <div class="group-actions">
            <button class="group-ungroup-btn" title="解散组 (Ctrl+Shift+G)">
              <svg viewBox="0 0 24 24"><path d="M16 16v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1"></path><rect x="9" y="3" width="12" height="12" rx="2"></rect></svg>
              解散
            </button>
          </div>

          <div class="header-port-slot header-port-slot-right" title="组连接端口 (右)">
            <i class="header-pin header-pin-right ${rightConnected ? 'pin-connected' : ''}" 
               data-header-pin-id="${rightPinId}" 
               style="background-color: ${rightColor}; color: ${rightColor};"></i>
          </div>
        </div>
      `;

      // Title editing
      const titleSpan = groupEl.querySelector('.group-title');
      const titleInput = groupEl.querySelector('.group-title-input');
      const startRename = () => {
        titleSpan.style.display = 'none';
        titleInput.style.display = 'block';
        titleInput.value = group.title || '';
        titleInput.focus();
        titleInput.select();
      };
      const finishRename = () => {
        if (titleInput.style.display === 'none') return;
        const newTitle = titleInput.value.trim() || '节点组';
        group.title = newTitle;
        titleSpan.textContent = newTitle;
        titleInput.style.display = 'none';
        titleSpan.style.display = '';
        store.commit();
        store.scheduleAutoSave();
      };
      titleSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename();
      });
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finishRename();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          titleInput.value = group.title || '';
          finishRename();
        }
      });
      titleInput.addEventListener('blur', finishRename);
      titleInput.addEventListener('mousedown', (e) => e.stopPropagation());

      // Ungroup button
      const ungroupBtn = groupEl.querySelector('.group-ungroup-btn');
      ungroupBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.ungroup(group.id);
      });

      // Right-click group header to recolor
      const headerEl = groupEl.querySelector('.group-header');
      headerEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot, .group-ungroup-btn')) return;
        e.preventDefault();
        e.stopPropagation();
        this.openPopoverForGroup(group, headerEl);
      });

      // Drag group by header
      headerEl.addEventListener('mousedown', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot, .group-ungroup-btn') || e.target === titleInput) return;
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        wires.clearFocus();
        wires.dismissDropMenu(true);
        this.clearCapsuleSelection();
        window.getSelection()?.removeAllRanges();
        this.hideSelectionPopover();

        // Select all cards in the group
        this.selectedCardIds = new Set(group.cardIds);
        this.updateSelectionVisuals();
        this.updateAlignmentBar();

        const memberCards = store.state.cards.filter(c => group.cardIds.includes(c.id));
        this.activeDrag = {
          type: 'MOVE_GROUP',
          groupId: group.id,
          startX: e.clientX,
          startY: e.clientY,
          isAlt: e.altKey,
          cloned: false,
          initialPositions: new Map(memberCards.map(c => [c.id, { x: c.x, y: c.y }]))
        };
        groupEl.classList.add('active');
      });

      // Group pins
      const pinLeft = groupEl.querySelector('.header-pin-left');
      const pinRight = groupEl.querySelector('.header-pin-right');
      this.bindPinEvents(pinLeft, leftPinId);
      this.bindPinEvents(pinRight, rightPinId);

      this.groupsContainerEl.appendChild(groupEl);
    });
  }

  updateGroupDOMBounds(groupId) {
    const group = store.state.groups?.find(g => g.id === groupId);
    if (!group) return;
    const bounds = this.calcGroupBounds(group);
    const groupEl = document.getElementById(`group-dom-${groupId}`);
    if (groupEl && bounds) {
      groupEl.style.left = `${bounds.x}px`;
      groupEl.style.top = `${bounds.y}px`;
      groupEl.style.width = `${bounds.width}px`;
      groupEl.style.height = `${bounds.height}px`;
      const countBadge = groupEl.querySelector('.group-card-count');
      if (countBadge) countBadge.textContent = `${group.cardIds.length} 个节点`;
    }
  }

  createGroupFromSelected() {
    if (this.selectedCardIds.size < 2) return null;
    const existingGroupCount = store.state.groups?.length || 0;
    const group = {
      id: `group-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      title: `组 ${existingGroupCount + 1}`,
      cardIds: [...this.selectedCardIds],
      headerColor: '#0a84ff'
    };
    store.addGroup(group);
    this.render();
    wires.render();
    store.scheduleAutoSave();
    return group;
  }

  ungroup(groupId) {
    store.removeGroup(groupId);
    this.render();
    wires.render();
    store.scheduleAutoSave();
  }

  ungroupSelected() {
    if (!store.state.groups || store.state.groups.length === 0) return;
    const groupsToRemove = store.state.groups.filter(g =>
      g.cardIds.some(id => this.selectedCardIds.has(id))
    );
    if (groupsToRemove.length > 0) {
      groupsToRemove.forEach(g => store.removeGroup(g.id));
      this.render();
      wires.render();
      store.scheduleAutoSave();
    }
  }

  openPopoverForGroup(group, headerEl) {
    this.clearCapsuleSelection();
    window.getSelection()?.removeAllRanges();
    this.currentRange = null;
    this.targetCapsule = null;
    this.targetHeaderCard = null;
    this.targetGroup = { group, headerEl };

    this.renderPopoverPalette();
    const currentColor = group.headerColor || null;
    this.setSelectedColor(currentColor);
    this.updatePopoverPosition();
  }

  applyGroupColor(group, newColor) {
    group.headerColor = newColor;
    const leftPinId = `pin-group-left-${group.id}`;
    const rightPinId = `pin-group-right-${group.id}`;
    const groupPins = new Set([leftPinId, rightPinId]);

    store.state.connections.forEach(conn => {
      if (groupPins.has(conn.fromPinId)) {
        conn.color = newColor;
      } else if (groupPins.has(conn.toPinId)) {
        const otherId = store.findCardIdByPin(conn.fromPinId);
        const otherCard = store.state.cards.find(c => c.id === otherId);
        if (!otherCard?.headerColor) {
          conn.color = newColor;
        }
      }
    });

    store.commit();
    this.render();
    wires.render();
    store.scheduleAutoSave();
  }

  bindAlignmentEvents() {
    if (!this.alignmentBarEl) return;
    const actions = {
      'btn-align-left': 'left',
      'btn-align-center-h': 'center-h',
      'btn-align-right': 'right',
      'btn-align-top': 'top',
      'btn-align-center-v': 'center-v',
      'btn-align-bottom': 'bottom',
      'btn-distribute-h': 'distribute-h',
      'btn-distribute-v': 'distribute-v'
    };

    Object.entries(actions).forEach(([btnId, type]) => {
      this.alignmentBarEl.querySelector(`#${btnId}`)?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.align(type);
      });
    });

    const btnCreateGroup = this.alignmentBarEl.querySelector('#btn-create-group');
    btnCreateGroup?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.createGroupFromSelected();
    });
  }

  align(type) {
    if (this.selectedCardIds.size < 2) return;
    const cards = store.state.cards.filter(c => this.selectedCardIds.has(c.id));
    if (cards.length < 2) return;

    cards.forEach(c => {
      const el = document.getElementById(`card-dom-${c.id}`);
      c.domWidth = el?.offsetWidth || c.width || 310;
      c.domHeight = el?.offsetHeight || 140;
    });

    const minX = Math.min(...cards.map(c => c.x));
    const maxX = Math.max(...cards.map(c => c.x + c.domWidth));
    const minY = Math.min(...cards.map(c => c.y));
    const maxY = Math.max(...cards.map(c => c.y + c.domHeight));

    switch (type) {
      case 'left':
        cards.forEach(c => { c.x = minX; });
        break;
      case 'center-h':
        const centerX = (minX + maxX) / 2;
        cards.forEach(c => { c.x = Math.round(centerX - c.domWidth / 2); });
        break;
      case 'right':
        cards.forEach(c => { c.x = Math.round(maxX - c.domWidth); });
        break;
      case 'top':
        cards.forEach(c => { c.y = minY; });
        break;
      case 'center-v':
        const centerY = (minY + maxY) / 2;
        cards.forEach(c => { c.y = Math.round(centerY - c.domHeight / 2); });
        break;
      case 'bottom':
        cards.forEach(c => { c.y = Math.round(maxY - c.domHeight); });
        break;
      case 'distribute-h':
        if (cards.length >= 3) {
          cards.sort((a, b) => a.x - b.x);
          const totalWidth = cards.reduce((sum, c) => sum + c.domWidth, 0);
          const totalSpan = (cards[cards.length - 1].x + cards[cards.length - 1].domWidth) - cards[0].x;
          const gap = (totalSpan - totalWidth) / (cards.length - 1);
          let curX = cards[0].x;
          cards.forEach((c, idx) => {
            if (idx > 0 && idx < cards.length - 1) {
              c.x = Math.round(curX);
            }
            curX += c.domWidth + gap;
          });
        }
        break;
      case 'distribute-v':
        if (cards.length >= 3) {
          cards.sort((a, b) => a.y - b.y);
          const totalHeight = cards.reduce((sum, c) => sum + c.domHeight, 0);
          const totalSpan = (cards[cards.length - 1].y + cards[cards.length - 1].domHeight) - cards[0].y;
          const gap = (totalSpan - totalHeight) / (cards.length - 1);
          let curY = cards[0].y;
          cards.forEach((c, idx) => {
            if (idx > 0 && idx < cards.length - 1) {
              c.y = Math.round(curY);
            }
            curY += c.domHeight + gap;
          });
        }
        break;
    }

    cards.forEach(c => {
      const el = document.getElementById(`card-dom-${c.id}`);
      if (el) {
        el.style.left = `${c.x}px`;
        el.style.top = `${c.y}px`;
      }
    });

    store.commit();
    wires.render();
    store.scheduleAutoSave();
  }

  calcSnap(leadCard, candidateX, candidateY, excludedCardIds = this.selectedCardIds) {
    const leadEl = document.getElementById(`card-dom-${leadCard.id}`);
    const leadW = leadEl?.offsetWidth || leadCard.width || 310;
    const leadH = leadEl?.offsetHeight || 140;

    const threshold = 8;
    const otherCards = store.state.cards.filter(c => !excludedCardIds.has(c.id));

    let bestX = { dist: threshold + 1, delta: 0, guide: null };
    let bestY = { dist: threshold + 1, delta: 0, guide: null };

    otherCards.forEach(target => {
      const targetEl = document.getElementById(`card-dom-${target.id}`);
      const targetW = targetEl?.offsetWidth || target.width || 310;
      const targetH = targetEl?.offsetHeight || 140;

      const candXPairs = [
        { cand: candidateX, target: target.x },
        { cand: candidateX, target: target.x + targetW },
        { cand: candidateX + leadW, target: target.x },
        { cand: candidateX + leadW, target: target.x + targetW },
        { cand: candidateX + leadW / 2, target: target.x + targetW / 2 }
      ];

      candXPairs.forEach(p => {
        const diff = p.target - p.cand;
        if (Math.abs(diff) < bestX.dist) {
          bestX = {
            dist: Math.abs(diff),
            delta: diff,
            guide: {
              x1: p.target,
              y1: Math.min(candidateY, target.y) - 24,
              x2: p.target,
              y2: Math.max(candidateY + leadH, target.y + targetH) + 24
            }
          };
        }
      });

      const candYPairs = [
        { cand: candidateY, target: target.y },
        { cand: candidateY, target: target.y + targetH },
        { cand: candidateY + leadH, target: target.y },
        { cand: candidateY + leadH, target: target.y + targetH },
        { cand: candidateY + leadH / 2, target: target.y + targetH / 2 }
      ];

      candYPairs.forEach(p => {
        const diff = p.target - p.cand;
        if (Math.abs(diff) < bestY.dist) {
          bestY = {
            dist: Math.abs(diff),
            delta: diff,
            guide: {
              x1: Math.min(candidateX, target.x) - 24,
              y1: p.target,
              x2: Math.max(candidateX + leadW, target.x + targetW) + 24,
              y2: p.target
            }
          };
        }
      });
    });

    const guideLines = [];
    if (bestX.guide) guideLines.push(bestX.guide);
    if (bestY.guide) guideLines.push(bestY.guide);

    return {
      snappedX: candidateX + bestX.delta,
      snappedY: candidateY + bestY.delta,
      guideLines
    };
  }

  bindMarqueeEvents() {
    this.viewportEl.addEventListener('mousedown', (e) => {
      const isBg = e.target === this.viewportEl ||
                   e.target === document.getElementById('board') ||
                   e.target.id === 'wire-svg';
      if (!isBg) return;
      if (e.button !== 0 || canvas.isSpacePressed) return;

      this.clearCapsuleSelection();
      wires.dismissDropMenu(true);

      this.activeMarquee = {
        startX: e.clientX,
        startY: e.clientY,
        isShift: e.shiftKey,
        initialSelection: new Set(this.selectedCardIds),
        moved: false
      };
    });
  }

  bindGlobalGestures() {
    window.addEventListener('mousemove', (e) => {
      if (this.activeMarquee) {
        const dist = Math.hypot(e.clientX - this.activeMarquee.startX, e.clientY - this.activeMarquee.startY);
        if (dist > 4) {
          this.activeMarquee.moved = true;
          const left = Math.min(e.clientX, this.activeMarquee.startX);
          const top = Math.min(e.clientY, this.activeMarquee.startY);
          const width = Math.abs(e.clientX - this.activeMarquee.startX);
          const height = Math.abs(e.clientY - this.activeMarquee.startY);

          this.marqueeBoxEl.style.display = 'block';
          this.marqueeBoxEl.style.left = `${left}px`;
          this.marqueeBoxEl.style.top = `${top}px`;
          this.marqueeBoxEl.style.width = `${width}px`;
          this.marqueeBoxEl.style.height = `${height}px`;

          const marqueeRect = { left, top, right: left + width, bottom: top + height };
          const intersected = new Set();

          store.state.cards.forEach(card => {
            const el = document.getElementById(`card-dom-${card.id}`);
            if (!el) return;
            const r = el.getBoundingClientRect();
            const overlap = !(r.right < marqueeRect.left || r.left > marqueeRect.right || r.bottom < marqueeRect.top || r.top > marqueeRect.bottom);
            if (overlap) intersected.add(card.id);
          });

          if (this.activeMarquee.isShift) {
            this.selectedCardIds = new Set([...this.activeMarquee.initialSelection, ...intersected]);
          } else {
            this.selectedCardIds = intersected;
          }

          this.updateSelectionVisuals();
          this.updateAlignmentBar();
        }
      }

      if (this.activeDrag) {
        const { zoom } = store.state.viewport;

        if (this.activeDrag.type === 'MOVE_CARDS') {
          // Alt+Drag: Clone cards and transfer drag to clones
          if ((this.activeDrag.isAlt || e.altKey) && !this.activeDrag.cloned) {
            const dist = Math.hypot(e.clientX - this.activeDrag.startX, e.clientY - this.activeDrag.startY);
            if (dist > 3) {
              const cardsToClone = store.state.cards.filter(c => this.selectedCardIds.has(c.id));
              const groupsToClone = (store.state.groups || []).filter(g =>
                g.cardIds && g.cardIds.length > 0 && g.cardIds.every(id => this.selectedCardIds.has(id))
              );
              const { newCards, newGroups, newConnections, cardIdMap } = this.cloneCardsAndGroups(cardsToClone, groupsToClone);
              newCards.forEach(c => store.state.cards.push(c));
              newGroups.forEach(g => store.state.groups.push(g));
              newConnections.forEach(conn => store.state.connections.push(conn));

              const newPositions = new Map();
              newCards.forEach(c => {
                newPositions.set(c.id, { x: c.x, y: c.y, width: c.width || 310 });
              });
              const newLeadId = cardIdMap.get(this.activeDrag.leadCardId) || newCards[0].id;
              this.selectedCardIds = new Set(newCards.map(c => c.id));
              this.activeDrag.cloned = true;
              this.activeDrag.leadCardId = newLeadId;
              this.activeDrag.initialPositions = newPositions;
              this.render();
              this.renderGroups();
              this.selectedCardIds.forEach(id => {
                document.getElementById(`card-dom-${id}`)?.classList.add('active');
              });
            }
          }

          let dx = (e.clientX - this.activeDrag.startX) / zoom;
          let dy = (e.clientY - this.activeDrag.startY) / zoom;

          const leadCard = store.state.cards.find(c => c.id === this.activeDrag.leadCardId);
          const leadInitPos = this.activeDrag.initialPositions.get(this.activeDrag.leadCardId);

          if (leadCard && leadInitPos) {
            let candX = leadInitPos.x + dx;
            let candY = leadInitPos.y + dy;

            const alignMode = !!store.state.settings?.alignMode;
            const gridSnapMode = !!store.state.settings?.gridSnapMode;
            const shouldAlign = alignMode ? !e.ctrlKey : e.ctrlKey;

            if (gridSnapMode) {
              const GRID_SIZE = 24;
              candX = Math.round(candX / GRID_SIZE) * GRID_SIZE;
              candY = Math.round(candY / GRID_SIZE) * GRID_SIZE;
            }

            if (shouldAlign) {
              const snap = this.calcSnap(leadCard, candX, candY);
              candX = snap.snappedX;
              candY = snap.snappedY;
              wires.showGuideLines(snap.guideLines);
            } else {
              wires.clearGuideLines();
            }

            dx = candX - leadInitPos.x;
            dy = candY - leadInitPos.y;
          }

          this.activeDrag.initialPositions.forEach((initPos, cardId) => {
            const card = store.state.cards.find(c => c.id === cardId);
            if (card) {
              card.x = Math.round(initPos.x + dx);
              card.y = Math.round(initPos.y + dy);
              const cardEl = document.getElementById(`card-dom-${card.id}`);
              if (cardEl) {
                cardEl.style.left = `${card.x}px`;
                cardEl.style.top = `${card.y}px`;
              }
            }
          });

          // Check hover over existing groups to add member cards
          let hoveredGroupId = null;
          if (store.state.groups && store.state.groups.length > 0) {
            const leadCard = store.state.cards.find(c => c.id === this.activeDrag.leadCardId);
            if (leadCard) {
              const cardCenterX = leadCard.x + (leadCard.width || 310) / 2;
              const cardCenterY = leadCard.y + 70;
              for (const group of store.state.groups) {
                const bounds = this.calcGroupBounds(group);
                if (bounds) {
                  if (cardCenterX >= bounds.x && cardCenterX <= bounds.x + bounds.width &&
                      cardCenterY >= bounds.y && cardCenterY <= bounds.y + bounds.height) {
                    const notInGroup = [...this.selectedCardIds].some(id => !group.cardIds.includes(id));
                    if (notInGroup) {
                      hoveredGroupId = group.id;
                      break;
                    }
                  }
                }
              }
            }
          }
          this.activeDrag.hoverGroupId = hoveredGroupId;
          document.querySelectorAll('.node-group').forEach(el => {
            const gId = el.id.replace('group-dom-', '');
            el.classList.toggle('group-drop-target', gId === hoveredGroupId);
          });

          // Update bounds for any groups containing moved cards
          if (store.state.groups) {
            store.state.groups.forEach(g => {
              if (g.cardIds.some(id => this.selectedCardIds.has(id))) {
                this.updateGroupDOMBounds(g.id);
              }
            });
          }

          wires.render();
        } else if (this.activeDrag.type === 'MOVE_GROUP') {
          // Alt+Drag: Clone group, member cards and connections
          if ((this.activeDrag.isAlt || e.altKey) && !this.activeDrag.cloned) {
            const dist = Math.hypot(e.clientX - this.activeDrag.startX, e.clientY - this.activeDrag.startY);
            if (dist > 3) {
              const group = store.state.groups?.find(g => g.id === this.activeDrag.groupId);
              if (group) {
                const cardsToClone = store.state.cards.filter(c => group.cardIds.includes(c.id));
                const { newCards, newGroups, newConnections, groupIdMap } = this.cloneCardsAndGroups(cardsToClone, [group]);
                newCards.forEach(c => store.state.cards.push(c));
                newGroups.forEach(g => store.state.groups.push(g));
                newConnections.forEach(conn => store.state.connections.push(conn));

                const newGroupId = groupIdMap.get(group.id);
                const newMemberCards = store.state.cards.filter(c => newCards.some(nc => nc.id === c.id));
                this.activeDrag.cloned = true;
                this.activeDrag.groupId = newGroupId;
                this.activeDrag.initialPositions = new Map(newMemberCards.map(c => [c.id, { x: c.x, y: c.y }]));
                this.selectedCardIds = new Set(newCards.map(c => c.id));
                this.render();
                this.renderGroups();
                document.getElementById(`group-dom-${newGroupId}`)?.classList.add('active');
              }
            }
          }

          let dx = (e.clientX - this.activeDrag.startX) / zoom;
          let dy = (e.clientY - this.activeDrag.startY) / zoom;

          const group = store.state.groups?.find(g => g.id === this.activeDrag.groupId);
          const leadCardId = this.activeDrag.initialPositions.keys().next().value;
          const leadCard = store.state.cards.find(c => c.id === leadCardId);
          const leadInitPos = this.activeDrag.initialPositions.get(leadCardId);

          if (leadCard && leadInitPos) {
            let candX = leadInitPos.x + dx;
            let candY = leadInitPos.y + dy;

            const alignMode = !!store.state.settings?.alignMode;
            const gridSnapMode = !!store.state.settings?.gridSnapMode;
            const shouldAlign = alignMode ? !e.ctrlKey : e.ctrlKey;

            if (gridSnapMode) {
              const GRID_SIZE = 24;
              candX = Math.round(candX / GRID_SIZE) * GRID_SIZE;
              candY = Math.round(candY / GRID_SIZE) * GRID_SIZE;
            }

            if (shouldAlign) {
              const excluded = new Set(group?.cardIds || [leadCardId]);
              const snap = this.calcSnap(leadCard, candX, candY, excluded);
              candX = snap.snappedX;
              candY = snap.snappedY;
              wires.showGuideLines(snap.guideLines);
            } else {
              wires.clearGuideLines();
            }

            dx = candX - leadInitPos.x;
            dy = candY - leadInitPos.y;
          }

          this.activeDrag.initialPositions.forEach((pos, cardId) => {
            const card = store.state.cards.find(c => c.id === cardId);
            if (card) {
              card.x = Math.round(pos.x + dx);
              card.y = Math.round(pos.y + dy);
              const cardEl = document.getElementById(`card-dom-${card.id}`);
              if (cardEl) {
                cardEl.style.left = `${card.x}px`;
                cardEl.style.top = `${card.y}px`;
              }
            }
          });

          this.updateGroupDOMBounds(this.activeDrag.groupId);
          wires.render();
        } else if (this.activeDrag.type === 'RESIZE_CARD') {
          const dx = (e.clientX - this.activeDrag.startX) / zoom;
          const card = store.state.cards.find(c => c.id === this.activeDrag.cardId);
          if (card) {
            const cardEl = document.getElementById(`card-dom-${card.id}`);
            const MIN_WIDTH = 250;

            if (this.activeDrag.side === 'left') {
              const rightEdge = this.activeDrag.initX + this.activeDrag.initWidth;
              let candWidth = this.activeDrag.initWidth - dx;
              let newWidth = Math.max(MIN_WIDTH, Math.round(candWidth));
              let newX = rightEdge - newWidth;

              if (store.state.settings?.gridSnapMode) {
                const GRID_SIZE = 24;
                const snappedX = Math.round(newX / GRID_SIZE) * GRID_SIZE;
                if (rightEdge - snappedX >= MIN_WIDTH) {
                  newX = snappedX;
                  newWidth = rightEdge - newX;
                }
              }

              card.x = newX;
              card.width = newWidth;
              if (cardEl) {
                cardEl.style.left = `${newX}px`;
                cardEl.style.width = `${newWidth}px`;
              }
            } else {
              let candWidth = this.activeDrag.initWidth + dx;
              let newWidth = Math.max(MIN_WIDTH, Math.round(candWidth));

              if (store.state.settings?.gridSnapMode) {
                const GRID_SIZE = 24;
                const rightEdge = card.x + newWidth;
                const snappedRight = Math.round(rightEdge / GRID_SIZE) * GRID_SIZE;
                if (snappedRight - card.x >= MIN_WIDTH) {
                  newWidth = snappedRight - card.x;
                }
              }

              card.width = newWidth;
              if (cardEl) {
                cardEl.style.width = `${newWidth}px`;
              }
            }
            wires.render();
          }
        }
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (this.activeMarquee) {
        this.marqueeBoxEl.style.display = 'none';
        if (!this.activeMarquee.moved && !this.activeMarquee.isShift) {
          this.clearSelection();
        }
        this.activeMarquee = null;
      }

      if (this.activeDrag) {
        wires.clearGuideLines();
        document.querySelectorAll('.group-drop-target').forEach(el => el.classList.remove('group-drop-target'));

        if (this.activeDrag.type === 'MOVE_CARDS') {
          const dist = Math.hypot(e.clientX - this.activeDrag.startX, e.clientY - this.activeDrag.startY);
          if (dist < 4 && !e.shiftKey && this.selectedCardIds.size > 1 && !this.activeDrag.cloned) {
            this.selectCard(this.activeDrag.leadCardId, false);
          }
          this.activeDrag.initialPositions.forEach((_, id) => {
            document.getElementById(`card-dom-${id}`)?.classList.remove('active');
          });

          if (this.activeDrag.hoverGroupId) {
            this.selectedCardIds.forEach(id => {
              store.addCardToGroup(this.activeDrag.hoverGroupId, id);
            });
            this.renderGroups();
          } else {
            if (store.state.groups && store.state.groups.length > 0) {
              store.state.groups.forEach(group => {
                const remainingCards = store.state.cards.filter(c => group.cardIds.includes(c.id));
                if (remainingCards.length > 1) {
                  const toRemove = [];
                  group.cardIds.forEach(cardId => {
                    if (this.selectedCardIds.has(cardId)) {
                      const card = store.state.cards.find(c => c.id === cardId);
                      if (card) {
                        const others = remainingCards.filter(c => c.id !== cardId);
                        const minDist = Math.min(...others.map(oc => Math.hypot(card.x - oc.x, card.y - oc.y)));
                        if (minDist > 550) {
                          toRemove.push(cardId);
                        }
                      }
                    }
                  });
                  toRemove.forEach(id => store.removeCardFromGroup(group.id, id));
                }
              });
              this.renderGroups();
            }
          }
        } else if (this.activeDrag.type === 'MOVE_GROUP') {
          document.getElementById(`group-dom-${this.activeDrag.groupId}`)?.classList.remove('active');
          this.updateGroupDOMBounds(this.activeDrag.groupId);
        } else if (this.activeDrag.type === 'RESIZE_CARD') {
          document.querySelectorAll('.card-resize-handle.active').forEach(h => h.classList.remove('active'));
        }
        this.activeDrag = null;
        store.commit();
        wires.render();
        store.scheduleAutoSave();
      }
    });

    window.addEventListener('keydown', (e) => {
      // Shortcut to toggle settings modal: Ctrl+, or Cmd+,
      if ((e.ctrlKey || e.metaKey) && (e.key === ',' || e.code === 'Comma')) {
        e.preventDefault();
        window.__settings?.toggle?.();
        return;
      }

      // Shortcut to edit card header title: F2 (when card selected or editing text inside body)
      if (e.key === 'F2') {
        const cardEl = document.activeElement?.closest?.('.note-card') || e.target?.closest?.('.note-card');
        let targetCardId = null;
        if (cardEl) {
          targetCardId = cardEl.id.replace('card-dom-', '');
        } else if (this.selectedCardIds.size > 0) {
          targetCardId = Array.from(this.selectedCardIds)[0];
        }
        if (targetCardId) {
          e.preventDefault();
          this.editCardTitle(targetCardId);
          return;
        }
      }

      const isEditingText = e.target?.closest?.('input, textarea, [contenteditable="true"]');

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !isEditingText) {
        e.preventDefault();
        store.undo();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) && !isEditingText) {
        e.preventDefault();
        store.redo();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        if (!isEditingText) {
          e.preventDefault();
          this.selectAllCards();
          return;
        }
      }

      // Copy: Ctrl+C
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !isEditingText) {
        if (this.selectedCardIds.size > 0) {
          e.preventDefault();
          this.copySelectedCards();
          return;
        }
      }

      // Cut: Ctrl+X
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && !isEditingText) {
        if (this.selectedCardIds.size > 0) {
          e.preventDefault();
          this.cutSelectedCards();
          return;
        }
      }

      // Paste: Ctrl+V
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !isEditingText) {
        if (this.clipboard && this.clipboard.cards?.length > 0) {
          e.preventDefault();
          this.pasteCards();
          return;
        }
      }

      // Group: Ctrl+G
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g' && !e.shiftKey && !isEditingText) {
        if (this.selectedCardIds.size >= 2) {
          e.preventDefault();
          this.createGroupFromSelected();
          return;
        }
      }

      // Ungroup: Ctrl+Shift+G
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g' && e.shiftKey && !isEditingText) {
        if (this.selectedCardIds.size > 0) {
          e.preventDefault();
          this.ungroupSelected();
          return;
        }
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedCapsule) {
          e.preventDefault();
          this.deleteCapsule(this.selectedCapsule);
          return;
        }
        if (!isEditingText && this.selectedCardIds.size > 0) {
          e.preventDefault();
          this.deleteSelectedCards();
        }
      } else if (e.key === 'Escape') {
        if (window.__settings?.isOpen?.()) {
          window.__settings.close();
          return;
        }
        this.hideCanvasContextMenu();
        if (this.selectedCapsule) {
          this.clearCapsuleSelection();
        }
        if (this.selectedCardIds.size > 0 && !wires.activeDrag) {
          this.clearSelection();
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.key === 'Control') {
        if (!store.state.settings?.alignMode) {
          wires.clearGuideLines();
        }
      }
    });
  }
}

export const nodes = new NodeManager();
