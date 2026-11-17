import { store } from './state.js';
import { canvas } from './canvas.js';
import { wires } from './wires.js';
import { computeRectsBoundingBox } from './focusLayout.js';
import { renderThumbnailCanvas, computeLocalThumbnail } from './subcanvas.js';
import { matchesShortcut } from './shortcuts.js';
import { media, CARD_HEADER_HEIGHT, sanitizeIframeUrl, shouldWebpageStartDormant, isLikelyVideoSiteUrl } from './media.js';

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

export function blendHexOnDark(hex, alpha = 0.16, base = [22, 22, 26]) {
  if (!hex) return `rgb(${base[0]}, ${base[1]}, ${base[2]})`;
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  const num = parseInt(c, 16);
  if (isNaN(num)) return `rgb(${base[0]}, ${base[1]}, ${base[2]})`;
  const r = Math.round(((num >> 16) & 255) * alpha + base[0] * (1 - alpha));
  const g = Math.round(((num >> 8) & 255) * alpha + base[1] * (1 - alpha));
  const b = Math.round((num & 255) * alpha + base[2] * (1 - alpha));
  return `rgb(${r}, ${g}, ${b})`;
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
    this.selectedColor = '#5ca479';
    this.selectedCardIds = new Set();
    this.activeMarquee = null;
    this.activeDrag = null;
    this.pendingCtrlGroupDrag = null;
    this._lastPointer = null;
    this.clipboard = null;
    this.pasteCount = 0;
    this.mouseBoardPos = { x: 0, y: 0 };
    this.focusExitAnimId = null;
    this.loadedWebpageIds = new Set();
  }

  init(containerEl, selectionPopoverEl, marqueeBoxEl, alignmentBarEl, viewportEl, capsuleActionBarEl, canvasContextMenuEl) {
    this.containerEl = containerEl;
    this.groupsContainerEl = document.getElementById('groups-container');
    this.selectionPopoverEl = selectionPopoverEl;
    this.capsuleActionBarEl = capsuleActionBarEl || document.getElementById('capsule-action-bar');
    this.canvasContextMenuEl = canvasContextMenuEl || document.getElementById('canvas-context-menu');
    this.groupContextMenuEl = document.getElementById('group-context-menu');
    this.subcanvasContextMenuEl = document.getElementById('subcanvas-context-menu');
    this.mediaContextMenuEl = document.getElementById('media-context-menu');
    this.activeContextGroup = null;
    this.activeContextSubcanvas = null;
    this.activeContextMedia = null;
    this.interactiveWebpageCardId = null;
    this.contextMenuBoardPos = null;
    this.marqueeBoxEl = marqueeBoxEl;
    this.alignmentBarEl = alignmentBarEl;
    this.viewportEl = viewportEl;

    media.init();
    media.bindCanvasDropAndPaste(viewportEl);

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
    this.bindGroupContextMenuEvents();
    this.bindSubcanvasContextMenuEvents();
    this.bindMediaContextMenuEvents();
    this.bindCanvasShortcuts();
    this.bindSelectionEvents();
    this.bindAlignmentEvents();
    this.bindMarqueeEvents();
    this.bindGlobalGestures();
  }

  spawnNode(pos, title = '未命名节点', skipCommit = false, headerColor = null) {
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
    if (headerColor) {
      card.headerColor = headerColor;
    }
    store.addCard(card, skipCommit);
    this.render();
    return card;
  }

  async spawnSubcanvas(pos, title = '未命名子画布', headerColor = null, cardIds = null) {
    let x = Math.round((pos?.x ?? 160) - 20);
    let y = Math.round((pos?.y ?? 200) - 20);
    if (store.state.settings?.gridSnapMode) {
      const GRID_SIZE = 24;
      x = Math.round(x / GRID_SIZE) * GRID_SIZE;
      y = Math.round(y / GRID_SIZE) * GRID_SIZE;
    }
    const card = await store.createSubcanvas({ x, y, title, headerColor, cardIds });
    if (!card) return null;
    this.filterSelectionAfterRestore();
    this.render();
    wires.render();
    this.updateAlignmentBar();
    return card;
  }

  async packSelectionToSubcanvas() {
    if (this.selectedCardIds.size === 0) return null;
    this.flushActiveDOMEdits();
    const ids = [...this.selectedCardIds];
    const selected = store.state.cards.filter(c => ids.includes(c.id));
    if (selected.length === 0) return null;
    const minX = Math.min(...selected.map(c => c.x));
    const minY = Math.min(...selected.map(c => c.y));
    const maxX = Math.max(...selected.map(c => c.x + (c.width || 310)));
    const maxY = Math.max(...selected.map(c => c.y + (c.height || 140)));
    const centerPos = {
      x: (minX + maxX) / 2 - 130,
      y: (minY + maxY) / 2 - 70
    };
    const title = selected.length === 1
      ? `${selected[0].title || '未命名'} (子画布)`
      : `子画布 (${selected.length} 节点)`;
    const card = await this.spawnSubcanvas(centerPos, title, null, ids);
    if (card) {
      this.selectCard(card.id, false);
      setTimeout(() => this.editCardTitle(card.id), 40);
    }
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

  resetRenderCacheForCanvasSwitch() {
    this.loadedWebpageIds.clear();
    this.exitWebpageInteractive();
  }

  loadWebpageCard(cardId) {
    if (!cardId) return;
    this.loadedWebpageIds.add(cardId);
    this.render();
    wires.render();
  }

  sleepWebpageCard(cardId) {
    if (!cardId) return;
    this.loadedWebpageIds.delete(cardId);
    if (this.interactiveWebpageCardId === cardId) {
      this.exitWebpageInteractive();
    }
    this.render();
    wires.render();
  }

  sleepAllWebpages() {
    this.loadedWebpageIds.clear();
    this.exitWebpageInteractive();
    this.render();
    wires.render();
  }

  _getCardKindKey(card) {
    if (card.kind === 'subcanvas') return 'subcanvas';
    if (card.kind === 'image' || card.kind === 'video' || card.kind === 'webpage') return card.kind;
    return 'card';
  }

  _applyCardThemeAndPins(card, cardEl, leftPinId, rightPinId, leftConnected, rightConnected, leftColor, rightColor) {
    const isLightTheme = document.documentElement.getAttribute('data-theme') === 'light';
    if (card.headerColor) {
      cardEl.style.setProperty('--card-theme-color', card.headerColor);
      cardEl.style.setProperty('--card-theme-bg', hexToRgba(card.headerColor, isLightTheme ? 0.08 : 0.055));
      cardEl.style.setProperty('--card-theme-header-bg', hexToRgba(card.headerColor, isLightTheme ? 0.18 : 0.11));
      cardEl.style.setProperty('--card-theme-header-border', hexToRgba(card.headerColor, isLightTheme ? 0.28 : 0.18));
      cardEl.style.setProperty('--card-theme-border', hexToRgba(card.headerColor, isLightTheme ? 0.48 : 0.36));
      cardEl.style.setProperty('--card-theme-glow', hexToRgba(card.headerColor, isLightTheme ? 0.28 : 0.25));
    } else {
      cardEl.style.removeProperty('--card-theme-color');
      cardEl.style.removeProperty('--card-theme-bg');
      cardEl.style.removeProperty('--card-theme-header-bg');
      cardEl.style.removeProperty('--card-theme-header-border');
      cardEl.style.removeProperty('--card-theme-border');
      cardEl.style.removeProperty('--card-theme-glow');
    }

    const leftPin = cardEl.querySelector('.header-pin-left');
    if (leftPin) {
      leftPin.setAttribute('data-header-pin-id', leftPinId);
      leftPin.classList.toggle('pin-connected', leftConnected);
      if (card.kind === 'subcanvas') {
        leftPin.style.color = leftColor;
      } else {
        leftPin.style.backgroundColor = leftColor;
        leftPin.style.color = leftColor;
      }
    }

    const rightPin = cardEl.querySelector('.header-pin-right');
    if (rightPin) {
      rightPin.setAttribute('data-header-pin-id', rightPinId);
      rightPin.classList.toggle('pin-connected', rightConnected);
      rightPin.style.backgroundColor = rightColor;
      rightPin.style.color = rightColor;
    }
  }

  _syncSubcanvasCard(card, existingEl, leftPinId, rightPinId, leftConnected, rightConnected, leftColor, rightColor) {
    const isNew = !existingEl;
    const cardEl = existingEl || document.createElement('div');
    const cardId = card.id;
    const getCard = () => store.state.cards.find(c => c.id === cardId) || cardEl.__cardData;
    cardEl.__cardData = card;

    if (isNew) {
      cardEl.id = `card-dom-${cardId}`;
      cardEl.dataset.cardKind = 'subcanvas';
      cardEl.innerHTML = `
        <div class="subcanvas-portal-stack" aria-hidden="true"></div>
        <div class="subcanvas-portal-frame">
          <div class="subcanvas-portal-stage">
            <canvas class="subcanvas-thumbnail-canvas"></canvas>
            <div class="subcanvas-portal-empty" style="display: none;"><svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="1.6" fill="none"><rect x="4" y="4" width="16" height="16" rx="4"></rect><line x1="12" y1="9" x2="12" y2="15"></line><line x1="9" y1="12" x2="15" y2="12"></line></svg></div>
          </div>
          <div class="subcanvas-portal-caption">
            <div class="header-port-slot subcanvas-port-slot subcanvas-port-slot-left" title="子画布连接端口 (左)">
              <span class="header-pin header-pin-left subcanvas-portal-pin" data-header-pin-id="${leftPinId}">
                <svg class="subcanvas-portal-icon" viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none">
                  <rect x="3" y="3" width="18" height="18" rx="3"></rect>
                  <path d="M9 12h6"></path>
                </svg>
              </span>
            </div>
            <span class="header-title subcanvas-portal-title" title="双击重命名"></span>
            <input class="header-title-input subcanvas-portal-title-input" placeholder="未命名子画布" style="display: none;" />
            <span class="subcanvas-portal-spacer" aria-hidden="true"></span>
            <span class="subcanvas-portal-count" style="display: none;"></span>
            <div class="header-port-slot subcanvas-port-slot subcanvas-port-slot-right" title="子画布连接端口 (右)">
              <i class="header-pin header-pin-right" data-header-pin-id="${rightPinId}"></i>
            </div>
          </div>
        </div>
        <div class="card-resize-handle card-resize-handle-left" data-side="left"></div>
        <div class="card-resize-handle card-resize-handle-right" data-side="right"></div>
        <div class="subcanvas-resize-bottom"></div>
      `;

      const titleSpan = cardEl.querySelector('.header-title');
      const titleInput = cardEl.querySelector('.header-title-input');
      let prevTitle = card.title || '';

      const syncInputWidth = () => {
        const len = (titleInput.value || '').length;
        const approx = Math.min(Math.max(len * 11 + 28, 96), 185);
        titleInput.style.width = `${approx}px`;
      };
      const startTitleEdit = () => {
        const cur = getCard();
        prevTitle = cur?.title || '';
        const spanW = titleSpan.offsetWidth || 0;
        titleSpan.style.display = 'none';
        titleInput.style.display = 'inline-block';
        titleInput.value = prevTitle;
        titleInput.style.width = `${Math.min(Math.max(spanW + 24, 96), 185)}px`;
        titleInput.focus();
        titleInput.select();
      };
      cardEl._startTitleEdit = startTitleEdit;
      titleInput.addEventListener('input', syncInputWidth);

      const finishTitleEdit = () => {
        if (titleInput.style.display === 'none') return;
        const cur = getCard();
        const newTitle = titleInput.value.trim() || '未命名子画布';
        const changed = newTitle !== prevTitle;
        if (cur) cur.title = newTitle;
        prevTitle = newTitle;
        titleSpan.textContent = newTitle;
        titleInput.style.display = 'none';
        titleSpan.style.display = '';
        if (changed) {
          if (cur?.subcanvasId) {
            store.updateCard(cur.id, { title: newTitle });
          }
          store.commit();
        }
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
          titleInput.value = getCard()?.title || '';
          finishTitleEdit();
        }
      });
      titleInput.addEventListener('blur', finishTitleEdit);
      titleInput.addEventListener('mousedown', (e) => e.stopPropagation());

      cardEl.addEventListener('mousedown', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot, .card-resize-handle, .subcanvas-resize-bottom') || e.target === titleInput) return;
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this._blurActiveTextEditor();
        wires.clearFocus();
        wires.dismissDropMenu(true);
        this.clearCapsuleSelection();
        window.getSelection()?.removeAllRanges();
        this.hideSelectionPopover();
        this.hideCanvasContextMenu();
        this.hideGroupContextMenu();
        this.hideSubcanvasContextMenu();

        const isMultiToggle = e.shiftKey || e.ctrlKey || e.metaKey;
        const wasSelected = this.selectedCardIds.has(cardId);
        if (isMultiToggle) {
          if (!wasSelected) {
            this.selectedCardIds.add(cardId);
            this.updateSelectionVisuals();
            this.updateAlignmentBar();
          }
        } else if (!wasSelected) {
          this.selectCard(cardId, false);
        }

        this.activeDrag = {
          type: 'MOVE_CARDS',
          leadCardId: cardId,
          startX: e.clientX,
          startY: e.clientY,
          isAlt: e.altKey,
          wasMultiToggle: isMultiToggle,
          toggleOffOnClick: isMultiToggle && wasSelected,
          cloned: false,
          initialPositions: new Map(
            [...this.selectedCardIds].map(id => {
              const c = store.state.cards.find(x => x.id === id);
              return [id, { x: c.x, y: c.y, width: c.width || 300 }];
            })
          )
        };
        this.selectedCardIds.forEach(id => {
          document.getElementById(`card-dom-${id}`)?.classList.add('active');
        });
      });

      cardEl.addEventListener('dblclick', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot, .subcanvas-portal-title, .subcanvas-portal-title-input, .card-resize-handle, .subcanvas-resize-bottom')) return;
        e.preventDefault();
        e.stopPropagation();
        const cur = getCard();
        if (cur?.subcanvasId) {
          store.navigateToCanvas(cur.subcanvasId);
        }
      });

      cardEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot')) return;
        e.preventDefault();
        e.stopPropagation();
        this.showSubcanvasContextMenu(getCard(), cardEl, startTitleEdit, e.clientX, e.clientY);
      });

      cardEl.querySelectorAll('.card-resize-handle').forEach(resizeHandle => {
        resizeHandle.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          this.hideAllMenus();
          const cur = getCard();
          const side = resizeHandle.getAttribute('data-side') || 'right';
          this.activeDrag = {
            type: 'RESIZE_CARD',
            side,
            cardId,
            startX: e.clientX,
            initX: cur.x,
            initWidth: cardEl.offsetWidth
          };
          resizeHandle.classList.add('active');
        });
      });

      const bottomResizeEl = cardEl.querySelector('.subcanvas-resize-bottom');
      bottomResizeEl?.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.hideAllMenus();
        const cur = getCard();
        this.activeDrag = {
          type: 'RESIZE_SUBCANVAS_HEIGHT',
          cardId,
          startY: e.clientY,
          initHeight: cur?.height || 180
        };
        bottomResizeEl.classList.add('active');
      });

      this.bindPinEvents(cardEl.querySelector('.header-pin-left'), leftPinId);
      this.bindPinEvents(cardEl.querySelector('.header-pin-right'), rightPinId);
    }

    // Update live state in-place
    cardEl.className = 'note-card subcanvas-portal' + (this.selectedCardIds.has(cardId) ? ' selected' : '');
    cardEl.style.left = `${card.x}px`;
    cardEl.style.top = `${card.y}px`;
    cardEl.style.width = `${card.width || 300}px`;
    const portalH = Math.max(120, card.height || 180);
    cardEl.style.height = `${portalH}px`;

    const subLeftColor = card.headerColor || (leftConnected ? leftColor : 'var(--text-secondary)');
    this._applyCardThemeAndPins(card, cardEl, leftPinId, rightPinId, leftConnected, rightConnected, subLeftColor, rightColor);
    if (card.headerColor) {
      cardEl.style.setProperty('--portal-accent', card.headerColor);
      cardEl.style.setProperty('--portal-border', hexToRgba(card.headerColor, 0.42));
    } else {
      cardEl.style.removeProperty('--portal-accent');
      cardEl.style.removeProperty('--portal-border');
    }

    const titleSpan = cardEl.querySelector('.header-title');
    const titleInput = cardEl.querySelector('.header-title-input');
    if (titleInput && titleInput.style.display === 'none') {
      if (titleSpan) titleSpan.textContent = card.title || '未命名子画布';
      titleInput.value = card.title || '';
    }

    const thumb = store.getThumbnailForSubcanvas(card);
    const totalItems = (thumb?.cardCount || 0) + (thumb?.subcanvasCount || 0);
    const isEmpty = totalItems === 0;
    const countEl = cardEl.querySelector('.subcanvas-portal-count');
    if (countEl) {
      if (totalItems > 0) {
        countEl.textContent = String(totalItems);
        countEl.style.display = '';
      } else {
        countEl.style.display = 'none';
      }
    }
    const emptyEl = cardEl.querySelector('.subcanvas-portal-empty');
    if (emptyEl) {
      emptyEl.style.display = isEmpty ? '' : 'none';
    }

    const thumbCanvas = cardEl.querySelector('.subcanvas-thumbnail-canvas');
    if (thumbCanvas) {
      const palette = store.getPalette();
      const themeAttr = document.documentElement.getAttribute('data-theme') || 'dark';
      const thumbKey = JSON.stringify(thumb || null) + '|' + JSON.stringify(palette) + '|' + themeAttr + '|' + (card.width || 300) + 'x' + portalH;
      if (cardEl.dataset.thumbKey !== thumbKey) {
        cardEl.dataset.thumbKey = thumbKey;
        renderThumbnailCanvas(thumbCanvas, thumb, palette);
      }
    }

    return cardEl;
  }

  _syncTextCard(card, existingEl, leftPinId, rightPinId, leftConnected, rightConnected, leftColor, rightColor) {
    const isNew = !existingEl;
    const cardEl = existingEl || document.createElement('div');
    const cardId = card.id;
    const getCard = () => store.state.cards.find(c => c.id === cardId) || cardEl.__cardData;
    cardEl.__cardData = card;

    if (isNew) {
      cardEl.id = `card-dom-${cardId}`;
      cardEl.dataset.cardKind = 'card';
      cardEl.innerHTML = `
        <div class="note-header">
          <div class="header-port-slot header-port-slot-left" title="连接端口 (左)">
            <i class="header-pin header-pin-left" data-header-pin-id="${leftPinId}"></i>
          </div>

          <div class="header-content">
            <span class="header-title" title="双击重命名"></span>
            <input class="header-title-input" placeholder="未命名节点" style="display: none;" />
          </div>

          <div class="header-port-slot header-port-slot-right" title="连接端口 (右)">
            <i class="header-pin header-pin-right" data-header-pin-id="${rightPinId}"></i>
          </div>
        </div>
        <div class="note-body" contenteditable="true" spellcheck="false"></div>
        <div class="card-resize-handle card-resize-handle-left" data-side="left" title="按住左右拖拽调节宽度 (左侧)"></div>
        <div class="card-resize-handle card-resize-handle-right" data-side="right" title="按住左右拖拽调节宽度 (右侧)"></div>
      `;

      const titleSpan = cardEl.querySelector('.header-title');
      const titleInput = cardEl.querySelector('.header-title-input');
      let prevTitle = card.title || '';

      const startTitleEdit = () => {
        const cur = getCard();
        prevTitle = cur?.title || '';
        titleSpan.style.display = 'none';
        titleInput.style.display = 'block';
        titleInput.value = prevTitle;
        titleInput.focus();
        titleInput.select();
      };
      cardEl._startTitleEdit = startTitleEdit;

      const finishTitleEdit = () => {
        if (titleInput.style.display === 'none') return;
        const cur = getCard();
        const newTitle = titleInput.value.trim() || '未命名节点';
        const changed = newTitle !== prevTitle;
        if (cur) cur.title = newTitle;
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
          titleInput.value = getCard()?.title || '';
          finishTitleEdit();
        }
      });
      titleInput.addEventListener('blur', finishTitleEdit);
      titleInput.addEventListener('mousedown', (e) => e.stopPropagation());

      cardEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.note-header, .header-pin, .header-port-slot, .card-resize-handle, .capsule-pin, .text-capsule, .header-title-input')) return;
        const isMultiToggle = e.shiftKey || e.ctrlKey || e.metaKey;
        if (isMultiToggle) {
          const wasSelected = this.selectedCardIds.has(cardId);
          this._blurActiveTextEditor();
          e.preventDefault();
          e.stopPropagation();
          window.getSelection()?.removeAllRanges();
          this.selectCard(cardId, true);

          if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !canvas.isSpacePressed) {
            const boardPos = canvas.screenToBoard(e.clientX, e.clientY);
            const hitGroup = this.findGroupAtBoardPos(boardPos, cardId);
            if (hitGroup) {
              this.pendingCtrlGroupDrag = {
                group: hitGroup,
                cardId,
                wasSelected,
                startX: e.clientX,
                startY: e.clientY
              };
            }
          }
        } else if (!this.selectedCardIds.has(cardId) || this.selectedCardIds.size > 1) {
          this.selectCard(cardId, false);
        }
      });

      const headerEl = cardEl.querySelector('.note-header');
      headerEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot, .capsule-pin')) return;
        e.preventDefault();
        e.stopPropagation();
        this.openPopoverForHeader(getCard(), headerEl);
      });

      headerEl.addEventListener('mousedown', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot') || e.target === titleInput) return;
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this._blurActiveTextEditor();
        wires.clearFocus();
        wires.dismissDropMenu(true);
        this.clearCapsuleSelection();
        window.getSelection()?.removeAllRanges();
        this.hideSelectionPopover();
        this.hideCanvasContextMenu();
        this.hideGroupContextMenu();
        this.hideSubcanvasContextMenu();

        const isMultiToggle = e.shiftKey || e.ctrlKey || e.metaKey;
        const wasSelected = this.selectedCardIds.has(cardId);
        if (isMultiToggle) {
          if (!wasSelected) {
            this.selectedCardIds.add(cardId);
            this.updateSelectionVisuals();
            this.updateAlignmentBar();
          }
        } else if (!wasSelected) {
          this.selectCard(cardId, false);
        }

        this.activeDrag = {
          type: 'MOVE_CARDS',
          leadCardId: cardId,
          startX: e.clientX,
          startY: e.clientY,
          isAlt: e.altKey,
          wasMultiToggle: isMultiToggle,
          toggleOffOnClick: isMultiToggle && wasSelected,
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

          const cur = getCard();
          const side = resizeHandle.getAttribute('data-side') || 'right';
          this.activeDrag = {
            type: 'RESIZE_CARD',
            side,
            cardId,
            startX: e.clientX,
            initX: cur.x,
            initWidth: cardEl.offsetWidth
          };
          resizeHandle.classList.add('active');
        });
      });

      this.bindPinEvents(cardEl.querySelector('.header-pin-left'), leftPinId);
      this.bindPinEvents(cardEl.querySelector('.header-pin-right'), rightPinId);

      const bodyEl = cardEl.querySelector('.note-body');
      let bodyTypingTimeout = null;

      const setBodyCaret = (node, offset = 0) => {
        if (!bodyEl || !node) return;
        const sel = window.getSelection();
        if (!sel) return;
        const range = document.createRange();
        try {
          range.setStart(node, offset);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch {}
      };

      const ensureTrailingEditableLine = () => {
        if (!bodyEl) return null;
        const blocks = bodyEl.querySelectorAll('.inline-media-block');
        if (blocks.length === 0) return null;
        const lastBlock = blocks[blocks.length - 1];
        const topNode = lastBlock.parentElement === bodyEl
          ? lastBlock
          : (() => {
              let cur = lastBlock;
              while (cur && cur.parentElement && cur.parentElement !== bodyEl) cur = cur.parentElement;
              return cur;
            })();
        if (!topNode || !topNode.parentElement) return null;

        // Check if there is any editable content after lastBlock inside topNode (when wrapped) or after topNode in bodyEl
        if (topNode !== lastBlock && media._hasEditableTargetAfter(lastBlock)) {
          return null;
        }
        if (media._hasEditableTargetAfter(topNode)) {
          return null;
        }

        if (
          topNode.nextSibling &&
          topNode.nextSibling.nodeType === 1 &&
          topNode.nextSibling.tagName === 'BR'
        ) {
          topNode.nextSibling.remove();
        }
        const line = document.createElement('div');
        line.appendChild(document.createElement('br'));
        bodyEl.insertBefore(line, topNode.nextSibling);
        return line;
      };

      bodyEl?.addEventListener('focus', () => {
        ensureTrailingEditableLine();
      });

      bodyEl?.addEventListener('input', () => {
        const cur = getCard();
        if (cur) cur.contentHtml = bodyEl.innerHTML;
        wires.render();
        store.scheduleAutoSave();

        clearTimeout(bodyTypingTimeout);
        bodyTypingTimeout = setTimeout(() => {
          store.commit();
        }, 700);
      });

      bodyEl?.addEventListener('blur', () => {
        clearTimeout(bodyTypingTimeout);
        store.commit();
      });

      bodyEl?.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
          e.preventDefault();
          document.execCommand('redo');
          const cur = getCard();
          if (cur) cur.contentHtml = bodyEl.innerHTML;
          wires.render();
          store.scheduleAutoSave();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
          setTimeout(() => {
            const cur = getCard();
            if (cur) cur.contentHtml = bodyEl.innerHTML;
            wires.render();
            store.scheduleAutoSave();
          }, 0);
          return;
        }

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
          ensureTrailingEditableLine();
        }

        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && bodyEl.querySelector('.inline-media-block')) {
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return;
          const prevRange = sel.getRangeAt(0).cloneRange();
          const prevRect = prevRange.getBoundingClientRect();
          const key = e.key;
          setTimeout(() => {
            if (document.activeElement !== bodyEl) return;
            const curSel = window.getSelection();
            if (!curSel || curSel.rangeCount === 0) return;
            const curRange = curSel.getRangeAt(0);
            const moved = curRange.startContainer !== prevRange.startContainer || curRange.startOffset !== prevRange.startOffset;
            if (moved) return;

            const mediaBlocks = [...bodyEl.querySelectorAll('.inline-media-block')];
            if (key === 'ArrowDown') {
              const nextBlock = mediaBlocks.find(b => b.getBoundingClientRect().top >= (prevRect.bottom || prevRect.top) - 6);
              if (nextBlock) {
                const topNode = nextBlock.parentElement === bodyEl ? nextBlock : nextBlock.closest('.note-body > *') || nextBlock;
                const afterTarget = media._hasEditableTargetAfter(topNode) || media._hasEditableTargetAfter(nextBlock);
                if (afterTarget) {
                  setBodyCaret(afterTarget.node, afterTarget.offset);
                } else {
                  const line = ensureTrailingEditableLine();
                  if (line) setBodyCaret(line, 0);
                }
              }
            } else if (key === 'ArrowUp') {
              const prevBlock = [...mediaBlocks].reverse().find(b => b.getBoundingClientRect().bottom <= (prevRect.top || prevRect.bottom) + 6);
              if (prevBlock) {
                const topNode = prevBlock.parentElement === bodyEl ? prevBlock : prevBlock.closest('.note-body > *') || prevBlock;
                let sib = topNode.previousSibling;
                while (sib && sib.nodeType === 3 && !sib.textContent) sib = sib.previousSibling;
                if (sib) {
                  if (sib.nodeType === 3) {
                    setBodyCaret(sib, sib.textContent.length);
                  } else if (sib.tagName === 'BR') {
                    const beforeLine = document.createRange();
                    beforeLine.setStartBefore(sib);
                    beforeLine.collapse(true);
                    curSel.removeAllRanges();
                    curSel.addRange(beforeLine);
                  } else {
                    setBodyCaret(sib, sib.childNodes.length);
                  }
                }
              }
            }
          }, 0);
        }
      });

      bodyEl?.addEventListener('click', (e) => {
        const inlineBlock = e.target?.closest?.('.inline-media-block, .inline-link-chip');
        if (inlineBlock) {
          const popoutBtn = e.target.closest('.inline-media-action-popout');
          if (popoutBtn) {
            e.preventDefault();
            e.stopPropagation();
            media.popoutInlineMedia(getCard(), inlineBlock);
            return;
          }
          const delBtn = e.target.closest('.inline-media-action-delete');
          if (delBtn) {
            e.preventDefault();
            e.stopPropagation();
            inlineBlock.remove();
            const cur = getCard();
            if (cur) cur.contentHtml = bodyEl.innerHTML;
            store.commit();
            wires.render();
            store.scheduleAutoSave();
            return;
          }
          const zoomBtn = e.target.closest('.inline-media-action-zoom');
          if (zoomBtn || (inlineBlock.classList.contains('inline-media-image') && e.target.tagName === 'IMG')) {
            e.preventDefault();
            e.stopPropagation();
            media.openLightbox({
              kind: inlineBlock.getAttribute('data-media-kind') || 'image',
              src: inlineBlock.getAttribute('data-src') || '',
              title: inlineBlock.getAttribute('data-title') || ''
            });
            return;
          }
          if (inlineBlock.classList.contains('inline-media-block') && e.target.tagName !== 'VIDEO') {
            const br = inlineBlock.getBoundingClientRect();
            const topNode = inlineBlock.parentElement === bodyEl ? inlineBlock : inlineBlock.closest('.note-body > *') || inlineBlock;
            if (e.clientY >= br.top + br.height / 2) {
              const target = media._hasEditableTargetAfter(topNode) || media._hasEditableTargetAfter(inlineBlock);
              if (target) setBodyCaret(target.node, target.offset);
              else {
                const line = ensureTrailingEditableLine();
                if (line) setBodyCaret(line, 0);
              }
            }
          }
          return;
        }

        // Clicking empty bottom area below the last inline-media-block focuses the next line
        const blocks = bodyEl.querySelectorAll('.inline-media-block');
        if (blocks.length > 0) {
          const lastBlock = blocks[blocks.length - 1];
          if (e.clientY >= lastBlock.getBoundingClientRect().bottom - 2) {
            const line = ensureTrailingEditableLine();
            if (line) {
              setBodyCaret(line, 0);
            }
          }
        }
      });
    }

    // Update live state in-place
    cardEl.className = 'note-card' + (card.headerColor ? ' has-theme-color' : '') + (this.selectedCardIds.has(cardId) ? ' selected' : '');
    cardEl.style.left = `${card.x}px`;
    cardEl.style.top = `${card.y}px`;
    cardEl.style.width = `${card.width || 310}px`;

    this._applyCardThemeAndPins(card, cardEl, leftPinId, rightPinId, leftConnected, rightConnected, leftColor, rightColor);

    const titleSpan = cardEl.querySelector('.header-title');
    const titleInput = cardEl.querySelector('.header-title-input');
    if (titleInput && titleInput.style.display === 'none') {
      if (titleSpan) titleSpan.textContent = card.title || '未命名节点';
      titleInput.value = card.title || '';
    }

    const bodyEl = cardEl.querySelector('.note-body');
    const nextHtml = card.contentHtml || '';
    if (bodyEl && document.activeElement !== bodyEl && bodyEl.innerHTML !== nextHtml) {
      bodyEl.innerHTML = nextHtml;
    }

    return cardEl;
  }

  render() {
    if (!this.containerEl) return;
    const cards = store.state.cards || [];
    const desiredIds = new Set(cards.map(c => c.id));

    if (this.interactiveWebpageCardId && !desiredIds.has(this.interactiveWebpageCardId)) {
      this.interactiveWebpageCardId = null;
    }

    // 1. Index existing DOM nodes and remove deleted or kind-changed nodes
    const existingById = new Map();
    [...this.containerEl.children].forEach(el => {
      if (!el.classList?.contains('note-card')) return;
      const cid = el.id.replace('card-dom-', '');
      const cardObj = desiredIds.has(cid) ? cards.find(c => c.id === cid) : null;
      if (!cardObj || el.dataset.cardKind !== this._getCardKindKey(cardObj)) {
        el.remove();
      } else {
        existingById.set(cid, el);
      }
    });

    // 2. Reconcile each card in-place without detaching unchanged elements
    let cursor = this.containerEl.firstElementChild;
    cards.forEach(card => {
      const leftPinId = `pin-head-left-${card.id}`;
      const rightPinId = `pin-head-right-${card.id}`;
      const legacyPinId = `pin-head-${card.id}`;

      const leftConn = store.state.connections.find(c => c.toPinId === leftPinId || c.fromPinId === leftPinId || c.toPinId === legacyPinId);
      const rightConn = store.state.connections.find(c => c.toPinId === rightPinId || c.fromPinId === rightPinId);

      const leftConnected = !!leftConn;
      const rightConnected = !!rightConn;

      const leftColor = card.headerColor || leftConn?.color || '#98989d';
      const rightColor = card.headerColor || rightConn?.color || '#98989d';

      const existingEl = existingById.get(card.id) || null;
      let cardEl;
      if (card.kind === 'subcanvas') {
        cardEl = this._syncSubcanvasCard(card, existingEl, leftPinId, rightPinId, leftConnected, rightConnected, leftColor, rightColor);
      } else if (card.kind === 'image' || card.kind === 'video' || card.kind === 'webpage') {
        cardEl = this._syncMediaCard(card, existingEl, leftPinId, rightPinId, leftConnected, rightConnected, leftColor, rightColor);
      } else {
        cardEl = this._syncTextCard(card, existingEl, leftPinId, rightPinId, leftConnected, rightConnected, leftColor, rightColor);
      }

      // Only touch DOM parent order if cardEl is new or out of position
      if (cardEl === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        this.containerEl.insertBefore(cardEl, cursor || null);
      }
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
      const groupEl = pinEl.closest('.node-group');
      const groupId = groupEl?.id.replace('group-dom-', '');
      const group = groupId ? store.state.groups?.find(g => g.id === groupId) : null;

      let color = '#98989d';
      if (capsule) {
        color = window.getComputedStyle(capsule).getPropertyValue('--capsule-pin').trim() || '#30d158';
      } else if (card?.headerColor) {
        color = card.headerColor;
      } else if (group?.headerColor) {
        color = group.headerColor;
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
      if (capsule.dataset.bound === '1') return;
      capsule.dataset.bound = '1';
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
        this._blurActiveTextEditor();
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
    this.clearCapsuleSelection({ silent: true });

    this.selectedCapsule = capsule;
    capsule.classList.add('capsule-selected');
    this.updateCapsuleActionPosition();
    if (this.onSelectionChange) this.onSelectionChange();
  }

  clearCapsuleSelection(opts = {}) {
    const hadCapsule = !!this.selectedCapsule;
    if (this.selectedCapsule) {
      this.selectedCapsule.classList.remove('capsule-selected');
      this.selectedCapsule = null;
    }
    if (this.capsuleActionBarEl) {
      this.capsuleActionBarEl.style.display = 'none';
    }
    if (hadCapsule && !opts.silent && this.onSelectionChange) {
      this.onSelectionChange();
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

    const btnNewNode = this.canvasContextMenuEl.querySelector('#menu-new-node');
    btnNewNode?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = this.contextMenuBoardPos || { x: 160, y: 200 };
      this.hideCanvasContextMenu();
      const node = this.spawnNode(pos);
      wires.render();
      setTimeout(() => this.editCardTitle(node.id), 30);
    });

    const btnNewSub = this.canvasContextMenuEl.querySelector('#menu-new-subcanvas');
    btnNewSub?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = this.contextMenuBoardPos || { x: 160, y: 200 };
      this.hideCanvasContextMenu();
      const card = await this.spawnSubcanvas(pos);
      if (card) {
        setTimeout(() => this.editCardTitle(card.id), 30);
      }
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
      this.renderGroups();
      wires.render();
    });

    const btnMinimap = this.canvasContextMenuEl.querySelector('#menu-toggle-minimap');
    btnMinimap?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      store.toggleMinimap();
      this.updateContextMenuToggles();
    });
  }

  bindSubcanvasContextMenuEvents() {
    if (!this.subcanvasContextMenuEl) return;
    this.subcanvasContextMenuEl.addEventListener('mousedown', (e) => e.stopPropagation());
    this.subcanvasContextMenuEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    this.subcanvasContextMenuEl.querySelector('#subcanvas-menu-enter')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextSubcanvas;
      this.hideSubcanvasContextMenu();
      if (ctx?.card?.subcanvasId) {
        store.navigateToCanvas(ctx.card.subcanvasId);
      }
    });

    this.subcanvasContextMenuEl.querySelector('#subcanvas-menu-export')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextSubcanvas;
      this.hideSubcanvasContextMenu();
      if (ctx?.card?.subcanvasId) {
        store.exportCanvasToFile(ctx.card.subcanvasId);
      }
    });

    this.subcanvasContextMenuEl.querySelector('#subcanvas-menu-rename')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextSubcanvas;
      this.hideSubcanvasContextMenu();
      ctx?.startRename?.();
    });

    this.subcanvasContextMenuEl.querySelector('#subcanvas-menu-color')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextSubcanvas;
      this.hideSubcanvasContextMenu();
      const anchorEl = ctx?.cardEl?.querySelector('.note-header') || ctx?.cardEl;
      if (ctx?.card && anchorEl) {
        this.openPopoverForHeader(ctx.card, anchorEl);
      }
    });

    this.subcanvasContextMenuEl.querySelector('#subcanvas-menu-delete')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextSubcanvas;
      this.hideSubcanvasContextMenu();
      if (ctx?.card) {
        store.removeCard(ctx.card.id);
        this.filterSelectionAfterRestore();
        this.render();
        wires.render();
      }
    });
  }

  showSubcanvasContextMenu(card, cardEl, startRename, screenX, screenY) {
    if (!this.subcanvasContextMenuEl) return;
    this.hideAllMenus();
    this.activeContextSubcanvas = { card, cardEl, startRename };
    const menu = this.subcanvasContextMenuEl;
    menu.style.display = 'flex';
    const menuWidth = menu.offsetWidth || 195;
    const menuHeight = menu.offsetHeight || 210;
    let left = screenX + 2;
    let top = screenY + 2;
    if (left + menuWidth > window.innerWidth - 10) left = screenX - menuWidth - 2;
    if (top + menuHeight > window.innerHeight - 10) top = screenY - menuHeight - 2;
    if (left < 10) left = 10;
    if (top < 10) top = 10;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  hideSubcanvasContextMenu() {
    if (this.subcanvasContextMenuEl) {
      this.subcanvasContextMenuEl.style.display = 'none';
    }
    this.activeContextSubcanvas = null;
  }

  bindMediaContextMenuEvents() {
    if (!this.mediaContextMenuEl) return;
    this.mediaContextMenuEl.addEventListener('mousedown', (e) => e.stopPropagation());
    this.mediaContextMenuEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    this.mediaContextMenuEl.querySelector('#media-menu-preview')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextMedia;
      this.hideMediaContextMenu();
      if (ctx?.card && (ctx.card.kind === 'image' || ctx.card.kind === 'video')) {
        media.openLightbox({
          kind: ctx.card.kind,
          src: ctx.card.media?.src || '',
          title: ctx.card.title || '',
          naturalWidth: ctx.card.media?.naturalWidth,
          naturalHeight: ctx.card.media?.naturalHeight
        });
      }
    });

    this.mediaContextMenuEl.querySelector('#media-menu-open-tab')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextMedia;
      this.hideMediaContextMenu();
      const url = ctx?.card?.media?.url || ctx?.card?.media?.src;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    });

    this.mediaContextMenuEl.querySelector('#media-menu-toggle-view')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextMedia;
      this.hideMediaContextMenu();
      if (ctx?.card?.kind === 'webpage') {
        const cur = ctx.card.media?.viewMode || 'iframe';
        const nextMode = cur === 'iframe' ? 'bookmark' : 'iframe';
        ctx.card.media = { ...ctx.card.media, viewMode: nextMode };
        if (nextMode === 'iframe') {
          this.loadedWebpageIds.add(ctx.card.id);
        }
        store.commit();
        this.render();
        wires.render();
        store.scheduleAutoSave();
      }
    });

    this.mediaContextMenuEl.querySelector('#media-menu-sleep')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextMedia;
      this.hideMediaContextMenu();
      if (ctx?.card?.kind === 'webpage') {
        if (shouldWebpageStartDormant(ctx.card, this.loadedWebpageIds)) {
          this.loadWebpageCard(ctx.card.id);
        } else {
          this.sleepWebpageCard(ctx.card.id);
        }
      }
    });

    this.mediaContextMenuEl.querySelector('#media-menu-localize')?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextMedia;
      this.hideMediaContextMenu();
      if (ctx?.card) {
        await media.convertExternalCardToLocal(ctx.card);
      }
    });

    this.mediaContextMenuEl.querySelector('#media-menu-rename')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextMedia;
      this.hideMediaContextMenu();
      if (typeof ctx?.startRename === 'function') {
        ctx.startRename();
      }
    });

    this.mediaContextMenuEl.querySelector('#media-menu-color')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextMedia;
      this.hideMediaContextMenu();
      if (ctx?.card && ctx?.cardEl) {
        const headerEl = ctx.cardEl.querySelector('.note-header') || ctx.cardEl;
        this.openPopoverForHeader(ctx.card, headerEl);
      }
    });

    this.mediaContextMenuEl.querySelector('#media-menu-delete')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextMedia;
      this.hideMediaContextMenu();
      if (ctx?.card) {
        this.selectedCardIds = new Set([ctx.card.id]);
        this.deleteSelectedCards();
      }
    });
  }

  showMediaContextMenu(card, cardEl, startRename, screenX, screenY) {
    if (!this.mediaContextMenuEl) return;
    this.hideAllMenus();
    this.activeContextMedia = { card, cardEl, startRename };
    const menu = this.mediaContextMenuEl;

    const labelEl = menu.querySelector('#media-menu-header-label');
    if (labelEl) {
      labelEl.textContent = card.kind === 'image' ? '图片节点' : (card.kind === 'video' ? '视频节点' : '网页节点');
    }
    const btnPreview = menu.querySelector('#media-menu-preview');
    const btnOpenTab = menu.querySelector('#media-menu-open-tab');
    const btnToggleView = menu.querySelector('#media-menu-toggle-view');
    const toggleViewLabel = menu.querySelector('#media-menu-toggle-view-label');
    const btnSleep = menu.querySelector('#media-menu-sleep');
    const sleepLabel = menu.querySelector('#media-menu-sleep-label');
    const btnLocalize = menu.querySelector('#media-menu-localize');

    if (btnPreview) btnPreview.style.display = (card.kind === 'image' || card.kind === 'video') ? 'flex' : 'none';
    if (btnOpenTab) btnOpenTab.style.display = card.kind === 'webpage' ? 'flex' : 'none';
    if (btnToggleView) {
      btnToggleView.style.display = card.kind === 'webpage' ? 'flex' : 'none';
      if (toggleViewLabel) {
        const cur = card.media?.viewMode || 'iframe';
        toggleViewLabel.textContent = cur === 'iframe' ? '切换为书签卡片' : '强制尝试内嵌网页';
      }
    }
    if (btnSleep) {
      const canSleep = card.kind === 'webpage' && (card.media?.viewMode || 'iframe') !== 'bookmark';
      btnSleep.style.display = canSleep ? 'flex' : 'none';
      if (canSleep && sleepLabel) {
        const dormant = shouldWebpageStartDormant(card, this.loadedWebpageIds);
        sleepLabel.textContent = dormant ? '加载 / 唤醒网页' : '休眠网页（停止播放）';
      }
    }
    if (btnLocalize) {
      btnLocalize.style.display = ((card.kind === 'image' || card.kind === 'video') && card.media?.isExternal) ? 'flex' : 'none';
    }

    menu.style.display = 'flex';
    const menuWidth = menu.offsetWidth || 195;
    const menuHeight = menu.offsetHeight || 220;
    let left = screenX + 2;
    let top = screenY + 2;
    if (left + menuWidth > window.innerWidth - 10) left = screenX - menuWidth - 2;
    if (top + menuHeight > window.innerHeight - 10) top = screenY - menuHeight - 2;
    if (left < 10) left = 10;
    if (top < 10) top = 10;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  hideMediaContextMenu() {
    if (this.mediaContextMenuEl) {
      this.mediaContextMenuEl.style.display = 'none';
    }
    this.activeContextMedia = null;
  }

  exitWebpageInteractive() {
    if (!this.interactiveWebpageCardId) return;
    const prevEl = document.getElementById(`card-dom-${this.interactiveWebpageCardId}`);
    prevEl?.classList.remove('is-webpage-interactive');
    this.interactiveWebpageCardId = null;
  }

  _escapeAttr(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _syncMediaCard(card, existingEl, leftPinId, rightPinId, leftConnected, rightConnected, leftColor, rightColor) {
    const isNew = !existingEl;
    const cardEl = existingEl || document.createElement('div');
    const cardId = card.id;
    const kind = card.kind;
    const m = card.media || {};
    const getCard = () => store.state.cards.find(c => c.id === cardId) || cardEl.__cardData;
    cardEl.__cardData = card;

    const defW = kind === 'webpage' ? 460 : (kind === 'video' ? 400 : 360);
    const defH = kind === 'webpage' ? 360 : (kind === 'video' ? 264 : 240);
    const cardW = Math.max(250, card.width || defW);
    const cardH = Math.max(140, card.height || defH);

    const typeIconSvg = kind === 'image'
      ? '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>'
      : (kind === 'video'
        ? '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2"></rect></svg>'
        : '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>');

    if (isNew) {
      cardEl.id = `card-dom-${cardId}`;
      cardEl.dataset.cardKind = kind;
      const resizeHandlesHtml = kind === 'webpage'
        ? `
          <div class="card-resize-handle card-resize-handle-left" data-side="left"></div>
          <div class="card-resize-handle card-resize-handle-right" data-side="right"></div>
          <div class="card-resize-handle-bottom" data-side="bottom"></div>
          <div class="card-resize-corner card-resize-corner-sw" data-corner="sw"></div>
          <div class="card-resize-corner card-resize-corner-se" data-corner="se"></div>
        `
        : `
          <div class="card-resize-handle card-resize-handle-left" data-side="left"></div>
          <div class="card-resize-handle card-resize-handle-right" data-side="right"></div>
          <div class="card-resize-corner card-resize-corner-nw" data-corner="nw"></div>
          <div class="card-resize-corner card-resize-corner-ne" data-corner="ne"></div>
          <div class="card-resize-corner card-resize-corner-sw" data-corner="sw"></div>
          <div class="card-resize-corner card-resize-corner-se" data-corner="se"></div>
        `;

      cardEl.innerHTML = `
        <div class="note-header">
          <div class="header-port-slot header-port-slot-left" title="连接端口 (左)">
            <i class="header-pin header-pin-left" data-header-pin-id="${leftPinId}"></i>
          </div>
          <div class="header-content">
            <span class="media-header-type-icon" aria-hidden="true">${typeIconSvg}</span>
            <span class="header-title" title="双击重命名"></span>
            <input class="header-title-input" placeholder="未命名节点" style="display: none;" />
            <div class="media-header-actions"></div>
          </div>
          <div class="header-port-slot header-port-slot-right" title="连接端口 (右)">
            <i class="header-pin header-pin-right" data-header-pin-id="${rightPinId}"></i>
          </div>
        </div>
        <div class="media-body-slot" style="flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;"></div>
        ${resizeHandlesHtml}
      `;

      const titleSpan = cardEl.querySelector('.header-title');
      const titleInput = cardEl.querySelector('.header-title-input');
      let prevTitle = card.title || '';

      const startTitleEdit = () => {
        const cur = getCard();
        prevTitle = cur?.title || '';
        titleSpan.style.display = 'none';
        titleInput.style.display = 'block';
        titleInput.value = prevTitle;
        titleInput.focus();
        titleInput.select();
      };
      cardEl._startTitleEdit = startTitleEdit;

      const finishTitleEdit = () => {
        if (titleInput.style.display === 'none') return;
        const cur = getCard();
        const newTitle = titleInput.value.trim() || '未命名节点';
        const changed = newTitle !== prevTitle;
        if (cur) {
          cur.title = newTitle;
          if (changed) cur.customTitle = true;
        }
        prevTitle = newTitle;
        titleSpan.textContent = newTitle;
        titleInput.style.display = 'none';
        titleSpan.style.display = 'block';
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
          titleInput.value = getCard()?.title || '';
          finishTitleEdit();
        }
      });
      titleInput.addEventListener('blur', finishTitleEdit);
      titleInput.addEventListener('mousedown', (e) => e.stopPropagation());

      // Delegated header actions
      const actionsEl = cardEl.querySelector('.media-header-actions');
      actionsEl?.addEventListener('click', (e) => {
        const cur = getCard();
        if (!cur) return;
        const cm = cur.media || {};
        if (e.target.closest('.btn-media-zoom')) {
          e.stopPropagation();
          const videoEl = cardEl.querySelector('video');
          if (videoEl) videoEl.pause();
          media.openLightbox({
            kind: cur.kind,
            src: cm.src || '',
            title: cur.title || '',
            naturalWidth: cm.naturalWidth,
            naturalHeight: cm.naturalHeight
          });
          return;
        }
        if (e.target.closest('.btn-webpage-open')) {
          e.stopPropagation();
          const url = cm.url || cm.src;
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
          return;
        }
        if (e.target.closest('.btn-webpage-sleep')) {
          e.stopPropagation();
          if (shouldWebpageStartDormant(cur, this.loadedWebpageIds)) {
            this.loadWebpageCard(cur.id);
          } else {
            this.sleepWebpageCard(cur.id);
          }
          return;
        }
        if (e.target.closest('.btn-webpage-toggle-mode')) {
          e.stopPropagation();
          const curMode = cm.viewMode || 'iframe';
          const nextMode = curMode === 'iframe' ? 'bookmark' : 'iframe';
          cur.media = { ...cm, viewMode: nextMode };
          if (nextMode === 'iframe') {
            this.loadedWebpageIds.add(cur.id);
          }
          this.exitWebpageInteractive();
          store.commit();
          this.render();
          wires.render();
          store.scheduleAutoSave();
        }
      });

      // Delegated body slot events
      const bodySlot = cardEl.querySelector('.media-body-slot');
      bodySlot?.addEventListener('click', (e) => {
        const cur = getCard();
        if (!cur) return;
        const cm = cur.media || {};

        if (e.target.closest('.btn-bookmark-try-iframe')) {
          e.stopPropagation();
          this.loadedWebpageIds.add(cur.id);
          cur.media = { ...cm, viewMode: 'iframe' };
          store.commit();
          this.render();
          wires.render();
          store.scheduleAutoSave();
          return;
        }

        if (e.target.closest('.btn-webpage-wake') || (e.target.closest('.webpage-dormant-card') && !e.target.closest('a.webpage-action-btn'))) {
          e.stopPropagation();
          this.loadWebpageCard(cur.id);
        }
      });

      bodySlot?.addEventListener('change', (e) => {
        const sel = e.target.closest('.webpage-entry-select');
        if (!sel) return;
        e.stopPropagation();
        const cur = getCard();
        const cm = cur?.media || {};
        const nextEntry = sel.value;
        if (cur && nextEntry && cm.assetId) {
          const nextUrl = `/api/v1/assets/${cm.assetId}/${nextEntry}`;
          cur.media = { ...cm, entryPath: nextEntry, src: nextUrl, url: nextUrl };
          this.loadedWebpageIds.add(cur.id);
          store.commit();
          this.render();
          store.scheduleAutoSave();
        }
      });

      bodySlot?.addEventListener('mousedown', (e) => {
        if (e.target.closest('.webpage-entry-select')) {
          e.stopPropagation();
          return;
        }
        const shieldEl = e.target.closest('.webpage-interact-shield');
        if (shieldEl) {
          if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
          e.stopPropagation();
          this.exitWebpageInteractive();
          this.selectCard(cardId, false);
          this.interactiveWebpageCardId = cardId;
          cardEl.classList.add('is-webpage-interactive');
        }
      });

      bodySlot?.addEventListener('dblclick', (e) => {
        const cur = getCard();
        if (!cur || (cur.kind !== 'image' && cur.kind !== 'video')) return;
        if (!e.target.closest('.media-card-body')) return;
        e.stopPropagation();
        const videoEl = cardEl.querySelector('video');
        if (videoEl) videoEl.pause();
        const cm = cur.media || {};
        media.openLightbox({
          kind: cur.kind,
          src: cm.src || '',
          title: cur.title || '',
          naturalWidth: cm.naturalWidth,
          naturalHeight: cm.naturalHeight
        });
      });

      // Card context menu
      cardEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot')) return;
        e.preventDefault();
        e.stopPropagation();
        this.showMediaContextMenu(getCard(), cardEl, startTitleEdit, e.clientX, e.clientY);
      });

      // Card selection on body mousedown
      cardEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.note-header, .header-pin, .header-port-slot, .card-resize-handle, .card-resize-handle-bottom, .card-resize-corner, .header-title-input, .media-header-btn, .webpage-entry-select, .webpage-action-btn')) return;
        const isMultiToggle = e.shiftKey || e.ctrlKey || e.metaKey;
        if (isMultiToggle) {
          e.preventDefault();
          e.stopPropagation();
          this.selectCard(cardId, true);
        } else if (!this.selectedCardIds.has(cardId) || this.selectedCardIds.size > 1) {
          this.selectCard(cardId, false);
        }
      });

      // Drag by header
      const headerEl = cardEl.querySelector('.note-header');
      headerEl.addEventListener('mousedown', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot, .media-header-btn') || e.target === titleInput) return;
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this._blurActiveTextEditor();
        this.hideAllMenus();

        const isMultiToggle = e.shiftKey || e.ctrlKey || e.metaKey;
        const wasSelected = this.selectedCardIds.has(cardId);
        if (isMultiToggle) {
          if (!wasSelected) {
            this.selectedCardIds.add(cardId);
            this.updateSelectionVisuals();
            this.updateAlignmentBar();
          }
        } else if (!wasSelected) {
          this.selectCard(cardId, false);
        }

        document.body.classList.add('is-card-dragging');
        this.activeDrag = {
          type: 'MOVE_CARDS',
          leadCardId: cardId,
          startX: e.clientX,
          startY: e.clientY,
          isAlt: e.altKey,
          wasMultiToggle: isMultiToggle,
          toggleOffOnClick: isMultiToggle && wasSelected,
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
        if (e.target.closest('.header-pin, .header-port-slot, .media-header-btn') || e.target === titleInput) return;
        startTitleEdit();
      });

      const getBodyRatio = () => {
        const cur = getCard();
        const cm = cur?.media || {};
        const nw = cm.naturalWidth || 0;
        const nh = cm.naturalHeight || 0;
        if (nw > 0 && nh > 0) return nw / nh;
        const w = cardEl.offsetWidth || cur?.width || defW;
        const h = cardEl.offsetHeight || cur?.height || defH;
        const curBodyH = Math.max(80, h - CARD_HEADER_HEIGHT);
        return w / curBodyH;
      };

      cardEl.querySelectorAll('.card-resize-handle').forEach(resizeHandle => {
        resizeHandle.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          this.hideAllMenus();
          const cur = getCard();
          const side = resizeHandle.getAttribute('data-side') || 'right';
          document.body.classList.add('is-card-dragging');
          this.activeDrag = {
            type: 'RESIZE_CARD',
            side,
            cardId,
            startX: e.clientX,
            initX: cur.x,
            initWidth: cardEl.offsetWidth,
            lockRatio: (cur.kind === 'image' || cur.kind === 'video') ? getBodyRatio() : null
          };
          resizeHandle.classList.add('active');
        });
      });

      const bottomResizeEl = cardEl.querySelector('.card-resize-handle-bottom');
      bottomResizeEl?.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.hideAllMenus();
        const cur = getCard();
        document.body.classList.add('is-card-dragging');
        this.activeDrag = {
          type: 'RESIZE_WEBPAGE',
          corner: 's',
          cardId,
          startX: e.clientX,
          startY: e.clientY,
          initX: cur.x,
          initY: cur.y,
          initWidth: cardEl.offsetWidth,
          initHeight: cardEl.offsetHeight
        };
        bottomResizeEl.classList.add('active');
      });

      cardEl.querySelectorAll('.card-resize-corner').forEach(cornerEl => {
        cornerEl.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          this.hideAllMenus();
          const cur = getCard();
          const corner = cornerEl.getAttribute('data-corner') || 'se';
          document.body.classList.add('is-card-dragging');
          if (cur.kind === 'webpage') {
            this.activeDrag = {
              type: 'RESIZE_WEBPAGE',
              corner,
              cardId,
              startX: e.clientX,
              startY: e.clientY,
              initX: cur.x,
              initY: cur.y,
              initWidth: cardEl.offsetWidth,
              initHeight: cardEl.offsetHeight
            };
          } else {
            this.activeDrag = {
              type: 'RESIZE_MEDIA_CORNER',
              corner,
              cardId,
              startX: e.clientX,
              startY: e.clientY,
              initX: cur.x,
              initY: cur.y,
              initWidth: cardEl.offsetWidth,
              initHeight: cardEl.offsetHeight,
              lockRatio: getBodyRatio()
            };
          }
          cornerEl.classList.add('active');
        });
      });

      this.bindPinEvents(cardEl.querySelector('.header-pin-left'), leftPinId);
      this.bindPinEvents(cardEl.querySelector('.header-pin-right'), rightPinId);
    }

    // In-place reconciliation of position, dimensions, classes, theme, pins, title
    cardEl.className = 'note-card media-card'
      + ` media-kind-${kind}`
      + (card.headerColor ? ' has-theme-color' : '')
      + (this.selectedCardIds.has(cardId) ? ' selected' : '')
      + (this.interactiveWebpageCardId === cardId ? ' is-webpage-interactive' : '');
    cardEl.style.left = `${card.x}px`;
    cardEl.style.top = `${card.y}px`;
    cardEl.style.width = `${cardW}px`;
    cardEl.style.height = `${cardH}px`;

    this._applyCardThemeAndPins(card, cardEl, leftPinId, rightPinId, leftConnected, rightConnected, leftColor, rightColor);

    const titleSpan = cardEl.querySelector('.header-title');
    const titleInput = cardEl.querySelector('.header-title-input');
    if (titleInput && titleInput.style.display === 'none') {
      if (titleSpan) titleSpan.textContent = card.title || '未命名节点';
      titleInput.value = card.title || '';
    }

    // Reconcile header actions only when mode/dormancy changes (never touches body)
    const viewMode = m.viewMode || 'iframe';
    const isDormant = kind === 'webpage' && shouldWebpageStartDormant(card, this.loadedWebpageIds);
    const headerActionsKey = kind === 'webpage'
      ? `webpage|${viewMode}|${isDormant ? 'dormant' : 'active'}`
      : 'media-zoom';

    if (cardEl.dataset.headerActionsKey !== headerActionsKey) {
      cardEl.dataset.headerActionsKey = headerActionsKey;
      const actionsEl = cardEl.querySelector('.media-header-actions');
      if (actionsEl) {
        if (kind === 'image' || kind === 'video') {
          actionsEl.innerHTML = `
            <button type="button" class="media-header-btn btn-media-zoom" title="放大预览">
              <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
            </button>
          `;
        } else {
          const sleepBtnHtml = viewMode !== 'bookmark'
            ? `<button type="button" class="media-header-btn btn-webpage-sleep ${isDormant ? 'is-active' : ''}" title="${isDormant ? '加载网页' : '休眠网页（停止播放）'}">
                ${isDormant
                  ? '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>'
                  : '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>'}
               </button>`
            : '';
          actionsEl.innerHTML = `
            ${sleepBtnHtml}
            <button type="button" class="media-header-btn btn-webpage-toggle-mode ${viewMode === 'bookmark' ? 'is-active' : ''}" title="${viewMode === 'iframe' ? '切换为书签卡片' : '切换为内嵌网页'}">
              <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="3" y1="10" x2="21" y2="10"></line></svg>
            </button>
            <button type="button" class="media-header-btn btn-webpage-open" title="在新标签页打开 (Enter)">
              <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            </button>
          `;
        }
      }
    }

    // Reconcile media body ONLY when its structural source/mode key changes
    const url = m.url || m.src || '';
    const src = m.src || m.url || '';
    const isLocal = !!m.isLocal || m.sourceType === 'html-file' || m.sourceType === 'html-bundle';
    const entriesKey = Array.isArray(m.htmlEntries) ? m.htmlEntries.join(',') : '';
    let bodyKey = '';
    if (kind === 'image') {
      bodyKey = `image|${m.src || ''}`;
    } else if (kind === 'video') {
      bodyKey = `video|${m.src || ''}`;
    } else if (viewMode === 'bookmark') {
      bodyKey = `bookmark|${url}|${m.title || ''}|${m.favicon || ''}|${m.description || ''}|${m.blockReason || ''}|${m.entryPath || ''}|${entriesKey}`;
    } else if (isDormant) {
      bodyKey = `dormant|${url}|${m.title || ''}|${m.favicon || ''}|${m.entryPath || ''}|${entriesKey}|${isLikelyVideoSiteUrl(url) ? 'v' : 'w'}`;
    } else {
      bodyKey = `iframe|${sanitizeIframeUrl(src)}|${isLocal ? '1' : '0'}|${m.entryPath || ''}|${entriesKey}`;
    }

    if (cardEl.dataset.bodyKey !== bodyKey) {
      cardEl.dataset.bodyKey = bodyKey;
      const bodySlot = cardEl.querySelector('.media-body-slot');
      if (bodySlot) {
        let bodyHtml = '';
        if (kind === 'image') {
          const escSrc = this._escapeAttr(m.src || '');
          bodyHtml = `<div class="media-card-body media-image-body">${escSrc
            ? `<img class="media-image-el" src="${escSrc}" alt="${this._escapeAttr(card.title)}" loading="lazy" draggable="false" />`
            : '<div class="media-fallback-state">无图片地址</div>'}</div>`;
        } else if (kind === 'video') {
          const escSrc = this._escapeAttr(m.src || '');
          bodyHtml = `<div class="media-card-body media-video-body">${escSrc
            ? `<video class="media-video-el" src="${escSrc}" controls preload="metadata" playsinline></video>`
            : '<div class="media-fallback-state">无视频地址</div>'}</div>`;
        } else {
          const sandboxAttr = isLocal
            ? 'allow-scripts allow-forms allow-popups'
            : 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation';

          let displayHost = url;
          try {
            displayHost = isLocal ? (m.entryPath || m.fileName || '本地网页') : new URL(url).hostname;
          } catch {}

          const entries = Array.isArray(m.htmlEntries) && m.htmlEntries.length > 1 ? m.htmlEntries : null;
          const entrySelectHtml = entries
            ? `<select class="webpage-entry-select" title="切换入口 HTML">${entries.map(ep => `<option value="${this._escapeAttr(ep)}" ${ep === m.entryPath ? 'selected' : ''}>${this._escapeAttr(ep)}</option>`).join('')}</select>`
            : '';

          const badgeText = viewMode === 'bookmark'
            ? '书签'
            : (isDormant ? '已休眠 · 待加载' : '点击交互 · Esc 退出');

          const subbarHtml = `
            <div class="webpage-subbar">
              ${m.favicon && !isLocal ? `<img class="webpage-favicon" src="${this._escapeAttr(m.favicon)}" alt="" onerror="this.style.display='none'" />` : ''}
              <span class="webpage-url-text" title="${this._escapeAttr(url)}">${this._escapeAttr(displayHost)}</span>
              ${entrySelectHtml}
              <span class="webpage-interact-badge">${badgeText}</span>
            </div>
          `;

          if (viewMode === 'bookmark') {
            const blockReasonText = m.blockReason ? `无法内嵌 (${this._escapeAttr(m.blockReason)})` : '书签预览模式';
            bodyHtml = `
              <div class="media-card-body media-webpage-body">
                ${subbarHtml}
                <div class="webpage-bookmark-card">
                  <div class="webpage-bookmark-head">
                    <div class="webpage-bookmark-icon">
                      ${m.favicon && !isLocal
                        ? `<img src="${this._escapeAttr(m.favicon)}" alt="" onerror="this.style.display='none'" />`
                        : typeIconSvg}
                    </div>
                    <div style="min-width: 0; flex: 1;">
                      <div class="webpage-bookmark-title">${this._escapeAttr(m.title || card.title || displayHost)}</div>
                      <div class="webpage-bookmark-url">${this._escapeAttr(url)}</div>
                    </div>
                  </div>
                  ${m.description ? `<div class="webpage-bookmark-desc">${this._escapeAttr(m.description)}</div>` : ''}
                  <div class="webpage-bookmark-footer">
                    <span class="webpage-block-badge">${blockReasonText}</span>
                    <div class="webpage-bookmark-actions">
                      <button type="button" class="webpage-action-btn btn-bookmark-try-iframe">尝试内嵌</button>
                      <a class="webpage-action-btn is-primary" href="${this._escapeAttr(url)}" target="_blank" rel="noopener noreferrer">打开网页 ↗</a>
                    </div>
                  </div>
                </div>
              </div>
            `;
          } else if (isDormant) {
            const isVideoSite = isLikelyVideoSiteUrl(url);
            const hintText = isVideoSite
              ? '检测到视频网站 · 为防止自动播放已暂缓加载'
              : '已按按需加载模式休眠 · 点击后加载网页';
            bodyHtml = `
              <div class="media-card-body media-webpage-body">
                ${subbarHtml}
                <div class="webpage-dormant-card" title="点击加载网页内容">
                  <div class="webpage-dormant-icon">
                    ${m.favicon && !isLocal
                      ? `<img src="${this._escapeAttr(m.favicon)}" alt="" onerror="this.style.display='none'" />`
                      : typeIconSvg}
                  </div>
                  <div class="webpage-dormant-title">${this._escapeAttr(m.title || card.title || displayHost)}</div>
                  <div class="webpage-dormant-hint">${hintText}</div>
                  <div class="webpage-dormant-actions">
                    <button type="button" class="webpage-action-btn is-primary btn-webpage-wake">加载网页</button>
                    <a class="webpage-action-btn" href="${this._escapeAttr(url)}" target="_blank" rel="noopener noreferrer">新标签页打开 ↗</a>
                  </div>
                </div>
              </div>
            `;
          } else {
            const iframeSrc = sanitizeIframeUrl(src);
            bodyHtml = `
              <div class="media-card-body media-webpage-body">
                ${subbarHtml}
                <div class="webpage-stage">
                  <iframe class="webpage-iframe" src="${this._escapeAttr(iframeSrc)}" sandbox="${sandboxAttr}" allow="autoplay 'none'; fullscreen" referrerpolicy="no-referrer" loading="lazy"></iframe>
                  <div class="webpage-interact-shield" title="点击直接操作网页，拖拽顶部标题栏移动卡片"></div>
                </div>
              </div>
            `;
          }
        }
        bodySlot.innerHTML = bodyHtml;

        const imgEl = bodySlot.querySelector('.media-image-el');
        imgEl?.addEventListener('error', () => {
          const mediaBody = bodySlot.querySelector('.media-image-body');
          if (mediaBody) {
            mediaBody.innerHTML = `<div class="media-fallback-state"><span>图片加载失败</span></div>`;
          }
        });
      }
    }

    return cardEl;
  }

  bindGroupContextMenuEvents() {
    if (!this.groupContextMenuEl) return;
    this.groupContextMenuEl.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });
    this.groupContextMenuEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    const btnRename = this.groupContextMenuEl.querySelector('#group-menu-rename');
    btnRename?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextGroup;
      this.hideGroupContextMenu();
      ctx?.startRename?.();
    });

    const btnColor = this.groupContextMenuEl.querySelector('#group-menu-color');
    btnColor?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextGroup;
      this.hideGroupContextMenu();
      if (ctx?.group && ctx?.labelEl) {
        this.openPopoverForGroup(ctx.group, ctx.labelEl, { x: e.clientX, y: e.clientY });
      }
    });

    const btnFit = this.groupContextMenuEl.querySelector('#group-menu-fit');
    btnFit?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextGroup;
      this.hideGroupContextMenu();
      if (ctx?.group) {
        this.fitGroupToMembers(ctx.group.id);
      }
    });

    const btnFocus = this.groupContextMenuEl.querySelector('#group-menu-focus');
    btnFocus?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextGroup;
      this.hideGroupContextMenu();
      if (ctx?.group) {
        this.enterFocusMode(ctx.group.cardIds);
      }
    });

    const btnUngroup = this.groupContextMenuEl.querySelector('#group-menu-ungroup');
    btnUngroup?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = this.activeContextGroup;
      this.hideGroupContextMenu();
      if (ctx?.group) {
        this.ungroup(ctx.group.id);
      }
    });
  }

  showGroupContextMenu(group, labelEl, startRename, screenX, screenY) {
    if (!this.groupContextMenuEl) return;
    this.hideAllMenus();
    this.activeContextGroup = { group, labelEl, startRename };

    const menu = this.groupContextMenuEl;
    menu.style.display = 'flex';

    const menuWidth = menu.offsetWidth || 190;
    const menuHeight = menu.offsetHeight || 190;
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

  hideGroupContextMenu() {
    if (this.groupContextMenuEl) {
      this.groupContextMenuEl.style.display = 'none';
    }
    this.activeContextGroup = null;
  }

  bindCanvasShortcuts() {
    if (!this.viewportEl) return;

    // Double click on empty canvas to quickly spawn node at cursor
    this.viewportEl.addEventListener('dblclick', (e) => {
      const isBg = (e.target === this.viewportEl ||
                    e.target === document.getElementById('board') ||
                    e.target.id === 'wire-svg') &&
                   !e.target.closest('.note-card, .wire-group, .hud-bar, .alignment-bar, #selection-popover, #capsule-action-bar, #wire-drop-menu, #canvas-context-menu, #group-context-menu, #minimap-widget');
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

    // Right click on empty canvas (or anywhere inside a group container) to open context menu
    this.viewportEl.addEventListener('contextmenu', (e) => {
      const isBg = (e.target === this.viewportEl ||
                    e.target === document.getElementById('board') ||
                    e.target.id === 'wire-svg') &&
                   !e.target.closest('.note-card, .wire-group, .hud-bar, .alignment-bar, #selection-popover, #capsule-action-bar, #wire-drop-menu, #canvas-context-menu, #group-context-menu, #minimap-widget');
      if (!isBg) return;

      e.preventDefault();
      e.stopPropagation();
      const boardPos = canvas.screenToBoard(e.clientX, e.clientY);
      const hitGroup = this.findGroupAtBoardPos(boardPos);
      if (hitGroup) {
        const groupEl = document.getElementById(`group-dom-${hitGroup.id}`);
        const labelEl = groupEl?.querySelector('.group-label') || null;
        const startRename = groupEl?.__startRename || null;
        this.showGroupContextMenu(hitGroup, labelEl, startRename, e.clientX, e.clientY);
        return;
      }
      this.showCanvasContextMenu(e.clientX, e.clientY);
    });
  }

  showCanvasContextMenu(screenX, screenY) {
    if (!this.canvasContextMenuEl) return;
    this.hideAllMenus();
    this.updateContextMenuToggles();
    this.contextMenuBoardPos = canvas.screenToBoard(screenX, screenY);

    const menu = this.canvasContextMenuEl;
    menu.style.display = 'flex';

    const menuWidth = 196;
    const menuHeight = 240;
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
    const minimapActive = !!store.state.settings?.minimap?.enabled;
    const alignPill = document.getElementById('toggle-align-pill');
    const gridPill = document.getElementById('toggle-gridsnap-pill');
    const minimapPill = document.getElementById('toggle-minimap-pill');
    if (alignPill) alignPill.classList.toggle('is-active', alignActive);
    if (gridPill) gridPill.classList.toggle('is-active', gridActive);
    if (minimapPill) minimapPill.classList.toggle('is-active', minimapActive);
  }

  hideAllMenus() {
    this.clearCapsuleSelection();
    this.hideSelectionPopover();
    this.hideCanvasContextMenu();
    this.hideGroupContextMenu();
    this.hideSubcanvasContextMenu();
    this.hideMediaContextMenu();
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

    // "无颜色 / 默认" button — applies immediately
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
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
      this.applyColor();
    });
    colorsRow.appendChild(noneBtn);

    const dividerLeft = document.createElement('div');
    dividerLeft.className = 'popover-divider';
    colorsRow.appendChild(dividerLeft);

    palette.forEach((color, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'popover-color-btn';
      btn.setAttribute('data-color', color);
      btn.style.setProperty('--btn-color', color);
      btn.title = `配色 ${idx + 1} (${color}) · 点击立即应用`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setSelectedColor(color);
        this.applyColor();
      });
      colorsRow.appendChild(btn);
    });

    const divider = document.createElement('div');
    divider.className = 'popover-divider';
    colorsRow.appendChild(divider);

    const customToggle = document.createElement('button');
    customToggle.type = 'button';
    customToggle.className = 'popover-palette-btn';
    customToggle.id = 'btn-popover-custom-toggle';
    customToggle.title = '自定义颜色';
    customToggle.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9"></circle>
        <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"></circle>
        <circle cx="15.5" cy="11.5" r="1" fill="currentColor" stroke="none"></circle>
        <circle cx="8.5" cy="11.5" r="1" fill="currentColor" stroke="none"></circle>
      </svg>
    `;
    customToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const drawer = this.selectionPopoverEl.querySelector('#popover-custom-drawer');
      if (drawer) {
        const isOpen = drawer.classList.toggle('is-open');
        customToggle.classList.toggle('is-open', isOpen);
      }
    });
    colorsRow.appendChild(customToggle);

    const drawerInput = this.selectionPopoverEl.querySelector('#popover-color-picker');
    if (drawerInput && !drawerInput._bound) {
      drawerInput._bound = true;
      const handleCustomColor = (e) => {
        const col = e.target.value;
        if (col) this.setSelectedColor(col);
      };
      drawerInput.addEventListener('input', handleCustomColor);
      drawerInput.addEventListener('change', handleCustomColor);
    }

    const drawer = this.selectionPopoverEl.querySelector('#popover-custom-drawer');
    if (drawer) drawer.classList.remove('is-open');

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
    }

    const picker = this.selectionPopoverEl.querySelector('#popover-color-picker');
    const swatch = this.selectionPopoverEl.querySelector('#popover-custom-swatch');
    const hexEl = this.selectionPopoverEl.querySelector('#popover-custom-hex');
    const activeHex = (this.selectedColor && this.selectedColor.startsWith('#'))
      ? this.selectedColor
      : (store.getPalette()[0] || '#5ca479');
    if (picker) picker.value = activeHex;
    if (swatch) swatch.style.backgroundColor = activeHex;
    if (hexEl) hexEl.textContent = activeHex.toUpperCase();
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
      if (this.targetGroup.boardPos) {
        const screenPos = canvas.boardToScreen(this.targetGroup.boardPos.x, this.targetGroup.boardPos.y);
        if (screenPos.y < -100 || screenPos.y > window.innerHeight + 100 || screenPos.x < -150 || screenPos.x > window.innerWidth + 150) {
          this.selectionPopoverEl.style.display = 'none';
          return;
        }
        this.selectionPopoverEl.style.display = 'flex';
        const popW = this.selectionPopoverEl.offsetWidth || 220;
        const popH = this.selectionPopoverEl.offsetHeight || 76;
        const minLeft = popW / 2 + 10;
        const maxLeft = Math.max(minLeft, window.innerWidth - popW / 2 - 10);
        const clampedLeft = Math.min(Math.max(screenPos.x, minLeft), maxLeft);
        const minTop = popH + 20;
        const maxTop = Math.max(minTop, window.innerHeight);
        const clampedTop = Math.min(Math.max(screenPos.y, minTop), maxTop);
        this.selectionPopoverEl.style.left = `${clampedLeft}px`;
        this.selectionPopoverEl.style.top = `${clampedTop}px`;
        return;
      }
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
    const hadRange = !!this.currentRange;
    if (this.selectionPopoverEl) {
      this.selectionPopoverEl.style.display = 'none';
    }
    this.currentRange = null;
    this.targetCapsule = null;
    this.targetHeaderCard = null;
    this.targetGroup = null;
    if (hadRange && this.onSelectionChange) {
      this.onSelectionChange();
    }
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
      const focus = selection.focusNode;
      const anchorBody = anchor?.nodeType === 3 ? anchor.parentElement?.closest('.note-body') : anchor?.closest?.('.note-body');
      const focusBody = focus?.nodeType === 3 ? focus.parentElement?.closest('.note-body') : focus?.closest?.('.note-body');
      if (!anchorBody || anchorBody !== focusBody) {
        if (!this.targetCapsule && !this.targetHeaderCard && !this.targetGroup) this.hideSelectionPopover();
        return;
      }

      const range = selection.getRangeAt(0);
      const anchorCapsule = anchor?.nodeType === 3 ? anchor.parentElement?.closest('.text-capsule') : anchor?.closest?.('.text-capsule');
      const focusCapsule = focus?.nodeType === 3 ? focus.parentElement?.closest('.text-capsule') : focus?.closest?.('.text-capsule');
      const intersectsExisting = Boolean(
        anchorCapsule ||
        focusCapsule ||
        Array.from(anchorBody.querySelectorAll('.text-capsule')).some(cap => range.intersectsNode(cap))
      );
      if (intersectsExisting) {
        if (!this.targetCapsule && !this.targetHeaderCard && !this.targetGroup) this.hideSelectionPopover();
        return;
      }

      this.targetCapsule = null;
      this.targetHeaderCard = null;
      this.targetGroup = null;
      this.currentRange = range.cloneRange();
      this.renderPopoverPalette();
      this.setSelectedColor(this.selectedColor || store.getPalette()[0] || '#30d158');
      this.updatePopoverPosition();
      if (this.onSelectionChange) this.onSelectionChange();
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

      if (this.groupContextMenuEl && this.groupContextMenuEl.contains(e.target)) return;
      this.hideGroupContextMenu();

      if (this.subcanvasContextMenuEl && this.subcanvasContextMenuEl.contains(e.target)) return;
      this.hideSubcanvasContextMenu();

      if (this.mediaContextMenuEl && this.mediaContextMenuEl.contains(e.target)) return;
      this.hideMediaContextMenu();

      if (this.interactiveWebpageCardId) {
        const activeCardEl = document.getElementById(`card-dom-${this.interactiveWebpageCardId}`);
        if (!activeCardEl || !activeCardEl.contains(e.target)) {
          this.exitWebpageInteractive();
        }
      }

      if (this.capsuleActionBarEl && this.capsuleActionBarEl.contains(e.target)) return;
      if (!e.target.closest('.text-capsule')) {
        this.clearCapsuleSelection();
      }

      if (this.selectionPopoverEl && this.selectionPopoverEl.contains(e.target)) return;
      if (e.target.closest('.text-capsule, .note-header, .group-label, #group-menu-color, #subcanvas-menu-color, #media-menu-color')) return;
      this.hideSelectionPopover();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideGroupContextMenu();
        this.hideCanvasContextMenu();
        this.hideSubcanvasContextMenu();
        this.hideMediaContextMenu();
        this.exitWebpageInteractive();
      }
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
          conn.color = wires.resolvePinColor(conn.toPinId) || '#98989d';
        }
      } else if (headPins.has(conn.toPinId)) {
        // If arriving from an uncolored header/group port, update connection color
        const isFromCapsule = conn.fromPinId.startsWith('pin-') &&
          !conn.fromPinId.startsWith('pin-head-') &&
          !conn.fromPinId.startsWith('pin-group-');
        if (!isFromCapsule) {
          conn.color = wires.resolvePinColor(conn.fromPinId) || newColor || '#98989d';
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
    const bg = newColor ? hexToRgba(newColor, 0.16) : 'rgba(152, 152, 157, 0.14)';

    capsule.style.setProperty('--capsule-pin', color);
    capsule.style.backgroundColor = bg;
    capsule.style.borderColor = 'transparent';

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

  createCapsuleFromSelection(color = '#5ca479') {
    if (!this.currentRange) return;

    const selectedText = this.currentRange.toString().replace(/\s*\n+\s*/g, ' ').trim();
    if (!selectedText) return;

    const pinId = store._nextId ? store._nextId('pin') : `pin-${Date.now()}`;
    const bg = hexToRgba(color, 0.16);

    const capsule = document.createElement('span');
    capsule.className = 'text-capsule';
    capsule.setAttribute('data-pin-id', pinId);
    capsule.setAttribute('contenteditable', 'false');
    capsule.style.setProperty('--capsule-pin', color);
    capsule.style.backgroundColor = bg;
    capsule.style.borderColor = 'transparent';
    const pinEl = document.createElement('i');
    pinEl.className = 'capsule-pin';
    capsule.appendChild(pinEl);
    capsule.appendChild(document.createTextNode(selectedText));

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

  _blurActiveTextEditor() {
    window.__canvases?.blurScope?.();
    const active = document.activeElement;
    if (active && active !== document.body && typeof active.blur === 'function') {
      if (active.isContentEditable || active.closest?.('input, textarea, select, [contenteditable]')) {
        active.blur();
      }
    }
  }

  selectCard(cardId, isShift = false) {
    window.__canvases?.blurScope?.();
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

  updateSelectionVisuals(silent = false) {
    document.querySelectorAll('.note-card').forEach(cardEl => {
      const cardId = cardEl.id.replace('card-dom-', '');
      cardEl.classList.toggle('selected', this.selectedCardIds.has(cardId));
    });
    const focusEntryBtn = document.getElementById('btn-focus-mode');
    if (focusEntryBtn) {
      focusEntryBtn.classList.toggle('is-ready', this.selectedCardIds.size > 0 && !store.isFocusMode);
    }
    if (!silent && this.onSelectionChange) this.onSelectionChange();
  }

  getSelectionState() {
    let textSelection = null;
    if (this.currentRange) {
      const txt = this.currentRange.toString().trim();
      const container = this.currentRange.commonAncestorContainer;
      const bodyEl = container?.nodeType === 3 ? container.parentElement?.closest('.note-body') : container?.closest?.('.note-body');
      const cardEl = bodyEl?.closest('.note-card');
      const cardId = cardEl ? cardEl.id.replace('card-dom-', '') : null;
      if (cardId && txt) {
        textSelection = { cardId, text: txt };
      }
    }
    return {
      cardIds: [...this.selectedCardIds],
      capsulePinId: this.selectedCapsule?.getAttribute('data-pin-id') || null,
      textSelection
    };
  }

  applyRemoteSelection(sel) {
    if (!sel || typeof sel !== 'object') return;
    const validIds = new Set(store.state.cards.map(c => c.id));
    this.selectedCardIds = new Set((sel.cardIds || []).filter(id => validIds.has(id)));
    this.updateSelectionVisuals(true);
    this.updateAlignmentBar();

    this.clearCapsuleSelection({ silent: true });
    if (sel.capsulePinId) {
      const capEl = document.querySelector(`.text-capsule[data-pin-id="${CSS.escape(sel.capsulePinId)}"]`);
      if (capEl) {
        this.selectedCapsule = capEl;
        capEl.classList.add('capsule-selected');
        this.updateCapsuleActionPosition();
      }
    }
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
    window.__library?.updateSelectionState?.();
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

  _nextCloneId(prefix) {
    this._cloneSeq = (this._cloneSeq || 0) + 1;
    return `${prefix}-${Date.now()}-${this._cloneSeq}-${Math.floor(Math.random() * 100000)}`;
  }

  cloneCardsAndGroups(cardsToClone, groupsToClone = [], connectionsToClone = null, options = {}) {
    const subcanvasSnapshots = options?.subcanvases || null;
    const parentCanvasId = options?.parentCanvasId || store.activeCanvasId;
    const parentBreadcrumbs = Array.isArray(options?.parentBreadcrumbs) ? options.parentBreadcrumbs : store.breadcrumbs;
    const clonedAncestors = options?.clonedAncestors || new Set();

    const cardIdMap = new Map();
    const groupIdMap = new Map();
    const pinIdMap = new Map();
    const newCards = [];
    const newGroups = [];

    // 1. Generate new IDs and map header pins for cards
    cardsToClone.forEach(c => {
      const newCardId = this._nextCloneId('card');
      cardIdMap.set(c.id, newCardId);
      pinIdMap.set(`pin-head-left-${c.id}`, `pin-head-left-${newCardId}`);
      pinIdMap.set(`pin-head-right-${c.id}`, `pin-head-right-${newCardId}`);
      pinIdMap.set(`pin-head-${c.id}`, `pin-head-left-${newCardId}`);
    });

    // 2. Generate new IDs and map pins for groups
    groupsToClone.forEach(g => {
      const newGroupId = this._nextCloneId('group');
      groupIdMap.set(g.id, newGroupId);
      pinIdMap.set(`pin-group-left-${g.id}`, `pin-group-left-${newGroupId}`);
      pinIdMap.set(`pin-group-right-${g.id}`, `pin-group-right-${newGroupId}`);
      pinIdMap.set(`pin-group-${g.id}`, `pin-group-left-${newGroupId}`);

      const clonedGroup = JSON.parse(JSON.stringify(g));
      clonedGroup.id = newGroupId;
      clonedGroup.cardIds = (g.cardIds || []).map(oldId => cardIdMap.get(oldId)).filter(Boolean);
      newGroups.push(clonedGroup);
    });

    // 3. Clone cards, recursively clone subcanvases, and remap capsule pins in contentHtml
    cardsToClone.forEach(c => {
      const newCardId = cardIdMap.get(c.id);
      const cloned = JSON.parse(JSON.stringify(c));
      cloned.id = newCardId;

      if (cloned.kind === 'subcanvas') {
        const newSubId = this._nextCloneId('canvas');
        const oldSubId = cloned.subcanvasId;
        const sourceSub = (oldSubId && subcanvasSnapshots?.[oldSubId])
          || (oldSubId ? (store.canvasesCache.get(oldSubId) || store.deletedSubcanvasTrash.get(oldSubId)) : null);
        const childTitle = cloned.title || sourceSub?.title || '未命名子画布';
        const childBreadcrumbs = [...parentBreadcrumbs, { id: newSubId, title: childTitle }];

        let innerCards = [];
        let innerGroups = [];
        let innerConnections = [];
        if (sourceSub && (!oldSubId || !clonedAncestors.has(oldSubId))) {
          const nextAncestors = new Set(clonedAncestors);
          if (oldSubId) nextAncestors.add(oldSubId);
          const innerRes = this.cloneCardsAndGroups(
            sourceSub.cards || [],
            sourceSub.groups || [],
            sourceSub.connections || [],
            {
              subcanvases: subcanvasSnapshots,
              parentCanvasId: newSubId,
              parentBreadcrumbs: childBreadcrumbs,
              clonedAncestors: nextAncestors
            }
          );
          innerCards = innerRes.newCards;
          innerGroups = innerRes.newGroups;
          innerConnections = innerRes.newConnections;
        }

        const childEntry = {
          id: newSubId,
          parentCanvasId,
          title: childTitle,
          breadcrumbs: childBreadcrumbs,
          viewport: sourceSub?.viewport ? JSON.parse(JSON.stringify(sourceSub.viewport)) : { x: 0, y: 0, zoom: 1.0 },
          cards: innerCards,
          connections: innerConnections,
          groups: innerGroups,
          dirty: true,
          updatedAt: Date.now()
        };
        store.putCachedCanvas(childEntry);
        cloned.subcanvasId = newSubId;
        cloned.thumbnail = computeLocalThumbnail(childEntry);
      }

      if (cloned.contentHtml) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = cloned.contentHtml;
        tempDiv.querySelectorAll('.text-capsule').forEach(capsule => {
          const oldPinId = capsule.getAttribute('data-pin-id');
          const newPinId = this._nextCloneId('pin');
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
          id: this._nextCloneId('conn'),
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

    const subIds = cardsToCopy
      .filter(c => c.kind === 'subcanvas' && c.subcanvasId)
      .map(c => c.subcanvasId);

    const syncSubtrees = subIds.length > 0 ? store.collectCachedSubcanvasSubtreeSync(subIds) : {};
    this._clipboardSeq = (this._clipboardSeq || 0) + 1;
    const seq = this._clipboardSeq;
    const marker = `pinpoint-clip:${seq}:${Date.now()}`;

    this.clipboard = {
      cards: JSON.parse(JSON.stringify(cardsToCopy)),
      groups: JSON.parse(JSON.stringify(groupsToCopy)),
      internalConnections,
      subcanvases: syncSubtrees,
      marker,
      markerWritten: false
    };
    this.pasteCount = 0;

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(marker).then(() => {
        if (this.clipboard && this.clipboard.marker === marker) {
          this.clipboard.markerWritten = true;
        }
      }).catch(() => {});
    }

    if (subIds.length > 0) {
      this._clipboardHydratePromise = store.collectSubcanvasSubtree(subIds).then((fullSubtrees) => {
        if (this._clipboardSeq === seq && this.clipboard) {
          this.clipboard.subcanvases = { ...syncSubtrees, ...fullSubtrees };
        }
        return this.clipboard?.subcanvases || syncSubtrees;
      }).finally(() => {
        if (this._clipboardSeq === seq) {
          this._clipboardHydratePromise = null;
        }
      });
    } else {
      this._clipboardHydratePromise = null;
    }

    return true;
  }

  async cutSelectedCards() {
    if (this.selectedCardIds.size === 0) return false;
    const originCanvasId = store.activeCanvasId;
    const cutIds = [...this.selectedCardIds];
    const ok = this.copySelectedCards();
    if (!ok) return false;

    const hasUncachedSub = (this.clipboard?.cards || []).some(c => {
      if (c.kind !== 'subcanvas' || !c.subcanvasId) return false;
      const seen = new Set();
      const q = [c.subcanvasId];
      while (q.length > 0) {
        const sid = q.shift();
        if (!sid || seen.has(sid)) continue;
        seen.add(sid);
        const snap = this.clipboard.subcanvases?.[sid];
        if (!snap) return true;
        for (const sc of snap.cards || []) {
          if (sc.kind === 'subcanvas' && sc.subcanvasId) q.push(sc.subcanvasId);
        }
      }
      return false;
    });

    if (hasUncachedSub && this._clipboardHydratePromise) {
      await this._clipboardHydratePromise;
    }

    if (store.activeCanvasId === originCanvasId) {
      this.selectedCardIds = new Set(cutIds);
      this.deleteSelectedCards();
    } else {
      const originEntry = store.canvasesCache.get(originCanvasId);
      if (originEntry) {
        const cutSet = new Set(cutIds);
        const cutSubIds = (originEntry.cards || [])
          .filter(c => cutSet.has(c.id) && c.kind === 'subcanvas' && c.subcanvasId)
          .map(c => c.subcanvasId);
        originEntry.cards = (originEntry.cards || []).filter(c => !cutSet.has(c.id));
        originEntry.dirty = true;
        store.putCachedCanvas(originEntry);
        cutSubIds.forEach(sid => store._markSubcanvasSubtreeDeleted(sid));
        store.notifyCanvasTreeUpdated();
      }
    }
    return true;
  }

  async pasteCards() {
    if (!this.clipboard || !this.clipboard.cards || this.clipboard.cards.length === 0) return false;
    if (this._clipboardHydratePromise) {
      try {
        await this._clipboardHydratePromise;
      } catch (e) {}
    }

    this.pasteCount++;
    const offset = 32 * this.pasteCount;

    const { newCards, newGroups, newConnections } = this.cloneCardsAndGroups(
      this.clipboard.cards,
      this.clipboard.groups || [],
      this.clipboard.internalConnections || [],
      { subcanvases: this.clipboard.subcanvases || null }
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
      newGroups.forEach(g => {
        if (typeof g.x === 'number' && typeof g.y === 'number') {
          g.x = Math.round(g.x + offset);
          g.y = Math.round(g.y + offset);
          if (store.state.settings?.gridSnapMode) {
            const GRID_SIZE = 24;
            g.x = Math.round(g.x / GRID_SIZE) * GRID_SIZE;
            g.y = Math.round(g.y / GRID_SIZE) * GRID_SIZE;
          }
        }
        store.state.groups.push(g);
      });
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
    if (newCards.some(c => c.kind === 'subcanvas')) {
      store.notifyCanvasTreeUpdated();
    }
    if (this.onSelectionChange) this.onSelectionChange();
    return true;
  }

  calcFitGroupBounds(group) {
    if (!group || !Array.isArray(group.cardIds) || group.cardIds.length === 0) return null;
    const memberCards = store.state.cards.filter(c => group.cardIds.includes(c.id));
    if (memberCards.length === 0) return null;

    const GRID_SIZE = 24;
    const PADDING_X = 24;
    const PADDING_TOP = 62;
    const PADDING_BOTTOM = 24;
    const MIN_WIDTH = 288;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    memberCards.forEach(c => {
      const el = document.getElementById(`card-dom-${c.id}`);
      const w = el?.offsetWidth || c.width || 310;
      const h = el?.offsetHeight || c.height || 140;
      const cx = (el && el.style.left) ? parseFloat(el.style.left) : c.x;
      const cy = (el && el.style.top) ? parseFloat(el.style.top) : c.y;
      if (cx < minX) minX = cx;
      if (cx + w > maxX) maxX = cx + w;
      if (cy < minY) minY = cy;
      if (cy + h > maxY) maxY = cy + h;
    });

    if (store.state.settings?.gridSnapMode) {
      const x = Math.floor((minX - PADDING_X) / GRID_SIZE) * GRID_SIZE;
      const y = Math.floor((minY - PADDING_TOP) / GRID_SIZE) * GRID_SIZE;
      const right = Math.ceil((maxX + 16) / GRID_SIZE) * GRID_SIZE;
      const bottom = Math.ceil((maxY + 16) / GRID_SIZE) * GRID_SIZE;
      const width = Math.max(MIN_WIDTH, right - x);
      const height = Math.max(GRID_SIZE * 2, bottom - y);
      return { x, y, width, height };
    }

    const x = minX - PADDING_X;
    const y = minY - PADDING_TOP;
    const width = Math.max(MIN_WIDTH, (maxX - minX) + PADDING_X * 2);
    const height = (maxY - minY) + PADDING_TOP + PADDING_BOTTOM;

    return { x, y, width, height };
  }

  calcGroupBounds(group) {
    if (!group) return null;
    if (
      typeof group.x === 'number' && !isNaN(group.x) &&
      typeof group.y === 'number' && !isNaN(group.y) &&
      typeof group.width === 'number' && !isNaN(group.width) &&
      typeof group.height === 'number' && !isNaN(group.height)
    ) {
      return {
        x: group.x,
        y: group.y,
        width: Math.max(220, group.width),
        height: Math.max(100, group.height)
      };
    }
    const fitted = this.calcFitGroupBounds(group);
    if (fitted) {
      group.x = Math.round(fitted.x);
      group.y = Math.round(fitted.y);
      group.width = Math.round(fitted.width);
      group.height = Math.round(fitted.height);
    }
    return fitted;
  }

  fitGroupToMembers(groupId) {
    const group = store.state.groups?.find(g => g.id === groupId);
    if (!group) return false;
    const fitted = this.calcFitGroupBounds(group);
    if (!fitted) {
      store.emitToast('组内暂无节点，无法自动适配大小', 'info');
      return false;
    }
    group.x = Math.round(fitted.x);
    group.y = Math.round(fitted.y);
    group.width = Math.round(fitted.width);
    group.height = Math.round(fitted.height);
    this.updateGroupDOMBounds(group.id);
    store.commit();
    wires.render();
    store.scheduleAutoSave();
    return true;
  }

  syncGroupMembershipByBounds(group) {
    if (!group) return false;
    const bounds = this.calcGroupBounds(group);
    if (!bounds) return false;
    const prevIds = Array.isArray(group.cardIds) ? group.cardIds : [];
    const prevSet = new Set(prevIds);
    const nextIds = [];

    for (const card of store.state.cards) {
      const cardEl = document.getElementById(`card-dom-${card.id}`);
      const cw = cardEl?.offsetWidth || card.width || 310;
      const ch = cardEl?.offsetHeight || card.height || 140;
      const cx = card.x + cw / 2;
      const cy = card.y + ch / 2;
      const isInside = cx >= bounds.x && cx <= bounds.x + bounds.width &&
                       cy >= bounds.y && cy <= bounds.y + bounds.height;
      if (isInside) {
        nextIds.push(card.id);
      }
    }

    const changed = nextIds.length !== prevIds.length || nextIds.some(id => !prevSet.has(id));
    if (changed) {
      group.cardIds = nextIds;
    }
    return changed;
  }

  findGroupAtBoardPos(boardPos, preferMemberCardId = null) {
    if (!boardPos) return null;
    const groups = store.state.groups || [];
    if (preferMemberCardId) {
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        if (!Array.isArray(g.cardIds) || !g.cardIds.includes(preferMemberCardId)) continue;
        const b = this.calcGroupBounds(g);
        if (!b) continue;
        if (boardPos.x >= b.x && boardPos.x <= b.x + b.width && boardPos.y >= b.y && boardPos.y <= b.y + b.height) {
          return g;
        }
      }
    }
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      const b = this.calcGroupBounds(g);
      if (!b) continue;
      if (
        boardPos.x >= b.x &&
        boardPos.x <= b.x + b.width &&
        boardPos.y >= b.y &&
        boardPos.y <= b.y + b.height
      ) {
        return g;
      }
    }
    return null;
  }

  startGroupDrag(group, e, { viaCtrlBody = false } = {}) {
    if (!group) return;
    const groupEl = document.getElementById(`group-dom-${group.id}`);
    this._blurActiveTextEditor();
    wires.clearFocus();
    wires.dismissDropMenu(true);
    this.clearCapsuleSelection();
    window.getSelection()?.removeAllRanges();
    this.hideSelectionPopover();
    this.hideCanvasContextMenu();
    this.hideGroupContextMenu();

    const isMultiToggle = !viaCtrlBody && (e.shiftKey || e.ctrlKey || e.metaKey);
    const memberCards = store.state.cards.filter(c => group.cardIds.includes(c.id));
    const memberIds = memberCards.map(c => c.id);
    let toggleOffGroupIds = null;

    if (isMultiToggle) {
      const allSelected = memberIds.length > 0 && memberIds.every(id => this.selectedCardIds.has(id));
      if (allSelected) {
        toggleOffGroupIds = memberIds;
      } else {
        memberIds.forEach(id => this.selectedCardIds.add(id));
        this.updateSelectionVisuals();
        this.updateAlignmentBar();
      }
    } else {
      this.selectedCardIds = new Set(memberIds);
      this.updateSelectionVisuals();
      this.updateAlignmentBar();
    }

    const curBounds = this.calcGroupBounds(group) || { x: 0, y: 0, width: 288, height: 140 };
    const initMinX = memberCards.length > 0 ? Math.min(...memberCards.map(c => c.x)) : curBounds.x;
    const initMinY = memberCards.length > 0 ? Math.min(...memberCards.map(c => c.y)) : curBounds.y;
    this.activeDrag = {
      type: 'MOVE_GROUP',
      groupId: group.id,
      startX: e.clientX,
      startY: e.clientY,
      isAlt: e.altKey,
      viaCtrlBody,
      toggleOffGroupIds,
      cloned: false,
      initMinX,
      initMinY,
      initGroupX: curBounds.x,
      initGroupY: curBounds.y,
      initialPositions: new Map(memberCards.map(c => [c.id, { x: c.x, y: c.y }]))
    };
    groupEl?.classList.add('active');
    if (this.viewportEl && !canvas.isSpacePressed) {
      this.viewportEl.style.cursor = 'grabbing';
    }
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
        groupEl.style.setProperty('--group-theme', group.headerColor);
        groupEl.style.setProperty('--group-border', hexToRgba(group.headerColor, 0.34));
        groupEl.style.setProperty('--group-border-hover', hexToRgba(group.headerColor, 0.56));
        groupEl.style.setProperty('--group-bg', hexToRgba(group.headerColor, 0.04));
        groupEl.style.setProperty('--group-bg-hover', hexToRgba(group.headerColor, 0.065));
        groupEl.style.setProperty('--group-glow', hexToRgba(group.headerColor, 0.24));
        groupEl.style.setProperty('--group-drop-bg', hexToRgba(group.headerColor, 0.085));
        groupEl.style.setProperty('--group-drop-glow', hexToRgba(group.headerColor, 0.28));
        groupEl.style.setProperty('--group-label-bg', hexToRgba(group.headerColor, 0.14));
        groupEl.style.setProperty('--group-label-bg-hover', hexToRgba(group.headerColor, 0.2));
      }

      const displayTitle = group.title || '未命名组';

      const groupLeftDisplayColor = group.headerColor || leftConn?.color || 'var(--text-muted)';
      const groupRightDisplayColor = group.headerColor || rightConn?.color || '#98989d';

      groupEl.innerHTML = `
        <div class="group-label">
          <div class="header-port-slot group-port-slot group-port-slot-left" title="组连接端口 (左)">
            <i class="header-pin header-pin-left group-label-dot ${leftConnected ? 'pin-connected' : ''}"
               data-header-pin-id="${leftPinId}"
               style="background-color: ${groupLeftDisplayColor}; color: ${groupLeftDisplayColor};"></i>
          </div>
          <span class="group-title"></span>
          <input class="group-title-input" placeholder="未命名组" style="display: none;" />
        </div>
        <div class="header-port-slot group-port-slot group-port-slot-right" title="组连接端口 (右)">
          <i class="header-pin header-pin-right ${rightConnected ? 'pin-connected' : ''}"
             data-header-pin-id="${rightPinId}"
             style="background-color: ${groupRightDisplayColor}; color: ${groupRightDisplayColor};"></i>
        </div>
        <div class="group-resize-handle group-resize-handle-n" data-dir="n"></div>
        <div class="group-resize-handle group-resize-handle-s" data-dir="s"></div>
        <div class="group-resize-handle group-resize-handle-w" data-dir="w"></div>
        <div class="group-resize-handle group-resize-handle-e" data-dir="e"></div>
        <div class="group-resize-handle group-resize-handle-nw" data-dir="nw"></div>
        <div class="group-resize-handle group-resize-handle-ne" data-dir="ne"></div>
        <div class="group-resize-handle group-resize-handle-sw" data-dir="sw"></div>
        <div class="group-resize-handle group-resize-handle-se" data-dir="se"></div>
      `;

      // Title editing
      const labelEl = groupEl.querySelector('.group-label');
      const titleSpan = groupEl.querySelector('.group-title');
      const titleInput = groupEl.querySelector('.group-title-input');
      labelEl.title = `${displayTitle} · 拖拽移动组（或按住 Ctrl 拖拽组内）· 双击重命名 · 右键菜单`;
      titleSpan.textContent = displayTitle;
      titleInput.value = group.title || '';

      let prevTitle = group.title || '';
      const startRename = () => {
        prevTitle = group.title || '';
        const lockedWidth = labelEl.offsetWidth;
        if (lockedWidth > 0) {
          labelEl.style.width = `${lockedWidth}px`;
        }
        groupEl.classList.add('is-renaming');
        titleSpan.style.display = 'none';
        titleInput.style.display = 'block';
        titleInput.value = group.title || '';
        titleInput.focus();
        titleInput.select();
      };
      groupEl.__startRename = startRename;
      const finishRename = () => {
        if (titleInput.style.display === 'none') return;
        const newTitle = titleInput.value.trim() || '未命名组';
        const changed = newTitle !== prevTitle;
        group.title = newTitle;
        prevTitle = newTitle;
        titleSpan.textContent = newTitle;
        labelEl.title = `${newTitle} · 拖拽移动组（或按住 Ctrl 拖拽组内）· 双击重命名 · 右键菜单`;
        titleInput.style.display = 'none';
        titleSpan.style.display = '';
        groupEl.classList.remove('is-renaming');
        this.syncGroupLabelWidth(groupEl);
        if (changed) store.commit();
        store.scheduleAutoSave();
      };
      labelEl.addEventListener('dblclick', (e) => {
        if (e.target === titleInput || e.target.closest('.header-pin, .header-port-slot')) return;
        e.stopPropagation();
        startRename();
      });
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finishRename();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          titleInput.value = prevTitle;
          finishRename();
        }
      });
      titleInput.addEventListener('blur', finishRename);
      titleInput.addEventListener('mousedown', (e) => e.stopPropagation());

      // Right-click group label or resize border to open group context menu
      const handleContextMenu = (e) => {
        if (e.target.closest('.header-pin, .header-port-slot')) return;
        e.preventDefault();
        e.stopPropagation();
        this.showGroupContextMenu(group, labelEl, startRename, e.clientX, e.clientY);
      };
      labelEl.addEventListener('contextmenu', handleContextMenu);

      // Resize handles on group edges and corners
      groupEl.querySelectorAll('.group-resize-handle').forEach(handle => {
        handle.addEventListener('contextmenu', handleContextMenu);
        handle.addEventListener('mousedown', (e) => {
          if (e.button !== 0 || canvas.isSpacePressed) return;
          e.preventDefault();
          e.stopPropagation();
          this._blurActiveTextEditor();
          wires.clearFocus();
          wires.dismissDropMenu(true);
          this.hideAllMenus();

          const curBounds = this.calcGroupBounds(group);
          if (!curBounds) return;
          handle.classList.add('active');
          groupEl.classList.add('active');
          this.activeDrag = {
            type: 'RESIZE_GROUP',
            groupId: group.id,
            dir: handle.dataset.dir,
            startX: e.clientX,
            startY: e.clientY,
            initX: curBounds.x,
            initY: curBounds.y,
            initWidth: curBounds.width,
            initHeight: curBounds.height
          };
        });
      });

      // Drag group by top-left header label
      labelEl.addEventListener('mousedown', (e) => {
        if (e.target.closest('.header-pin, .header-port-slot') || e.target === titleInput) return;
        if (e.button !== 0 || canvas.isSpacePressed) return;
        e.preventDefault();
        e.stopPropagation();
        this.startGroupDrag(group, e, { viaCtrlBody: false });
      });

      // Group pins
      const pinLeft = groupEl.querySelector('.header-pin-left');
      const pinRight = groupEl.querySelector('.header-pin-right');
      this.bindPinEvents(pinLeft, leftPinId);
      this.bindPinEvents(pinRight, rightPinId);

      this.groupsContainerEl.appendChild(groupEl);
      this.syncGroupLabelWidth(groupEl, bounds.width);
    });
  }

  syncGroupLabelWidth(groupEl) {
    if (!groupEl) return;
    const labelEl = groupEl.querySelector('.group-label');
    if (labelEl) {
      labelEl.style.width = '';
    }
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
      this.syncGroupLabelWidth(groupEl, bounds.width);
    }
  }

  createGroupFromSelected() {
    if (this.selectedCardIds.size < 2) return null;
    const existingGroupCount = store.state.groups?.length || 0;
    const group = {
      id: `group-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      title: existingGroupCount === 0 ? '未命名组' : `组 ${existingGroupCount + 1}`,
      cardIds: [...this.selectedCardIds],
      headerColor: null
    };
    const initBounds = this.calcFitGroupBounds(group);
    if (initBounds) {
      group.x = Math.round(initBounds.x);
      group.y = Math.round(initBounds.y);
      group.width = Math.round(initBounds.width);
      group.height = Math.round(initBounds.height);
    }
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

  openPopoverForGroup(group, headerEl, anchorScreen = null) {
    this.clearCapsuleSelection();
    window.getSelection()?.removeAllRanges();
    this.currentRange = null;
    this.targetCapsule = null;
    this.targetHeaderCard = null;
    const boardPos = anchorScreen ? canvas.screenToBoard(anchorScreen.x, anchorScreen.y) : null;
    this.targetGroup = { group, headerEl, boardPos };

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
        if (newColor) {
          conn.color = newColor;
        } else {
          conn.color = wires.resolvePinColor(conn.toPinId) || '#98989d';
        }
      } else if (groupPins.has(conn.toPinId)) {
        const isFromCapsule = conn.fromPinId.startsWith('pin-') &&
          !conn.fromPinId.startsWith('pin-head-') &&
          !conn.fromPinId.startsWith('pin-group-');
        if (!isFromCapsule) {
          conn.color = wires.resolvePinColor(conn.fromPinId) || newColor || '#98989d';
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

    const btnPackSubcanvas = this.alignmentBarEl.querySelector('#btn-pack-subcanvas');
    btnPackSubcanvas?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.packSelectionToSubcanvas();
    });

    const btnSaveToLibrary = this.alignmentBarEl.querySelector('#btn-save-to-library');
    btnSaveToLibrary?.addEventListener('click', (e) => {
      e.stopPropagation();
      window.__library?.openSaveForm?.();
    });

    const btnAlignFocus = this.alignmentBarEl.querySelector('#btn-align-focus');
    btnAlignFocus?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.enterFocusMode();
    });

    const btnDeleteSelected = this.alignmentBarEl.querySelector('#btn-delete-selected');
    btnDeleteSelected?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteSelectedCards();
    });
  }

  flushActiveDOMEdits({ exitInputs = true } = {}) {
    store.state.cards.forEach(card => {
      const cardEl = document.getElementById(`card-dom-${card.id}`);
      if (!cardEl) return;
      const titleInput = cardEl.querySelector('.header-title-input');
      const titleSpan = cardEl.querySelector('.header-title');
      if (titleInput && titleInput.style.display !== 'none') {
        const newTitle = titleInput.value.trim() || (card.kind === 'subcanvas' ? '未命名子画布' : '未命名节点');
        card.title = newTitle;
        if (titleSpan) {
          titleSpan.textContent = newTitle;
        }
        if (exitInputs) {
          if (titleSpan) titleSpan.style.display = '';
          titleInput.style.display = 'none';
        }
      }
      if (card.kind !== 'subcanvas') {
        const bodyEl = cardEl.querySelector('.note-body');
        if (bodyEl) {
          card.contentHtml = bodyEl.innerHTML;
        }
      }
    });

    (store.state.groups || []).forEach(group => {
      const groupEl = document.getElementById(`group-dom-${group.id}`);
      if (!groupEl) return;
      const titleInput = groupEl.querySelector('.group-title-input');
      const titleSpan = groupEl.querySelector('.group-title');
      if (titleInput && titleInput.style.display !== 'none') {
        const newTitle = titleInput.value.trim() || '未命名组';
        group.title = newTitle;
        if (titleSpan) {
          titleSpan.textContent = newTitle;
        }
        if (exitInputs) {
          if (titleSpan) titleSpan.style.display = '';
          titleInput.style.display = 'none';
          groupEl.classList.remove('is-renaming');
          this.syncGroupLabelWidth(groupEl);
        }
      }
    });
  }

  measureCardRects() {
    const rectMap = new Map();
    store.state.cards.forEach(card => {
      const el = document.getElementById(`card-dom-${card.id}`);
      const w = el?.offsetWidth || card.width || 310;
      const h = el?.offsetHeight || 140;
      rectMap.set(card.id, {
        left: card.x,
        top: card.y,
        right: card.x + w,
        bottom: card.y + h,
        width: w,
        height: h,
        cx: card.x + w / 2,
        cy: card.y + h / 2
      });
    });
    return rectMap;
  }

  updateFocusModeUI() {
    const isFocus = store.isFocusMode;
    document.body.classList.toggle('is-focus-session', isFocus);

    const statusDot = document.querySelector('.hud-title-dot');
    if (statusDot) {
      if (isFocus) {
        if (!statusDot.dataset.normalTitle && statusDot.title) {
          statusDot.dataset.normalTitle = statusDot.title;
        }
        statusDot.title = '专注模式进行中';
      } else if (statusDot.dataset.normalTitle) {
        statusDot.title = statusDot.dataset.normalTitle;
      }
    }

    const focusEntryBtn = document.getElementById('btn-focus-mode');
    if (focusEntryBtn) {
      focusEntryBtn.classList.toggle('is-ready', !isFocus && this.selectedCardIds.size > 0);
    }

    const saveBtn = document.getElementById('btn-save');
    if (saveBtn) {
      saveBtn.setAttribute(
        'data-tooltip',
        isFocus ? '专注模式下不可保存，请先退出' : '保存到后端 (Ctrl+S)'
      );
    }

    window.__sync?.updateStatusDot?.();
  }

  enterFocusMode(cardIdsOverride = null) {
    if (store.isFocusMode) return false;
    if (this.focusExitAnimId) {
      cancelAnimationFrame(this.focusExitAnimId);
      this.focusExitAnimId = null;
      document.body.classList.remove('focus-animating');
    }

    this.flushActiveDOMEdits();
    this.hideAllMenus();
    wires.clearFocus();

    const targetIds = cardIdsOverride
      ? [...new Set(cardIdsOverride)].filter(id => store.state.cards.some(c => c.id === id))
      : [...this.selectedCardIds].filter(id => store.state.cards.some(c => c.id === id));

    if (targetIds.length === 0) {
      store.emitToast('请先选中至少一个节点或组，再进入专注模式', 'info');
      return false;
    }

    const rectMap = this.measureCardRects();
    const beforeRects = targetIds.map(id => rectMap.get(id)).filter(Boolean);
    const beforeBox = computeRectsBoundingBox(beforeRects);

    const ok = store.enterFocusMode(targetIds, beforeBox, rectMap);
    if (!ok) return false;

    this.filterSelectionAfterRestore();
    this.render();
    wires.render();
    this.updateSelectionVisuals(true);
    this.updateAlignmentBar();
    this.updateFocusModeUI();
    if (this.onSelectionChange) this.onSelectionChange();
    return true;
  }

  confirmFocusMode() {
    if (!store.isFocusMode) return false;
    this.flushActiveDOMEdits();
    this.hideAllMenus();
    wires.clearFocus();

    const rectMap = this.measureCardRects();
    const focusCardRects = store.state.cards.map(c => rectMap.get(c.id)).filter(Boolean);
    const afterBox = computeRectsBoundingBox(focusCardRects);

    const result = store.confirmFocusMode(afterBox, focusCardRects);
    if (!result) return false;

    this.updateFocusModeUI();
    this.animateFocusExit(result);
    return true;
  }

  cancelFocusMode() {
    if (!store.isFocusMode) return false;
    this.flushActiveDOMEdits();
    this.hideAllMenus();
    wires.clearFocus();

    const ok = store.cancelFocusMode();
    if (!ok) return false;

    this.filterSelectionAfterRestore();
    this.render();
    wires.render();
    this.updateSelectionVisuals(true);
    this.updateAlignmentBar();
    this.updateFocusModeUI();
    if (this.onSelectionChange) this.onSelectionChange();
    store.emitToast('已退出专注模式，临时修改已放弃', 'info');
    return true;
  }

  animateFocusExit({ cardTargets, groupTargets, outsideCardIds, outsideGroupIds, externalConnIds }) {
    if (this.focusExitAnimId) {
      cancelAnimationFrame(this.focusExitAnimId);
      this.focusExitAnimId = null;
    }

    this.filterSelectionAfterRestore();
    this.render();
    this.updateSelectionVisuals(true);
    this.updateAlignmentBar();

    const hasMovedOutsideCards = Boolean(outsideCardIds && outsideCardIds.length > 0);
    const hasMovedGroups = Boolean(groupTargets && groupTargets.size > 0);
    if (!hasMovedOutsideCards && !hasMovedGroups) {
      wires.render();
      window.__minimap?.requestRender?.();
      return;
    }

    const outsideIdSet = new Set(outsideCardIds || []);
    const outsideGroupIdSet = new Set(outsideGroupIds || []);
    const affectedGroupIds = [];
    const whollyOutsideGroupIds = [];

    (store.state.groups || []).forEach(g => {
      const hasOutside = g.cardIds.some(id => outsideIdSet.has(id)) || groupTargets?.has(g.id) || outsideGroupIdSet.has(g.id);
      if (hasOutside) {
        affectedGroupIds.push(g.id);
        if (outsideGroupIdSet.has(g.id) || (g.cardIds.length > 0 && g.cardIds.every(id => outsideIdSet.has(id)))) {
          whollyOutsideGroupIds.push(g.id);
        }
      }
    });

    document.body.classList.add('focus-animating');

    const applyFrame = (eased, fade) => {
      (outsideCardIds || []).forEach(id => {
        const target = cardTargets.get(id);
        const el = document.getElementById(`card-dom-${id}`);
        if (!target || !el) return;
        const curX = target.origX + target.dx * eased;
        const curY = target.origY + target.dy * eased;
        el.style.left = `${curX}px`;
        el.style.top = `${curY}px`;
        el.style.opacity = `${fade}`;
      });

      affectedGroupIds.forEach(gid => {
        const gt = groupTargets?.get(gid);
        const gEl = document.getElementById(`group-dom-${gid}`);
        if (gt && gEl) {
          const curX = gt.origX + (gt.x - gt.origX) * eased;
          const curY = gt.origY + (gt.y - gt.origY) * eased;
          const curW = (gt.origWidth ?? gt.width) + (gt.width - (gt.origWidth ?? gt.width)) * eased;
          const curH = (gt.origHeight ?? gt.height) + (gt.height - (gt.origHeight ?? gt.height)) * eased;
          gEl.style.left = `${curX}px`;
          gEl.style.top = `${curY}px`;
          gEl.style.width = `${curW}px`;
          gEl.style.height = `${curH}px`;
        } else {
          this.updateGroupDOMBounds(gid);
        }
      });
      whollyOutsideGroupIds.forEach(gid => {
        const gEl = document.getElementById(`group-dom-${gid}`);
        if (gEl) gEl.style.opacity = `${fade}`;
      });

      wires.render();
      (externalConnIds || []).forEach(connId => {
        const wEl = document.getElementById(`wire-group-${connId}`);
        if (wEl) wEl.style.opacity = `${fade}`;
      });
    };

    // Frame 0: outside cards appear at pre-focus positions at opacity 0
    applyFrame(0, 0);

    const DURATION = 460;
    const startTime = performance.now();

    const step = (now) => {
      const p = Math.min(1, (now - startTime) / DURATION);
      const eased = 1 - Math.pow(1 - p, 3);
      const fade = Math.min(1, p / 0.65);

      applyFrame(eased, fade);

      if (p < 1) {
        this.focusExitAnimId = requestAnimationFrame(step);
      } else {
        this.focusExitAnimId = null;
        document.body.classList.remove('focus-animating');

        outsideCardIds.forEach(id => {
          const card = store.state.cards.find(c => c.id === id);
          const el = document.getElementById(`card-dom-${id}`);
          if (card && el) {
            el.style.left = `${card.x}px`;
            el.style.top = `${card.y}px`;
            el.style.opacity = '';
          }
        });

        whollyOutsideGroupIds.forEach(gid => {
          const gEl = document.getElementById(`group-dom-${gid}`);
          if (gEl) gEl.style.opacity = '';
        });

        this.renderGroups();
        wires.render();
        window.__minimap?.requestRender?.();
      }
    };

    this.focusExitAnimId = requestAnimationFrame(step);
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

      this._blurActiveTextEditor();
      this.clearCapsuleSelection();
      wires.dismissDropMenu(true);

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
        const boardPos = canvas.screenToBoard(e.clientX, e.clientY);
        const hitGroup = this.findGroupAtBoardPos(boardPos);
        if (hitGroup) {
          e.preventDefault();
          e.stopPropagation();
          this.startGroupDrag(hitGroup, e, { viaCtrlBody: true });
          return;
        }
      }

      this.activeMarquee = {
        startX: e.clientX,
        startY: e.clientY,
        isAdditive: e.shiftKey || e.ctrlKey || e.metaKey,
        initialSelection: new Set(this.selectedCardIds),
        moved: false
      };
    });
  }

  _updateCtrlGroupCursor(ctrlActive) {
    if (!this.viewportEl || canvas.isSpacePressed || canvas.dragAction || this.activeMarquee || wires.activeDrag) return;
    if (this.activeDrag?.type === 'MOVE_GROUP') {
      this.viewportEl.style.cursor = 'grabbing';
      return;
    }
    if (this.activeDrag) return;
    if (!ctrlActive || !this._lastPointer) {
      if (this.viewportEl.style.cursor === 'grab' || this.viewportEl.style.cursor === 'grabbing') {
        this.viewportEl.style.cursor = '';
      }
      return;
    }
    const { clientX, clientY, target } = this._lastPointer;
    const isBgOrCardBody = (
      target === this.viewportEl ||
      target === document.getElementById('board') ||
      target?.id === 'wire-svg' ||
      (target?.closest?.('.note-card') && !target.closest?.('.note-header, .header-pin, .header-port-slot, .card-resize-handle, .capsule-pin, .text-capsule, .header-title-input'))
    );
    if (isBgOrCardBody && this.findGroupAtBoardPos(canvas.screenToBoard(clientX, clientY))) {
      this.viewportEl.style.cursor = 'grab';
    } else if (this.viewportEl.style.cursor === 'grab') {
      this.viewportEl.style.cursor = '';
    }
  }

  bindGlobalGestures() {
    window.addEventListener('mousemove', (e) => {
      this._lastPointer = { clientX: e.clientX, clientY: e.clientY, target: e.target };

      if (this.pendingCtrlGroupDrag) {
        const dist = Math.hypot(e.clientX - this.pendingCtrlGroupDrag.startX, e.clientY - this.pendingCtrlGroupDrag.startY);
        if (dist > 4) {
          const pending = this.pendingCtrlGroupDrag;
          this.pendingCtrlGroupDrag = null;
          // Restore the card's pre-toggle selection state before selecting the whole group
          if (pending.wasSelected) this.selectedCardIds.add(pending.cardId);
          else this.selectedCardIds.delete(pending.cardId);
          this.startGroupDrag(pending.group, {
            ...e,
            clientX: pending.startX,
            clientY: pending.startY,
            shiftKey: false,
            ctrlKey: true,
            metaKey: false,
            altKey: e.altKey
          }, { viaCtrlBody: true });
        }
      }

      this._updateCtrlGroupCursor((e.ctrlKey || e.metaKey) && !e.shiftKey);
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

          if (this.activeMarquee.isAdditive) {
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
          // Check if leadCard is hovering over a group container to join
          let hoveredGroupId = null;
          if (store.state.groups && store.state.groups.length > 0) {
            const leadCard = store.state.cards.find(c => c.id === this.activeDrag.leadCardId);
            if (leadCard) {
              const leadEl = document.getElementById(`card-dom-${leadCard.id}`);
              const leadW = leadEl?.offsetWidth || leadCard.width || 310;
              const leadH = leadEl?.offsetHeight || leadCard.height || 140;
              const cardCenterX = leadCard.x + leadW / 2;
              const cardCenterY = leadCard.y + leadH / 2;
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
                const newGroupObj = store.state.groups.find(g => g.id === newGroupId);
                const newMemberCards = store.state.cards.filter(c => newCards.some(nc => nc.id === c.id));
                this.activeDrag.cloned = true;
                this.activeDrag.groupId = newGroupId;
                this.activeDrag.initMinX = newMemberCards.length > 0 ? Math.min(...newMemberCards.map(c => c.x)) : (newGroupObj?.x ?? 0);
                this.activeDrag.initMinY = newMemberCards.length > 0 ? Math.min(...newMemberCards.map(c => c.y)) : (newGroupObj?.y ?? 0);
                this.activeDrag.initGroupX = newGroupObj?.x ?? this.activeDrag.initGroupX;
                this.activeDrag.initGroupY = newGroupObj?.y ?? this.activeDrag.initGroupY;
                this.activeDrag.initialPositions = new Map(newMemberCards.map(c => [c.id, { x: c.x, y: c.y }]));
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
          const leadCard = leadCardId ? store.state.cards.find(c => c.id === leadCardId) : null;
          const leadInitPos = leadCardId ? this.activeDrag.initialPositions.get(leadCardId) : null;

          if (leadCard && leadInitPos) {
            let candX = leadInitPos.x + dx;
            let candY = leadInitPos.y + dy;

            const alignMode = !!store.state.settings?.alignMode;
            const gridSnapMode = !!store.state.settings?.gridSnapMode;
            const shouldAlign = this.activeDrag.viaCtrlBody
              ? alignMode
              : (alignMode ? !e.ctrlKey : e.ctrlKey);

            if (gridSnapMode) {
              const GRID_SIZE = 24;
              const targetMinX = Math.round((this.activeDrag.initMinX + dx) / GRID_SIZE) * GRID_SIZE;
              const targetMinY = Math.round((this.activeDrag.initMinY + dy) / GRID_SIZE) * GRID_SIZE;
              candX = leadInitPos.x + (targetMinX - this.activeDrag.initMinX);
              candY = leadInitPos.y + (targetMinY - this.activeDrag.initMinY);
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
          } else if (store.state.settings?.gridSnapMode) {
            const GRID_SIZE = 24;
            dx = Math.round((this.activeDrag.initGroupX + dx) / GRID_SIZE) * GRID_SIZE - this.activeDrag.initGroupX;
            dy = Math.round((this.activeDrag.initGroupY + dy) / GRID_SIZE) * GRID_SIZE - this.activeDrag.initGroupY;
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

          if (group) {
            group.x = Math.round(this.activeDrag.initGroupX + dx);
            group.y = Math.round(this.activeDrag.initGroupY + dy);
          }
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
              if (this.activeDrag.lockRatio) {
                const newH = Math.max(140, Math.round(CARD_HEADER_HEIGHT + newWidth / this.activeDrag.lockRatio));
                card.height = newH;
                if (cardEl) cardEl.style.height = `${newH}px`;
              }
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
              if (this.activeDrag.lockRatio) {
                const newH = Math.max(140, Math.round(CARD_HEADER_HEIGHT + newWidth / this.activeDrag.lockRatio));
                card.height = newH;
                if (cardEl) cardEl.style.height = `${newH}px`;
              }
              if (cardEl) {
                cardEl.style.width = `${newWidth}px`;
              }
            }
            if (card.kind === 'subcanvas') {
              const thumbCanvas = cardEl?.querySelector('.subcanvas-thumbnail-canvas');
              if (thumbCanvas) renderThumbnailCanvas(thumbCanvas, store.getThumbnailForSubcanvas(card), store.getPalette());
            }
            wires.render();
          }
        } else if (this.activeDrag.type === 'RESIZE_MEDIA_CORNER') {
          const dx = (e.clientX - this.activeDrag.startX) / zoom;
          const dy = (e.clientY - this.activeDrag.startY) / zoom;
          const card = store.state.cards.find(c => c.id === this.activeDrag.cardId);
          if (card) {
            const cardEl = document.getElementById(`card-dom-${card.id}`);
            const MIN_WIDTH = 250;
            const corner = this.activeDrag.corner || 'se';
            const ratio = this.activeDrag.lockRatio || 1.5;
            const isLeft = corner.includes('w');
            const isTop = corner.includes('n');
            const candWFromX = isLeft ? (this.activeDrag.initWidth - dx) : (this.activeDrag.initWidth + dx);
            const initBodyH = Math.max(80, this.activeDrag.initHeight - CARD_HEADER_HEIGHT);
            const candBodyHFromY = isTop ? (initBodyH - dy) : (initBodyH + dy);
            const candWFromY = candBodyHFromY * ratio;
            const useY = Math.abs(dy) > Math.abs(dx);
            let newWidth = Math.max(MIN_WIDTH, Math.round(useY ? candWFromY : candWFromX));
            let newHeight = Math.max(140, Math.round(CARD_HEADER_HEIGHT + newWidth / ratio));

            if (isLeft) {
              const rightEdge = this.activeDrag.initX + this.activeDrag.initWidth;
              card.x = rightEdge - newWidth;
            }
            if (isTop) {
              const bottomEdge = this.activeDrag.initY + this.activeDrag.initHeight;
              card.y = bottomEdge - newHeight;
            }
            card.width = newWidth;
            card.height = newHeight;
            if (cardEl) {
              cardEl.style.left = `${card.x}px`;
              cardEl.style.top = `${card.y}px`;
              cardEl.style.width = `${newWidth}px`;
              cardEl.style.height = `${newHeight}px`;
            }
            wires.render();
          }
        } else if (this.activeDrag.type === 'RESIZE_WEBPAGE') {
          const dx = (e.clientX - this.activeDrag.startX) / zoom;
          const dy = (e.clientY - this.activeDrag.startY) / zoom;
          const card = store.state.cards.find(c => c.id === this.activeDrag.cardId);
          if (card) {
            const cardEl = document.getElementById(`card-dom-${card.id}`);
            const MIN_W = 250;
            const MIN_H = 160;
            const corner = this.activeDrag.corner || 'se';
            let newX = this.activeDrag.initX;
            let newW = this.activeDrag.initWidth;
            let newH = this.activeDrag.initHeight;

            if (corner.includes('w')) {
              const rightEdge = this.activeDrag.initX + this.activeDrag.initWidth;
              newW = Math.max(MIN_W, Math.round(this.activeDrag.initWidth - dx));
              newX = rightEdge - newW;
            } else if (corner.includes('e')) {
              newW = Math.max(MIN_W, Math.round(this.activeDrag.initWidth + dx));
            }
            if (corner.includes('s')) {
              newH = Math.max(MIN_H, Math.round(this.activeDrag.initHeight + dy));
            }
            if (store.state.settings?.gridSnapMode) {
              newW = Math.max(MIN_W, Math.round(newW / 24) * 24);
              newH = Math.max(MIN_H, Math.round(newH / 24) * 24);
            }
            card.x = newX;
            card.width = newW;
            card.height = newH;
            if (cardEl) {
              cardEl.style.left = `${newX}px`;
              cardEl.style.width = `${newW}px`;
              cardEl.style.height = `${newH}px`;
            }
            wires.render();
          }
        } else if (this.activeDrag.type === 'RESIZE_SUBCANVAS_HEIGHT') {
          const dy = (e.clientY - this.activeDrag.startY) / zoom;
          const card = store.state.cards.find(c => c.id === this.activeDrag.cardId);
          if (card) {
            let newH = Math.max(120, Math.round(this.activeDrag.initHeight + dy));
            if (store.state.settings?.gridSnapMode) {
              newH = Math.max(120, Math.round(newH / 24) * 24);
            }
            card.height = newH;
            const cardEl = document.getElementById(`card-dom-${card.id}`);
            if (cardEl) {
              cardEl.style.height = `${newH}px`;
              const thumbCanvas = cardEl.querySelector('.subcanvas-thumbnail-canvas');
              if (thumbCanvas) renderThumbnailCanvas(thumbCanvas, store.getThumbnailForSubcanvas(card), store.getPalette());
            }
            wires.render();
          }
        } else if (this.activeDrag.type === 'RESIZE_GROUP') {
          const dx = (e.clientX - this.activeDrag.startX) / zoom;
          const dy = (e.clientY - this.activeDrag.startY) / zoom;
          const group = store.state.groups?.find(g => g.id === this.activeDrag.groupId);
          if (group) {
            const MIN_W = 220;
            const MIN_H = 100;
            const dir = this.activeDrag.dir;
            const { initX, initY, initWidth, initHeight } = this.activeDrag;
            let x = initX;
            let y = initY;
            let w = initWidth;
            let h = initHeight;
            const gridSnap = !!store.state.settings?.gridSnapMode;
            const GRID = 24;

            if (dir.includes('e')) {
              w = Math.max(MIN_W, Math.round(initWidth + dx));
              if (gridSnap) w = Math.max(MIN_W, Math.round((initX + w) / GRID) * GRID - x);
            }
            if (dir.includes('s')) {
              h = Math.max(MIN_H, Math.round(initHeight + dy));
              if (gridSnap) h = Math.max(MIN_H, Math.round((initY + h) / GRID) * GRID - y);
            }
            if (dir.includes('w')) {
              const rightEdge = initX + initWidth;
              let candW = Math.max(MIN_W, Math.round(initWidth - dx));
              let candX = rightEdge - candW;
              if (gridSnap) {
                const snappedX = Math.round(candX / GRID) * GRID;
                if (rightEdge - snappedX >= MIN_W) {
                  candX = snappedX;
                  candW = rightEdge - candX;
                }
              }
              x = candX;
              w = candW;
            }
            if (dir.includes('n')) {
              const bottomEdge = initY + initHeight;
              let candH = Math.max(MIN_H, Math.round(initHeight - dy));
              let candY = bottomEdge - candH;
              if (gridSnap) {
                const snappedY = Math.round(candY / GRID) * GRID;
                if (bottomEdge - snappedY >= MIN_H) {
                  candY = snappedY;
                  candH = bottomEdge - candY;
                }
              }
              y = candY;
              h = candH;
            }

            group.x = x;
            group.y = y;
            group.width = w;
            group.height = h;
            this.updateGroupDOMBounds(group.id);
            const groupEl = document.getElementById(`group-dom-${group.id}`);
            if (groupEl) {
              const prevSet = new Set(group.cardIds || []);
              const hasNewMember = store.state.cards.some(c => {
                if (prevSet.has(c.id)) return false;
                const el = document.getElementById(`card-dom-${c.id}`);
                const cw = el?.offsetWidth || c.width || 310;
                const ch = el?.offsetHeight || c.height || 140;
                const cx = c.x + cw / 2;
                const cy = c.y + ch / 2;
                return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
              });
              groupEl.classList.toggle('group-drop-target', hasNewMember);
            }
            wires.render();
          }
        }
      }
    });

    window.addEventListener('mouseup', (e) => {
      this.pendingCtrlGroupDrag = null;
      if (this.activeMarquee) {
        this.marqueeBoxEl.style.display = 'none';
        if (!this.activeMarquee.moved && !this.activeMarquee.isAdditive) {
          this.clearSelection();
        }
        this.activeMarquee = null;
      }

      if (this.activeDrag) {
        wires.clearGuideLines();
        document.querySelectorAll('.group-drop-target').forEach(el => el.classList.remove('group-drop-target'));

        if (this.activeDrag.type === 'MOVE_CARDS') {
          const dist = Math.hypot(e.clientX - this.activeDrag.startX, e.clientY - this.activeDrag.startY);
          if (dist < 4 && !this.activeDrag.cloned) {
            if (this.activeDrag.toggleOffOnClick) {
              this.selectedCardIds.delete(this.activeDrag.leadCardId);
              this.updateSelectionVisuals();
              this.updateAlignmentBar();
            } else if (!this.activeDrag.wasMultiToggle && !(e.shiftKey || e.ctrlKey || e.metaKey) && this.selectedCardIds.size > 1) {
              this.selectCard(this.activeDrag.leadCardId, false);
            }
          }
          this.activeDrag.initialPositions.forEach((_, id) => {
            document.getElementById(`card-dom-${id}`)?.classList.remove('active');
          });

          if (store.state.groups && store.state.groups.length > 0) {
            let membershipChanged = false;
            this.selectedCardIds.forEach(cardId => {
              const card = store.state.cards.find(c => c.id === cardId);
              if (!card) return;
              const cardEl = document.getElementById(`card-dom-${card.id}`);
              const cw = cardEl?.offsetWidth || card.width || 310;
              const ch = cardEl?.offsetHeight || card.height || 140;
              const cx = card.x + cw / 2;
              const cy = card.y + ch / 2;

              store.state.groups.forEach(group => {
                const bounds = this.calcGroupBounds(group);
                if (!bounds) return;
                const isInside = cx >= bounds.x && cx <= bounds.x + bounds.width &&
                                 cy >= bounds.y && cy <= bounds.y + bounds.height;
                const isMember = group.cardIds.includes(cardId);
                if (isInside && !isMember) {
                  group.cardIds.push(cardId);
                  membershipChanged = true;
                } else if (!isInside && isMember) {
                  group.cardIds = group.cardIds.filter(id => id !== cardId);
                  membershipChanged = true;
                }
              });
            });
            if (membershipChanged) {
              this.renderGroups();
            }
          }
        } else if (this.activeDrag.type === 'MOVE_GROUP') {
          const dist = Math.hypot(e.clientX - this.activeDrag.startX, e.clientY - this.activeDrag.startY);
          if (dist < 4 && this.activeDrag.toggleOffGroupIds) {
            this.activeDrag.toggleOffGroupIds.forEach(id => this.selectedCardIds.delete(id));
            this.updateSelectionVisuals();
            this.updateAlignmentBar();
          }
          document.getElementById(`group-dom-${this.activeDrag.groupId}`)?.classList.remove('active');
          this.updateGroupDOMBounds(this.activeDrag.groupId);
          if (this.viewportEl && !canvas.isSpacePressed) {
            this.viewportEl.style.cursor = '';
          }
        } else if (this.activeDrag.type === 'RESIZE_GROUP') {
          document.querySelectorAll('.group-resize-handle.active').forEach(h => h.classList.remove('active'));
          document.getElementById(`group-dom-${this.activeDrag.groupId}`)?.classList.remove('active');
          const group = store.state.groups?.find(g => g.id === this.activeDrag.groupId);
          if (group) {
            this.syncGroupMembershipByBounds(group);
          }
          this.updateGroupDOMBounds(this.activeDrag.groupId);
        } else if (this.activeDrag.type === 'RESIZE_CARD' || this.activeDrag.type === 'RESIZE_MEDIA_CORNER' || this.activeDrag.type === 'RESIZE_WEBPAGE') {
          document.querySelectorAll('.card-resize-handle.active, .card-resize-handle-bottom.active, .card-resize-corner.active').forEach(h => h.classList.remove('active'));
        } else if (this.activeDrag.type === 'RESIZE_SUBCANVAS_HEIGHT') {
          document.querySelectorAll('.subcanvas-resize-bottom.active').forEach(h => h.classList.remove('active'));
        }
        document.body.classList.remove('is-card-dragging');
        this.activeDrag = null;
        store.commit();
        wires.render();
        store.scheduleAutoSave();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Control' || e.key === 'Meta') {
        this._updateCtrlGroupCursor(!e.shiftKey);
      }
      if (window.__settings?.isRecordingShortcut?.()) return;

      // Shortcut to toggle settings modal
      if (matchesShortcut(e, store.getShortcut('openSettings'))) {
        e.preventDefault();
        window.__settings?.toggle?.();
        return;
      }

      // Shortcut to edit card header title
      if (matchesShortcut(e, store.getShortcut('renameCard'))) {
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

      if (e.isComposing || e.keyCode === 229) return;
      const targetEl = e.target instanceof Element ? e.target : e.target?.parentElement;
      const activeEl = document.activeElement instanceof Element ? document.activeElement : null;
      const isEditingText = Boolean(
        targetEl?.isContentEditable ||
        activeEl?.isContentEditable ||
        targetEl?.closest?.('input, textarea, select, [contenteditable]') ||
        activeEl?.closest?.('input, textarea, select, [contenteditable]')
      );

      if (!isEditingText && matchesShortcut(e, store.getShortcut('undo'))) {
        e.preventDefault();
        store.undo();
        return;
      }

      const allShortcuts = store.getShortcuts();
      const hasBound = (combo) => Object.values(allShortcuts).some(v => v && v.toUpperCase() === combo.toUpperCase());

      const redoBinding = store.getShortcut('redo');
      const isRedoAlias = redoBinding === 'Ctrl+Y' && !hasBound('Ctrl+Shift+Z') &&
        (e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey && (e.code === 'KeyZ' || e.key?.toLowerCase() === 'z');
      if (!isEditingText && (matchesShortcut(e, redoBinding) || isRedoAlias)) {
        e.preventDefault();
        store.redo();
        return;
      }

      if (!isEditingText && matchesShortcut(e, store.getShortcut('selectAll'))) {
        if (window.__canvases?.handleSelectAllShortcut?.(e)) {
          return;
        }
        if (window.__library?.handleSelectAllShortcut?.(e)) {
          return;
        }
        e.preventDefault();
        this.selectAllCards();
        return;
      }

      // Copy
      if (!isEditingText && matchesShortcut(e, store.getShortcut('copy'))) {
        if (this.selectedCardIds.size > 0) {
          e.preventDefault();
          this.copySelectedCards();
          return;
        }
      }

      // Cut
      if (!isEditingText && matchesShortcut(e, store.getShortcut('cut'))) {
        if (this.selectedCardIds.size > 0) {
          e.preventDefault();
          this.cutSelectedCards();
          return;
        }
      }

      // Paste: native 'paste' event handles Ctrl+V / Cmd+V (external media/URL + internal cards);
      // only intercept here if user rebound paste to a non-Ctrl+V shortcut.
      const pasteSc = store.getShortcut('paste');
      if (!isEditingText && pasteSc && pasteSc.toUpperCase() !== 'CTRL+V' && matchesShortcut(e, pasteSc)) {
        if (this.clipboard && this.clipboard.cards?.length > 0) {
          e.preventDefault();
          this.pasteCards();
          return;
        }
      }

      // Open selected webpage card in new tab (Enter or Ctrl+Enter)
      if (!isEditingText && (e.key === 'Enter') && this.selectedCardIds.size === 1) {
        const selId = [...this.selectedCardIds][0];
        const selCard = store.state.cards.find(c => c.id === selId);
        if (selCard?.kind === 'webpage') {
          const url = selCard.media?.url || selCard.media?.src;
          if (url) {
            e.preventDefault();
            window.open(url, '_blank', 'noopener,noreferrer');
            return;
          }
        }
      }

      // Focus Mode
      if (!isEditingText && matchesShortcut(e, store.getShortcut('toggleFocusMode'))) {
        if (!store.isFocusMode && this.selectedCardIds.size > 0) {
          e.preventDefault();
          this.enterFocusMode();
          return;
        }
      }

      // Canvases Drawer Toggle
      if (!isEditingText && !window.__settings?.isOpen?.() && matchesShortcut(e, store.getShortcut('toggleCanvases'))) {
        e.preventDefault();
        window.__canvases?.toggle?.();
        return;
      }

      // Library Drawer Toggle
      if (!isEditingText && !window.__settings?.isOpen?.() && matchesShortcut(e, store.getShortcut('toggleLibrary'))) {
        e.preventDefault();
        window.__library?.toggle?.();
        return;
      }

      // Save selected cards to Library
      if (!isEditingText && !window.__settings?.isOpen?.() && matchesShortcut(e, store.getShortcut('saveToLibrary'))) {
        e.preventDefault();
        window.__library?.openSaveForm?.();
        return;
      }

      // Group
      if (!isEditingText && matchesShortcut(e, store.getShortcut('createGroup'))) {
        if (this.selectedCardIds.size >= 2) {
          e.preventDefault();
          this.createGroupFromSelected();
          return;
        }
      }

      // Ungroup
      if (!isEditingText && matchesShortcut(e, store.getShortcut('ungroup'))) {
        if (this.selectedCardIds.size > 0) {
          e.preventDefault();
          this.ungroupSelected();
          return;
        }
      }

      const deleteBinding = store.getShortcut('deleteSelected');
      const isDeleteAlias = deleteBinding === 'Delete' && !hasBound('Backspace') &&
        !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === 'Backspace';
      if (matchesShortcut(e, deleteBinding) || isDeleteAlias) {
        if (window.__settings?.isOpen?.()) return;
        if (!isEditingText && window.__canvases?.handleDeleteShortcut?.(e)) {
          return;
        }
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
        if (window.__canvases?.handleEscape?.()) {
          return;
        }
        if (window.__library?.handleEscape?.()) {
          return;
        }
        if (isEditingText) {
          activeEl?.blur?.();
          targetEl?.blur?.();
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
      if (e.key === 'Control' || e.key === 'Meta') {
        this._updateCtrlGroupCursor(false);
        if (!store.state.settings?.alignMode) {
          wires.clearGuideLines();
        }
      }
    });

    window.addEventListener('blur', () => {
      this.pendingCtrlGroupDrag = null;
      this._updateCtrlGroupCursor(false);
    });
  }
}

export const nodes = new NodeManager();
