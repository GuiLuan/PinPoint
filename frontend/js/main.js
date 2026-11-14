import { store } from './state.js';
import { canvas } from './canvas.js';
import { nodes } from './nodes.js';
import { wires } from './wires.js';
import { settings } from './settings.js';
import { minimap } from './minimap.js';
import { sync } from './sync.js';
import { library } from './library.js';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
  const libraryDrawerEl = document.getElementById('library-drawer');
  const btnLibraryEl = document.getElementById('btn-library');

  const btnCanvasesEl = document.getElementById('btn-canvases');
  const canvasesDrawerEl = document.getElementById('canvases-drawer');
  const btnCloseCanvasesEl = document.getElementById('btn-close-canvases');
  const canvasesSearchInputEl = document.getElementById('canvases-search-input');
  const canvasesCountBadgeEl = document.getElementById('canvases-count-badge');
  const canvasTreeListEl = document.getElementById('canvas-tree-list');

  const breadcrumbBarEl = document.getElementById('canvas-breadcrumb-bar');
  const breadcrumbTrailEl = document.getElementById('canvas-breadcrumb-trail');
  const btnCanvasBackEl = document.getElementById('btn-canvas-back');

  await store.restoreFromIndexedDB();

  canvas.init(viewportEl, boardEl);
  wires.init(wireSvgEl, (pos, skipCommit, title, headerColor) => nodes.spawnNode(pos, title, skipCommit, headerColor), wireDropMenuEl);
  nodes.init(cardsContainerEl, selectionPopoverEl, marqueeBoxEl, alignmentBarEl, viewportEl, capsuleActionBarEl, canvasContextMenuEl);
  settings.init(settingsOverlayEl);
  minimap.init(minimapWidgetEl);
  library.init(libraryDrawerEl, btnLibraryEl);

  window.__store = store;
  window.__nodes = nodes;
  window.__wires = wires;
  window.__settings = settings;
  window.__minimap = minimap;
  window.__sync = sync;
  window.__library = library;

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
    library.updateSelectionState();
  };

  function updateStatus(text) {
    if (fileStatusEl) fileStatusEl.textContent = text || '';
  }

  let toastTimer = null;
  let toastRemainingMs = 5000;
  let toastStartedAt = 0;
  let isToastHovered = false;
  const TOAST_POS_CLASSES = [
    'toast-pos-top-left',
    'toast-pos-top-center',
    'toast-pos-top-right',
    'toast-pos-bottom-left',
    'toast-pos-bottom-center',
    'toast-pos-bottom-right'
  ];

  function applyToastSettings() {
    const toastEl = document.getElementById('app-toast');
    if (!toastEl) return;
    const ts = store.getToastSettings();
    TOAST_POS_CLASSES.forEach(cls => toastEl.classList.remove(cls));
    toastEl.classList.add(`toast-pos-${ts.position || 'bottom-left'}`);
  }

  function hideToast() {
    const toastEl = document.getElementById('app-toast');
    clearTimeout(toastTimer);
    toastTimer = null;
    if (toastEl) {
      toastEl.classList.remove('is-visible');
    }
  }

  function scheduleToastHide(delayMs) {
    clearTimeout(toastTimer);
    toastRemainingMs = Math.max(800, delayMs);
    toastStartedAt = Date.now();
    toastTimer = setTimeout(() => {
      hideToast();
    }, toastRemainingMs);
  }

  const appToastEl = document.getElementById('app-toast');
  const btnCloseToastEl = document.getElementById('btn-close-toast');
  btnCloseToastEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    hideToast();
  });
  appToastEl?.addEventListener('mousedown', (e) => e.stopPropagation());
  appToastEl?.addEventListener('mouseenter', () => {
    isToastHovered = true;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
      const elapsed = Date.now() - toastStartedAt;
      toastRemainingMs = Math.max(1200, toastRemainingMs - elapsed);
    }
  });
  appToastEl?.addEventListener('mouseleave', () => {
    isToastHovered = false;
    if (appToastEl.classList.contains('is-visible')) {
      scheduleToastHide(toastRemainingMs);
    }
  });

  function showToast(message, variant = 'info') {
    const toastEl = document.getElementById('app-toast');
    const textEl = document.getElementById('app-toast-text');
    if (!toastEl || !message) return;
    if (textEl) {
      textEl.textContent = message;
    } else {
      toastEl.textContent = message;
    }
    applyToastSettings();
    toastEl.classList.remove('toast-info', 'toast-warning', 'toast-success', 'is-visible');
    toastEl.classList.add(`toast-${variant}`);
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');

    const ts = store.getToastSettings();
    const durationMs = Math.max(2, Math.min(30, ts?.durationSec || 5)) * 1000;
    toastRemainingMs = durationMs;
    if (!isToastHovered) {
      scheduleToastHide(durationMs);
    } else {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  let canvasesSearchQuery = '';
  const collapsedCanvasIds = new Set();

  function isCanvasesDrawerOpen() {
    return !!canvasesDrawerEl?.classList.contains('is-open');
  }

  async function openCanvasesDrawer() {
    if (!canvasesDrawerEl) return;
    if (library.isOpen()) {
      library.close();
    }
    const libPos = store.getLibrarySettings()?.position === 'right' ? 'right' : 'left';
    canvasesDrawerEl.classList.remove('pos-left', 'pos-right');
    canvasesDrawerEl.classList.add(`pos-${libPos}`);
    canvasesDrawerEl.classList.add('is-open');
    btnCanvasesEl?.classList.add('is-active');
    renderCanvasTreeDrawer();
    await store.refreshCanvasTree();
    renderCanvasTreeDrawer();
  }

  function closeCanvasesDrawer() {
    if (!canvasesDrawerEl) return;
    canvasesDrawerEl.classList.remove('is-open');
    btnCanvasesEl?.classList.remove('is-active');
  }

  function toggleCanvasesDrawer() {
    if (isCanvasesDrawerOpen()) {
      closeCanvasesDrawer();
    } else {
      openCanvasesDrawer();
    }
  }

  function renderCanvasNavigation() {
    const crumbs = store.breadcrumbs || [{ id: 'root', title: '主画布' }];
    const showBreadcrumbs = !(store.activeCanvasId === 'root' && crumbs.length <= 1);
    document.body.classList.toggle('has-breadcrumbs', showBreadcrumbs);

    if (breadcrumbBarEl && breadcrumbTrailEl) {
      if (!showBreadcrumbs) {
        breadcrumbBarEl.style.display = 'none';
      } else {
        breadcrumbBarEl.style.display = 'flex';
        breadcrumbTrailEl.innerHTML = '';
        crumbs.forEach((crumb, idx) => {
          if (idx > 0) {
            const sep = document.createElement('span');
            sep.className = 'breadcrumb-sep';
            sep.textContent = '/';
            breadcrumbTrailEl.appendChild(sep);
          }
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'breadcrumb-item' + (crumb.id === store.activeCanvasId ? ' is-current' : '');
          btn.textContent = crumb.title || (crumb.id === 'root' ? '主画布' : '子画布');
          btn.disabled = crumb.id === store.activeCanvasId;
          btn.addEventListener('click', () => {
            store.navigateToCanvas(crumb.id);
          });
          breadcrumbTrailEl.appendChild(btn);
        });
      }
    }

    if (isCanvasesDrawerOpen()) {
      renderCanvasTreeDrawer();
    } else if (canvasesCountBadgeEl) {
      canvasesCountBadgeEl.textContent = String(store.getCanvasHierarchy().length);
    }
  }

  function renderCanvasTreeDrawer() {
    if (!canvasTreeListEl) return;
    const allRows = store.getCanvasHierarchy();
    if (canvasesCountBadgeEl) {
      canvasesCountBadgeEl.textContent = String(allRows.length);
    }

    const rowMap = new Map(allRows.map(r => [r.id, r]));
    const childrenSet = new Set();
    allRows.forEach(r => {
      if (r.parentCanvasId) childrenSet.add(r.parentCanvasId);
    });

    const isHiddenByCollapse = (row) => {
      let pid = row.parentCanvasId;
      const seen = new Set();
      while (pid && !seen.has(pid)) {
        seen.add(pid);
        if (collapsedCanvasIds.has(pid)) return true;
        pid = rowMap.get(pid)?.parentCanvasId || null;
      }
      return false;
    };

    const q = canvasesSearchQuery.trim().toLowerCase();
    const rows = q
      ? allRows.filter(r => (r.title || '').toLowerCase().includes(q))
      : allRows.filter(r => !isHiddenByCollapse(r));

    canvasTreeListEl.innerHTML = '';
    if (rows.length === 0) {
      canvasTreeListEl.innerHTML = `<div class="library-empty-state"><p>没有匹配的画布</p></div>`;
      return;
    }

    rows.forEach(row => {
      const hasChildren = childrenSet.has(row.id);
      const isCollapsed = collapsedCanvasIds.has(row.id);
      const itemEl = document.createElement('div');
      itemEl.className = 'canvas-tree-row' + (row.id === store.activeCanvasId ? ' is-active' : '');
      itemEl.style.paddingLeft = `${6 + (q ? 0 : (row.depth || 0) * 14)}px`;

      const dirtyMark = row.dirty ? '<span class="canvas-tree-dirty-dot" title="未保存"></span>' : '';
      const totalSub = (row.cardCount ?? 0) + (row.subcanvasCount ?? 0);
      const countText = totalSub > 0 ? String(totalSub) : '';
      const toggleHtml = hasChildren && !q
        ? `<button type="button" class="canvas-tree-toggle-btn" title="${isCollapsed ? '展开' : '折叠'}">
             <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.2" fill="none" style="transform: rotate(${isCollapsed ? '-90deg' : '0deg'}); transition: transform 0.14s ease;">
               <polyline points="6 9 12 15 18 9"></polyline>
             </svg>
           </button>`
        : '<span class="canvas-tree-toggle-spacer"></span>';

      itemEl.innerHTML = `
        ${toggleHtml}
        <button type="button" class="canvas-tree-jump-btn">
          <span class="canvas-tree-icon">${row.depth > 0 ? '↳' : '◈'}</span>
          <span class="canvas-tree-name">${escapeHtml(row.title)}</span>
          <input type="text" class="canvas-tree-rename-input" style="display: none;" value="${escapeHtml(row.title)}" />
          ${dirtyMark}
          ${countText ? `<span class="canvas-tree-meta">${countText}</span>` : ''}
        </button>
        <div class="canvas-tree-row-actions">
          <button type="button" class="canvas-tree-action-btn canvas-tree-rename-btn" title="重命名">
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none">
              <path d="M12 20h9"></path>
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
            </svg>
          </button>
          <button type="button" class="canvas-tree-action-btn canvas-tree-export-btn" title="导出 .pinpoint">
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
          </button>
        </div>
      `;

      const toggleBtn = itemEl.querySelector('.canvas-tree-toggle-btn');
      toggleBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (collapsedCanvasIds.has(row.id)) {
          collapsedCanvasIds.delete(row.id);
        } else {
          collapsedCanvasIds.add(row.id);
        }
        renderCanvasTreeDrawer();
      });

      const jumpBtn = itemEl.querySelector('.canvas-tree-jump-btn');
      const nameEl = itemEl.querySelector('.canvas-tree-name');
      const renameInput = itemEl.querySelector('.canvas-tree-rename-input');

      const startInlineRename = (e) => {
        e?.stopPropagation?.();
        if (!nameEl || !renameInput) return;
        nameEl.style.display = 'none';
        renameInput.style.display = 'block';
        renameInput.value = row.title || '';
        renameInput.focus();
        renameInput.select();
      };

      const finishInlineRename = async (commit = true) => {
        if (!renameInput || renameInput.style.display === 'none') return;
        const val = renameInput.value.trim();
        renameInput.style.display = 'none';
        nameEl.style.display = '';
        if (commit && val && val !== row.title) {
          await store.renameCanvas(row.id, val);
        }
      };

      renameInput?.addEventListener('click', (e) => e.stopPropagation());
      renameInput?.addEventListener('mousedown', (e) => e.stopPropagation());
      renameInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finishInlineRename(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finishInlineRename(false);
        }
      });
      renameInput?.addEventListener('blur', () => finishInlineRename(true));

      nameEl?.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startInlineRename(e);
      });

      jumpBtn?.addEventListener('click', (e) => {
        if (renameInput && renameInput.style.display !== 'none') return;
        e.stopPropagation();
        store.navigateToCanvas(row.id);
      });

      itemEl.querySelector('.canvas-tree-rename-btn')?.addEventListener('click', startInlineRename);

      itemEl.querySelector('.canvas-tree-export-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        store.exportCanvasToFile(row.id);
      });

      canvasTreeListEl.appendChild(itemEl);
    });
  }

  window.__updateSaveUI = ({ connected, dirty, saving, label }) => {
    const btnSave = document.getElementById('btn-save');
    if (btnSave) {
      btnSave.classList.toggle('is-offline', !connected);
      btnSave.classList.toggle('has-unsaved', !!connected && !!dirty);
      btnSave.classList.toggle('is-saving', !!saving);
      if (label) {
        btnSave.setAttribute('data-tooltip', label);
      }
    }
  };

  btnCanvasesEl?.addEventListener('click', () => {
    toggleCanvasesDrawer();
  });

  btnCloseCanvasesEl?.addEventListener('click', () => {
    closeCanvasesDrawer();
  });

  canvasesDrawerEl?.addEventListener('mousedown', (e) => e.stopPropagation());
  canvasesDrawerEl?.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  canvasesSearchInputEl?.addEventListener('input', (e) => {
    canvasesSearchQuery = e.target.value || '';
    renderCanvasTreeDrawer();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isCanvasesDrawerOpen()) {
      closeCanvasesDrawer();
    }
  });

  btnCanvasBackEl?.addEventListener('click', () => {
    const crumbs = store.breadcrumbs || [];
    if (crumbs.length >= 2) {
      store.navigateToCanvas(crumbs[crumbs.length - 2].id);
    } else if (store.parentCanvasId) {
      store.navigateToCanvas(store.parentCanvasId);
    } else {
      store.navigateToCanvas('root');
    }
  });

  // HUD Button: Focus Mode
  document.getElementById('btn-focus-mode')?.addEventListener('click', () => {
    nodes.enterFocusMode();
  });

  // HUD Button: Library Drawer
  btnLibraryEl?.addEventListener('click', () => {
    if (!library.isOpen() && isCanvasesDrawerOpen()) {
      closeCanvasesDrawer();
    }
    library.toggle();
  });

  document.getElementById('btn-focus-confirm')?.addEventListener('click', () => {
    nodes.confirmFocusMode();
  });

  document.getElementById('btn-focus-cancel')?.addEventListener('click', () => {
    nodes.cancelFocusMode();
  });

  // HUD Button: Add Node
  document.getElementById('btn-add-node')?.addEventListener('click', () => {
    const { x, y, zoom } = store.state.viewport;
    const centerX = (-x + window.innerWidth / 2) / zoom;
    const centerY = (-y + window.innerHeight / 2) / zoom;
    const node = nodes.spawnNode({ x: centerX, y: centerY });
    wires.render();

    setTimeout(() => {
      nodes.editCardTitle(node.id);
    }, 50);
  });

  // HUD Button: Add Subcanvas
  document.getElementById('btn-add-subcanvas')?.addEventListener('click', async () => {
    const { x, y, zoom } = store.state.viewport;
    const centerX = (-x + window.innerWidth / 2) / zoom - 120;
    const centerY = (-y + window.innerHeight / 2) / zoom - 60;
    const card = await nodes.spawnSubcanvas({ x: centerX, y: centerY });
    if (card) {
      setTimeout(() => {
        nodes.editCardTitle(card.id);
      }, 50);
    }
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

  // HUD Button: Import .pinpoint into current canvas
  document.getElementById('btn-open')?.addEventListener('click', async () => {
    if (store.isFocusMode) {
      showToast('请先退出专注模式后再导入', 'warning');
      return;
    }
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    if (store.hasUnsavedChanges()) {
      const confirmed = confirm('当前存在未保存的更改，导入将覆盖当前画布内容。\n\n确定要继续导入吗？');
      if (!confirmed) return;
    }
    const res = await store.openFromFile();
    if (res?.success) {
      updateStatus(res.fileName);
      canvas.applyTransform();
      nodes.render();
      wires.render();
      renderCanvasNavigation();
    }
  });

  // HUD Button: Export current canvas as .pinpoint
  document.getElementById('btn-export')?.addEventListener('click', async () => {
    await store.exportCanvasToFile(store.activeCanvasId);
  });

  // HUD Button: Save (Ctrl+S or click)
  document.getElementById('btn-save')?.addEventListener('click', async () => {
    await sync.saveAllToBackend({ manual: true });
  });

  // HUD Button: Reset Current Canvas
  document.getElementById('btn-reset')?.addEventListener('click', () => {
    if (store.isFocusMode) {
      showToast('请先退出专注模式后再重置', 'warning');
      return;
    }
    if (confirm('确定要清空并重置当前画布吗？')) {
      store.reset();
      updateStatus('');
      canvas.applyTransform();
      nodes.render();
      wires.render();
      renderCanvasNavigation();
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
    if (event.type === 'TOAST') {
      showToast(event.message, event.variant);
      return;
    } else if (event.type === 'DIRTY_CHANGED') {
      if (isCanvasesDrawerOpen()) {
        renderCanvasTreeDrawer();
      }
      return;
    } else if (event.type === 'CANVAS_TREE_UPDATED') {
      renderCanvasNavigation();
      return;
    } else if (event.type === 'CANVAS_SWITCHED') {
      nodes.clearSelection();
      nodes.hideAllMenus();
      canvas.applyTransform();
      nodes.render();
      wires.render();
      nodes.updateAlignmentBar();
      minimap.checkAndHealViewport();
      minimap.requestRender();
      renderCanvasNavigation();
      return;
    } else if (event.type === 'FOCUS_MODE_ENTERED' || event.type === 'FOCUS_MODE_EXITED' || event.type === 'FOCUS_MODE_CANCELLED') {
      nodes.updateFocusModeUI();
      minimap.requestRender();
      return;
    } else if (event.type === 'FILE_OPENED') {
      updateStatus(event.fileName || '');
      nodes.filterSelectionAfterRestore();
      canvas.applyTransform();
      nodes.render();
      wires.render();
      renderCanvasNavigation();
    } else if (event.type === 'STATE_RESET') {
      updateStatus('');
      nodes.filterSelectionAfterRestore();
      canvas.applyTransform();
      nodes.render();
      wires.render();
      renderCanvasNavigation();
    } else if (event.type === 'STATE_RESTORED') {
      nodes.filterSelectionAfterRestore();
      canvas.applyTransform();
      nodes.render();
      wires.render();
      nodes.updateAlignmentBar();
      applyToastSettings();
      if (store.isFocusMode) nodes.updateFocusModeUI();
    } else if (event.type === 'SETTINGS_CHANGED') {
      settings.syncUI();
      nodes.renderPopoverPalette();
      nodes.updateContextMenuToggles();
      minimap.applySettings();
      library.applySettings();
      applyToastSettings();
      if (canvasesDrawerEl) {
        const libPos = store.getLibrarySettings()?.position === 'right' ? 'right' : 'left';
        canvasesDrawerEl.classList.remove('pos-left', 'pos-right');
        canvasesDrawerEl.classList.add(`pos-${libPos}`);
      }
    } else if (event.type === 'REMOTE_SYNCED') {
      if (event.sourceEvent === 'VIEWPORT_CHANGED') {
        canvas.applyTransform();
      } else if (event.sourceEvent === 'SETTINGS_CHANGED') {
        settings.syncUI();
        nodes.renderPopoverPalette();
        nodes.updateContextMenuToggles();
        minimap.applySettings();
        library.applySettings();
        applyToastSettings();
      } else {
        nodes.filterSelectionAfterRestore();
        canvas.applyTransform();
        nodes.render();
        wires.render();
        nodes.updateAlignmentBar();
        settings.syncUI();
        nodes.renderPopoverPalette();
        nodes.updateContextMenuToggles();
        minimap.applySettings();
        minimap.requestRender();
        library.applySettings();
        applyToastSettings();
        renderCanvasNavigation();
      }
    } else if (event.type === 'CONNECTION_ADDED' || event.type === 'CONNECTION_REMOVED' || event.type === 'CONNECTION_RECONNECTED' || event.type?.startsWith('GROUP_') || event.type?.startsWith('CARD_')) {
      nodes.render();
      wires.render();
      minimap.requestRender();
      if (store.isFocusMode) nodes.updateFocusModeUI();
    }
  });

  // Initial render
  canvas.applyTransform();
  nodes.render();
  wires.render();
  updateUndoRedoButtons();
  applyToastSettings();
  renderCanvasNavigation();
  sync.init();

  document.fonts?.ready?.then(() => {
    if (!store.isFocusMode) {
      wires.render();
    }
  });

  let isBypassingUnloadCheck = false;

  // Intercept Ctrl+R and F5 reload when unsaved changes exist
  window.addEventListener('keydown', (e) => {
    const isReload = e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r');
    if (isReload) {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      if (store.hasUnsavedChanges()) {
        e.preventDefault();
        if (confirm('当前有未保存的更改，重新加载将丢失未保存的内容。\n\n确定要重新加载吗？')) {
          isBypassingUnloadCheck = true;
          window.location.reload();
        }
      }
    }
  });

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
