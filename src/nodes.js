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
    this.selectedColor = '#30d158';
    this.selectedCardIds = new Set();
    this.activeMarquee = null;
    this.activeDrag = null;
  }

  init(containerEl, selectionPopoverEl, marqueeBoxEl, alignmentBarEl, viewportEl, capsuleActionBarEl, canvasContextMenuEl) {
    this.containerEl = containerEl;
    this.selectionPopoverEl = selectionPopoverEl;
    this.capsuleActionBarEl = capsuleActionBarEl || document.getElementById('capsule-action-bar');
    this.canvasContextMenuEl = canvasContextMenuEl || document.getElementById('canvas-context-menu');
    this.marqueeBoxEl = marqueeBoxEl;
    this.alignmentBarEl = alignmentBarEl;
    this.viewportEl = viewportEl;
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

    this.setSelectedColor(this.selectedColor || palette[0] || '#30d158');
  }

  setSelectedColor(color) {
    this.selectedColor = color;
    let matchedPreset = false;
    this.selectionPopoverEl.querySelectorAll('.popover-color-btn').forEach(btn => {
      const btnColor = btn.getAttribute('data-color');
      const isMatch = btnColor?.toLowerCase() === color?.toLowerCase();
      btn.classList.toggle('selected', isMatch);
      if (isMatch) matchedPreset = true;
    });

    const paletteBtn = this.selectionPopoverEl.querySelector('.popover-palette-btn');
    if (paletteBtn) {
      paletteBtn.classList.toggle('selected', !matchedPreset);
      const colorPicker = paletteBtn.querySelector('.popover-color-picker');
      if (colorPicker && color && color.startsWith('#')) colorPicker.value = color;
    }

    const dot = this.selectionPopoverEl.querySelector('.apply-color-dot');
    if (dot) dot.style.backgroundColor = color;
  }

  openPopoverForCapsule(capsule) {
    this.clearCapsuleSelection();
    window.getSelection()?.removeAllRanges();
    this.currentRange = null;
    this.targetHeaderCard = null;
    this.targetCapsule = capsule;

    this.renderPopoverPalette();
    const currentColor = capsule.style.getPropertyValue('--capsule-pin').trim() ||
                         window.getComputedStyle(capsule).getPropertyValue('--capsule-pin').trim() ||
                         '#30d158';

    this.setSelectedColor(currentColor);
    this.updatePopoverPosition();
  }

  openPopoverForHeader(card, headerEl) {
    this.clearCapsuleSelection();
    window.getSelection()?.removeAllRanges();
    this.currentRange = null;
    this.targetCapsule = null;
    this.targetHeaderCard = { card, headerEl };

    this.renderPopoverPalette();
    const currentColor = card.headerColor || '#30d158';
    this.setSelectedColor(currentColor);
    this.updatePopoverPosition();
  }

  updatePopoverPosition() {
    if (!this.selectionPopoverEl) return;

    let rect = null;
    if (this.targetHeaderCard) {
      rect = this.targetHeaderCard.headerEl.getBoundingClientRect();
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
  }

  bindSelectionEvents() {
    document.addEventListener('selectionchange', () => {
      if (document.body.classList.contains('is-wire-dragging') || this.activeDrag) {
        this.hideSelectionPopover();
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        if (!this.targetCapsule && !this.targetHeaderCard) this.hideSelectionPopover();
        return;
      }

      const text = selection.toString().trim();
      if (!text) {
        if (!this.targetCapsule && !this.targetHeaderCard) this.hideSelectionPopover();
        return;
      }

      const anchor = selection.anchorNode;
      const bodyEl = anchor?.nodeType === 3 ? anchor.parentElement.closest('.note-body') : anchor?.closest('.note-body');
      if (!bodyEl) {
        if (!this.targetCapsule && !this.targetHeaderCard) this.hideSelectionPopover();
        return;
      }

      this.targetCapsule = null;
      this.targetHeaderCard = null;
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
      if (e.target.closest('.text-capsule, .note-header')) return;
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
        conn.color = newColor;
      } else if (headPins.has(conn.toPinId)) {
        // If arriving from an uncolored header node, update connection color
        const otherCardId = store.findCardIdByPin(conn.fromPinId);
        const otherCard = store.state.cards.find(c => c.id === otherCardId);
        const isFromCapsule = conn.fromPinId.startsWith('pin-') && !conn.fromPinId.startsWith('pin-head-');
        if (!isFromCapsule && !otherCard?.headerColor) {
          conn.color = newColor;
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
    const bg = hexToRgba(newColor, 0.14);
    const border = hexToRgba(newColor, 0.38);

    capsule.style.setProperty('--capsule-pin', newColor);
    capsule.style.backgroundColor = bg;
    capsule.style.borderColor = border;

    // Update both outgoing and incoming connections connected to this capsule
    if (pinId) {
      store.state.connections.forEach(conn => {
        if (conn.fromPinId === pinId || conn.toPinId === pinId) {
          conn.color = newColor;
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
      if (distributeH) {
        distributeH.style.opacity = count >= 3 ? '1' : '0.35';
        distributeH.style.pointerEvents = count >= 3 ? 'auto' : 'none';
      }
      if (distributeV) {
        distributeV.style.opacity = count >= 3 ? '1' : '0.35';
        distributeV.style.pointerEvents = count >= 3 ? 'auto' : 'none';
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

  calcSnap(leadCard, candidateX, candidateY) {
    const leadEl = document.getElementById(`card-dom-${leadCard.id}`);
    const leadW = leadEl?.offsetWidth || leadCard.width || 310;
    const leadH = leadEl?.offsetHeight || 140;

    const threshold = 8;
    const otherCards = store.state.cards.filter(c => !this.selectedCardIds.has(c.id));

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
        if (this.activeDrag.type === 'MOVE_CARDS') {
          const dist = Math.hypot(e.clientX - this.activeDrag.startX, e.clientY - this.activeDrag.startY);
          if (dist < 4 && !e.shiftKey && this.selectedCardIds.size > 1) {
            this.selectCard(this.activeDrag.leadCardId, false);
          }
          this.activeDrag.initialPositions.forEach((_, id) => {
            document.getElementById(`card-dom-${id}`)?.classList.remove('active');
          });
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
