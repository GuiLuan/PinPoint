export const DEFAULT_SHORTCUTS = {
  toggleCanvases: 'C',
  toggleLibrary: 'L',
  saveToLibrary: 'Shift+L',
  toggleFocusMode: 'F',
  openSettings: 'Ctrl+,',
  searchCurrentCanvas: 'Ctrl+K',
  searchAllCanvases: 'Ctrl+Shift+K',
  saveGraph: 'Ctrl+S',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Y',
  selectAll: 'Ctrl+A',
  copy: 'Ctrl+C',
  cut: 'Ctrl+X',
  paste: 'Ctrl+V',
  createGroup: 'Ctrl+G',
  ungroup: 'Ctrl+Shift+G',
  renameCard: 'F2',
  deleteSelected: 'Delete'
};

export const SHORTCUT_DEFINITIONS = [
  { key: 'toggleCanvases', label: '打开 / 收起画布' },
  { key: 'toggleLibrary', label: '打开 / 收起库' },
  { key: 'saveToLibrary', label: '保存到库' },
  { key: 'toggleFocusMode', label: '进入专注模式' },
  { key: 'openSettings', label: '偏好设置' },
  { key: 'searchCurrentCanvas', label: '搜索当前画布' },
  { key: 'searchAllCanvases', label: '搜索全部画布' },
  { key: 'saveGraph', label: '保存图谱' },
  { key: 'undo', label: '撤销' },
  { key: 'redo', label: '重做' },
  { key: 'selectAll', label: '全选' },
  { key: 'copy', label: '复制选中节点' },
  { key: 'cut', label: '剪切选中节点' },
  { key: 'paste', label: '粘贴节点' },
  { key: 'createGroup', label: '创建组' },
  { key: 'ungroup', label: '解散组' },
  { key: 'renameCard', label: '重命名节点' },
  { key: 'deleteSelected', label: '删除选中项' }
];

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock']);

const CODE_KEY_MAP = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right'
};

const SPECIAL_KEY_ALIASES = {
  del: 'Delete',
  delete: 'Delete',
  backspace: 'Backspace',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: 'Space',
  ' ': 'Space',
  spacebar: 'Space',
  arrowup: 'Up',
  up: 'Up',
  arrowdown: 'Down',
  down: 'Down',
  arrowleft: 'Left',
  left: 'Left',
  arrowright: 'Right',
  right: 'Right',
  esc: 'Escape',
  escape: 'Escape',
  comma: ',',
  period: '.',
  slash: '/'
};

export function extractBaseKeyFromEvent(e) {
  if (!e) return '';
  if (e.key && MODIFIER_KEYS.has(e.key)) return '';
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  if (CODE_KEY_MAP[code]) return CODE_KEY_MAP[code];

  const k = String(e.key || '');
  if (!k || k === 'Process' || k === 'Unidentified') return '';
  const lower = k.toLowerCase();
  if (SPECIAL_KEY_ALIASES[lower]) return SPECIAL_KEY_ALIASES[lower];
  if (/^f([1-9]|1[0-2])$/i.test(k)) return k.toUpperCase();
  if (k.length === 1) return k.toUpperCase();
  return k;
}

export function normalizeShortcutString(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const parts = trimmed.split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  let ctrl = false;
  let alt = false;
  let shift = false;
  let baseKey = '';

  for (const part of parts) {
    const low = part.toLowerCase();
    if (low === 'ctrl' || low === 'control' || low === 'cmd' || low === 'meta' || low === 'command') {
      ctrl = true;
    } else if (low === 'alt' || low === 'option') {
      alt = true;
    } else if (low === 'shift') {
      shift = true;
    } else {
      if (SPECIAL_KEY_ALIASES[low]) {
        baseKey = SPECIAL_KEY_ALIASES[low];
      } else if (/^f([1-9]|1[0-2])$/i.test(part)) {
        baseKey = part.toUpperCase();
      } else if (part.length === 1) {
        baseKey = part.toUpperCase();
      } else {
        baseKey = part;
      }
    }
  }

  if (!baseKey || baseKey === 'Escape') return '';
  const out = [];
  if (ctrl) out.push('Ctrl');
  if (alt) out.push('Alt');
  if (shift) out.push('Shift');
  out.push(baseKey);
  return out.join('+');
}

export function formatShortcutFromEvent(e) {
  const baseKey = extractBaseKeyFromEvent(e);
  if (!baseKey || baseKey === 'Escape') return '';
  const out = [];
  if (e.ctrlKey || e.metaKey) out.push('Ctrl');
  if (e.altKey) out.push('Alt');
  if (e.shiftKey) out.push('Shift');
  out.push(baseKey);
  return out.join('+');
}

export function parseShortcut(binding) {
  const norm = normalizeShortcutString(binding);
  if (!norm) return null;
  const parts = norm.split('+');
  const key = parts[parts.length - 1];
  return {
    ctrl: parts.includes('Ctrl'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
    key
  };
}

export function matchesShortcut(e, binding) {
  if (!e || !binding) return false;
  const parsed = parseShortcut(binding);
  if (!parsed) return false;
  if ((e.ctrlKey || e.metaKey) !== parsed.ctrl) return false;
  if (!!e.altKey !== parsed.alt) return false;
  if (!!e.shiftKey !== parsed.shift) return false;

  const eventKey = extractBaseKeyFromEvent(e);
  if (!eventKey) return false;
  return eventKey.toUpperCase() === parsed.key.toUpperCase();
}

export function formatShortcutDisplay(binding) {
  const norm = normalizeShortcutString(binding);
  if (!norm) return '未设置';
  return norm.split('+').join(' + ');
}
