import { store } from './state.js';

class CanvasManager {
  constructor() {
    this.viewportEl = null;
    this.boardEl = null;
    this.dragAction = null;
    this.onTransform = null;
    this.isSpacePressed = false;
  }

  init(viewportEl, boardEl) {
    this.viewportEl = viewportEl;
    this.boardEl = boardEl;
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

  applyTransform() {
    const { x, y, zoom } = store.state.viewport;
    this.boardEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;

    const minorSize = 24 * zoom;
    const majorSize = 120 * zoom;
    this.viewportEl.style.backgroundSize = `${minorSize}px ${minorSize}px, ${minorSize}px ${minorSize}px, ${majorSize}px ${majorSize}px, ${majorSize}px ${majorSize}px`;
    this.viewportEl.style.backgroundPosition = `${x}px ${y}px, ${x}px ${y}px, ${x}px ${y}px, ${x}px ${y}px`;

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
    this.viewportEl.addEventListener('mousedown', (e) => {
      const isCanvasBackground = e.target === this.viewportEl ||
                                 e.target === this.boardEl ||
                                 e.target.id === 'wire-svg';
      if (!isCanvasBackground) return;

      if (e.button === 1 || this.isSpacePressed) {
        e.preventDefault();
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
      this.applyTransform();
    });

    window.addEventListener('mouseup', () => {
      if (this.dragAction?.type === 'PAN') {
        this.dragAction = null;
        this.viewportEl.style.cursor = this.isSpacePressed ? 'grab' : '';
        store.scheduleAutoSave();
      }
    });

    this.viewportEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      const { zoom, x, y } = store.state.viewport;
      const nextZoom = Math.min(Math.max(zoom * zoomFactor, 0.35), 2.5);

      const mouseX = e.clientX;
      const mouseY = e.clientY;

      store.state.viewport.x = mouseX - (mouseX - x) * (nextZoom / zoom);
      store.state.viewport.y = mouseY - (mouseY - y) * (nextZoom / zoom);
      store.state.viewport.zoom = nextZoom;

      this.applyTransform();
      store.scheduleAutoSave();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      const isEditingText = e.target?.closest?.('input, textarea, [contenteditable="true"]');
      if (e.code === 'Space' && !e.repeat && !isEditingText) {
        this.isSpacePressed = true;
        this.viewportEl.style.cursor = 'grab';
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        store.saveToFile();
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
