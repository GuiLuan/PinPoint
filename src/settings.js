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
    }
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
