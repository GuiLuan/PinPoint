import { store } from './state.js';
import { canvas } from './canvas.js';

class WireManager {
  constructor() {
    this.svgEl = null;
    this.tempWireEl = null;
    this.connectionsGroupEl = null;
    this.wireDropMenuEl = null;
    this.activeDrag = null;
    this.pendingDrop = null;
    this.spawnNodeCallback = null;
  }

  init(svgEl, spawnNodeCallback, wireDropMenuEl) {
    this.svgEl = svgEl;
    this.spawnNodeCallback = spawnNodeCallback;
    this.wireDropMenuEl = wireDropMenuEl || document.getElementById('wire-drop-menu');

    this.guidesGroupEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.guidesGroupEl.setAttribute('id', 'guides-group');
    this.svgEl.appendChild(this.guidesGroupEl);

    this.connectionsGroupEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.svgEl.appendChild(this.connectionsGroupEl);

    this.tempWireEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.tempWireEl.setAttribute('class', 'wire-temp');
    this.tempWireEl.style.display = 'none';
    this.svgEl.appendChild(this.tempWireEl);

    if (this.wireDropMenuEl) {
      this.wireDropMenuEl.addEventListener('mousedown', (e) => {
        e.stopPropagation();
      });
      const btnSpawn = this.wireDropMenuEl.querySelector('#btn-wire-spawn-node');
      btnSpawn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onSpawnNodeFromMenu();
      });
    }

    this.bindGlobalEvents();
  }

  getPinBoardPos(pinId) {
    let pinEl = document.querySelector(`[data-pin-id="${pinId}"] .capsule-pin`);
    if (!pinEl) {
      pinEl = document.querySelector(`[data-header-pin-id="${pinId}"]`);
    }
    if (!pinEl && pinId.startsWith('pin-head-') && !pinId.startsWith('pin-head-left-') && !pinId.startsWith('pin-head-right-')) {
      const cardId = pinId.replace('pin-head-', '');
      pinEl = document.querySelector(`[data-header-pin-id="pin-head-left-${cardId}"]`) ||
              document.querySelector(`[data-header-pin-id="pin-head-right-${cardId}"]`);
    }
    if (!pinEl) return null;

    const rect = pinEl.getBoundingClientRect();
    const { x, y, zoom } = store.state.viewport;

    return {
      x: (rect.left + rect.width / 2 - x) / zoom,
      y: (rect.top + rect.height / 2 - y) / zoom
    };
  }

  createBezierPath(p1, p2, fromDir = 'right', toDir = 'left') {
    const dx = p2.x - p1.x;
    const tension = Math.min(Math.max(Math.abs(dx) * 0.45, 45), 140);
    const c1x = fromDir === 'left' ? p1.x - tension : p1.x + tension;
    const c1y = p1.y;
    const c2x = toDir === 'right' ? p2.x + tension : p2.x - tension;
    const c2y = p2.y;

    return `M ${p1.x} ${p1.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }

  getBezierMidpoint(p1, p2, fromDir = 'right', toDir = 'left') {
    const dx = p2.x - p1.x;
    const tension = Math.min(Math.max(Math.abs(dx) * 0.45, 45), 140);
    const c1x = fromDir === 'left' ? p1.x - tension : p1.x + tension;
    const c1y = p1.y;
    const c2x = toDir === 'right' ? p2.x + tension : p2.x - tension;
    const c2y = p2.y;

    const t = 0.5;
    const om = 1 - t;
    const x = Math.pow(om, 3) * p1.x + 3 * Math.pow(om, 2) * t * c1x + 3 * om * Math.pow(t, 2) * c2x + Math.pow(t, 3) * p2.x;
    const y = Math.pow(om, 3) * p1.y + 3 * Math.pow(om, 2) * t * c1y + 3 * om * Math.pow(t, 2) * c2y + Math.pow(t, 3) * p2.y;
    return { x, y };
  }

  resolvePinColor(pinId) {
    if (!pinId) return null;
    if (pinId.startsWith('pin-head-')) {
      const cardId = store.findCardIdByPin(pinId);
      const card = store.state.cards.find(c => c.id === cardId);
      return card?.headerColor || null;
    }
    const capsuleEl = document.querySelector(`[data-pin-id="${pinId}"]`);
    if (capsuleEl) {
      const col = capsuleEl.style.getPropertyValue('--capsule-pin').trim() ||
                  window.getComputedStyle(capsuleEl).getPropertyValue('--capsule-pin').trim();
      if (col && col !== '#98989d') return col;
    }
    const card = store.state.cards.find(c => c.contentHtml && c.contentHtml.includes(pinId));
    if (card) {
      const match = card.contentHtml.match(new RegExp(`data-pin-id="${pinId}"[^>]*--capsule-pin:\\s*([^;"]+)`));
      if (match && match[1]) return match[1].trim();
    }
    return null;
  }

  render() {
    this.connectionsGroupEl.innerHTML = '';

    store.state.connections.forEach(conn => {
      const p1 = this.getPinBoardPos(conn.fromPinId);
      const p2 = this.getPinBoardPos(conn.toPinId);
      if (!p1 || !p2) return;

      const fromDir = conn.fromPinId.includes('left') ? 'left' : 'right';
      const toDir = conn.toPinId.includes('right') ? 'right' : 'left';
      const pathData = this.createBezierPath(p1, p2, fromDir, toDir);
      const color = conn.color || '#98989d';

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'wire-group');
      g.setAttribute('id', `wire-group-${conn.id}`);

      // 1. Glow layer
      const glow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      glow.setAttribute('d', pathData);
      glow.setAttribute('class', 'wire-glow');
      glow.setAttribute('stroke', color);
      g.appendChild(glow);

      // 2. Main cable
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData);
      path.setAttribute('class', 'wire-path');
      path.setAttribute('stroke', color);
      g.appendChild(path);

      // 3. Flowing pulse
      const pulse = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pulse.setAttribute('d', pathData);
      pulse.setAttribute('class', 'wire-pulse');
      g.appendChild(pulse);

      // 4. Subtle reroute node in middle
      const mid = this.getBezierMidpoint(p1, p2, fromDir, toDir);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', mid.x);
      dot.setAttribute('cy', mid.y);
      dot.setAttribute('r', '3');
      dot.setAttribute('class', 'reroute-dot');
      dot.setAttribute('style', `color: ${color}; fill: ${color};`);
      g.appendChild(dot);

      // 5. Top invisible hit zone
      const hitZone = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hitZone.setAttribute('d', pathData);
      hitZone.setAttribute('class', 'wire-hit-zone');
      g.appendChild(hitZone);

      hitZone.addEventListener('mouseenter', () => {
        if (this.activeDrag) return;
        this.triggerWireFocus(conn);
      });

      hitZone.addEventListener('mouseleave', () => {
        if (this.activeDrag) return;
        this.clearFocus();
      });

      hitZone.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.clearFocus();
        this.dismissDropMenu(true);
        window.getSelection()?.removeAllRanges();
        document.body.classList.add('is-wire-dragging');

        const startPos = this.getPinBoardPos(conn.fromPinId);
        if (!startPos) return;

        this.activeDrag = {
          type: 'RECONNECT',
          connId: conn.id,
          fromPinId: conn.fromPinId,
          startPos,
          wireColor: color,
          startClientX: e.clientX,
          startClientY: e.clientY,
          moved: false
        };

        g.classList.add('wire-reconnecting');
        this.tempWireEl.style.display = 'block';
        this.tempWireEl.style.stroke = color;
        this.updateTempWire(startPos, canvas.screenToBoard(e.clientX, e.clientY));
      });

      hitZone.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });

      this.connectionsGroupEl.appendChild(g);
    });

    this.updateCapsuleBadges();
  }

  updateCapsuleBadges() {
    document.querySelectorAll('.text-capsule').forEach(capsule => {
      const pinId = capsule.getAttribute('data-pin-id');
      const hasConn = store.state.connections.some(c => c.fromPinId === pinId || c.toPinId === pinId);
      capsule.classList.toggle('has-connection', hasConn);
    });
  }

  triggerWireFocus(conn) {
    if (!conn) return;
    document.body.classList.add('focus-mode');

    const group = document.getElementById(`wire-group-${conn.id}`);
    if (group) group.classList.add('focus-wire');

    [conn.fromPinId, conn.toPinId].forEach(pinId => {
      const capsule = document.querySelector(`[data-pin-id="${pinId}"]`);
      if (capsule) {
        capsule.closest('.note-card')?.classList.add('focus-card');
        capsule.classList.add('target-highlight');
      }
      const headPin = document.querySelector(`[data-header-pin-id="${pinId}"]`);
      if (headPin) {
        headPin.closest('.note-card')?.classList.add('focus-card');
        headPin.classList.add('pin-active');
      }
    });
  }

  triggerPinFocus(pinId) {
    const related = store.state.connections.filter(c => c.fromPinId === pinId || c.toPinId === pinId);
    if (related.length === 0) return;

    document.body.classList.add('focus-mode');

    const pinIds = new Set();
    related.forEach(c => {
      pinIds.add(c.fromPinId);
      pinIds.add(c.toPinId);
      document.getElementById(`wire-group-${c.id}`)?.classList.add('focus-wire');
    });

    pinIds.forEach(pId => {
      const capsule = document.querySelector(`[data-pin-id="${pId}"]`);
      if (capsule) {
        capsule.closest('.note-card')?.classList.add('focus-card');
        if (pId !== pinId) capsule.classList.add('target-highlight');
      }
      const headPin = document.querySelector(`[data-header-pin-id="${pId}"]`);
      if (headPin) {
        headPin.closest('.note-card')?.classList.add('focus-card');
        headPin.classList.add('pin-active');
      }
    });
  }

  clearFocus() {
    document.body.classList.remove('focus-mode');
    document.querySelectorAll('.focus-wire').forEach(el => el.classList.remove('focus-wire'));
    document.querySelectorAll('.focus-card').forEach(el => el.classList.remove('focus-card'));
    document.querySelectorAll('.target-highlight').forEach(el => el.classList.remove('target-highlight'));
    document.querySelectorAll('.pin-active').forEach(el => el.classList.remove('pin-active'));
    document.querySelectorAll('.pin-ghost').forEach(el => el.classList.remove('pin-ghost'));
  }

  updateTempWire(p1, p2, fromDir = 'right', toDir = 'left') {
    this.tempWireEl.setAttribute('d', this.createBezierPath(p1, p2, fromDir, toDir));
  }

  showGuideLines(lines) {
    if (!this.guidesGroupEl) return;
    this.guidesGroupEl.innerHTML = '';
    lines.forEach(l => {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', l.x1);
      line.setAttribute('y1', l.y1);
      line.setAttribute('x2', l.x2);
      line.setAttribute('y2', l.y2);
      line.setAttribute('class', 'snap-guide-line');
      this.guidesGroupEl.appendChild(line);
    });
  }

  clearGuideLines() {
    if (this.guidesGroupEl) {
      this.guidesGroupEl.innerHTML = '';
    }
  }

  startConnect(fromPinId, startPos, color, clientX = 0, clientY = 0) {
    this.dismissDropMenu(true);
    window.getSelection()?.removeAllRanges();
    document.body.classList.add('is-wire-dragging');
    this.activeDrag = {
      type: 'CONNECT',
      fromPinId,
      startPos,
      wireColor: color,
      startClientX: clientX,
      startClientY: clientY,
      moved: false
    };
    this.tempWireEl.style.display = 'block';
    this.tempWireEl.style.stroke = color;
  }

  showDropMenu(clientX, clientY, dropBoardPos, dragInfo) {
    this.pendingDrop = {
      type: dragInfo.type,
      connId: dragInfo.connId,
      fromPinId: dragInfo.fromPinId,
      wireColor: dragInfo.wireColor,
      startPos: dragInfo.startPos,
      dropBoardPos
    };

    if (!this.wireDropMenuEl) return;

    let left = clientX + 10;
    let top = clientY - 18;
    const menuWidth = 130;
    const menuHeight = 44;

    if (left + menuWidth > window.innerWidth - 12) {
      left = clientX - menuWidth - 10;
    }
    if (top + menuHeight > window.innerHeight - 12) {
      top = window.innerHeight - menuHeight - 12;
    }
    if (top < 12) top = 12;

    this.wireDropMenuEl.style.left = `${left}px`;
    this.wireDropMenuEl.style.top = `${top}px`;
    this.wireDropMenuEl.style.display = 'flex';

    const fromDir = this.pendingDrop.fromPinId.includes('left') ? 'left' : 'right';
    const toDir = this.pendingDrop.dropBoardPos.x < this.pendingDrop.startPos.x ? 'right' : 'left';
    this.tempWireEl.style.display = 'block';
    this.tempWireEl.style.stroke = this.pendingDrop.wireColor;
    this.updateTempWire(this.pendingDrop.startPos, this.pendingDrop.dropBoardPos, fromDir, toDir);
  }

  onSpawnNodeFromMenu() {
    if (!this.pendingDrop) return;
    const { type, connId, fromPinId, wireColor, startPos, dropBoardPos } = this.pendingDrop;

    const newNode = this.spawnNodeCallback(dropBoardPos, true);
    const isLeft = startPos.x < dropBoardPos.x;
    const newHeadPinId = isLeft ? `pin-head-left-${newNode.id}` : `pin-head-right-${newNode.id}`;

    if (type === 'RECONNECT') {
      store.reconnect(connId, newHeadPinId);
    } else {
      store.addConnection(fromPinId, newHeadPinId, wireColor);
    }

    this.dismissDropMenu(false);
    store.commit();
    this.render();
    store.scheduleAutoSave();
  }

  dismissDropMenu(isDiscard = true) {
    if (!this.pendingDrop) return;

    if (isDiscard) {
      if (this.pendingDrop.type === 'RECONNECT') {
        store.removeConnection(this.pendingDrop.connId);
        store.commit();
        store.scheduleAutoSave();
      }
    }

    this.pendingDrop = null;
    if (this.wireDropMenuEl) {
      this.wireDropMenuEl.style.display = 'none';
    }
    this.tempWireEl.style.display = 'none';
    this.render();
  }

  updateDropMenuPosition() {
    if (!this.pendingDrop || !this.wireDropMenuEl || this.wireDropMenuEl.style.display === 'none') return;
    const screenPos = canvas.boardToScreen(this.pendingDrop.dropBoardPos.x, this.pendingDrop.dropBoardPos.y);
    let left = screenPos.x + 10;
    let top = screenPos.y - 18;
    const menuWidth = 130;
    const menuHeight = 44;
    if (left + menuWidth > window.innerWidth - 12) left = screenPos.x - menuWidth - 10;
    if (top + menuHeight > window.innerHeight - 12) top = window.innerHeight - menuHeight - 12;
    if (top < 12) top = 12;

    this.wireDropMenuEl.style.left = `${left}px`;
    this.wireDropMenuEl.style.top = `${top}px`;

    const fromDir = this.pendingDrop.fromPinId.includes('left') ? 'left' : 'right';
    const toDir = this.pendingDrop.dropBoardPos.x < this.pendingDrop.startPos.x ? 'right' : 'left';
    this.updateTempWire(this.pendingDrop.startPos, this.pendingDrop.dropBoardPos, fromDir, toDir);
  }

  bindGlobalEvents() {
    window.addEventListener('selectstart', (e) => {
      if (document.body.classList.contains('is-wire-dragging') || this.activeDrag) {
        e.preventDefault();
      }
    });

    window.addEventListener('mousedown', (e) => {
      if (this.wireDropMenuEl && this.wireDropMenuEl.contains(e.target)) return;
      if (this.pendingDrop) {
        this.dismissDropMenu(true);
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.activeDrag) return;
      if (Math.hypot(e.clientX - this.activeDrag.startClientX, e.clientY - this.activeDrag.startClientY) > 5) {
        this.activeDrag.moved = true;
      }
      const boardPos = canvas.screenToBoard(e.clientX, e.clientY);

      const fromDir = this.activeDrag.fromPinId.includes('left') ? 'left' : 'right';
      let toDir = boardPos.x < this.activeDrag.startPos.x ? 'right' : 'left';

      document.querySelectorAll('.pin-active').forEach(el => el.classList.remove('pin-active'));
      document.querySelectorAll('.pin-ghost').forEach(el => {
        el.classList.remove('pin-ghost');
        const cardEl = el.closest('.note-card');
        const cardId = cardEl?.id.replace('card-dom-', '');
        const card = cardId ? store.state.cards.find(c => c.id === cardId) : null;
        if (!card?.headerColor && !el.classList.contains('pin-connected')) {
          el.style.backgroundColor = '';
          el.style.color = '';
        }
      });
      document.querySelectorAll('.target-highlight').forEach(el => el.classList.remove('target-highlight'));

      const hitEl = (e.clientX !== undefined && e.clientY !== undefined ? document.elementFromPoint(e.clientX, e.clientY) : null) || e.target;
      const targetSlot = hitEl?.closest ? hitEl.closest('.header-port-slot') : null;
      const targetPin = hitEl?.closest ? hitEl.closest('.capsule-pin, .header-pin') : null;
      const targetCapsule = hitEl?.closest ? hitEl.closest('.text-capsule') : null;
      const targetCard = hitEl?.closest ? hitEl.closest('.note-card') : null;

      let targetId = null;
      let activePinEl = null;

      if (targetSlot) {
        activePinEl = targetSlot.querySelector('.header-pin');
        targetId = activePinEl?.getAttribute('data-header-pin-id');
        toDir = targetId?.includes('right') ? 'right' : 'left';
      } else if (targetPin) {
        targetId = targetPin.getAttribute('data-header-pin-id') || targetPin.closest('.text-capsule')?.getAttribute('data-pin-id');
        activePinEl = targetPin;
        toDir = targetId?.includes('right') ? 'right' : 'left';
      } else if (targetCapsule) {
        targetId = targetCapsule.getAttribute('data-pin-id');
        activePinEl = targetCapsule.querySelector('.capsule-pin');
        toDir = 'left';
      } else if (targetCard) {
        const rect = targetCard.getBoundingClientRect();
        const isLeft = e.clientX < rect.left + rect.width / 2;
        const pinEl = isLeft
          ? targetCard.querySelector('.header-pin-left')
          : targetCard.querySelector('.header-pin-right');
        if (pinEl) {
          targetId = pinEl.getAttribute('data-header-pin-id');
          activePinEl = pinEl;
          toDir = isLeft ? 'left' : 'right';
        }
      }

      this.updateTempWire(this.activeDrag.startPos, boardPos, fromDir, toDir);

      if (targetId) {
        if (store.canConnect(this.activeDrag.fromPinId, targetId)) {
          document.body.style.cursor = 'crosshair';
          if (activePinEl) {
            if (activePinEl.classList.contains('pin-connected')) {
              activePinEl.classList.add('pin-active');
            } else {
              activePinEl.classList.add('pin-ghost');
              const cardEl = activePinEl.closest('.note-card');
              const cardId = cardEl?.id.replace('card-dom-', '');
              const card = cardId ? store.state.cards.find(c => c.id === cardId) : null;
              if (!card?.headerColor && this.activeDrag.wireColor && this.activeDrag.wireColor !== '#98989d') {
                activePinEl.style.backgroundColor = this.activeDrag.wireColor;
                activePinEl.style.color = this.activeDrag.wireColor;
              }
            }
          }
          if (targetCapsule) targetCapsule.classList.add('target-highlight');
        } else {
          document.body.style.cursor = 'not-allowed';
        }
      } else {
        document.body.style.cursor = '';
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.activeDrag) return;
      document.body.classList.remove('is-wire-dragging');
      document.body.style.cursor = '';
      this.tempWireEl.style.display = 'none';
      document.querySelectorAll('.pin-active').forEach(el => el.classList.remove('pin-active'));
      document.querySelectorAll('.pin-ghost').forEach(el => {
        el.classList.remove('pin-ghost');
        const cardEl = el.closest('.note-card');
        const cardId = cardEl?.id.replace('card-dom-', '');
        const card = cardId ? store.state.cards.find(c => c.id === cardId) : null;
        if (!card?.headerColor && !el.classList.contains('pin-connected')) {
          el.style.backgroundColor = '';
          el.style.color = '';
        }
      });
      document.querySelectorAll('.target-highlight').forEach(el => el.classList.remove('target-highlight'));

      const hitEl = (e.clientX !== undefined && e.clientY !== undefined ? document.elementFromPoint(e.clientX, e.clientY) : null) || e.target;
      const targetSlot = hitEl?.closest ? hitEl.closest('.header-port-slot') : null;
      const targetPin = hitEl?.closest ? hitEl.closest('.capsule-pin, .header-pin') : null;
      const targetCapsule = hitEl?.closest ? hitEl.closest('.text-capsule') : null;
      const targetCard = hitEl?.closest ? hitEl.closest('.note-card') : null;
      let targetPinId = null;

      if (targetSlot) {
        targetPinId = targetSlot.querySelector('.header-pin')?.getAttribute('data-header-pin-id');
      } else if (targetPin) {
        targetPinId = targetPin.getAttribute('data-header-pin-id') || targetPin.closest('.text-capsule')?.getAttribute('data-pin-id');
      } else if (targetCapsule) {
        targetPinId = targetCapsule.getAttribute('data-pin-id');
      } else if (targetCard) {
        const rect = targetCard.getBoundingClientRect();
        const isLeft = e.clientX < rect.left + rect.width / 2;
        const pinEl = isLeft
          ? targetCard.querySelector('.header-pin-left')
          : targetCard.querySelector('.header-pin-right');
        targetPinId = pinEl?.getAttribute('data-header-pin-id');
      }

      const { type, connId, fromPinId, wireColor, moved } = this.activeDrag;

      if (targetPinId && store.canConnect(fromPinId, targetPinId)) {
        this.activeDrag = null;
        let finalColor = wireColor;
        if (!finalColor || finalColor === '#98989d') {
          const targetColor = this.resolvePinColor(targetPinId);
          if (targetColor) {
            finalColor = targetColor;
          }
        }
        if (type === 'RECONNECT') {
          store.reconnect(connId, targetPinId);
          if (finalColor && finalColor !== '#98989d') {
            const conn = store.state.connections.find(c => c.id === connId);
            if (conn && conn.color === '#98989d') conn.color = finalColor;
          }
        } else {
          store.addConnection(fromPinId, targetPinId, finalColor);
        }
        this.render();
      } else {
        if (type === 'RECONNECT' && !moved) {
          this.activeDrag = null;
          this.render();
        } else if (this.spawnNodeCallback) {
          const dropPos = canvas.screenToBoard(e.clientX, e.clientY);
          const dragInfo = this.activeDrag;
          this.activeDrag = null;
          this.showDropMenu(e.clientX, e.clientY, dropPos, dragInfo);
        } else {
          this.activeDrag = null;
          this.render();
        }
      }

      window.getSelection()?.removeAllRanges();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.pendingDrop) {
          this.dismissDropMenu(true);
        }
        if (this.activeDrag) {
          document.body.classList.remove('is-wire-dragging');
          document.body.style.cursor = '';
          this.tempWireEl.style.display = 'none';
          document.querySelectorAll('.pin-ghost').forEach(el => {
            el.classList.remove('pin-ghost');
            const cardEl = el.closest('.note-card');
            const cardId = cardEl?.id.replace('card-dom-', '');
            const card = cardId ? store.state.cards.find(c => c.id === cardId) : null;
            if (!card?.headerColor && !el.classList.contains('pin-connected')) {
              el.style.backgroundColor = '';
              el.style.color = '';
            }
          });
          this.activeDrag = null;
          this.render();
          window.getSelection()?.removeAllRanges();
        }
      }
    });
  }
}

export const wires = new WireManager();
