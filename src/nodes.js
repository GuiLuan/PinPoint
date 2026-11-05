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
    this.marqueeBoxEl = null;
    this.alignmentBarEl = null;
    this.viewportEl = null;
    this.currentRange = null;
    this.targetCapsule = null;
    this.selectedColor = '#30d158';
    this.selectedCardIds = new Set();
    this.activeMarquee = null;
    this.activeDrag = null;
  }

  init(containerEl, selectionPopoverEl, marqueeBoxEl, alignmentBarEl, viewportEl) {
    this.containerEl = containerEl;
    this.selectionPopoverEl = selectionPopoverEl;
    this.marqueeBoxEl = marqueeBoxEl;
    this.alignmentBarEl = alignmentBarEl;
    this.viewportEl = viewportEl;
    this.bindSelectionEvents();
    this.bindAlignmentEvents();
    this.bindMarqueeEvents();
    this.bindGlobalGestures();
  }

  spawnNode(pos, title = '未命名节点', skipCommit = false) {
    const card = {
      id: `card-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      title: title || '未命名节点',
      x: Math.round(pos.x - 20),
      y: Math.round(pos.y - 20),
      width: 310,
      contentHtml: ''
    };
    store.addCard(card, skipCommit);
    this.render();
    return card;
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

      let prevTitle = card.title || '';
      const startTitleEdit = () => {
        prevTitle = card.title || '';
        titleSpan.style.display = 'none';
        titleInput.style.display = 'block';
        titleInput.value = card.title || '';
        titleInput.focus();
        titleInput.select();
      };

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

      // Delete node
      const closeBtn = cardEl.querySelector('.card-close-btn');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.removeCard(card.id);
        this.render();
        wires.render();
      });

      cardEl.addEventListener('mousedown', (e) => {
        if (e.shiftKey && !e.target.closest('.header-pin, .capsule-pin, .card-close-btn')) {
          e.preventDefault();
          this.selectCard(card.id, true);
        }
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

        store.commit();
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
        } else if (e.key === 'Enter' && !e.target?.closest?.('input, [contenteditable="true"]')) {
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

    store.commit();
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

          if (e.ctrlKey && leadCard && leadInitPos) {
            const snap = this.calcSnap(leadCard, leadInitPos.x + dx, leadInitPos.y + dy);
            dx = snap.snappedX - leadInitPos.x;
            dy = snap.snappedY - leadInitPos.y;
            wires.showGuideLines(snap.guideLines);
          } else {
            wires.clearGuideLines();
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
            const newWidth = Math.max(250, Math.round(this.activeDrag.initWidth + dx));
            card.width = newWidth;
            const cardEl = document.getElementById(`card-dom-${card.id}`);
            if (cardEl) {
              cardEl.style.width = `${newWidth}px`;
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

      if ((e.key === 'Delete' || e.key === 'Backspace') && !isEditingText) {
        if (this.selectedCardIds.size > 0) {
          e.preventDefault();
          this.deleteSelectedCards();
        }
      } else if (e.key === 'Escape') {
        if (this.selectedCardIds.size > 0 && !wires.activeDrag) {
          this.clearSelection();
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.key === 'Control') {
        wires.clearGuideLines();
      }
    });
  }
}

export const nodes = new NodeManager();
