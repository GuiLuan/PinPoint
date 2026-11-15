import { store } from './state.js';
import { canvas } from './canvas.js';
import { nodes, hexToRgba } from './nodes.js';
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
  const btnCanvasesDeleteSelectedEl = document.getElementById('btn-canvases-delete-selected');
  const btnCanvasesCheckModeEl = document.getElementById('btn-canvases-check-mode');
  const canvasesCheckBannerEl = document.getElementById('canvases-check-banner');
  const btnCanvasesCheckAllEl = document.getElementById('btn-canvases-check-all');
  const btnCanvasesCheckDoneEl = document.getElementById('btn-canvases-check-done');
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

  function applyAppearanceSettings() {
    const ap = store.getAppearanceSettings();
    const html = document.documentElement;
    const prevTheme = html.getAttribute('data-theme');
    html.setAttribute('data-theme', ap.theme || 'dark');
    html.setAttribute('data-canvas-texture', ap.canvasTexture || 'dots');

    const isLight = ap.theme === 'light';
    const accent = ap.accentColor || '#4c8dff';
    html.style.setProperty('--accent', accent);
    html.style.setProperty('--accent-soft', hexToRgba(accent, isLight ? 0.16 : 0.14));
    html.style.setProperty('--accent-border', hexToRgba(accent, isLight ? 0.56 : 0.5));
    html.style.setProperty('--accent-text', accent);

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', isLight ? '#ebe6dd' : '#17181a');
    }

    canvas.applyTransform();
    if (prevTheme !== ap.theme) {
      nodes.render();
      wires.render();
      minimap.requestRender();
    }
  }

  function syncEdgeDrawerOffsets() {
    const canvasesOpen = isCanvasesDrawerOpen();
    const libOpen = library.isOpen();
    const libPos = store.getLibrarySettings()?.position === 'right' ? 'right' : 'left';
    const leftOpen = canvasesOpen || (libOpen && libPos === 'left');
    const rightOpen = libOpen && libPos === 'right';
    document.body.classList.toggle('drawer-left-open', leftOpen);
    document.body.classList.toggle('drawer-right-open', rightOpen);

    let leftW = 0;
    if (canvasesOpen && libPos === 'left' && canvasesDrawerEl) {
      leftW = canvasesDrawerEl.offsetWidth || store.getLibrarySettings()?.width || 348;
    } else if (libOpen && libPos === 'left' && libraryDrawerEl) {
      leftW = libraryDrawerEl.offsetWidth || store.getLibrarySettings()?.width || 348;
    }
    let rightW = 0;
    if (canvasesOpen && libPos === 'right' && canvasesDrawerEl) {
      rightW = canvasesDrawerEl.offsetWidth || store.getLibrarySettings()?.width || 348;
    } else if (rightOpen && libraryDrawerEl) {
      rightW = libraryDrawerEl.offsetWidth || store.getLibrarySettings()?.width || 348;
    }
    document.documentElement.style.setProperty('--open-left-drawer-width', `${leftW}px`);
    document.documentElement.style.setProperty('--open-right-drawer-width', `${rightW}px`);
  }
  window.__syncDrawerLayout = syncEdgeDrawerOffsets;

  const btnHudMoreEl = document.getElementById('btn-hud-more');
  const hudMoreMenuEl = document.getElementById('hud-more-menu');
  function closeHudMoreMenu() {
    if (hudMoreMenuEl) hudMoreMenuEl.classList.remove('is-open');
    btnHudMoreEl?.setAttribute('aria-expanded', 'false');
  }
  btnHudMoreEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!hudMoreMenuEl) return;
    const open = hudMoreMenuEl.classList.toggle('is-open');
    btnHudMoreEl.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  hudMoreMenuEl?.addEventListener('mousedown', (e) => e.stopPropagation());
  hudMoreMenuEl?.addEventListener('click', () => closeHudMoreMenu());
  document.addEventListener('mousedown', (e) => {
    if (hudMoreMenuEl && !hudMoreMenuEl.contains(e.target) && e.target !== btnHudMoreEl) {
      closeHudMoreMenu();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHudMoreMenu();
  });

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

  const HIDDEN_TREE_CANVASES_KEY = 'pinpoint-hidden-tree-canvases';
  function loadHiddenTreeCanvasIds() {
    try {
      const raw = localStorage.getItem(HIDDEN_TREE_CANVASES_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr.filter(id => typeof id === 'string' && id));
      }
    } catch (e) {}
    return new Set();
  }
  function saveHiddenTreeCanvasIds(idSet) {
    try {
      localStorage.setItem(HIDDEN_TREE_CANVASES_KEY, JSON.stringify([...idSet]));
    } catch (e) {}
  }

  let canvasesSearchQuery = '';
  const collapsedCanvasIds = new Set();
  let pendingCanvasTreeRender = false;
  let isCanvasesCheckMode = false;
  const hiddenTreeCanvasIds = loadHiddenTreeCanvasIds();
  let selectedTreeCanvasIds = new Set();
  let treeSelectionAnchorId = null;
  let canvasesFocusActive = false;
  let lastRenderedTreeRowIds = [];

  function syncCanvasesSelectionVisuals(allRows = store.getCanvasHierarchy()) {
    const validIds = new Set(allRows.map(r => r.id));
    for (const id of [...selectedTreeCanvasIds]) {
      if (!validIds.has(id)) selectedTreeCanvasIds.delete(id);
    }
    if (treeSelectionAnchorId && !validIds.has(treeSelectionAnchorId)) {
      treeSelectionAnchorId = null;
    }

    const checkedTotal = allRows.filter(r => !hiddenTreeCanvasIds.has(r.id)).length;
    if (canvasesCountBadgeEl) {
      if (isCanvasesCheckMode) {
        canvasesCountBadgeEl.textContent = `${checkedTotal}/${allRows.length}`;
      } else if (selectedTreeCanvasIds.size > 0 && checkedTotal > 0) {
        canvasesCountBadgeEl.textContent = `已选 ${selectedTreeCanvasIds.size} / ${checkedTotal}`;
      } else {
        canvasesCountBadgeEl.textContent = String(checkedTotal);
      }
    }

    if (btnCanvasesDeleteSelectedEl) {
      const hasDeletable = [...selectedTreeCanvasIds].some(id => id !== 'root');
      btnCanvasesDeleteSelectedEl.style.display = (!isCanvasesCheckMode && hasDeletable) ? 'flex' : 'none';
    }

    if (canvasTreeListEl) {
      canvasTreeListEl.querySelectorAll('.canvas-tree-row').forEach(rowEl => {
        const cid = rowEl.dataset.canvasId;
        rowEl.classList.toggle('is-selected', Boolean(cid && selectedTreeCanvasIds.has(cid)));
      });
    }
  }

  async function deleteSelectedTreeCanvases() {
    if (selectedTreeCanvasIds.size === 0) return false;
    const res = await store.deleteCanvases([...selectedTreeCanvasIds]);
    if (res?.deletedIds?.length) {
      res.deletedIds.forEach(id => selectedTreeCanvasIds.delete(id));
      if (treeSelectionAnchorId && res.deletedIds.includes(treeSelectionAnchorId)) {
        treeSelectionAnchorId = null;
      }
      nodes.filterSelectionAfterRestore();
      nodes.render();
      wires.render();
      nodes.updateAlignmentBar();
      renderCanvasNavigation();
      store.scheduleAutoSave();
      return true;
    }
    return Boolean(res?.rootSkipped);
  }

  window.__canvases = {
    isOpen: () => isCanvasesDrawerOpen(),
    toggle: () => toggleCanvasesDrawer(),
    blurScope: () => {
      canvasesFocusActive = false;
    },
    handleSelectAllShortcut: (e) => {
      if (!isCanvasesDrawerOpen()) return false;
      const inCanvases = canvasesFocusActive || canvasesDrawerEl?.contains(document.activeElement);
      if (!inCanvases) return false;
      if (lastRenderedTreeRowIds.length === 0) return false;
      e.preventDefault();
      selectedTreeCanvasIds = new Set(lastRenderedTreeRowIds);
      treeSelectionAnchorId = lastRenderedTreeRowIds[0] || null;
      syncCanvasesSelectionVisuals();
      return true;
    },
    handleDeleteShortcut: (e) => {
      if (!isCanvasesDrawerOpen()) return false;
      const inCanvases = canvasesFocusActive || canvasesDrawerEl?.contains(document.activeElement);
      if (!inCanvases || selectedTreeCanvasIds.size === 0) return false;
      e.preventDefault();
      deleteSelectedTreeCanvases();
      return true;
    },
    handleEscape: () => {
      if (!isCanvasesDrawerOpen()) return false;
      const inCanvases = canvasesFocusActive || canvasesDrawerEl?.contains(document.activeElement);
      if (selectedTreeCanvasIds.size > 0 && inCanvases) {
        selectedTreeCanvasIds.clear();
        treeSelectionAnchorId = null;
        syncCanvasesSelectionVisuals();
        return true;
      }
      if (inCanvases || (nodes.selectedCardIds.size === 0 && !nodes.selectedCapsule)) {
        closeCanvasesDrawer();
        return true;
      }
      return false;
    }
  };

  function syncShortcutTooltips() {
    const fmt = (key, fallbackLabel) => {
      const b = store.getShortcut(key);
      return b ? `${fallbackLabel} (${b})` : fallbackLabel;
    };
    const setTip = (id, key, label) => {
      const el = document.getElementById(id);
      if (el) el.setAttribute('data-tooltip', fmt(key, label));
    };
    setTip('btn-canvases', 'toggleCanvases', '全部画布');
    setTip('btn-library', 'toggleLibrary', '节点库');
    setTip('btn-focus-mode', 'toggleFocusMode', '专注模式');
    setTip('btn-undo', 'undo', '撤销');
    setTip('btn-redo', 'redo', '重做');
    setTip('btn-settings', 'openSettings', '偏好设置');
    setTip('btn-create-group', 'createGroup', '创建组');
    setTip('btn-save-to-library', 'saveToLibrary', '保存到库');
    setTip('btn-align-focus', 'toggleFocusMode', '进入专注模式');
    setTip('btn-delete-selected', 'deleteSelected', '删除选中');
    setTip('btn-canvases-delete-selected', 'deleteSelected', '删除选中画布');

    const menuSettingsEl = document.getElementById('menu-open-settings');
    if (menuSettingsEl) {
      const b = store.getShortcut('openSettings');
      menuSettingsEl.title = fmt('openSettings', '偏好设置');
      const scSpan = menuSettingsEl.querySelector('.context-menu-shortcut');
      if (scSpan) scSpan.textContent = b || '';
    }
    library.updateSelectionState?.();
    sync.updateStatusDot?.();
  }

  function setCanvasesCheckMode(active) {
    isCanvasesCheckMode = !!active;
    if (btnCanvasesCheckModeEl) {
      btnCanvasesCheckModeEl.classList.toggle('is-active', isCanvasesCheckMode);
      btnCanvasesCheckModeEl.setAttribute('aria-pressed', isCanvasesCheckMode ? 'true' : 'false');
      btnCanvasesCheckModeEl.setAttribute('data-tooltip', isCanvasesCheckMode ? '完成勾选' : '勾选显示画布');
    }
    if (canvasesCheckBannerEl) {
      canvasesCheckBannerEl.style.display = isCanvasesCheckMode ? 'flex' : 'none';
    }
    renderCanvasTreeDrawer();
  }

  function isCanvasesDrawerOpen() {
    return !!canvasesDrawerEl?.classList.contains('is-open');
  }

  function applySharedSidePanelSettings() {
    if (!canvasesDrawerEl) return;
    const lib = store.getLibrarySettings();
    const libPos = lib?.position === 'right' ? 'right' : 'left';
    canvasesDrawerEl.classList.remove('pos-left', 'pos-right');
    canvasesDrawerEl.classList.add(`pos-${libPos}`);
    if (!canvasesDrawerEl.classList.contains('is-resizing')) {
      canvasesDrawerEl.style.width = `${library.clampWidth(lib?.width)}px`;
    }
  }

  async function openCanvasesDrawer() {
    if (!canvasesDrawerEl) return;
    if (library.isOpen()) {
      library.close();
    }
    applySharedSidePanelSettings();
    canvasesDrawerEl.classList.add('is-open');
    btnCanvasesEl?.classList.add('is-active');
    canvasesFocusActive = true;
    syncEdgeDrawerOffsets();
    renderCanvasTreeDrawer();
    await store.refreshCanvasTree();
    renderCanvasTreeDrawer();
  }

  function closeCanvasesDrawer() {
    if (!canvasesDrawerEl) return;
    canvasesFocusActive = false;
    if (isCanvasesCheckMode) {
      isCanvasesCheckMode = false;
      btnCanvasesCheckModeEl?.classList.remove('is-active');
      btnCanvasesCheckModeEl?.setAttribute('aria-pressed', 'false');
      btnCanvasesCheckModeEl?.setAttribute('data-tooltip', '勾选显示画布');
      if (canvasesCheckBannerEl) canvasesCheckBannerEl.style.display = 'none';
    }
    canvasesDrawerEl.classList.remove('is-open');
    btnCanvasesEl?.classList.remove('is-active');
    if (document.activeElement === btnCanvasesEl) {
      btnCanvasesEl.blur();
    }
    syncEdgeDrawerOffsets();
  }
  window.__closeCanvasesDrawer = closeCanvasesDrawer;

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
      const allRows = store.getCanvasHierarchy();
      const visibleCount = allRows.filter(r => !hiddenTreeCanvasIds.has(r.id)).length;
      canvasesCountBadgeEl.textContent = String(visibleCount);
    }
  }

  function renderCanvasTreeDrawer() {
    if (!canvasTreeListEl) return;
    // Never destroy an active inline rename input inside the drawer
    const activeRename = canvasTreeListEl.querySelector('.canvas-tree-rename-input');
    const isRenamingInDrawer = Array.from(canvasTreeListEl.querySelectorAll('.canvas-tree-rename-input'))
      .some(inp => inp.style.display !== 'none' || inp === document.activeElement);
    if (isRenamingInDrawer && activeRename) {
      pendingCanvasTreeRender = true;
      return;
    }
    pendingCanvasTreeRender = false;
    const allRows = store.getCanvasHierarchy();
    const checkedTotal = allRows.filter(r => !hiddenTreeCanvasIds.has(r.id)).length;
    if (canvasesCountBadgeEl) {
      canvasesCountBadgeEl.textContent = isCanvasesCheckMode
        ? `${checkedTotal}/${allRows.length}`
        : String(checkedTotal);
    }

    const rowMap = new Map(allRows.map(r => [r.id, r]));
    const baseRows = isCanvasesCheckMode
      ? allRows
      : allRows.filter(r => !hiddenTreeCanvasIds.has(r.id));
    const visibleIdSet = new Set(baseRows.map(r => r.id));

    const visibleChildrenSet = new Set();
    baseRows.forEach(r => {
      let pid = r.parentCanvasId;
      const seen = new Set();
      while (pid && !seen.has(pid)) {
        seen.add(pid);
        if (visibleIdSet.has(pid)) {
          visibleChildrenSet.add(pid);
          break;
        }
        pid = rowMap.get(pid)?.parentCanvasId || null;
      }
    });

    const getVisibleDepth = (row) => {
      let depth = 0;
      let pid = row.parentCanvasId;
      const seen = new Set();
      while (pid && !seen.has(pid)) {
        seen.add(pid);
        if (visibleIdSet.has(pid)) depth += 1;
        pid = rowMap.get(pid)?.parentCanvasId || null;
      }
      return depth;
    };

    const isHiddenByCollapse = (row) => {
      let pid = row.parentCanvasId;
      const seen = new Set();
      while (pid && !seen.has(pid)) {
        seen.add(pid);
        if (visibleIdSet.has(pid) && collapsedCanvasIds.has(pid)) return true;
        pid = rowMap.get(pid)?.parentCanvasId || null;
      }
      return false;
    };

    const q = canvasesSearchQuery.trim().toLowerCase();
    const rows = q
      ? baseRows.filter(r => (r.title || '').toLowerCase().includes(q))
      : baseRows.filter(r => !isHiddenByCollapse(r));
    lastRenderedTreeRowIds = rows.map(r => r.id);

    canvasTreeListEl.innerHTML = '';
    if (rows.length === 0) {
      if (!q && allRows.length > 0 && !isCanvasesCheckMode) {
        canvasTreeListEl.innerHTML = `
          <div class="library-empty-state">
            <p>已隐藏全部画布</p>
            <button type="button" class="canvases-empty-action-btn" id="btn-empty-enter-check">勾选要显示的画布</button>
          </div>
        `;
        canvasTreeListEl.querySelector('#btn-empty-enter-check')?.addEventListener('click', () => {
          setCanvasesCheckMode(true);
        });
      } else {
        canvasTreeListEl.innerHTML = `<div class="library-empty-state"><p>没有匹配的画布</p></div>`;
      }
      syncCanvasesSelectionVisuals(allRows);
      return;
    }

    rows.forEach(row => {
      const hasChildren = visibleChildrenSet.has(row.id);
      const isCollapsed = collapsedCanvasIds.has(row.id);
      const visibleDepth = q ? 0 : getVisibleDepth(row);
      const isChecked = !hiddenTreeCanvasIds.has(row.id);

      const itemEl = document.createElement('div');
      itemEl.dataset.canvasId = row.id;
      itemEl.className = 'canvas-tree-row'
        + (row.id === store.activeCanvasId ? ' is-active' : '')
        + (selectedTreeCanvasIds.has(row.id) ? ' is-selected' : '')
        + (isCanvasesCheckMode && !isChecked ? ' is-unchecked' : '');
      itemEl.style.paddingLeft = `${6 + visibleDepth * 14}px`;

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
      const checkHtml = isCanvasesCheckMode
        ? `<label class="canvas-tree-check-wrap" title="${isChecked ? '在画布树中隐藏' : '在画布树中显示'}">
             <input type="checkbox" class="canvas-tree-checkbox" ${isChecked ? 'checked' : ''} aria-label="显示 ${escapeHtml(row.title)}" />
             <span class="canvas-tree-checkbox-box" aria-hidden="true"></span>
           </label>`
        : '';

      itemEl.innerHTML = `
        ${toggleHtml}
        ${checkHtml}
        <button type="button" class="canvas-tree-jump-btn">
          <span class="canvas-tree-icon">${visibleDepth > 0 ? '↳' : '◈'}</span>
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

      const checkWrapEl = itemEl.querySelector('.canvas-tree-check-wrap');
      const checkboxEl = itemEl.querySelector('.canvas-tree-checkbox');
      checkWrapEl?.addEventListener('mousedown', (e) => e.stopPropagation());
      checkWrapEl?.addEventListener('click', (e) => e.stopPropagation());
      checkboxEl?.addEventListener('change', (e) => {
        e.stopPropagation();
        if (checkboxEl.checked) {
          hiddenTreeCanvasIds.delete(row.id);
        } else {
          hiddenTreeCanvasIds.add(row.id);
        }
        saveHiddenTreeCanvasIds(hiddenTreeCanvasIds);
        itemEl.classList.toggle('is-unchecked', !checkboxEl.checked);
        const nextChecked = allRows.filter(r => !hiddenTreeCanvasIds.has(r.id)).length;
        if (canvasesCountBadgeEl) {
          canvasesCountBadgeEl.textContent = `${nextChecked}/${allRows.length}`;
        }
      });

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
        } else if (pendingCanvasTreeRender) {
          renderCanvasTreeDrawer();
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
        canvasesFocusActive = true;
        canvasTreeListEl.focus({ preventScroll: true });

        const isCtrl = !!(e.ctrlKey || e.metaKey);
        const isShift = !!e.shiftKey;
        const orderedIds = lastRenderedTreeRowIds;

        if (isShift) {
          e.preventDefault();
          const anchorValid = treeSelectionAnchorId && orderedIds.includes(treeSelectionAnchorId);
          const fallbackAnchor = orderedIds.includes(store.activeCanvasId) ? store.activeCanvasId : row.id;
          const anchorId = anchorValid ? treeSelectionAnchorId : fallbackAnchor;
          if (!anchorValid) treeSelectionAnchorId = anchorId;

          const aIdx = orderedIds.indexOf(anchorId);
          const bIdx = orderedIds.indexOf(row.id);
          if (aIdx >= 0 && bIdx >= 0) {
            const start = Math.min(aIdx, bIdx);
            const end = Math.max(aIdx, bIdx);
            const rangeIds = orderedIds.slice(start, end + 1);
            if (isCtrl) {
              rangeIds.forEach(id => selectedTreeCanvasIds.add(id));
            } else {
              selectedTreeCanvasIds = new Set(rangeIds);
            }
          } else {
            selectedTreeCanvasIds = new Set([row.id]);
            treeSelectionAnchorId = row.id;
          }
          syncCanvasesSelectionVisuals(allRows);
          return;
        }

        if (isCtrl) {
          e.preventDefault();
          if (selectedTreeCanvasIds.has(row.id)) {
            selectedTreeCanvasIds.delete(row.id);
            if (treeSelectionAnchorId === row.id) {
              const remaining = [...selectedTreeCanvasIds];
              treeSelectionAnchorId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
            }
          } else {
            selectedTreeCanvasIds.add(row.id);
            treeSelectionAnchorId = row.id;
          }
          syncCanvasesSelectionVisuals(allRows);
          return;
        }

        selectedTreeCanvasIds.clear();
        treeSelectionAnchorId = row.id;
        syncCanvasesSelectionVisuals(allRows);
        store.navigateToCanvas(row.id);
      });

      itemEl.querySelector('.canvas-tree-rename-btn')?.addEventListener('click', startInlineRename);

      itemEl.querySelector('.canvas-tree-export-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        store.exportCanvasToFile(row.id);
      });

      canvasTreeListEl.appendChild(itemEl);
    });
    syncCanvasesSelectionVisuals(allRows);
  }

  window.__updateSaveUI = ({ connected, dirty, saving, label }) => {
    const btnSave = document.getElementById('btn-save');
    const labelEl = document.getElementById('save-status-label');
    if (btnSave) {
      btnSave.classList.toggle('is-offline', !connected);
      btnSave.classList.toggle('has-unsaved', !!connected && !!dirty);
      btnSave.classList.toggle('is-saving', !!saving);
      if (label) {
        btnSave.setAttribute('data-tooltip', label);
      }
    }
    if (labelEl) {
      if (!connected) labelEl.textContent = '离线';
      else if (saving) labelEl.textContent = '保存中';
      else if (dirty) labelEl.textContent = '未保存';
      else labelEl.textContent = '已保存';
    }
  };

  document.querySelectorAll('.hud-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (e.detail > 0) btn.blur();
    });
  });

  btnCanvasesEl?.addEventListener('click', () => {
    toggleCanvasesDrawer();
  });

  btnCloseCanvasesEl?.addEventListener('click', () => {
    closeCanvasesDrawer();
  });

  btnCanvasesDeleteSelectedEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteSelectedTreeCanvases();
  });

  btnCanvasesCheckModeEl?.addEventListener('click', () => {
    setCanvasesCheckMode(!isCanvasesCheckMode);
  });

  btnCanvasesCheckAllEl?.addEventListener('click', () => {
    hiddenTreeCanvasIds.clear();
    saveHiddenTreeCanvasIds(hiddenTreeCanvasIds);
    renderCanvasTreeDrawer();
  });

  btnCanvasesCheckDoneEl?.addEventListener('click', () => {
    setCanvasesCheckMode(false);
  });

  canvasesDrawerEl?.addEventListener('mousedown', (e) => {
    canvasesFocusActive = true;
    e.stopPropagation();
  });
  canvasTreeListEl?.addEventListener('click', (e) => {
    canvasesFocusActive = true;
    if (e.target === canvasTreeListEl && selectedTreeCanvasIds.size > 0) {
      selectedTreeCanvasIds.clear();
      treeSelectionAnchorId = null;
      syncCanvasesSelectionVisuals();
    }
  });
  canvasesDrawerEl?.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  canvasesSearchInputEl?.addEventListener('input', (e) => {
    canvasesSearchQuery = e.target.value || '';
    renderCanvasTreeDrawer();
  });

  const canvasesResizeHandleEl = document.getElementById('canvases-resize-handle');
  if (canvasesResizeHandleEl && canvasesDrawerEl) {
    canvasesResizeHandleEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startWidth = canvasesDrawerEl.getBoundingClientRect().width;
      const isRight = canvasesDrawerEl.classList.contains('pos-right');

      canvasesDrawerEl.classList.add('is-resizing');
      document.body.style.cursor = 'ew-resize';

      const onMouseMove = (ev) => {
        const delta = isRight ? (startX - ev.clientX) : (ev.clientX - startX);
        const nextWidth = library.clampWidth(startWidth + delta);
        canvasesDrawerEl.style.width = `${nextWidth}px`;
        syncEdgeDrawerOffsets();
      };

      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        canvasesDrawerEl.classList.remove('is-resizing');
        document.body.style.cursor = '';

        const finalWidth = library.clampWidth(canvasesDrawerEl.getBoundingClientRect().width);
        canvasesDrawerEl.style.width = `${finalWidth}px`;
        store.setLibrarySettings({ width: finalWidth });
        syncEdgeDrawerOffsets();
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });

    canvasesResizeHandleEl.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const resetWidth = library.clampWidth(348);
      canvasesDrawerEl.style.width = `${resetWidth}px`;
      store.setLibrarySettings({ width: resetWidth });
      syncEdgeDrawerOffsets();
    });
  }

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

  // HUD Button: Import .pinpoint as child subcanvas of current canvas
  document.getElementById('btn-open')?.addEventListener('click', async () => {
    if (store.isFocusMode) {
      showToast('请先退出专注模式后再导入', 'warning');
      return;
    }
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    const res = await store.openFromFile();
    if (res?.success) {
      if (res.card?.id) {
        nodes.selectedCardIds = new Set([res.card.id]);
      }
      canvas.applyTransform();
      nodes.render();
      wires.render();
      nodes.updateAlignmentBar();
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
      applyAppearanceSettings();
      syncShortcutTooltips();
      canvas.applyTransform();
      nodes.render();
      wires.render();
      nodes.updateAlignmentBar();
      applyToastSettings();
      if (store.isFocusMode) nodes.updateFocusModeUI();
    } else if (event.type === 'SETTINGS_CHANGED') {
      applyAppearanceSettings();
      syncShortcutTooltips();
      settings.syncUI();
      nodes.renderPopoverPalette();
      nodes.updateContextMenuToggles();
      minimap.applySettings();
      library.applySettings();
      applyToastSettings();
      applySharedSidePanelSettings();
      syncEdgeDrawerOffsets();
    } else if (event.type === 'REMOTE_SYNCED') {
      if (event.sourceEvent === 'VIEWPORT_CHANGED') {
        canvas.applyTransform();
      } else if (event.sourceEvent === 'SETTINGS_CHANGED') {
        applyAppearanceSettings();
        syncShortcutTooltips();
        settings.syncUI();
        nodes.renderPopoverPalette();
        nodes.updateContextMenuToggles();
        minimap.applySettings();
        library.applySettings();
        applyToastSettings();
        applySharedSidePanelSettings();
        syncEdgeDrawerOffsets();
      } else {
        nodes.filterSelectionAfterRestore();
        applyAppearanceSettings();
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
        applySharedSidePanelSettings();
        renderCanvasNavigation();
        syncEdgeDrawerOffsets();
      }
    } else if (event.type === 'CONNECTION_ADDED' || event.type === 'CONNECTION_REMOVED' || event.type === 'CONNECTION_RECONNECTED' || event.type?.startsWith('GROUP_') || event.type?.startsWith('CARD_')) {
      nodes.render();
      wires.render();
      minimap.requestRender();
      if (store.isFocusMode) nodes.updateFocusModeUI();
    }
  });

  // Initial render
  applyAppearanceSettings();
  syncShortcutTooltips();
  applySharedSidePanelSettings();
  canvas.applyTransform();
  nodes.render();
  wires.render();
  updateUndoRedoButtons();
  applyToastSettings();
  renderCanvasNavigation();
  syncEdgeDrawerOffsets();
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
