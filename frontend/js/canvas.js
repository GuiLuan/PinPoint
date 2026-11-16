import { store } from './state.js';
import { matchesShortcut } from './shortcuts.js';

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.5;

// Obsidian-like inertial physics & damping constants
const PAN_SAMPLE_WINDOW_MS = 95;
const PAN_STALE_RELEASE_MS = 45;
const PAN_FRICTION = 7.2;        // Exponential velocity decay (1/s) -> ~450ms smooth glide
const PAN_STOP_SPEED = 8;        // px/s threshold to stop inertia
const PAN_MAX_SPEED = 4500;      // px/s cap to prevent driver spikes

const ZOOM_SMOOTH_SPEED = 16;    // Exponential lerp rate (1/s) -> ~220ms silky ease
const ZOOM_WHEEL_SENSITIVITY = 0.00125;
const ZOOM_PINCH_SENSITIVITY = 0.0045;

const VIEWPORT_TWEEN_SPEED = 13; // Exponential lerp rate for fit-to-content / focus glide

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

class CanvasManager {
  constructor() {
    this.viewportEl = null;
    this.boardEl = null;
    this.dragAction = null;
    this.onTransform = null;
    this.isSpacePressed = false;

    // Velocity tracking for drag-release pan inertia
    this.panSamples = [];
    this.panVelocity = { x: 0, y: 0 };

    // Smooth wheel zoom target state
    this.zoomAnim = {
      active: false,
      targetZoom: 1.0,
      anchorX: 0,
      anchorY: 0
    };

    // Smooth viewport tween (used by fitToContent / animateToViewport)
    this.viewportTween = null;

    this.animRafId = null;
    this.lastAnimTime = 0;
  }

  init(viewportEl, boardEl) {
    this.viewportEl = viewportEl;
    this.boardEl = boardEl;
    this.zoomAnim.targetZoom = store.state.viewport.zoom || 1.0;
    this.applyTransform();
    this.bindEvents();

    const resetScroll = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
      if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0;
      if (document.documentElement.scrollLeft !== 0) document.documentElement.scrollLeft = 0;
      if (document.body.scrollTop !== 0) document.body.scrollTop = 0;
      if (document.body.scrollLeft !== 0) document.body.scrollLeft = 0;
      if (this.viewportEl && (this.viewportEl.scrollTop !== 0 || this.viewportEl.scrollLeft !== 0)) {
        this.viewportEl.scrollTop = 0;
        this.viewportEl.scrollLeft = 0;
      }
    };

    window.addEventListener('scroll', resetScroll, { passive: false, capture: true });
    this.viewportEl.addEventListener('scroll', resetScroll, { passive: false, capture: true });
  }

  _setAnimatingClass(active) {
    if (!this.boardEl) return;
    this.boardEl.classList.toggle('is-viewport-animating', !!active);
  }

  stopAnimations() {
    if (this.animRafId) {
      cancelAnimationFrame(this.animRafId);
      this.animRafId = null;
    }
    this.panVelocity.x = 0;
    this.panVelocity.y = 0;
    this.zoomAnim.active = false;
    this.zoomAnim.targetZoom = store.state.viewport.zoom || 1.0;
    this.viewportTween = null;
    this.lastAnimTime = 0;
    if (!this.dragAction) {
      this._setAnimatingClass(false);
    }
  }

  animateToViewport(target) {
    if (!target) return;
    const nextZoom = clamp(Number(target.zoom ?? store.state.viewport.zoom ?? 1.0), MIN_ZOOM, MAX_ZOOM);
    const nextX = Number(target.x ?? store.state.viewport.x ?? 0);
    const nextY = Number(target.y ?? store.state.viewport.y ?? 0);

    this.panVelocity.x = 0;
    this.panVelocity.y = 0;
    this.zoomAnim.active = false;
    this.zoomAnim.targetZoom = nextZoom;

    this.viewportTween = { x: nextX, y: nextY, zoom: nextZoom };
    this._ensureAnimLoop();
  }

  _stepAnimation(now = performance.now()) {
    const rawDt = (now - this.lastAnimTime) / 1000;
    this.lastAnimTime = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);

    let changed = false;
    const vp = store.state.viewport;

    // 1. Programmatic smooth viewport tween (e.g. fitToContent)
    if (this.viewportTween) {
      const t = 1 - Math.exp(-VIEWPORT_TWEEN_SPEED * dt);
      const dx = this.viewportTween.x - vp.x;
      const dy = this.viewportTween.y - vp.y;
      const logCurr = Math.log(Math.max(vp.zoom, MIN_ZOOM));
      const logTarget = Math.log(Math.max(this.viewportTween.zoom, MIN_ZOOM));
      const dLogZ = logTarget - logCurr;

      if (Math.hypot(dx, dy) < 0.35 && Math.abs(dLogZ) < 0.0005) {
        vp.x = this.viewportTween.x;
        vp.y = this.viewportTween.y;
        vp.zoom = this.viewportTween.zoom;
        this.viewportTween = null;
      } else {
        vp.x += dx * t;
        vp.y += dy * t;
        vp.zoom = Math.exp(logCurr + dLogZ * t);
      }
      changed = true;
    }

    // 2. Drag-release pan inertia (exponential decay)
    const speed = Math.hypot(this.panVelocity.x, this.panVelocity.y);
    if (speed > 0 && !this.dragAction) {
      if (speed < PAN_STOP_SPEED) {
        this.panVelocity.x = 0;
        this.panVelocity.y = 0;
      } else {
        const decay = Math.exp(-PAN_FRICTION * dt);
        const integralFactor = (1 - decay) / PAN_FRICTION;
        vp.x += this.panVelocity.x * integralFactor;
        vp.y += this.panVelocity.y * integralFactor;
        this.panVelocity.x *= decay;
        this.panVelocity.y *= decay;
        changed = true;
      }
    }

    // 3. Smooth wheel zoom in log-zoom space, pinned around cursor anchor
    if (this.zoomAnim.active) {
      const currZoom = Math.max(vp.zoom, MIN_ZOOM);
      const logCurr = Math.log(currZoom);
      const logTarget = Math.log(this.zoomAnim.targetZoom);
      const logDiff = logTarget - logCurr;

      let nextZoom;
      if (Math.abs(logDiff) < 0.0004) {
        nextZoom = this.zoomAnim.targetZoom;
        this.zoomAnim.active = false;
      } else {
        const t = 1 - Math.exp(-ZOOM_SMOOTH_SPEED * dt);
        nextZoom = Math.exp(logCurr + logDiff * t);
      }

      const ratio = nextZoom / currZoom;
      const prevX = vp.x;
      const prevY = vp.y;
      vp.x = this.zoomAnim.anchorX - (this.zoomAnim.anchorX - vp.x) * ratio;
      vp.y = this.zoomAnim.anchorY - (this.zoomAnim.anchorY - vp.y) * ratio;
      if (this.dragAction?.type === 'PAN') {
        this.dragAction.initViewX += (vp.x - prevX);
        this.dragAction.initViewY += (vp.y - prevY);
      }
      vp.zoom = nextZoom;
      changed = true;
    }

    if (changed) {
      this.applyTransform();
    }

    const stillRunning =
      Boolean(this.viewportTween) ||
      this.zoomAnim.active ||
      (!this.dragAction && Math.hypot(this.panVelocity.x, this.panVelocity.y) >= PAN_STOP_SPEED);

    if (!stillRunning) {
      this.panVelocity.x = 0;
      this.panVelocity.y = 0;
      if (!this.dragAction) {
        this._setAnimatingClass(false);
      }
      store.scheduleAutoSave();
    }

    return stillRunning;
  }

  _ensureAnimLoop() {
    if (this.animRafId) return;
    this.lastAnimTime = performance.now();
    this._setAnimatingClass(true);

    const step = (now) => {
      if (this._stepAnimation(now)) {
        this.animRafId = requestAnimationFrame(step);
      } else {
        this.animRafId = null;
      }
    };

    this.animRafId = requestAnimationFrame(step);
  }

  _recordPanSample(clientX, clientY, now = performance.now()) {
    this.panSamples.push({ x: clientX, y: clientY, t: now });
    const cutoff = now - PAN_SAMPLE_WINDOW_MS;
    while (this.panSamples.length > 2 && this.panSamples[0].t < cutoff) {
      this.panSamples.shift();
    }
  }

  _computeReleaseVelocity(now = performance.now()) {
    if (this.panSamples.length < 2) return { x: 0, y: 0 };
    const latest = this.panSamples[this.panSamples.length - 1];
    if (now - latest.t > PAN_STALE_RELEASE_MS) {
      return { x: 0, y: 0 };
    }
    const cutoff = now - PAN_SAMPLE_WINDOW_MS;
    let oldest = this.panSamples[0];
    for (let i = 0; i < this.panSamples.length - 1; i++) {
      if (this.panSamples[i].t >= cutoff) {
        oldest = this.panSamples[i];
        break;
      }
    }
    const dtSec = (latest.t - oldest.t) / 1000;
    if (dtSec <= 0.004) return { x: 0, y: 0 };

    let vx = (latest.x - oldest.x) / dtSec;
    let vy = (latest.y - oldest.y) / dtSec;
    const speed = Math.hypot(vx, vy);
    if (speed > PAN_MAX_SPEED) {
      const scale = PAN_MAX_SPEED / speed;
      vx *= scale;
      vy *= scale;
    }
    return { x: vx, y: vy };
  }

  applyTransform() {
    const { x, y, zoom } = store.state.viewport;
    this.boardEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;

    const tex = store.getAppearanceSettings?.().canvasTexture || 'dots';
    const minorSize = 24 * zoom;
    if (tex === 'solid') {
      this.viewportEl.style.backgroundSize = '';
      this.viewportEl.style.backgroundPosition = '';
    } else if (tex === 'dots') {
      this.viewportEl.style.backgroundSize = `${minorSize}px ${minorSize}px`;
      this.viewportEl.style.backgroundPosition = `${x}px ${y}px`;
    } else {
      this.viewportEl.style.backgroundSize = `${minorSize}px ${minorSize}px, ${minorSize}px ${minorSize}px`;
      this.viewportEl.style.backgroundPosition = `${x}px ${y}px, ${x}px ${y}px`;
    }

    if (this.onTransform) this.onTransform();
  }

  screenToBoard(clientX, clientY) {
    const { x, y, zoom } = store.state.viewport;
    return {
      x: (clientX - x) / zoom,
      y: (clientY - y) / zoom
    };
  }

  boardToScreen(boardX, boardY) {
    const { x, y, zoom } = store.state.viewport;
    return {
      x: boardX * zoom + x,
      y: boardY * zoom + y
    };
  }

  bindEvents() {
    this.viewportEl.addEventListener('mousedown', () => {
      // Any mouse interaction inside the viewport stops leftover pan glide or fit tween immediately
      if (this.panVelocity.x !== 0 || this.panVelocity.y !== 0 || this.viewportTween) {
        this.panVelocity.x = 0;
        this.panVelocity.y = 0;
        this.viewportTween = null;
      }
    }, { capture: true });

    this.viewportEl.addEventListener('mousedown', (e) => {
      const isCanvasBackground = e.target === this.viewportEl ||
                                 e.target === this.boardEl ||
                                 e.target.id === 'wire-svg';
      const isPanOnGroup = (e.button === 1 || this.isSpacePressed) && e.target.closest?.('.node-group');
      if (!isCanvasBackground && !isPanOnGroup) return;

      if (e.button === 1 || this.isSpacePressed) {
        e.preventDefault();
        this.panSamples = [];
        this._recordPanSample(e.clientX, e.clientY);
        this._setAnimatingClass(true);
        this.dragAction = {
          type: 'PAN',
          startX: e.clientX,
          startY: e.clientY,
          initViewX: store.state.viewport.x,
          initViewY: store.state.viewport.y
        };
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.dragAction || this.dragAction.type !== 'PAN') return;
      this.viewportEl.style.cursor = 'grabbing';
      const dx = e.clientX - this.dragAction.startX;
      const dy = e.clientY - this.dragAction.startY;
      store.state.viewport.x = this.dragAction.initViewX + dx;
      store.state.viewport.y = this.dragAction.initViewY + dy;
      this._recordPanSample(e.clientX, e.clientY);
      this.applyTransform();
    });

    window.addEventListener('mouseup', () => {
      if (this.dragAction?.type === 'PAN') {
        this.dragAction = null;
        this.viewportEl.style.cursor = this.isSpacePressed ? 'grab' : '';
        const vel = this._computeReleaseVelocity();
        this.panSamples = [];
        if (Math.hypot(vel.x, vel.y) > 35) {
          this.panVelocity = vel;
          this._ensureAnimLoop();
        } else {
          if (!this.zoomAnim.active && !this.viewportTween) {
            this._setAnimatingClass(false);
          }
          store.scheduleAutoSave();
        }
      }
    });

    this.viewportEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.viewportTween = null;

      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 32;
      else if (e.deltaMode === 2) dy *= 400;
      if (dy === 0) return;
      dy = clamp(dy, -240, 240);

      const sensitivity = e.ctrlKey ? ZOOM_PINCH_SENSITIVITY : ZOOM_WHEEL_SENSITIVITY;
      const zoomFactor = Math.exp(-dy * sensitivity);

      const baseTarget = this.zoomAnim.active
        ? this.zoomAnim.targetZoom
        : (store.state.viewport.zoom || 1.0);

      this.zoomAnim.targetZoom = clamp(baseTarget * zoomFactor, MIN_ZOOM, MAX_ZOOM);
      this.zoomAnim.anchorX = e.clientX;
      this.zoomAnim.anchorY = e.clientY;
      this.zoomAnim.active = true;

      this._ensureAnimLoop();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (window.__settings?.isRecordingShortcut?.()) return;
      const isEditingText = e.target?.closest?.('input, textarea, [contenteditable="true"]');
      if (e.code === 'Space' && !e.repeat && !isEditingText) {
        this.isSpacePressed = true;
        this.viewportEl.style.cursor = 'grab';
      }
      if (matchesShortcut(e, store.getShortcut('saveGraph'))) {
        e.preventDefault();
        window.__sync?.saveAllToBackend?.({ manual: true });
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.isSpacePressed = false;
        if (!this.dragAction) this.viewportEl.style.cursor = '';
      }
    });
  }
}

export const canvas = new CanvasManager();
