import { store, DEFAULT_PALETTE } from './state.js';
import { hexToRgba } from './nodes.js';
import { SHORTCUT_DEFINITIONS, formatShortcutDisplay, formatShortcutFromEvent } from './shortcuts.js';

class SettingsManager {
  constructor() {
    this.overlayEl = null;
    this.modalEl = null;
    this.recordingShortcutKey = null;
  }

  init(overlayEl) {
    this.overlayEl = overlayEl;
    if (!this.overlayEl) return;
    this.modalEl = this.overlayEl.querySelector('#settings-modal');

    // Close button
    const closeBtn = this.overlayEl.querySelector('#btn-close-settings');
    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });

    // Click backdrop overlay to close
    this.overlayEl.addEventListener('mousedown', (e) => {
      if (e.target === this.overlayEl) {
        this.close();
      }
    });

    // Stepper buttons for slot count
    const btnSlotDec = this.overlayEl.querySelector('#btn-slot-dec');
    const btnSlotInc = this.overlayEl.querySelector('#btn-slot-inc');

    btnSlotDec?.addEventListener('click', (e) => {
      e.preventDefault();
      const current = store.getPalette();
      if (current.length > 2) {
        store.setPaletteSlotCount(current.length - 1);
        this.renderPaletteSlots();
      }
    });

    btnSlotInc?.addEventListener('click', (e) => {
      e.preventDefault();
      const current = store.getPalette();
      if (current.length < 10) {
        store.setPaletteSlotCount(current.length + 1);
        this.renderPaletteSlots();
      }
    });

    // Add slot button
    const btnAddSlot = this.overlayEl.querySelector('#btn-add-slot');
    btnAddSlot?.addEventListener('click', (e) => {
      e.preventDefault();
      store.addPaletteSlot();
      this.renderPaletteSlots();
    });

    // Reset palette button
    const btnResetPalette = this.overlayEl.querySelector('#btn-reset-palette');
    btnResetPalette?.addEventListener('click', (e) => {
      e.preventDefault();
      store.resetPalette();
      this.renderPaletteSlots();
    });

    // Assistance toggles
    const alignTogglePill = this.overlayEl.querySelector('#settings-toggle-align');
    alignTogglePill?.parentElement?.addEventListener('click', (e) => {
      e.preventDefault();
      store.toggleAlignMode();
      this.syncAssistanceToggles();
    });

    const gridTogglePill = this.overlayEl.querySelector('#settings-toggle-gridsnap');
    gridTogglePill?.parentElement?.addEventListener('click', (e) => {
      e.preventDefault();
      store.toggleGridSnapMode();
      this.syncAssistanceToggles();
      window.__nodes?.renderGroups?.();
      window.__wires?.render?.();
    });

    // Appearance settings listeners
    this.bindAppearanceListeners();

    // Minimap settings listeners
    this.bindMinimapListeners();

    // Library settings listeners
    this.bindLibraryListeners();

    // Save & Storage settings listeners
    this.bindSaveListeners();

    // Toast Notification settings listeners
    this.bindToastListeners();

    // Shortcuts settings listeners
    this.bindShortcutsListeners();

    // Nav tabs switching
    this.overlayEl.querySelectorAll('.settings-nav-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const tabId = btn.getAttribute('data-tab');
        if (tabId) this.switchTab(tabId);
      });
    });

    this.currentTab = 'appearance';
    this.syncAppearanceSettings();
    this.renderPaletteSlots();
    this.syncAssistanceToggles();
    this.syncMinimapSettings();
    this.syncLibrarySettings();
    this.syncSaveSettings();
    this.syncToastSettings();
    this.syncShortcuts();
  }

  switchTab(tabId) {
    if (!this.overlayEl) return;
    this.currentTab = tabId;

    this.overlayEl.querySelectorAll('.settings-nav-item').forEach(btn => {
      const match = btn.getAttribute('data-tab') === tabId;
      btn.classList.toggle('is-active', match);
    });

    this.overlayEl.querySelectorAll('.settings-tab-panel').forEach(panel => {
      const match = panel.id === `tab-panel-${tabId}`;
      panel.classList.toggle('is-active', match);
    });

    if (tabId === 'appearance') {
      this.syncAppearanceSettings();
    } else if (tabId === 'palette') {
      this.updatePreviewMockup();
    } else if (tabId === 'minimap') {
      this.syncMinimapSettings();
    } else if (tabId === 'library') {
      this.syncLibrarySettings();
    } else if (tabId === 'save') {
      this.syncSaveSettings();
    } else if (tabId === 'toast') {
      this.syncToastSettings();
    } else if (tabId === 'shortcuts') {
      this.syncShortcuts();
    }
  }

  isOpen() {
    return this.overlayEl && this.overlayEl.classList.contains('is-open');
  }

  isRecordingShortcut() {
    return Boolean(this.recordingShortcutKey);
  }

  open() {
    if (!this.overlayEl) return;
    this.recordingShortcutKey = null;
    this.switchTab(this.currentTab || 'appearance');
    this.syncAppearanceSettings();
    this.renderPaletteSlots();
    this.syncAssistanceToggles();
    this.syncMinimapSettings();
    this.syncLibrarySettings();
    this.syncSaveSettings();
    this.syncToastSettings();
    this.syncShortcuts();
    this.overlayEl.classList.add('is-open');
  }

  close() {
    if (!this.overlayEl) return;
    this.recordingShortcutKey = null;
    this.overlayEl.classList.remove('is-open');
  }

  toggle() {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  syncUI() {
    if (this.isOpen()) {
      this.syncAppearanceSettings();
      this.renderPaletteSlots();
      this.syncAssistanceToggles();
      this.syncMinimapSettings();
      this.syncLibrarySettings();
      this.syncSaveSettings();
      this.syncToastSettings();
      this.syncShortcuts();
    }
  }

  bindAppearanceListeners() {
    if (!this.overlayEl) return;
    const panel = this.overlayEl.querySelector('#tab-panel-appearance');
    if (!panel) return;

    panel.addEventListener('click', (e) => {
      const themeCard = e.target.closest('.theme-mode-card');
      if (themeCard) {
        e.preventDefault();
        const theme = themeCard.getAttribute('data-theme');
        if (theme === 'dark' || theme === 'light') {
          store.setAppearanceSettings({ theme });
          this.syncAppearanceSettings();
        }
        return;
      }

      const accentDot = e.target.closest('.accent-preset-dot');
      if (accentDot) {
        e.preventDefault();
        const accent = accentDot.getAttribute('data-accent');
        if (accent) {
          store.setAppearanceSettings({ accentColor: accent });
          this.syncAppearanceSettings();
        }
        return;
      }

      const texCard = e.target.closest('.canvas-tex-card');
      if (texCard) {
        e.preventDefault();
        const tex = texCard.getAttribute('data-tex');
        if (tex) {
          store.setAppearanceSettings({ canvasTexture: tex });
          this.syncAppearanceSettings();
        }
      }
    });

    const accentInput = panel.querySelector('#settings-accent-input');
    accentInput?.addEventListener('input', (e) => {
      store.setAppearanceSettings({ accentColor: e.target.value });
      this.syncAppearanceSettings();
    });
  }

  syncAppearanceSettings() {
    if (!this.overlayEl) return;
    const ap = store.getAppearanceSettings();

    this.overlayEl.querySelectorAll('.theme-mode-card').forEach(card => {
      card.classList.toggle('is-active', card.getAttribute('data-theme') === ap.theme);
    });

    this.overlayEl.querySelectorAll('.accent-preset-dot').forEach(dot => {
      dot.classList.toggle('is-active', dot.getAttribute('data-accent')?.toLowerCase() === ap.accentColor?.toLowerCase());
    });

    const accentInput = this.overlayEl.querySelector('#settings-accent-input');
    if (accentInput && ap.accentColor) accentInput.value = ap.accentColor;

    this.overlayEl.querySelectorAll('.canvas-tex-card').forEach(card => {
      card.classList.toggle('is-active', card.getAttribute('data-tex') === ap.canvasTexture);
    });
  }

  bindMinimapListeners() {
    if (!this.overlayEl) return;
    const panel = this.overlayEl.querySelector('#tab-panel-minimap');
    if (!panel) return;

    // Toggle switch row and pill
    const toggleRow = panel.querySelector('#row-toggle-minimap');
    const togglePill = panel.querySelector('#settings-toggle-minimap');

    const handleToggle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      store.toggleMinimap();
      this.syncMinimapSettings();
    };

    toggleRow?.addEventListener('click', handleToggle);
    togglePill?.addEventListener('click', handleToggle);

    // Position cards
    panel.querySelectorAll('.minimap-pos-card').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = btn.getAttribute('data-pos');
        if (pos) {
          store.setMinimapSettings({ position: pos });
          this.syncMinimapSettings();
        }
      });
    });

    // Size preset buttons
    panel.querySelectorAll('.settings-size-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const size = parseInt(btn.getAttribute('data-size'), 10);
        if (size) {
          store.setMinimapSettings({ size });
          this.syncMinimapSettings();
        }
      });
    });

    // Size slider
    const sizeSlider = panel.querySelector('#minimap-size-slider');
    sizeSlider?.addEventListener('input', (e) => {
      const size = parseInt(e.target.value, 10);
      if (size) {
        store.setMinimapSettings({ size });
        this.syncMinimapSettings();
      }
    });

    // Delegated click handler on the whole panel for extra robustness
    panel.addEventListener('click', (e) => {
      const posCard = e.target.closest('.minimap-pos-card');
      if (posCard) {
        e.preventDefault();
        const pos = posCard.getAttribute('data-pos');
        if (pos) {
          store.setMinimapSettings({ position: pos });
          this.syncMinimapSettings();
        }
        return;
      }

      const sizeBtn = e.target.closest('.settings-size-btn');
      if (sizeBtn) {
        e.preventDefault();
        const size = parseInt(sizeBtn.getAttribute('data-size'), 10);
        if (size) {
          store.setMinimapSettings({ size });
          this.syncMinimapSettings();
        }
        return;
      }

      const row = e.target.closest('#row-toggle-minimap, #settings-toggle-minimap');
      if (row) {
        e.preventDefault();
        store.toggleMinimap();
        this.syncMinimapSettings();
        return;
      }
    });
  }

  syncMinimapSettings() {
    if (!this.overlayEl) return;
    const mm = store.getMinimapSettings();

    // Toggle pill
    const pill = this.overlayEl.querySelector('#settings-toggle-minimap');
    if (pill) pill.classList.toggle('is-active', !!mm.enabled);

    // Position cards
    this.overlayEl.querySelectorAll('.minimap-pos-card').forEach(card => {
      const pos = card.getAttribute('data-pos');
      card.classList.toggle('is-active', pos === mm.position);
    });

    // Size preset buttons
    this.overlayEl.querySelectorAll('.settings-size-btn').forEach(btn => {
      const s = parseInt(btn.getAttribute('data-size'), 10);
      btn.classList.toggle('is-active', s === mm.size);
    });

    // Slider and value
    const slider = this.overlayEl.querySelector('#minimap-size-slider');
    const valDisplay = this.overlayEl.querySelector('#minimap-size-val');
    if (slider) slider.value = mm.size;
    if (valDisplay) valDisplay.textContent = `${mm.size}px`;
  }

  bindLibraryListeners() {
    if (!this.overlayEl) return;
    const panel = this.overlayEl.querySelector('#tab-panel-library');
    if (!panel) return;

    panel.addEventListener('click', (e) => {
      const posCard = e.target.closest('.library-pos-card');
      if (posCard) {
        e.preventDefault();
        const pos = posCard.getAttribute('data-lib-pos');
        if (pos === 'left' || pos === 'right') {
          store.setLibrarySettings({ position: pos });
          this.syncLibrarySettings();
        }
        return;
      }

      const layoutCard = e.target.closest('.library-layout-card');
      if (layoutCard) {
        e.preventDefault();
        const layout = layoutCard.getAttribute('data-lib-layout');
        if (layout === 'grid' || layout === 'list') {
          store.setLibrarySettings({ layout });
          this.syncLibrarySettings();
        }
      }
    });
  }

  syncLibrarySettings() {
    if (!this.overlayEl) return;
    const lib = store.getLibrarySettings();

    this.overlayEl.querySelectorAll('.library-pos-card').forEach(card => {
      card.classList.toggle('is-active', card.getAttribute('data-lib-pos') === lib.position);
    });

    this.overlayEl.querySelectorAll('.library-layout-card').forEach(card => {
      card.classList.toggle('is-active', card.getAttribute('data-lib-layout') === lib.layout);
    });
  }

  bindSaveListeners() {
    if (!this.overlayEl) return;
    const panel = this.overlayEl.querySelector('#tab-panel-save');
    if (!panel) return;

    panel.addEventListener('click', (e) => {
      const modeCard = e.target.closest('.save-mode-card');
      if (modeCard) {
        e.preventDefault();
        const mode = modeCard.getAttribute('data-save-mode');
        if (mode === 'auto' || mode === 'manual') {
          store.setSaveSettings({ mode });
          this.syncSaveSettings();
        }
        return;
      }

      const presetBtn = e.target.closest('.save-interval-preset');
      if (presetBtn) {
        e.preventDefault();
        const sec = parseInt(presetBtn.getAttribute('data-sec'), 10);
        if (sec) {
          store.setSaveSettings({ intervalSec: sec });
          this.syncSaveSettings();
        }
        return;
      }
    });

    const slider = panel.querySelector('#save-interval-slider');
    slider?.addEventListener('input', (e) => {
      const sec = parseInt(e.target.value, 10);
      if (sec) {
        store.setSaveSettings({ intervalSec: sec });
        this.syncSaveSettings();
      }
    });

    const btnSaveNow = panel.querySelector('#btn-settings-save-now');
    btnSaveNow?.addEventListener('click', async (e) => {
      e.preventDefault();
      await window.__sync?.saveAllToBackend?.({ manual: true });
      this.syncSaveSettings();
    });
  }

  syncSaveSettings() {
    if (!this.overlayEl) return;
    const sv = store.getSaveSettings();

    this.overlayEl.querySelectorAll('.save-mode-card').forEach(card => {
      card.classList.toggle('is-active', card.getAttribute('data-save-mode') === sv.mode);
    });

    const intervalSection = this.overlayEl.querySelector('#settings-save-interval-section');
    if (intervalSection) {
      intervalSection.style.opacity = sv.mode === 'auto' ? '1' : '0.45';
      intervalSection.style.pointerEvents = sv.mode === 'auto' ? 'auto' : 'none';
    }

    this.overlayEl.querySelectorAll('.save-interval-preset').forEach(btn => {
      const sec = parseInt(btn.getAttribute('data-sec'), 10);
      btn.classList.toggle('is-active', sec === sv.intervalSec);
    });

    const slider = this.overlayEl.querySelector('#save-interval-slider');
    const valEl = this.overlayEl.querySelector('#save-interval-val');
    if (slider) slider.value = sv.intervalSec;
    if (valEl) valEl.textContent = `${sv.intervalSec} 秒`;
  }

  bindToastListeners() {
    if (!this.overlayEl) return;
    const panel = this.overlayEl.querySelector('#tab-panel-toast');
    if (!panel) return;

    panel.addEventListener('click', (e) => {
      const posCard = e.target.closest('.toast-pos-card');
      if (posCard) {
        e.preventDefault();
        const pos = posCard.getAttribute('data-toast-pos');
        if (pos) {
          store.setToastSettings({ position: pos });
          this.syncToastSettings();
        }
        return;
      }

      const presetBtn = e.target.closest('.toast-duration-preset');
      if (presetBtn) {
        e.preventDefault();
        const sec = parseInt(presetBtn.getAttribute('data-sec'), 10);
        if (sec) {
          store.setToastSettings({ durationSec: sec });
          this.syncToastSettings();
        }
        return;
      }
    });

    const slider = panel.querySelector('#toast-duration-slider');
    slider?.addEventListener('input', (e) => {
      const sec = parseInt(e.target.value, 10);
      if (sec) {
        store.setToastSettings({ durationSec: sec });
        this.syncToastSettings();
      }
    });

    const btnTest = panel.querySelector('#btn-settings-test-toast');
    btnTest?.addEventListener('click', (e) => {
      e.preventDefault();
      const ts = store.getToastSettings();
      store.emitToast(`通知预览（停留 ${ts.durationSec} 秒）`, 'info');
    });
  }

  syncToastSettings() {
    if (!this.overlayEl) return;
    const ts = store.getToastSettings();

    this.overlayEl.querySelectorAll('.toast-pos-card').forEach(card => {
      card.classList.toggle('is-active', card.getAttribute('data-toast-pos') === ts.position);
    });

    this.overlayEl.querySelectorAll('.toast-duration-preset').forEach(btn => {
      const sec = parseInt(btn.getAttribute('data-sec'), 10);
      btn.classList.toggle('is-active', sec === ts.durationSec);
    });

    const slider = this.overlayEl.querySelector('#toast-duration-slider');
    const valEl = this.overlayEl.querySelector('#toast-duration-val');
    if (slider) slider.value = Math.min(15, Math.max(2, ts.durationSec));
    if (valEl) valEl.textContent = `${ts.durationSec} 秒`;
  }

  syncAssistanceToggles() {
    if (!this.overlayEl) return;
    const alignActive = !!store.state.settings?.alignMode;
    const gridActive = !!store.state.settings?.gridSnapMode;

    const alignPill = this.overlayEl.querySelector('#settings-toggle-align');
    const gridPill = this.overlayEl.querySelector('#settings-toggle-gridsnap');

    if (alignPill) alignPill.classList.toggle('is-active', alignActive);
    if (gridPill) gridPill.classList.toggle('is-active', gridActive);
  }

  bindShortcutsListeners() {
    if (!this.overlayEl) return;
    const panel = this.overlayEl.querySelector('#tab-panel-shortcuts');
    if (!panel) return;

    panel.addEventListener('click', (e) => {
      const clearBtn = e.target.closest('.shortcut-clear-btn');
      if (clearBtn) {
        e.preventDefault();
        e.stopPropagation();
        const key = clearBtn.getAttribute('data-shortcut-key');
        if (key) {
          this.recordingShortcutKey = null;
          store.setShortcut(key, '');
          this.syncShortcuts();
        }
        return;
      }

      const keyBtn = e.target.closest('.shortcut-key-btn');
      if (keyBtn) {
        e.preventDefault();
        e.stopPropagation();
        const key = keyBtn.getAttribute('data-shortcut-key');
        if (!key) return;
        this.recordingShortcutKey = (this.recordingShortcutKey === key) ? null : key;
        this.syncShortcuts();
        return;
      }

      if (this.recordingShortcutKey) {
        this.recordingShortcutKey = null;
        this.syncShortcuts();
      }
    });

    const resetBtn = panel.querySelector('#btn-reset-shortcuts');
    resetBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.recordingShortcutKey = null;
      store.resetShortcuts();
      this.syncShortcuts();
      store.emitToast('已恢复默认快捷键', 'success');
    });

    window.addEventListener('keydown', (e) => {
      if (!this.recordingShortcutKey) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        this.recordingShortcutKey = null;
        this.syncShortcuts();
        return;
      }

      const combo = formatShortcutFromEvent(e);
      if (!combo) return;

      const targetKey = this.recordingShortcutKey;
      const currentMap = store.getShortcuts();
      const conflictEntry = SHORTCUT_DEFINITIONS.find(
        def => def.key !== targetKey && currentMap[def.key] && currentMap[def.key].toUpperCase() === combo.toUpperCase()
      );

      this.recordingShortcutKey = null;
      if (conflictEntry) {
        store.setShortcuts({ [conflictEntry.key]: '', [targetKey]: combo });
        store.emitToast(`已绑定为「${formatShortcutDisplay(combo)}」，原「${conflictEntry.label}」已清空`, 'info');
      } else {
        store.setShortcut(targetKey, combo);
      }
      this.syncShortcuts();
    }, true);
  }

  syncShortcuts() {
    if (!this.overlayEl) return;
    const container = this.overlayEl.querySelector('#shortcuts-list-container');
    if (!container) return;

    const shortcuts = store.getShortcuts();
    container.innerHTML = '';

    for (const def of SHORTCUT_DEFINITIONS) {
      const binding = shortcuts[def.key] || '';
      const isRecording = this.recordingShortcutKey === def.key;

      const row = document.createElement('div');
      row.className = 'shortcut-item shortcut-item-editable' + (isRecording ? ' is-recording' : '');

      const labelEl = document.createElement('span');
      labelEl.className = 'shortcut-label';
      labelEl.textContent = def.label;

      const rightWrap = document.createElement('div');
      rightWrap.className = 'shortcut-controls';

      const keyBtn = document.createElement('button');
      keyBtn.type = 'button';
      keyBtn.className = 'shortcut-key-btn' + (isRecording ? ' is-recording' : '') + (!binding ? ' is-empty' : '');
      keyBtn.setAttribute('data-shortcut-key', def.key);
      keyBtn.title = isRecording ? '请按下新的快捷键，按 Esc 取消' : '点击修改快捷键';

      const kbd = document.createElement('kbd');
      kbd.textContent = isRecording ? '按下按键...' : formatShortcutDisplay(binding);
      keyBtn.appendChild(kbd);
      rightWrap.appendChild(keyBtn);

      if (binding && !isRecording) {
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'shortcut-clear-btn';
        clearBtn.setAttribute('data-shortcut-key', def.key);
        clearBtn.title = '清空此快捷键';
        clearBtn.setAttribute('aria-label', `清空 ${def.label} 快捷键`);
        clearBtn.innerHTML = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        rightWrap.appendChild(clearBtn);
      }

      row.appendChild(labelEl);
      row.appendChild(rightWrap);
      container.appendChild(row);
    }
  }

  renderPaletteSlots() {
    if (!this.overlayEl) return;
    const container = this.overlayEl.querySelector('#palette-slots-container');
    const countDisplay = this.overlayEl.querySelector('#slot-count-val');
    const btnDec = this.overlayEl.querySelector('#btn-slot-dec');
    const btnInc = this.overlayEl.querySelector('#btn-slot-inc');
    const btnAdd = this.overlayEl.querySelector('#btn-add-slot');

    if (!container) return;

    const palette = store.getPalette();
    const count = palette.length;

    if (countDisplay) countDisplay.textContent = count;
    if (btnDec) btnDec.disabled = count <= 2;
    if (btnInc) btnInc.disabled = count >= 10;
    if (btnAdd) btnAdd.disabled = count >= 10;

    container.innerHTML = '';

    palette.forEach((color, idx) => {
      const slotEl = document.createElement('div');
      slotEl.className = 'palette-slot-item';
      slotEl.setAttribute('data-slot-index', idx);

      slotEl.innerHTML = `
        <span class="slot-badge">${idx + 1}</span>
        <label class="slot-color-swatch" style="background-color: ${color};" title="点击更改颜色">
          <input type="color" class="slot-color-input" value="${color}" />
        </label>
        <input type="text" class="slot-hex-input" value="${color.toUpperCase()}" maxlength="7" spellcheck="false" title="输入 16 进制颜色代码" />
        <button class="slot-remove-btn" title="删除此槽位" ${count <= 2 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      `;

      const swatchLabel = slotEl.querySelector('.slot-color-swatch');
      const colorInput = slotEl.querySelector('.slot-color-input');
      const hexInput = slotEl.querySelector('.slot-hex-input');
      const removeBtn = slotEl.querySelector('.slot-remove-btn');

      const onColorChange = (newColor) => {
        if (!newColor.startsWith('#')) newColor = '#' + newColor;
        swatchLabel.style.backgroundColor = newColor;
        colorInput.value = newColor;
        hexInput.value = newColor.toUpperCase();
        store.updatePaletteColor(idx, newColor);
        this.updatePreviewMockup();
      };

      colorInput.addEventListener('input', (e) => {
        onColorChange(e.target.value);
      });

      colorInput.addEventListener('change', (e) => {
        onColorChange(e.target.value);
      });

      hexInput.addEventListener('input', (e) => {
        let val = e.target.value.trim();
        if (!val.startsWith('#')) val = '#' + val;
        if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
          onColorChange(val);
        }
      });

      hexInput.addEventListener('blur', () => {
        // Reset to valid color if left incomplete
        hexInput.value = palette[idx].toUpperCase();
      });

      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.removePaletteSlot(idx);
        this.renderPaletteSlots();
      });

      container.appendChild(slotEl);
    });

    this.updatePreviewMockup();
  }

  updatePreviewMockup() {
    if (!this.overlayEl) return;
    const palette = store.getPalette();
    const primaryColor = palette[0] || '#30d158';
    const secondaryColor = palette[1] || palette[0] || '#0a84ff';

    const cardMockup = this.overlayEl.querySelector('#preview-card-mockup');
    const headerMockup = this.overlayEl.querySelector('#preview-header-mockup');
    const capsuleMockup = this.overlayEl.querySelector('#preview-capsule-mockup');

    if (cardMockup && headerMockup) {
      cardMockup.style.background = hexToRgba(primaryColor, 0.055);
      cardMockup.style.borderColor = hexToRgba(primaryColor, 0.36);
      cardMockup.style.boxShadow = 'var(--elev-card)';

      headerMockup.style.background = hexToRgba(primaryColor, 0.11);
      headerMockup.style.borderBottomColor = hexToRgba(primaryColor, 0.18);
      headerMockup.style.color = 'var(--text-primary)';
    }

    if (capsuleMockup) {
      capsuleMockup.style.setProperty('--capsule-pin', secondaryColor);
      capsuleMockup.style.backgroundColor = hexToRgba(secondaryColor, 0.16);
      capsuleMockup.style.borderColor = 'transparent';
    }
  }
}

export const settings = new SettingsManager();
