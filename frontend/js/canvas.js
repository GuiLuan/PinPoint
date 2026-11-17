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
const ZOOM_PINCH_SENSITIVITY = 0.005;

const WHEEL_STREAM_TIMEOUT_MS = 260;
const WHEEL_PAN_IDLE_SAVE_MS = 180;
const WHEEL_PAN_MAX_DELTA = 420;

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

    // Trackpad / wheel / touch gesture state
    this._wheelStreamMode = null;
    this._lastWheelTime = 0;
    this._wheelPanIdleTimer = null;
    this._safariGesture = null;
    this._touchGesture = null;
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
    if (this._wheelPanIdleTimer) {
      clearTimeout(this._wheelPanIdleTimer);
      this._wheelPanIdleTimer = null;
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

  _normalizeWheelDeltas(e) {
    let dx = e.deltaX || 0;
    let dy = e.deltaY || 0;
    if (e.deltaMode === 1) {
      dx *= 32;
      dy *= 32;
    } else if (e.deltaMode === 2) {
      dx *= 400;
      dy *= 400;
    }
    // Shift + vertical wheel maps to horizontal pan on systems that don't remap it natively
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && dx === 0 && dy !== 0) {
      dx = dy;
      dy = 0;
    }
    return { dx, dy };
  }

  _isDiscreteMouseWheel(e) {
    if (e.deltaMode !== 0) return true;
    if (e.deltaX !== 0) return false;
    if (!Number.isInteger(e.deltaY)) return false;
    const absY = Math.abs(e.deltaY);
    if (absY < 48) return false;
    if (typeof e.wheelDeltaY === 'number' && e.wheelDeltaY !== 0) {
      return Math.abs(e.wheelDeltaY) % 120 === 0;
    }
    return absY % 100 === 0 || absY % 120 === 0;
  }

  _classifyWheelIntent(e) {
    if (e.ctrlKey || e.metaKey) return 'zoom';

    const wheelMode = store.getNavigationSettings?.().wheelMode || 'auto';
    if (wheelMode === 'trackpad') return 'pan';
    if (wheelMode === 'mouse') {
      if (e.shiftKey) return 'pan';
      if (e.deltaX !== 0 && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return 'pan';
      return 'zoom';
    }

    // 'auto' mode: distinguish trackpad two-finger swipe from notched mouse wheel
    const now = performance.now();
    const withinStream = Boolean(this._wheelStreamMode) && (now - this._lastWheelTime) < WHEEL_STREAM_TIMEOUT_MS;
    this._lastWheelTime = now;

    if (e.shiftKey) {
      this._wheelStreamMode = 'pan';
      return 'pan';
    }
    if (e.deltaMode !== 0) {
      this._wheelStreamMode = 'zoom';
      return 'zoom';
    }
    if (!this._isDiscreteMouseWheel(e)) {
      this._wheelStreamMode = 'pan';
      return 'pan';
    }
    if (withinStream && this._wheelStreamMode === 'pan') {
      return 'pan';
    }
    this._wheelStreamMode = 'zoom';
    return 'zoom';
  }

  _canScrollElement(target, dx, dy) {
    let el = target;
    while (el && el !== this.viewportEl && el !== document.body) {
      if (el instanceof Element) {
        const style = getComputedStyle(el);
        const overflowY = style.overflowY;
        const overflowX = style.overflowX;
        if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
          if ((dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) ||
              (dy < 0 && el.scrollTop > 1)) {
            return true;
          }
        }
        if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) {
          if ((dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) ||
              (dx < 0 && el.scrollLeft > 1)) {
            return true;
          }
        }
      }
      el = el.parentElement;
    }
    return false;
  }

  _scheduleWheelPanIdle() {
    if (this._wheelPanIdleTimer) clearTimeout(this._wheelPanIdleTimer);
    this._wheelPanIdleTimer = setTimeout(() => {
      this._wheelPanIdleTimer = null;
      if (!this.dragAction && !this.zoomAnim.active && !this.viewportTween &&
          Math.hypot(this.panVelocity.x, this.panVelocity.y) < PAN_STOP_SPEED) {
        this._setAnimatingClass(false);
        store.scheduleAutoSave();
      }
    }, WHEEL_PAN_IDLE_SAVE_MS);
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
      this._wheelStreamMode = null;
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
      if (e.target?.closest?.('.note-card.is-webpage-interactive')) {
        return;
      }

      const { dx, dy } = this._normalizeWheelDeltas(e);

      // Allow inner scrollable containers (when not zooming) to scroll normally
      if (!e.ctrlKey && !e.metaKey && this._canScrollElement(e.target, dx, dy)) {
        return;
      }

      e.preventDefault();

      // Avoid double-zooming on Safari when gesture* events handle the pinch
      if ((e.ctrlKey || e.metaKey) && this._safariGesture?.active) {
        return;
      }

      const intent = this._classifyWheelIntent(e);

      if (intent === 'pan') {
        if (dx === 0 && dy === 0) return;
        const clampedDx = clamp(dx, -WHEEL_PAN_MAX_DELTA, WHEEL_PAN_MAX_DELTA);
        const clampedDy = clamp(dy, -WHEEL_PAN_MAX_DELTA, WHEEL_PAN_MAX_DELTA);
        this.viewportTween = null;
        this.panVelocity.x = 0;
        this.panVelocity.y = 0;
        store.state.viewport.x -= clampedDx;
        store.state.viewport.y -= clampedDy;
        if (this.dragAction?.type === 'PAN') {
          this.dragAction.initViewX -= clampedDx;
          this.dragAction.initViewY -= clampedDy;
        }
        this._setAnimatingClass(true);
        this.applyTransform();
        this._scheduleWheelPanIdle();
        return;
      }

      this.viewportTween = null;
      if (dy === 0) return;
      const clampedZoomDy = clamp(dy, -240, 240);

      const isTrackpadPinch = e.ctrlKey && !e.metaKey && !this._isDiscreteMouseWheel(e);
      const sensitivity = isTrackpadPinch ? ZOOM_PINCH_SENSITIVITY : ZOOM_WHEEL_SENSITIVITY;
      const zoomFactor = Math.exp(-clampedZoomDy * sensitivity);

      const baseTarget = this.zoomAnim.active
        ? this.zoomAnim.targetZoom
        : (store.state.viewport.zoom || 1.0);

      this.zoomAnim.targetZoom = clamp(baseTarget * zoomFactor, MIN_ZOOM, MAX_ZOOM);
      this.zoomAnim.anchorX = e.clientX;
      this.zoomAnim.anchorY = e.clientY;
      this.zoomAnim.active = true;

      this._ensureAnimLoop();
    }, { passive: false });

    // Safari macOS trackpad pinch gestures
    this.viewportEl.addEventListener('gesturestart', (e) => {
      if (e.target?.closest?.('.note-card.is-webpage-interactive')) return;
      e.preventDefault();
      this.viewportTween = null;
      this._safariGesture = {
        active: true,
        lastScale: e.scale || 1
      };
      this._setAnimatingClass(true);
    }, { passive: false });

    this.viewportEl.addEventListener('gesturechange', (e) => {
      if (!this._safariGesture?.active) return;
      e.preventDefault();
      const scale = e.scale || 1;
      const ratio = scale / (this._safariGesture.lastScale || 1);
      this._safariGesture.lastScale = scale;
      if (!Number.isFinite(ratio) || ratio <= 0) return;

      const baseTarget = this.zoomAnim.active
        ? this.zoomAnim.targetZoom
        : (store.state.viewport.zoom || 1.0);

      this.zoomAnim.targetZoom = clamp(baseTarget * ratio, MIN_ZOOM, MAX_ZOOM);
      this.zoomAnim.anchorX = e.clientX ?? (window.innerWidth / 2);
      this.zoomAnim.anchorY = e.clientY ?? (window.innerHeight / 2);
      this.zoomAnim.active = true;
      this._ensureAnimLoop();
    }, { passive: false });

    const endSafariGesture = (e) => {
      if (!this._safariGesture?.active) return;
      e.preventDefault();
      this._safariGesture = null;
    };
    this.viewportEl.addEventListener('gestureend', endSafariGesture, { passive: false });

    // Touchscreen two-finger pan & pinch-to-zoom
    const getTouchPairMetrics = (t0, t1) => ({
      midX: (t0.clientX + t1.clientX) / 2,
      midY: (t0.clientY + t1.clientY) / 2,
      dist: Math.max(1, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY))
    });

    this.viewportEl.addEventListener('touchstart', (e) => {
      if (e.target?.closest?.('.note-card.is-webpage-interactive')) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        this.viewportTween = null;
        this.panVelocity.x = 0;
        this.panVelocity.y = 0;
        this.zoomAnim.active = false;
        this._touchGesture = getTouchPairMetrics(e.touches[0], e.touches[1]);
        this._setAnimatingClass(true);
      } else {
        this._touchGesture = null;
      }
    }, { passive: false });

    this.viewportEl.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2 || !this._touchGesture) return;
      e.preventDefault();
      const next = getTouchPairMetrics(e.touches[0], e.touches[1]);
      const prev = this._touchGesture;

      const vp = store.state.viewport;
      const currZoom = Math.max(vp.zoom || 1.0, MIN_ZOOM);
      const scaleRatio = next.dist / prev.dist;
      const nextZoom = clamp(currZoom * scaleRatio, MIN_ZOOM, MAX_ZOOM);
      const appliedRatio = nextZoom / currZoom;

      vp.x = next.midX - (prev.midX - vp.x) * appliedRatio;
      vp.y = next.midY - (prev.midY - vp.y) * appliedRatio;
      vp.zoom = nextZoom;
      this.zoomAnim.targetZoom = nextZoom;

      this._touchGesture = next;
      this.applyTransform();
    }, { passive: false });

    const endTouchGesture = (e) => {
      if (this._touchGesture && e.touches.length < 2) {
        this._touchGesture = null;
        if (!this.dragAction && !this.zoomAnim.active && !this.viewportTween) {
          this._setAnimatingClass(false);
        }
        store.scheduleAutoSave();
      }
    };
    this.viewportEl.addEventListener('touchend', endTouchGesture, { passive: true });
    this.viewportEl.addEventListener('touchcancel', endTouchGesture, { passive: true });

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
