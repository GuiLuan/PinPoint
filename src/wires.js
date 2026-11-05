import { store } from './state.js';
import { canvas } from './canvas.js';

class WireManager {
  constructor() {
    this.svgEl = null;
    this.tempWireEl = null;
    this.connectionsGroupEl = null;
    this.activeDrag = null;
    this.spawnNodeCallback = null;
  }

  init(svgEl, spawnNodeCallback) {
    this.svgEl = svgEl;
    this.spawnNodeCallback = spawnNodeCallback;
    this.guidesGroupEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.guidesGroupEl.setAttribute('id', 'guides-group');
    this.svgEl.appendChild(this.guidesGroupEl);

    this.connectionsGroupEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.svgEl.appendChild(this.connectionsGroupEl);

    this.tempWireEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.tempWireEl.setAttribute('class', 'wire-temp');
    this.tempWireEl.style.display = 'none';
    this.svgEl.appendChild(this.tempWireEl);

    this.bindGlobalEvents();
  }

  getPinBoardPos(pinId) {
    let pinEl = document.querySelector(`[data-pin-id="${pinId}"] .capsule-pin`);
    if (!pinEl) {
      pinEl = document.querySelector(`[data-header-pin-id="${pinId}"]`);
    }
    if (!pinEl) return null;

    const rect = pinEl.getBoundingClientRect();
    const { x, y, zoom } = store.state.viewport;

    return {
      x: (rect.left + rect.width / 2 - x) / zoom,
      y: (rect.top + rect.height / 2 - y) / zoom
    };
  }

  createBezierPath(p1, p2) {
    const dx = p2.x - p1.x;
    let c1x, c1y, c2x, c2y;

    if (dx >= 0) {
      c1x = p1.x + Math.min(Math.max(dx * 0.45, 40), 120);
      c1y = p1.y;
      c2x = p2.x - Math.min(Math.max(dx * 0.45, 40), 120);
      c2y = p2.y;
    } else {
      const tension = Math.max(Math.abs(dx) * 0.5, 60);
      c1x = p1.x + tension;
      c1y = p1.y;
      c2x = p2.x - tension;
      c2y = p2.y;
    }

    return `M ${p1.x} ${p1.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }

  getBezierMidpoint(p1, p2) {
    const dx = p2.x - p1.x;
    let c1x, c1y, c2x, c2y;

    if (dx >= 0) {
      c1x = p1.x + Math.min(Math.max(dx * 0.45, 40), 120);
      c1y = p1.y;
      c2x = p2.x - Math.min(Math.max(dx * 0.45, 40), 120);
      c2y = p2.y;
    } else {
      const tension = Math.max(Math.abs(dx) * 0.5, 60);
      c1x = p1.x + tension;
      c1y = p1.y;
      c2x = p2.x - tension;
      c2y = p2.y;
    }

    const t = 0.5;
    const om = 1 - t;
    const x = Math.pow(om, 3) * p1.x + 3 * Math.pow(om, 2) * t * c1x + 3 * om * Math.pow(t, 2) * c2x + Math.pow(t, 3) * p2.x;
    const y = Math.pow(om, 3) * p1.y + 3 * Math.pow(om, 2) * t * c1y + 3 * om * Math.pow(t, 2) * c2y + Math.pow(t, 3) * p2.y;
    return { x, y };
  }

  render() {
    this.connectionsGroupEl.innerHTML = '';

    store.state.connections.forEach(conn => {
      const p1 = this.getPinBoardPos(conn.fromPinId);
      const p2 = this.getPinBoardPos(conn.toPinId);
      if (!p1 || !p2) return;

      const pathData = this.createBezierPath(p1, p2);
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
      const mid = this.getBezierMidpoint(p1, p2);
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
        window.getSelection()?.removeAllRanges();
        document.body.classList.add('is-wire-dragging');

        const startPos = this.getPinBoardPos(conn.fromPinId);
        if (!startPos) return;

        this.activeDrag = {
          type: 'RECONNECT',
          connId: conn.id,
          fromPinId: conn.fromPinId,
          startPos,
          wireColor: color
        };

        g.classList.add('wire-reconnecting');
        this.tempWireEl.style.display = 'block';
        this.tempWireEl.style.stroke = color;
        this.updateTempWire(startPos, canvas.screenToBoard(e.clientX, e.clientY));
      });

      hitZone.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.clearFocus();
        store.removeConnection(conn.id);
        this.render();
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
  }

  updateTempWire(p1, p2) {
    this.tempWireEl.setAttribute('d', this.createBezierPath(p1, p2));
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

  startConnect(fromPinId, startPos, color) {
    window.getSelection()?.removeAllRanges();
    document.body.classList.add('is-wire-dragging');
    this.activeDrag = {
      type: 'CONNECT',
      fromPinId,
      startPos,
      wireColor: color
    };
    this.tempWireEl.style.display = 'block';
    this.tempWireEl.style.stroke = color;
  }

  bindGlobalEvents() {
    window.addEventListener('selectstart', (e) => {
      if (document.body.classList.contains('is-wire-dragging') || this.activeDrag) {
        e.preventDefault();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.activeDrag) return;
      const boardPos = canvas.screenToBoard(e.clientX, e.clientY);
      this.updateTempWire(this.activeDrag.startPos, boardPos);

      document.querySelectorAll('.pin-active').forEach(el => el.classList.remove('pin-active'));
      document.querySelectorAll('.target-highlight').forEach(el => el.classList.remove('target-highlight'));

      const targetPin = e.target?.closest ? e.target.closest('.capsule-pin, .header-pin') : null;
      const targetCapsule = e.target?.closest ? e.target.closest('.text-capsule') : null;

      let targetId = null;
      if (targetPin) {
        targetId = targetPin.getAttribute('data-header-pin-id') || targetPin.closest('.text-capsule')?.getAttribute('data-pin-id');
      } else if (targetCapsule) {
        targetId = targetCapsule.getAttribute('data-pin-id');
      }

      if (targetId) {
        if (store.canConnect(this.activeDrag.fromPinId, targetId)) {
          document.body.style.cursor = 'crosshair';
          if (targetPin) targetPin.classList.add('pin-active');
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
      document.querySelectorAll('.target-highlight').forEach(el => el.classList.remove('target-highlight'));

      const targetPin = e.target?.closest ? e.target.closest('.capsule-pin, .header-pin') : null;
      const targetCapsule = e.target?.closest ? e.target.closest('.text-capsule') : null;
      let targetPinId = null;
      if (targetPin) {
        targetPinId = targetPin.getAttribute('data-header-pin-id') || targetPin.closest('.text-capsule')?.getAttribute('data-pin-id');
      } else if (targetCapsule) {
        targetPinId = targetCapsule.getAttribute('data-pin-id');
      }

      const { type, connId, fromPinId, wireColor } = this.activeDrag;

      if (targetPinId && store.canConnect(fromPinId, targetPinId)) {
        if (type === 'RECONNECT') {
          store.reconnect(connId, targetPinId);
        } else {
          store.addConnection(fromPinId, targetPinId, wireColor);
        }
      } else if (!targetPinId && this.spawnNodeCallback) {
        // Dragged to empty space: seamlessly spawn a pure node at cursor location!
        const dropPos = canvas.screenToBoard(e.clientX, e.clientY);
        const newNode = this.spawnNodeCallback(dropPos, true);
        const newHeadPinId = `pin-head-${newNode.id}`;

        if (type === 'RECONNECT') {
          store.reconnect(connId, newHeadPinId);
        } else {
          store.addConnection(fromPinId, newHeadPinId, wireColor);
        }
      }

      this.activeDrag = null;
      this.render();
      window.getSelection()?.removeAllRanges();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.activeDrag) {
        document.body.classList.remove('is-wire-dragging');
        document.body.style.cursor = '';
        this.tempWireEl.style.display = 'none';
        this.activeDrag = null;
        this.render();
        window.getSelection()?.removeAllRanges();
      }
    });
  }
}

export const wires = new WireManager();
