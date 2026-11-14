import { store, DEFAULT_PALETTE } from './state.js';
import { hexToRgba } from './nodes.js';

class SettingsManager {
  constructor() {
    this.overlayEl = null;
    this.modalEl = null;
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
    });

    // Minimap settings listeners
    this.bindMinimapListeners();

    // Nav tabs switching
    this.overlayEl.querySelectorAll('.settings-nav-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const tabId = btn.getAttribute('data-tab');
        if (tabId) this.switchTab(tabId);
      });
    });

    this.currentTab = 'palette';
    this.renderPaletteSlots();
    this.syncAssistanceToggles();
    this.syncMinimapSettings();
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

    if (tabId === 'palette') {
      this.updatePreviewMockup();
    } else if (tabId === 'minimap') {
      this.syncMinimapSettings();
    }
  }

  isOpen() {
    return this.overlayEl && this.overlayEl.classList.contains('is-open');
  }

  open() {
    if (!this.overlayEl) return;
    this.switchTab(this.currentTab || 'palette');
    this.renderPaletteSlots();
    this.syncAssistanceToggles();
    this.syncMinimapSettings();
    this.overlayEl.classList.add('is-open');
  }

  close() {
    if (!this.overlayEl) return;
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
      this.renderPaletteSlots();
      this.syncAssistanceToggles();
      this.syncMinimapSettings();
    }
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

  syncAssistanceToggles() {
    if (!this.overlayEl) return;
    const alignActive = !!store.state.settings?.alignMode;
    const gridActive = !!store.state.settings?.gridSnapMode;

    const alignPill = this.overlayEl.querySelector('#settings-toggle-align');
    const gridPill = this.overlayEl.querySelector('#settings-toggle-gridsnap');

    if (alignPill) alignPill.classList.toggle('is-active', alignActive);
    if (gridPill) gridPill.classList.toggle('is-active', gridActive);
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
      cardMockup.style.setProperty('--card-theme-border', hexToRgba(primaryColor, 0.75));
      cardMockup.style.setProperty('--card-theme-glow', hexToRgba(primaryColor, 0.45));
      const bg1 = hexToRgba(primaryColor, 0.24);
      const bg2 = hexToRgba(primaryColor, 0.10);
      const borderOutline = hexToRgba(primaryColor, 0.70);
      const borderDivider = hexToRgba(primaryColor, 0.35);

      headerMockup.style.background = `linear-gradient(180deg, ${bg1} 0%, ${bg2} 100%)`;
      headerMockup.style.borderColor = borderOutline;
      headerMockup.style.borderTopColor = primaryColor;
      headerMockup.style.borderBottomColor = borderDivider;
    }

    if (capsuleMockup) {
      capsuleMockup.style.setProperty('--capsule-pin', secondaryColor);
      capsuleMockup.style.backgroundColor = hexToRgba(secondaryColor, 0.14);
      capsuleMockup.style.borderColor = hexToRgba(secondaryColor, 0.38);
    }
  }
}

export const settings = new SettingsManager();
