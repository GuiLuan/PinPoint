import { store } from './state.js';
import { canvas } from './canvas.js';
import { wires } from './wires.js';

function hexToRgba(hex, alpha = 1) {
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
    this.currentRange = null;
    this.targetCapsule = null;
    this.selectedColor = '#30d158';
    this.activeDrag = null;
  }

  init(containerEl, selectionPopoverEl) {
    this.containerEl = containerEl;
    this.selectionPopoverEl = selectionPopoverEl;
    this.bindSelectionEvents();
    this.bindGlobalGestures();
  }

  spawnNode(pos, title = '未命名节点') {
    const card = {
      id: `card-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      title: title || '未命名节点',
      x: Math.round(pos.x - 20),
      y: Math.round(pos.y - 20),
      width: 310,
      contentHtml: ''
    };
    store.addCard(card);
    this.render();
    return card;
  }

  render() {
    this.containerEl.innerHTML = '';

    store.state.cards.forEach(card => {
      const cardEl = document.createElement('div');
      cardEl.className = 'note-card';
      cardEl.id = `card-dom-${card.id}`;
      cardEl.style.left = `${card.x}px`;
      cardEl.style.top = `${card.y}px`;
      cardEl.style.width = `${card.width || 310}px`;

      const headPinId = `pin-head-${card.id}`;
      const conn = store.state.connections.find(c => c.toPinId === headPinId);
      const headColor = conn?.color || '#98989d';

      cardEl.innerHTML = `
        <div class="note-header">
          <div class="header-left">
            <i class="header-pin" data-header-pin-id="${headPinId}" style="background-color: ${headColor};" title="节点端口：可连出 / 可连入"></i>
            <span class="header-title" title="双击重命名">${card.title || '未命名节点'}</span>
            <input class="header-title-input" value="${card.title || ''}" placeholder="未命名节点" style="display: none;" />
          </div>
          <button class="card-close-btn" title="删除节点">
            <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
        <div class="note-body" contenteditable="true" spellcheck="false">${card.contentHtml || ''}</div>
        <div class="card-resize-handle" title="按住左右拖拽调节宽度"></div>
      `;

      // Title editing (double click to edit, enter/blur/escape to commit)
      const titleSpan = cardEl.querySelector('.header-title');
      const titleInput = cardEl.querySelector('.header-title-input');

      const startTitleEdit = () => {
        titleSpan.style.display = 'none';
        titleInput.style.display = 'block';
        titleInput.value = card.title || '';
        titleInput.focus();
        titleInput.select();
      };

      const finishTitleEdit = () => {
        if (titleInput.style.display === 'none') return;
        const newTitle = titleInput.value.trim() || '未命名节点';
        card.title = newTitle;
        titleSpan.textContent = newTitle;
        titleInput.style.display = 'none';
        titleSpan.style.display = '';
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

      // Delete node
      const closeBtn = cardEl.querySelector('.card-close-btn');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.removeCard(card.id);
        this.render();
        wires.render();
      });

      // Drag node by header
      const headerEl = cardEl.querySelector('.note-header');
      headerEl.addEventListener('mousedown', (e) => {
        if (e.target.closest('.header-pin, .card-close-btn') || e.target === titleInput) return;
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        wires.clearFocus();
        window.getSelection()?.removeAllRanges();
        this.hideSelectionPopover();

        this.activeDrag = {
          type: 'MOVE_CARD',
          cardId: card.id,
          startX: e.clientX,
          startY: e.clientY,
          initX: card.x,
          initY: card.y
        };
        cardEl.classList.add('active');
      });

      headerEl.addEventListener('dblclick', (e) => {
        if (e.target.closest('.header-pin, .card-close-btn') || e.target === titleInput) return;
        startTitleEdit();
      });

      // Card resizing
      const resizeHandle = cardEl.querySelector('.card-resize-handle');
      resizeHandle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        wires.clearFocus();
        window.getSelection()?.removeAllRanges();
        this.hideSelectionPopover();

        this.activeDrag = {
          type: 'RESIZE_CARD',
          cardId: card.id,
          startX: e.clientX,
          initWidth: cardEl.offsetWidth
        };
        resizeHandle.classList.add('active');
      });

      // Header pin connection
      const headPinEl = cardEl.querySelector('.header-pin');
      this.bindPinEvents(headPinEl, headPinId);

      // Body input
      const bodyEl = cardEl.querySelector('.note-body');
      bodyEl.addEventListener('input', () => {
        card.contentHtml = bodyEl.innerHTML;
        wires.render();
        store.scheduleAutoSave();
      });

      this.containerEl.appendChild(cardEl);
    });

    this.bindCapsuleEvents();
  }

  bindPinEvents(pinEl, pinId) {
    if (!pinEl) return;

    pinEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      wires.clearFocus();
      window.getSelection()?.removeAllRanges();

      const startPos = wires.getPinBoardPos(pinId);
      if (!startPos) return;

      const capsule = pinEl.closest('.text-capsule');
      let color = '#98989d';
      if (capsule) {
        color = window.getComputedStyle(capsule).getPropertyValue('--capsule-pin').trim() || '#30d158';
      }

      wires.startConnect(pinId, startPos, color);
      pinEl.classList.add('pin-active');
    });

    pinEl.addEventListener('mouseenter', () => {
      if (wires.activeDrag) {
        if (store.canConnect(wires.activeDrag.fromPinId, pinId)) {
          pinEl.classList.add('pin-active');
        }
      }
    });

    pinEl.addEventListener('mouseleave', () => {
      if (wires.activeDrag) {
        pinEl.classList.remove('pin-active');
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

      // Right click un-capsules text
      capsule.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        wires.clearFocus();

        store.state.connections = store.state.connections.filter(c => c.fromPinId !== pinId && c.toPinId !== pinId);

        const text = capsule.innerText.replace('↗', '').trim();
        const textNode = document.createTextNode(text);
        const cardEl = capsule.closest('.note-card');
        const cardId = cardEl?.id.replace('card-dom-', '');

        capsule.parentNode.replaceChild(textNode, capsule);

        if (cardId) {
          const card = store.state.cards.find(c => c.id === cardId);
          if (card) {
            card.contentHtml = cardEl.querySelector('.note-body').innerHTML;
          }
        }

        wires.render();
        store.scheduleAutoSave();
      });

      // Prevent mousedown on capsule from triggering text selection on the atomic node
      capsule.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.capsule-pin')) return;
        e.preventDefault();
      });

      // Click capsule body to change its color
      capsule.addEventListener('click', (e) => {
        if (e.target.closest('.capsule-pin')) return;
        e.stopPropagation();
        this.openPopoverForCapsule(capsule);
      });
    });
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
    window.getSelection()?.removeAllRanges();
    this.currentRange = null;
    this.targetCapsule = capsule;

    const currentColor = capsule.style.getPropertyValue('--capsule-pin').trim() ||
                         window.getComputedStyle(capsule).getPropertyValue('--capsule-pin').trim() ||
                         '#30d158';

    this.setSelectedColor(currentColor);
    this.updatePopoverPosition();
  }

  updatePopoverPosition() {
    if (!this.selectionPopoverEl) return;

    let rect = null;
    if (this.targetCapsule) {
      rect = this.targetCapsule.getBoundingClientRect();
    } else if (this.currentRange) {
      rect = this.currentRange.getBoundingClientRect();
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
  }

  bindSelectionEvents() {
    document.addEventListener('selectionchange', () => {
      if (document.body.classList.contains('is-wire-dragging') || this.activeDrag) {
        this.hideSelectionPopover();
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        if (!this.targetCapsule) this.hideSelectionPopover();
        return;
      }

      const text = selection.toString().trim();
      if (!text) {
        if (!this.targetCapsule) this.hideSelectionPopover();
        return;
      }

      const anchor = selection.anchorNode;
      const bodyEl = anchor?.nodeType === 3 ? anchor.parentElement.closest('.note-body') : anchor?.closest('.note-body');
      if (!bodyEl) {
        if (!this.targetCapsule) this.hideSelectionPopover();
        return;
      }

      this.targetCapsule = null;
      this.currentRange = selection.getRangeAt(0).cloneRange();
      this.setSelectedColor(this.selectedColor || '#30d158');
      this.updatePopoverPosition();
    });

    this.selectionPopoverEl.addEventListener('mousedown', (e) => {
      if (!e.target.classList.contains('popover-color-picker')) {
        e.preventDefault();
      }
    });

    this.selectionPopoverEl.querySelectorAll('.popover-color-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = btn.getAttribute('data-color') || '#30d158';
        this.setSelectedColor(color);
      });
    });

    const colorPicker = this.selectionPopoverEl.querySelector('.popover-color-picker');
    if (colorPicker) {
      const handleCustomColor = (e) => {
        const color = e.target.value;
        if (color) this.setSelectedColor(color);
      };
      colorPicker.addEventListener('input', handleCustomColor);
      colorPicker.addEventListener('change', handleCustomColor);
    }

    const applyBtn = this.selectionPopoverEl.querySelector('#popover-apply-btn');
    if (applyBtn) {
      applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.applyColor();
      });
    }

    document.addEventListener('mousedown', (e) => {
      if (this.selectionPopoverEl && this.selectionPopoverEl.contains(e.target)) return;
      if (e.target.closest('.text-capsule')) return;
      this.hideSelectionPopover();
    });

    window.addEventListener('keydown', (e) => {
      if (this.selectionPopoverEl && this.selectionPopoverEl.style.display === 'flex') {
        if (e.key === 'Escape') {
          this.hideSelectionPopover();
        } else if (e.key === 'Enter' && !e.target.closest('input, [contenteditable="true"]')) {
          e.preventDefault();
          this.applyColor();
        }
      }
    });
  }

  applyColor() {
    if (this.targetCapsule) {
      this.recolorCapsule(this.targetCapsule, this.selectedColor);
    } else if (this.currentRange) {
      this.createCapsuleFromSelection(this.selectedColor);
    }
    this.hideSelectionPopover();
  }

  recolorCapsule(capsule, newColor) {
    const pinId = capsule.getAttribute('data-pin-id');
    const bg = hexToRgba(newColor, 0.14);
    const border = hexToRgba(newColor, 0.38);

    capsule.style.setProperty('--capsule-pin', newColor);
    capsule.style.backgroundColor = bg;
    capsule.style.borderColor = border;

    // Only update outgoing connections originating from this capsule
    if (pinId) {
      store.state.connections.forEach(conn => {
        if (conn.fromPinId === pinId) {
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
    wires.render();
    store.scheduleAutoSave();
  }

  bindGlobalGestures() {
    window.addEventListener('mousemove', (e) => {
      if (!this.activeDrag) return;
      const { zoom } = store.state.viewport;

      if (this.activeDrag.type === 'MOVE_CARD') {
        const dx = (e.clientX - this.activeDrag.startX) / zoom;
        const dy = (e.clientY - this.activeDrag.startY) / zoom;
        const card = store.state.cards.find(c => c.id === this.activeDrag.cardId);
        if (card) {
          card.x = this.activeDrag.initX + dx;
          card.y = this.activeDrag.initY + dy;
          const cardEl = document.getElementById(`card-dom-${card.id}`);
          if (cardEl) {
            cardEl.style.left = `${card.x}px`;
            cardEl.style.top = `${card.y}px`;
          }
          wires.render();
        }
      } else if (this.activeDrag.type === 'RESIZE_CARD') {
        const dx = (e.clientX - this.activeDrag.startX) / zoom;
        const card = store.state.cards.find(c => c.id === this.activeDrag.cardId);
        if (card) {
          const newWidth = Math.max(250, Math.round(this.activeDrag.initWidth + dx));
          card.width = newWidth;
          const cardEl = document.getElementById(`card-dom-${card.id}`);
          if (cardEl) {
            cardEl.style.width = `${newWidth}px`;
          }
          wires.render();
        }
      }
    });

    window.addEventListener('mouseup', () => {
      if (this.activeDrag) {
        if (this.activeDrag.type === 'MOVE_CARD') {
          document.getElementById(`card-dom-${this.activeDrag.cardId}`)?.classList.remove('active');
        } else if (this.activeDrag.type === 'RESIZE_CARD') {
          document.querySelectorAll('.card-resize-handle.active').forEach(h => h.classList.remove('active'));
        }
        this.activeDrag = null;
        wires.render();
        store.scheduleAutoSave();
      }
    });
  }
}

export const nodes = new NodeManager();
