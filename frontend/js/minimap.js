import { store } from './state.js';
import { canvas } from './canvas.js';
import { nodes } from './nodes.js';

class MinimapManager {
  constructor() {
    this.containerEl = null;
    this.canvasContainerEl = null;
    this.canvasEl = null;
    this.ctx = null;
    this.viewportBoxEl = null;

    this.isDraggingViewport = false;
    this.isDirectNavigating = false;
    this.dragStartMouse = { x: 0, y: 0 };
    this.dragStartVp = { x: 0, y: 0 };
    this.dragScale = 1;
    this.navBounds = null;
    this.lastWorldBounds = null;
    this.rafId = null;
  }

  init(containerEl) {
    this.containerEl = containerEl || document.getElementById('minimap-widget');
    if (!this.containerEl) return;

    this.canvasContainerEl = this.containerEl.querySelector('#minimap-canvas-container');
    this.canvasEl = this.containerEl.querySelector('#minimap-canvas');
    this.viewportBoxEl = this.containerEl.querySelector('#minimap-viewport-indicator');
    if (this.canvasEl) {
      this.ctx = this.canvasEl.getContext('2d');
    }

    // Stop context menu and canvas pan on the widget
    this.containerEl.addEventListener('contextmenu', (e) => e.stopPropagation());
    this.containerEl.addEventListener('mousedown', (e) => e.stopPropagation());

    // Dragging the viewport indicator
    this.viewportBoxEl?.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.isDraggingViewport = true;
      this.dragStartMouse = { x: e.clientX, y: e.clientY };
      this.dragStartVp = { x: store.state.viewport.x, y: store.state.viewport.y };
      // Lock the scale at the moment drag starts to prevent feedback divergence
      this.dragScale = this.lastWorldBounds?.scale || 1;
      this.viewportBoxEl.classList.add('is-dragging');
    });

    // Clicking / dragging on canvas container to navigate directly
    this.canvasContainerEl?.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target === this.viewportBoxEl) return;
      e.preventDefault();
      e.stopPropagation();
      this.isDirectNavigating = true;
      // Lock navigation bounds at mousedown
      this.navBounds = this.lastWorldBounds ? { ...this.lastWorldBounds } : null;
      this.navigateWorldFromMini(e.clientX, e.clientY);
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDraggingViewport) {
        const dx = e.clientX - this.dragStartMouse.x;
        const dy = e.clientY - this.dragStartMouse.y;
        const scale = this.dragScale || 1;
        if (scale > 0) {
          store.state.viewport.x = this.dragStartVp.x - (dx / scale) * store.state.viewport.zoom;
          store.state.viewport.y = this.dragStartVp.y - (dy / scale) * store.state.viewport.zoom;
          canvas.applyTransform();
        }
      } else if (this.isDirectNavigating) {
        this.navigateWorldFromMini(e.clientX, e.clientY);
      }
    });

    window.addEventListener('mouseup', () => {
      if (this.isDraggingViewport || this.isDirectNavigating) {
        this.isDraggingViewport = false;
        this.isDirectNavigating = false;
        this.navBounds = null;
        this.viewportBoxEl?.classList.remove('is-dragging');
        store.scheduleAutoSave();
      }
    });

    // Header buttons
    const btnFit = this.containerEl.querySelector('#btn-minimap-fit');
    btnFit?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.fitToContent();
    });

    const btnClose = this.containerEl.querySelector('#btn-minimap-close');
    btnClose?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      store.toggleMinimap();
    });

    window.addEventListener('resize', () => {
      this.requestRender();
    });

    this.checkAndHealViewport();
    this.applySettings();
  }

  // Self-heal: If viewport was saved to millions of pixels away, bring it back to center
  checkAndHealViewport() {
    const cards = store.state.cards;
    if (!cards || cards.length === 0) return;
    const { x, y, zoom } = store.state.viewport;
    if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y) || isNaN(zoom) || zoom <= 0) {
      this.fitToContent();
      return;
    }

    let avgX = 0, avgY = 0;
    for (const c of cards) {
      avgX += (typeof c.x === 'number' && !isNaN(c.x) ? c.x : 0);
      avgY += (typeof c.y === 'number' && !isNaN(c.y) ? c.y : 0);
    }
    avgX /= cards.length;
    avgY /= cards.length;

    const screenCenterX = (-x + window.innerWidth / 2) / zoom;
    const screenCenterY = (-y + window.innerHeight / 2) / zoom;
    const dist = Math.hypot(screenCenterX - avgX, screenCenterY - avgY);
    if (dist > 8000) {
      this.fitToContent();
    }
  }

  applySettings() {
    if (!this.containerEl) return;
    const settings = store.getMinimapSettings();

    // Position class (always update even if disabled)
    const validPositions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    validPositions.forEach(p => this.containerEl.classList.remove(`pos-${p}`));
    const pos = validPositions.includes(settings.position) ? settings.position : 'bottom-right';
    this.containerEl.classList.add(`pos-${pos}`);

    // Size (always update even if disabled)
    const size = Math.max(140, Math.min(320, settings.size || 220));
    const canvasHeight = Math.round(size * 0.62);
    this.containerEl.style.setProperty('--minimap-width', `${size}px`);
    this.containerEl.style.setProperty('--minimap-canvas-height', `${canvasHeight}px`);

    // Enabled state
    if (!settings.enabled) {
      this.containerEl.style.display = 'none';
      return;
    }
    this.containerEl.style.display = 'flex';

    this.requestRender();
  }

  requestRender() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  navigateWorldFromMini(clientX, clientY) {
    const bounds = this.navBounds || this.lastWorldBounds;
    if (!bounds || !this.canvasContainerEl) return;
    const rect = this.canvasContainerEl.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const { minX, minY, scale, offsetX, offsetY } = bounds;
    if (scale <= 0) return;
    const worldX = minX + (mx - offsetX) / scale;
    const worldY = minY + (my - offsetY) / scale;

    store.state.viewport.x = window.innerWidth / 2 - worldX * store.state.viewport.zoom;
    store.state.viewport.y = window.innerHeight / 2 - worldY * store.state.viewport.zoom;
    canvas.applyTransform();
  }

  fitToContent() {
    const cards = store.state.cards;
    if (!cards || cards.length === 0) {
      store.state.viewport.x = 0;
      store.state.viewport.y = 0;
      store.state.viewport.zoom = 1.0;
      canvas.applyTransform();
      store.scheduleAutoSave();
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const card of cards) {
      const cardEl = document.getElementById(`card-dom-${card.id}`);
      const h = cardEl ? cardEl.offsetHeight : 180;
      const w = card.width || 320;
      minX = Math.min(minX, card.x);
      minY = Math.min(minY, card.y);
      maxX = Math.max(maxX, card.x + w);
      maxY = Math.max(maxY, card.y + h);
    }

    if (store.state.groups) {
      for (const g of store.state.groups) {
        minX = Math.min(minX, g.x);
        minY = Math.min(minY, g.y);
        maxX = Math.max(maxX, g.x + g.width);
        maxY = Math.max(maxY, g.y + g.height);
      }
    }

    const padding = 120;
    const contentW = (maxX - minX) + padding * 2;
    const contentH = (maxY - minY) + padding * 2;
    const availW = window.innerWidth;
    const availH = window.innerHeight;

    const zoom = Math.min(Math.max(Math.min(availW / contentW, availH / contentH), 0.35), 1.3);
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    store.state.viewport.zoom = zoom;
    store.state.viewport.x = availW / 2 - midX * zoom;
    store.state.viewport.y = availH / 2 - midY * zoom;
    canvas.applyTransform();
    store.scheduleAutoSave();
  }

  getPinWorldCenter(pinId) {
    if (!pinId) return null;
    const pinEl = document.querySelector(`[data-pin-id="${pinId}"]`);
    if (pinEl) {
      const rect = pinEl.getBoundingClientRect();
      return canvas.screenToBoard(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
    const cardId = store.findCardIdByPin(pinId);
    const card = store.state.cards.find(c => c.id === cardId);
    if (card) {
      return { x: card.x + (card.width || 320) / 2, y: card.y + 40 };
    }
    return null;
  }

  drawRoundRect(ctx, x, y, w, h, r = 3) {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  drawTopRoundedRect(ctx, x, y, w, h, r = 3) {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, [r, r, 0, 0]);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  render() {
    if (!this.containerEl || this.containerEl.style.display === 'none') return;
    if (!this.canvasEl || !this.ctx || !this.canvasContainerEl) return;

    const W = this.canvasContainerEl.clientWidth;
    const H = this.canvasContainerEl.clientHeight;
    if (W <= 0 || H <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    if (this.canvasEl.width !== Math.round(W * dpr) || this.canvasEl.height !== Math.round(H * dpr)) {
      this.canvasEl.width = Math.round(W * dpr);
      this.canvasEl.height = Math.round(H * dpr);
    }

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.ctx.clearRect(0, 0, W, H);

    // Current viewport in world space
    let { x, y, zoom } = store.state.viewport;
    if (typeof x !== 'number' || isNaN(x)) x = 0;
    if (typeof y !== 'number' || isNaN(y)) y = 0;
    if (typeof zoom !== 'number' || isNaN(zoom) || zoom <= 0) zoom = 1.0;

    const vpW = window.innerWidth / zoom;
    const vpH = window.innerHeight / zoom;
    const vpL = -x / zoom;
    const vpT = -y / zoom;
    const vpR = vpL + vpW;
    const vpB = vpT + vpH;

    // 1. Calculate Content Bounds (Cards + Groups)
    let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity;
    const cards = store.state.cards || [];
    for (const card of cards) {
      const cw = card.width || 320;
      const cardEl = document.getElementById(`card-dom-${card.id}`);
      const ch = cardEl ? cardEl.offsetHeight : 180;
      cMinX = Math.min(cMinX, card.x);
      cMinY = Math.min(cMinY, card.y);
      cMaxX = Math.max(cMaxX, card.x + cw);
      cMaxY = Math.max(cMaxY, card.y + ch);
    }

    if (store.state.groups) {
      for (const g of store.state.groups) {
        cMinX = Math.min(cMinX, g.x);
        cMinY = Math.min(cMinY, g.y);
        cMaxX = Math.max(cMaxX, g.x + g.width);
        cMaxY = Math.max(cMaxY, g.y + g.height);
      }
    }

    // Fallback if canvas has no cards
    if (!isFinite(cMinX) || !isFinite(cMaxX)) {
      cMinX = vpL;
      cMinY = vpT;
      cMaxX = vpR;
      cMaxY = vpB;
    }

    // 2. Determine Minimap World Bounds
    // Content is primary: we ensure content is always well-sized and visible in the minimap.
    // Include viewport if nearby, but don't let a distant viewport collapse the content!
    const contentW = Math.max(cMaxX - cMinX, 200);
    const contentH = Math.max(cMaxY - cMinY, 200);
    const maxExtensionX = contentW * 1.5 + vpW;
    const maxExtensionY = contentH * 1.5 + vpH;

    let minX = Math.min(cMinX, Math.max(cMinX - maxExtensionX, vpL));
    let minY = Math.min(cMinY, Math.max(cMinY - maxExtensionY, vpT));
    let maxX = Math.max(cMaxX, Math.min(cMaxX + maxExtensionX, vpR));
    let maxY = Math.max(cMaxY, Math.min(cMaxY + maxExtensionY, vpB));

    // Padding around bounds
    const padX = Math.max((maxX - minX) * 0.1, 120);
    const padY = Math.max((maxY - minY) * 0.1, 120);
    minX -= padX;
    minY -= padY;
    maxX += padX;
    maxY += padY;

    const worldW = Math.max(maxX - minX, 100);
    const worldH = Math.max(maxY - minY, 100);
    const scale = Math.min(W / worldW, H / worldH);
    const offsetX = (W - worldW * scale) / 2;
    const offsetY = (H - worldH * scale) / 2;

    this.lastWorldBounds = { minX, minY, maxX, maxY, scale, offsetX, offsetY, W, H };

    // 1. Draw Groups
    if (store.state.groups && store.state.groups.length > 0) {
      this.ctx.save();
      for (const g of store.state.groups) {
        const gx = offsetX + (g.x - minX) * scale;
        const gy = offsetY + (g.y - minY) * scale;
        const gw = g.width * scale;
        const gh = g.height * scale;
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([2, 2]);
        this.drawRoundRect(this.ctx, gx, gy, gw, gh, 3);
        this.ctx.fill();
        this.ctx.stroke();
      }
      this.ctx.restore();
    }

    // 2. Draw Connections
    if (store.state.connections && store.state.connections.length > 0) {
      this.ctx.save();
      this.ctx.lineWidth = 1;
      for (const conn of store.state.connections) {
        const p1 = this.getPinWorldCenter(conn.fromPinId);
        const p2 = this.getPinWorldCenter(conn.toPinId);
        if (p1 && p2) {
          const m1x = offsetX + (p1.x - minX) * scale;
          const m1y = offsetY + (p1.y - minY) * scale;
          const m2x = offsetX + (p2.x - minX) * scale;
          const m2y = offsetY + (p2.y - minY) * scale;
          this.ctx.strokeStyle = conn.color || '#30d158';
          this.ctx.beginPath();
          this.ctx.moveTo(m1x, m1y);
          const dx = (m2x - m1x) * 0.5;
          this.ctx.bezierCurveTo(m1x + dx, m1y, m2x - dx, m2y, m2x, m2y);
          this.ctx.stroke();
        }
      }
      this.ctx.restore();
    }

    // 3. Draw Cards
    this.ctx.save();
    const defaultColor = store.getPalette()[0] || '#30d158';
    for (const card of cards) {
      const cw = card.width || 320;
      const cardEl = document.getElementById(`card-dom-${card.id}`);
      const ch = cardEl ? cardEl.offsetHeight : 180;
      const cx = offsetX + (card.x - minX) * scale;
      const cy = offsetY + (card.y - minY) * scale;
      const mw = Math.max(cw * scale, 5);
      const mh = Math.max(ch * scale, 4);
      const radius = Math.min(2.5, mw / 2);

      // Card body background
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      this.drawRoundRect(this.ctx, cx, cy, mw, mh, radius);
      this.ctx.fill();

      // Card header bar
      const headerH = Math.max(mh * 0.28, 2.5);
      this.ctx.fillStyle = card.headerColor || defaultColor;
      this.drawTopRoundedRect(this.ctx, cx, cy, mw, headerH, radius);
      this.ctx.fill();

      // Selection or normal border
      const isSelected = nodes?.selectedCardIds?.has(card.id);
      if (isSelected) {
        this.ctx.strokeStyle = '#0a84ff';
        this.ctx.lineWidth = 1.5;
        this.drawRoundRect(this.ctx, cx - 0.5, cy - 0.5, mw + 1, mh + 1, radius);
        this.ctx.stroke();
      } else {
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        this.ctx.lineWidth = 0.75;
        this.drawRoundRect(this.ctx, cx, cy, mw, mh, radius);
        this.ctx.stroke();
      }
    }
    this.ctx.restore();

    // 4. Update Viewport Indicator
    if (this.viewportBoxEl) {
      let vpMiniX = offsetX + (vpL - minX) * scale;
      let vpMiniY = offsetY + (vpT - minY) * scale;
      let vpMiniW = vpW * scale;
      let vpMiniH = vpH * scale;

      // Ensure minimum visible size for the viewport indicator
      vpMiniW = Math.max(vpMiniW, 10);
      vpMiniH = Math.max(vpMiniH, 8);

      // Clamp position so indicator is kept visible within minimap container
      const clampedX = Math.max(-vpMiniW + 12, Math.min(vpMiniX, W - 12));
      const clampedY = Math.max(-vpMiniH + 12, Math.min(vpMiniY, H - 12));

      this.viewportBoxEl.style.left = `${clampedX}px`;
      this.viewportBoxEl.style.top = `${clampedY}px`;
      this.viewportBoxEl.style.width = `${vpMiniW}px`;
      this.viewportBoxEl.style.height = `${vpMiniH}px`;
    }
  }
}

export const minimap = new MinimapManager();
