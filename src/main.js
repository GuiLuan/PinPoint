import { store } from './state.js';
import { canvas } from './canvas.js';
import { nodes } from './nodes.js';
import { wires } from './wires.js';

function initApp() {
  const viewportEl = document.getElementById('viewport');
  const boardEl = document.getElementById('board');
  const wireSvgEl = document.getElementById('wire-svg');
  const cardsContainerEl = document.getElementById('cards-container');
  const selectionPopoverEl = document.getElementById('selection-popover');
  const fileStatusEl = document.getElementById('hud-file-status');

  canvas.init(viewportEl, boardEl);
  wires.init(wireSvgEl, (pos) => nodes.spawnNode(pos));
  nodes.init(cardsContainerEl, selectionPopoverEl);
  canvas.onTransform = () => nodes.updatePopoverPosition();

  function updateStatus(text) {
    if (fileStatusEl) fileStatusEl.textContent = text;
  }

  // HUD Button: Add Node
  document.getElementById('btn-add-node')?.addEventListener('click', () => {
    const { x, y, zoom } = store.state.viewport;
    const centerX = (-x + window.innerWidth / 2) / zoom;
    const centerY = (-y + window.innerHeight / 2) / zoom;
    const node = nodes.spawnNode({ x: centerX, y: centerY });
    wires.render();

    // Focus and rename newly created node
    setTimeout(() => {
      const cardEl = document.getElementById(`card-dom-${node.id}`);
      if (cardEl) {
        const titleSpan = cardEl.querySelector('.header-title');
        titleSpan?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      }
    }, 50);
  });

  // HUD Button: Open File
  document.getElementById('btn-open')?.addEventListener('click', async () => {
    const res = await store.openFromFile();
    if (res?.success) {
      updateStatus(res.fileName);
      nodes.render();
      wires.render();
      canvas.applyTransform();
    }
  });

  // HUD Button: Save File (Ctrl+S or click)
  document.getElementById('btn-save')?.addEventListener('click', async () => {
    const res = await store.saveToFile();
    if (res?.success) {
      updateStatus(`已保存: ${res.fileName}`);
      setTimeout(() => updateStatus(store.fileName || ''), 2500);
    }
  });

  // HUD Button: Reset Canvas
  document.getElementById('btn-reset')?.addEventListener('click', () => {
    if (confirm('确定要清空画布并重置图谱吗？')) {
      store.reset();
      updateStatus('');
      nodes.render();
      wires.render();
      canvas.applyTransform();
    }
  });

  store.subscribe((event) => {
    if (event.type === 'FILE_OPENED') {
      updateStatus(store.fileName);
      nodes.render();
      wires.render();
      canvas.applyTransform();
    } else if (event.type === 'FILE_SAVED') {
      updateStatus(store.fileName);
    } else if (event.type === 'STATE_RESET') {
      updateStatus('');
      nodes.render();
      wires.render();
    }
  });

  // Initial render
  nodes.render();
  wires.render();
  if (store.fileName) updateStatus(store.fileName);
}

window.addEventListener('DOMContentLoaded', initApp);
