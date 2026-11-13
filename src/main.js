import { store } from './state.js';
import { canvas } from './canvas.js';
import { nodes } from './nodes.js';
import { wires } from './wires.js';
import { settings } from './settings.js';
import { minimap } from './minimap.js';
import { sync } from './sync.js';

async function initApp() {
  const viewportEl = document.getElementById('viewport');
  const boardEl = document.getElementById('board');
  const wireSvgEl = document.getElementById('wire-svg');
  const cardsContainerEl = document.getElementById('cards-container');
  const selectionPopoverEl = document.getElementById('selection-popover');
  const marqueeBoxEl = document.getElementById('marquee-box');
  const alignmentBarEl = document.getElementById('alignment-bar');
  const fileStatusEl = document.getElementById('hud-file-status');
  const capsuleActionBarEl = document.getElementById('capsule-action-bar');
  const wireDropMenuEl = document.getElementById('wire-drop-menu');
  const canvasContextMenuEl = document.getElementById('canvas-context-menu');
  const settingsOverlayEl = document.getElementById('settings-overlay');
  const minimapWidgetEl = document.getElementById('minimap-widget');

  canvas.init(viewportEl, boardEl);
  wires.init(wireSvgEl, (pos, skipCommit, title, headerColor) => nodes.spawnNode(pos, title, skipCommit, headerColor), wireDropMenuEl);
  nodes.init(cardsContainerEl, selectionPopoverEl, marqueeBoxEl, alignmentBarEl, viewportEl, capsuleActionBarEl, canvasContextMenuEl);
  settings.init(settingsOverlayEl);
  minimap.init(minimapWidgetEl);

  window.__store = store;
  window.__nodes = nodes;
  window.__wires = wires;
  window.__settings = settings;
  window.__minimap = minimap;
  window.__sync = sync;

  canvas.onTransform = () => {
    nodes.updatePopoverPosition();
    nodes.updateAlignmentBar();
    nodes.updateCapsuleActionPosition();
    wires.updateDropMenuPosition();
    minimap.render();
    sync.notifyViewportChanged();
  };

  wires.onRender = () => {
    minimap.requestRender();
  };

  nodes.onSelectionChange = () => {
    minimap.requestRender();
    sync.notifySelectionChanged();
  };

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

  // HUD Button: Undo & Redo
  document.getElementById('btn-undo')?.addEventListener('click', () => {
    store.undo();
  });

  document.getElementById('btn-redo')?.addEventListener('click', () => {
    store.redo();
  });

  function updateUndoRedoButtons() {
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    if (btnUndo) {
      btnUndo.style.opacity = store.canUndo() ? '1' : '0.35';
      btnUndo.style.pointerEvents = store.canUndo() ? 'auto' : 'none';
    }
    if (btnRedo) {
      btnRedo.style.opacity = store.canRedo() ? '1' : '0.35';
      btnRedo.style.pointerEvents = store.canRedo() ? 'auto' : 'none';
    }
  }

  // HUD Button: Open File
  document.getElementById('btn-open')?.addEventListener('click', async () => {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    if (store.hasUnsavedChanges()) {
      const confirmed = confirm('当前图谱尚未保存到文件或有未保存的更改，打开新文件将覆盖当前内容。\n\n确定要继续打开吗？');
      if (!confirmed) return;
    }
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

  // HUD Button: Settings (Ctrl+,)
  document.getElementById('btn-settings')?.addEventListener('click', () => {
    settings.toggle();
  });

  // Canvas context menu button: Settings
  document.getElementById('menu-open-settings')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    nodes.hideCanvasContextMenu();
    settings.open();
  });

  store.subscribe((event) => {
    updateUndoRedoButtons();
    if (event.type === 'FILE_OPENED') {
      updateStatus(store.fileName);
      nodes.filterSelectionAfterRestore();
      nodes.render();
      wires.render();
      canvas.applyTransform();
    } else if (event.type === 'FILE_SAVED') {
      updateStatus(`已保存: ${store.fileName}`);
      setTimeout(() => updateStatus(store.fileName || ''), 2500);
    } else if (event.type === 'HANDLE_RESTORED') {
      updateStatus(store.fileName);
    } else if (event.type === 'STATE_RESET') {
      updateStatus('');
      nodes.filterSelectionAfterRestore();
      nodes.render();
      wires.render();
      canvas.applyTransform();
    } else if (event.type === 'STATE_RESTORED') {
      nodes.filterSelectionAfterRestore();
      nodes.render();
      wires.render();
      nodes.updateAlignmentBar();
    } else if (event.type === 'SETTINGS_CHANGED') {
      settings.syncUI();
      nodes.renderPopoverPalette();
      nodes.updateContextMenuToggles();
      minimap.applySettings();
    } else if (event.type === 'REMOTE_SYNCED') {
      if (event.sourceEvent === 'VIEWPORT_CHANGED') {
        canvas.applyTransform();
      } else if (event.sourceEvent === 'SETTINGS_CHANGED') {
        settings.syncUI();
        nodes.renderPopoverPalette();
        nodes.updateContextMenuToggles();
        minimap.applySettings();
      } else {
        nodes.filterSelectionAfterRestore();
        nodes.render();
        wires.render();
        nodes.updateAlignmentBar();
        canvas.applyTransform();
        settings.syncUI();
        nodes.renderPopoverPalette();
        nodes.updateContextMenuToggles();
        minimap.applySettings();
        minimap.requestRender();
      }
    } else if (event.type === 'CONNECTION_ADDED' || event.type === 'CONNECTION_REMOVED' || event.type === 'CONNECTION_RECONNECTED' || event.type?.startsWith('GROUP_') || event.type?.startsWith('CARD_')) {
      nodes.render();
      wires.render();
      minimap.requestRender();
    }
  });

  // Initial render
  nodes.render();
  wires.render();
  updateUndoRedoButtons();
  sync.init();
  await store.restoreFileHandle();
  if (store.fileName) updateStatus(store.fileName);

  let isBypassingUnloadCheck = false;

  // Intercept Ctrl+R and F5 reload
  window.addEventListener('keydown', (e) => {
    const isReload = e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r');
    if (isReload) {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      if (store.hasUnsavedChanges()) {
        e.preventDefault();
        if (confirm('当前图谱尚未保存到文件或有未保存的更改，重新加载将丢失未保存的内容。\n\n确定要重新加载吗？')) {
          isBypassingUnloadCheck = true;
          window.location.reload();
        }
      }
    }
  });

  // Warn before closing or navigating away if there are unsaved changes
  window.addEventListener('beforeunload', (e) => {
    if (isBypassingUnloadCheck) return;
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    if (store.hasUnsavedChanges()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

window.addEventListener('DOMContentLoaded', initApp);
